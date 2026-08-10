// Public, unauthenticated API for the embeddable website chat widget
// (public/widget-embed/chat-widget.js). Deliberately separate from the
// x-api-key-protected /api router below, since real website visitors on a
// client's site (e.g. the demo healthcare site) have no way to hold that key.
// CORS is wide open here on purpose - this router only ever handles a
// visitor's own chat messages, nothing sensitive, and it needs to work from
// any client site it's embedded on, not just this same origin.
const express = require('express');
const router = express.Router();
const prisma = require('../db');
const { translateBetween, detectAndTranslate } = require('../translate');
const { normalizePhone } = require('../phone');
const { getOrCreateConversation, addMessage, toPublicMessages } = require('../conversations');
const { getAutoReply, nearestBranch } = require('../groq');
const asyncHandler = require('../asyncHandler');

router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

async function getPrimaryLanguage() {
  const settings = await prisma.settings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  return settings.primaryLanguage;
}

// Turns a stored message into one line of context for the bot. Plain
// placeholders like "[image]" carry no useful text, but a shared location
// is exactly the thing the ambulance flow AND the nearest-branch finder
// (src/groq.js) need to see and react to - so unlike other placeholders,
// describe it with an actual coordinate/maps link (and the nearest branch,
// computed here rather than left for the model to guess at) instead of
// dropping it from history entirely.
function describeForBot(message) {
  if (message.messageType === 'location') {
    let coords = {};
    try { coords = JSON.parse(message.extra || '{}'); } catch (err) { /* ignore */ }
    if (coords.latitude != null && coords.longitude != null) {
      const mapsUrl = `https://www.google.com/maps?q=${coords.latitude},${coords.longitude}`;
      const branch = nearestBranch(coords.latitude, coords.longitude);
      const branchNote = branch
        ? ` Nearest branch: ${branch.name}, ${branch.address} (~${branch.distanceKm} km away).`
        : '';
      return `[Patient shared their location: ${mapsUrl}.${branchNote}]`;
    }
  }
  const text = message.direction === 'inbound' ? (message.translatedText || message.originalText) : message.originalText;
  if (text && /^\[[a-z]+\]$/i.test(text)) return null; // other placeholders (e.g. "[image]") - nothing useful to hand the bot
  return text;
}

// Shared by POST /message and POST /location - runs the Groq auto-reply
// (src/groq.js) against a conversation's recent history and, if it produces
// a reply, translates and saves it. Also flips conversation.urgent on when
// the bot signals an active ambulance/emergency exchange (see the
// [[URGENT]] marker in groq.js's systemPrompt), so agents can spot it in
// the dashboard sidebar without relying on the regular unread badge alone.
async function runAutoReply(conversation, primaryLanguage, customerLanguage) {
  if (conversation.muted || !conversation.botEnabled) return;
  try {
    const recent = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    const history = recent
      .reverse()
      .map((m) => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: describeForBot(m) }))
      .filter((m) => m.content);

    const auto = await getAutoReply(history);
    if (!auto || auto.escalate || !auto.reply) return;

    const { translatedText: botReplyTranslated } = await translateBetween(auto.reply, primaryLanguage, customerLanguage);
    await addMessage(conversation.id, {
      direction: 'outbound',
      originalText: auto.reply,
      detectedLanguage: 'bot',
      translatedText: botReplyTranslated,
      targetLanguage: customerLanguage,
    });

    if (auto.urgent) {
      await prisma.conversation.update({ where: { id: conversation.id }, data: { urgent: true } });
    }

    // The bot only ever tells the PATIENT their request is "noted, front
    // desk will confirm" (see the booking rules in groq.js) - but we still
    // track it as a real Appointment row internally so src/reminders.js has
    // something concrete to send 24h/1h reminders and a post-visit
    // follow-up against.
    if (auto.appointment) {
      await prisma.appointment.create({
        data: {
          conversationId: conversation.id,
          department: auto.appointment.department,
          doctorName: auto.appointment.doctor,
          scheduledAt: auto.appointment.scheduledAt,
        },
      });
    }

    // Same pattern as auto.appointment above, but for a standalone
    // diagnostic test booking (see the [[TESTBOOK|...]] marker and test
    // booking flow in groq.js) - gives src/reminders.js a TestBooking row
    // to send 24h/1h reminders against.
    if (auto.testBooking) {
      await prisma.testBooking.create({
        data: {
          conversationId: conversation.id,
          department: auto.testBooking.department,
          testName: auto.testBooking.test,
          fee: auto.testBooking.fee,
          scheduledAt: auto.testBooking.scheduledAt,
        },
      });
    }
  } catch (err) {
    console.error('Auto-reply (Groq) failed, leaving for a human:', err.message);
  }
}

