// Public API for the embeddable website chat widget (public/widget-embed/
// chat-widget.js). Deliberately separate from the x-api-key-protected /api
// router below, since real website visitors on a client's site (e.g. the
// demo healthcare site) have no way to hold that key - patient identity
// here is instead a per-patient JWT issued by /signup or /login (see
// src/auth.js), required on every route except those two plus OPTIONS
// preflight. CORS is wide open on purpose - this router needs to work from
// any client site the widget is embedded on, not just this same origin.
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const prisma = require('../db');
const { translateBetween, detectAndTranslate } = require('../translate');
const { normalizePhone } = require('../phone');
const { addMessage, toPublicMessages } = require('../conversations');
const { runAutoReply } = require('../autoReply');
const { hashPassword, verifyPassword, signPatientToken, requireAuth } = require('../auth');
const asyncHandler = require('../asyncHandler');

router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

async function getPrimaryLanguage() {
  const settings = await prisma.settings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  return settings.primaryLanguage;
}

// Looks up a chat by id and 404s/403s if it doesn't exist or belongs to
// someone else - every authenticated route below that touches a specific
// chat runs this first instead of trusting the chatId on its own. A cuid
// is effectively unguessable, but ownership should never rest on that
// alone.
async function loadOwnedChat(chatId, patientId) {
  const conversation = await prisma.conversation.findUnique({
    where: { channel_contactKey: { channel: 'webchat', contactKey: chatId } },
  });
  if (!conversation || conversation.patientId !== patientId) return null;
  return conversation;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Patient accounts ───────────────────────────────────────────────────
// Sign-in is required before a patient can chat at all - see requireAuth
// on every route below this point. That's also what makes booking an
// appointment or any other service require an account: there's no way to
// reach the booking flow without first reaching the chat itself.

router.post('/signup', asyncHandler(async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await prisma.patient.findUnique({ where: { email: normalizedEmail } });
  if (existing) return res.status(409).json({ error: 'An account with this email already exists - please log in instead.' });

  const passwordHash = await hashPassword(password);
  const patient = await prisma.patient.create({
    data: { name: name.trim(), email: normalizedEmail, passwordHash },
  });

  const token = signPatientToken(patient);
  res.status(201).json({ token, patient: { id: patient.id, name: patient.name, email: patient.email } });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const patient = await prisma.patient.findUnique({ where: { email: String(email).trim().toLowerCase() } });
  const ok = patient && await verifyPassword(password, patient.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect email or password' });

  const token = signPatientToken(patient);
  res.json({ token, patient: { id: patient.id, name: patient.name, email: patient.email } });
}));

// Lets the widget restore a session on page load from a token it already
// has in localStorage, instead of asking the patient to log in every visit.
router.get('/me', requireAuth, (req, res) => {
  res.json({ patient: req.patient });
});

// Lists every chat this patient has started, most recent first, with a
// one-line preview of the last message - the widget's chat-switcher reads
// this to build its list.
router.get('/chats', requireAuth, asyncHandler(async (req, res) => {
  const conversations = await prisma.conversation.findMany({
    where: { patientId: req.patient.id, channel: 'webchat' },
    orderBy: { createdAt: 'desc' },
    include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  res.json({
    chats: conversations.map((c) => {
      const last = c.messages[0];
      const preview = last ? (last.direction === 'inbound' ? last.originalText : (last.translatedText || last.originalText)) : null;
      return {
        chatId: c.contactKey,
        createdAt: c.createdAt,
        linkedWhatsapp: c.linkedWhatsapp,
        lastMessage: preview,
        lastMessageAt: last ? last.createdAt : c.createdAt,
      };
    }),
  });
}));

// Starts a brand new, empty chat thread for this patient (the widget's
// "New Chat" button) - e.g. one thread to book an appointment, a separate
// one later for a diagnostic test, all listed together under GET /chats.
router.post('/chats', requireAuth, asyncHandler(async (req, res) => {
  const chatId = crypto.randomUUID();
  const conversation = await prisma.conversation.create({
    data: { channel: 'webchat', contactKey: chatId, patientId: req.patient.id, displayName: req.patient.name },
  });
  res.status(201).json({ chatId: conversation.contactKey, createdAt: conversation.createdAt });
}));

// ── Chatting ────────────────────────────────────────────────────────────

// A patient sends a message from the widget, into one of their own chats
// (see POST /chats above - chatId must already exist and belong to them).
// Figures out (or reuses) the chat's locked-in language, translates into
// the site's configured primary language, and returns the saved
// (translated) message.
//
// Language handling, in priority order:
//   1. An explicit `language` in the request - only sent when the patient
//      manually changes language via the widget's "change language" button.
//      Always wins and overwrites the locked-in language from here on.
//   2. The chat's already-locked `customerLanguage`, if this isn't the
//      first message - keeps the WHOLE chat in one language instead of
//      re-detecting (and potentially flip-flopping on) every message.
//   3. Auto-detected from the text itself - only happens once, on the very
//      first message of a brand new chat. Prefers Google's own auto-detect
//      (via detectAndTranslate in src/translate.js) since that's what
//      actually recognizes Hinglish and other script-ambiguous text; falls
//      back to franc when Google isn't configured.
router.post('/message', requireAuth, asyncHandler(async (req, res) => {
  const { chatId, text, language } = req.body || {};
  if (!chatId || !text || !text.trim()) {
    return res.status(400).json({ error: 'chatId and text are required' });
  }

  let conversation = await loadOwnedChat(chatId, req.patient.id);
  if (!conversation) return res.status(404).json({ error: 'Chat not found - start a new one first.' });

  const primaryLanguage = await getPrimaryLanguage();

  let customerLanguage;
  let translatedText;

  if (language) {
    customerLanguage = language;
    ({ translatedText } = await translateBetween(text, customerLanguage, primaryLanguage));
  } else if (conversation.customerLanguage) {
    customerLanguage = conversation.customerLanguage;
    ({ translatedText } = await translateBetween(text, customerLanguage, primaryLanguage));
  } else {
    ({ translatedText, detectedLanguage: customerLanguage } = await detectAndTranslate(text, primaryLanguage));
  }

  if (conversation.customerLanguage !== customerLanguage) {
    conversation = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { customerLanguage },
    });
  }

  const saved = await addMessage(conversation.id, {
    direction: 'inbound',
    originalText: text,
    detectedLanguage: customerLanguage,
    translatedText,
    targetLanguage: primaryLanguage,
  });

  if (!conversation.muted) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { unreadCount: { increment: 1 } },
    });
  }

  // Instant auto-reply via Groq (see src/autoReply.js and src/groq.js) —
  // no-ops silently if GROQ_API_KEY isn't set, if a human has already taken
  // over this conversation (botEnabled === false), or if Groq itself
  // decides the question needs a human. Runs in the same request as the
  // patient's message so the reply is already saved by the time the
  // widget's next poll (~4s) comes around. Also delivers over WhatsApp too
  // when this chat is linked (see runAutoReply in autoReply.js).
  await runAutoReply(conversation, primaryLanguage, customerLanguage);

  res.json({ message: saved, detectedLanguage: customerLanguage });
}));

// A patient shares their current GPS location (the widget's "Share my
// location" button - see chat-widget.js) — most useful mid-way through the
// ambulance/emergency flow, but works standalone too (e.g. "which branch is
// closest to me"). Stored the same shape as every other location message
// (see extractIncoming in webhook.js and the dashboard's own location send
// in api.js) so it renders identically everywhere.
router.post('/location', requireAuth, asyncHandler(async (req, res) => {
  const { chatId, latitude, longitude } = req.body || {};
  if (!chatId || typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.status(400).json({ error: 'chatId, latitude, and longitude (numbers) are required' });
  }

  const conversation = await loadOwnedChat(chatId, req.patient.id);
  if (!conversation) return res.status(404).json({ error: 'Chat not found - start a new one first.' });

  const primaryLanguage = await getPrimaryLanguage();

  const saved = await addMessage(conversation.id, {
    direction: 'inbound',
    originalText: '[location]',
    translatedText: '[location]',
    detectedLanguage: conversation.customerLanguage || 'n/a',
    targetLanguage: primaryLanguage,
    messageType: 'location',
    extra: JSON.stringify({ latitude, longitude }),
  });

  if (!conversation.muted) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { unreadCount: { increment: 1 } } });
  }

  await runAutoReply(conversation, primaryLanguage, conversation.customerLanguage || 'en');

  res.json({ message: saved });
}));