// A visitor sends a message from the widget. Figures out (or reuses) the
// conversation's locked-in language, creates the webchat conversation on
// first contact, translates into the site's configured primary language,
// and returns the saved (translated) message.
//
// Language handling, in priority order:
//   1. An explicit `language` in the request - only sent when the visitor
//      manually changes language via the widget's "change language" button.
//      Always wins and overwrites the locked-in language from here on.
//   2. The conversation's already-locked `customerLanguage`, if this isn't
//      the first message - keeps the WHOLE conversation in one language
//      instead of re-detecting (and potentially flip-flopping on) every
//      message.
//   3. Auto-detected from the text itself - only happens once, on the very
//      first message of a brand new conversation. Prefers Google's own
//      auto-detect (via detectAndTranslate in src/translate.js) since that's
//      what actually recognizes Hinglish and other script-ambiguous text;
//      falls back to franc when Google isn't configured.
router.post('/message', asyncHandler(async (req, res) => {
  const { visitorId, text, language } = req.body;
  if (!visitorId || !text || !text.trim()) {
    return res.status(400).json({ error: 'visitorId and text are required' });
  }

  const primaryLanguage = await getPrimaryLanguage();

  let conversation = await prisma.conversation.findUnique({
    where: { channel_contactKey: { channel: 'webchat', contactKey: visitorId } },
  });

  let customerLanguage;
  let translatedText;

  if (language) {
    customerLanguage = language;
    ({ translatedText } = await translateBetween(text, customerLanguage, primaryLanguage));
  } else if (conversation?.customerLanguage) {
    customerLanguage = conversation.customerLanguage;
    ({ translatedText } = await translateBetween(text, customerLanguage, primaryLanguage));
  } else {
    ({ translatedText, detectedLanguage: customerLanguage } = await detectAndTranslate(text, primaryLanguage));
  }

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { channel: 'webchat', contactKey: visitorId, customerLanguage },
    });
  } else if (conversation.customerLanguage !== customerLanguage) {
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

  // Instant auto-reply via Groq (see src/groq.js and runAutoReply above) —
  // no-ops silently if GROQ_API_KEY isn't set, if a human has already taken
  // over this conversation (botEnabled === false), or if Groq itself
  // decides the question needs a human. Runs in the same request as the
  // visitor's message so the reply is already saved by the time the
  // widget's next poll (~4s) comes around.
  await runAutoReply(conversation, primaryLanguage, customerLanguage);

  res.json({ message: saved, detectedLanguage: customerLanguage });
}));