// The widget polls this to render one chat's full thread, including the
// agent's/bot's replies (translated back into the patient's own language).
router.get('/messages', requireAuth, asyncHandler(async (req, res) => {
  const { chatId } = req.query;
  if (!chatId) return res.status(400).json({ error: 'chatId is required' });

  const conversation = await loadOwnedChat(chatId, req.patient.id);
  if (!conversation) return res.status(404).json({ error: 'Chat not found' });

  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'asc' },
  });
  // Polled every 4s by the widget - see toPublicMessage in conversations.js
  // for why this can't ship raw base64 media on every poll.
  //
  // linkedWhatsapp is included so the widget can keep its "Linked!" banner
  // in sync with the CURRENT chat on every poll, instead of just flipping
  // it on once client-side at the moment of linking and never touching it
  // again (see also the businessNumber check in link-whatsapp below for why
  // we don't compute a waLink here too - only bother once
  // WHATSAPP_BUSINESS_DISPLAY_NUMBER is actually configured).
  const businessNumber = process.env.WHATSAPP_BUSINESS_DISPLAY_NUMBER;
  res.json({
    messages: toPublicMessages(messages),
    linkedWhatsapp: conversation.linkedWhatsapp || null,
    waLink: conversation.linkedWhatsapp && businessNumber ? `https://wa.me/${businessNumber}` : null,
  });
}));

// "Continue on WhatsApp": the patient types their own WhatsApp number into
// the widget. We link it to the CURRENT chat right away, so when they
// message the business's WhatsApp number, webhook.js recognizes the number
// and merges it into this SAME chat instead of starting a new one. Returns
// the business's WhatsApp number so the widget can build a wa.me deep link.
router.post('/link-whatsapp', requireAuth, asyncHandler(async (req, res) => {
  const { chatId, phone } = req.body || {};
  if (!chatId || !phone) return res.status(400).json({ error: 'chatId and phone are required' });

  const businessNumber = process.env.WHATSAPP_BUSINESS_DISPLAY_NUMBER;
  if (!businessNumber) {
    return res.status(503).json({ error: 'WhatsApp bridging is not configured on this server yet' });
  }

  const conversation = await loadOwnedChat(chatId, req.patient.id);
  if (!conversation) return res.status(404).json({ error: 'Chat not found - start a new one first.' });

  const normalized = normalizePhone(phone);

  // A phone number can only be linked to one chat at a time - drop any
  // stale link from a previous chat (this patient's own older chat, or
  // someone else's) using the same number.
  await prisma.conversation.updateMany({
    where: { linkedWhatsapp: normalized, NOT: { id: conversation.id } },
    data: { linkedWhatsapp: null },
  });

  // NOTE: we deliberately do NOT touch botEnabled here - the bot keeps
  // answering wherever the patient actually messages from (see runAutoReply
  // in src/autoReply.js, and its WhatsApp-delivery branch for linkedWhatsapp
  // chats); staff can still silence it manually via PATCH
  // /api/conversations/:id if they take over by hand.
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { linkedWhatsapp: normalized },
  });

  res.json({ linked: true, businessNumber, waLink: `https://wa.me/${businessNumber}` });
}));

module.exports = router;