// A visitor shares their current GPS location (the widget's "Share my
// location" button - see chat-widget.js) — most useful mid-way through the
// ambulance/emergency flow, but works standalone too (e.g. "which branch is
// closest to me"). Stored the same shape as every other location message
// (see extractIncoming in webhook.js and the dashboard's own location send
// in api.js) so it renders identically everywhere.
router.post('/location', asyncHandler(async (req, res) => {
  const { visitorId, latitude, longitude } = req.body;
  if (!visitorId || typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.status(400).json({ error: 'visitorId, latitude, and longitude (numbers) are required' });
  }

  const primaryLanguage = await getPrimaryLanguage();
  const conversation = await getOrCreateConversation('webchat', visitorId, null);

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

// The widget polls this to render the full thread, including the agent's
// replies (translated back into the visitor's own language when they were
// sent from the dashboard).
router.get('/messages', asyncHandler(async (req, res) => {
  const { visitorId } = req.query;
  if (!visitorId) return res.status(400).json({ error: 'visitorId is required' });

  const conversation = await prisma.conversation.findUnique({
    where: { channel_contactKey: { channel: 'webchat', contactKey: visitorId } },
  });
  if (!conversation) return res.json({ messages: [], linkedWhatsapp: null });

  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'asc' },
  });
  // Polled every 4s by the widget - see toPublicMessage in conversations.js
  // for why this can't ship raw base64 media on every poll.
  //
  // linkedWhatsapp is included so the widget can keep its "Linked!" banner
  // in sync with the CURRENT conversation row on every poll, instead of
  // just flipping it on once client-side at the moment of linking and
  // never touching it again. That one-time flag used to go stale and lie:
  // if this conversation got deleted (see DELETE /api/conversations/:id)
  // and the visitor then sent a new message in the same still-open browser
  // tab, getOrCreateConversation() creates a brand new row under the same
  // visitorId - unlinked - but the widget kept showing "Linked!" from the
  // old, now-gone conversation, since nothing ever told it otherwise. A
  // patient's WhatsApp replies would then silently land nowhere the widget
  // could show them (see also the businessNumber check in link-whatsapp
  // below for why we don't compute a waLink here too - only bother once
  // WHATSAPP_BUSINESS_DISPLAY_NUMBER is actually configured).
  const businessNumber = process.env.WHATSAPP_BUSINESS_DISPLAY_NUMBER;
  res.json({
    messages: toPublicMessages(messages),
    linkedWhatsapp: conversation.linkedWhatsapp || null,
    waLink: conversation.linkedWhatsapp && businessNumber ? `https://wa.me/${businessNumber}` : null,
  });
}));

// "Continue on WhatsApp": the visitor types their own WhatsApp number into
// the widget. We link it to their existing webchat conversation right away,
// so when they message the business's WhatsApp number, webhook.js recognizes
// the number and merges it into this SAME conversation instead of starting
// a new one. Returns the business's WhatsApp number so the widget can build
// a wa.me deep link.
router.post('/link-whatsapp', asyncHandler(async (req, res) => {
  const { visitorId, phone } = req.body;
  if (!visitorId || !phone) return res.status(400).json({ error: 'visitorId and phone are required' });

  const businessNumber = process.env.WHATSAPP_BUSINESS_DISPLAY_NUMBER;
  if (!businessNumber) {
    return res.status(503).json({ error: 'WhatsApp bridging is not configured on this server yet' });
  }

  const conversation = await getOrCreateConversation('webchat', visitorId, null);
  const normalized = normalizePhone(phone);

  // A phone number can only be linked to one conversation at a time - drop
  // any stale link from a previous visitor session using the same number.
  await prisma.conversation.updateMany({
    where: { linkedWhatsapp: normalized, NOT: { id: conversation.id } },
    data: { linkedWhatsapp: null },
  });

  // botEnabled: false — once a patient asks to continue on their own
  // WhatsApp, treat that the same as a human agent stepping in (see
  // runAutoReply()'s botEnabled check in this file): the bot stops
  // auto-replying to any further messages on this conversation, on EITHER
  // channel, from here on. Reasoning: "continue on WhatsApp" is a deliberate
  // request to move to a real, personal channel for the rest of the
  // conversation, not a request for the same bot to keep answering there -
  // staff can always flip it back on via PATCH /api/conversations/:id like
  // any other conversation.
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { linkedWhatsapp: normalized, botEnabled: false },
  });

  res.json({ linked: true, businessNumber, waLink: `https://wa.me/${businessNumber}` });
}));

module.exports = router;
