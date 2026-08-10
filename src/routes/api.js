const express = require('express');
const router = express.Router();
const prisma = require('../db');
const { translateText, translateBetween } = require('../translate');
const {
  sendWhatsAppMessage,
  uploadWhatsAppMedia,
  sendWhatsAppMedia,
  sendWhatsAppLocation,
  sendWhatsAppContact,
} = require('../whatsapp');
const { sendMessengerMessage, sendInstagramMessage } = require('../meta-channels');
const { normalizePhone } = require('../phone');
const { getOrCreateConversation, addMessage, toPublicMessage, toPublicMessages } = require('../conversations');
const { gregorianToHijri, hijriToGregorian, today } = require('../hijri');
const asyncHandler = require('../asyncHandler');

function messageTypeFromMime(mimeType = '') {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

// ── Conversations ────────────────────────────────────────────────────────

// List all conversations with a preview of the last message - powers the
// left-hand contact list in the UI.
router.get('/conversations', asyncHandler(async (req, res) => {
  const conversations = await prisma.conversation.findMany({
    include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    orderBy: { createdAt: 'desc' },
  });
  // This list is polled every 5s regardless of which conversation (if any)
  // is open - the last-message preview only ever shows text, so there's no
  // reason to ship a full base64 media blob here every poll cycle.
  res.json(conversations.map((c) => ({ ...c, messages: toPublicMessages(c.messages) })));
}));

// Full message thread (both inbound and outbound, in order) for one
// conversation - this is what makes sending/receiving live on one page.
router.get('/conversations/:id/messages', asyncHandler(async (req, res) => {
  const messages = await prisma.message.findMany({
    where: { conversationId: req.params.id },
    orderBy: { createdAt: 'asc' },
  });
  res.json(toPublicMessages(messages));
}));

// Manually send a reply from the dashboard itself. Translates the agent's
// text (assumed written in the primary language) into whatever language the
// customer has been writing in, then sends it out on the right channel.
router.post('/conversations/:id/reply', asyncHandler(async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  // Webchat conversations lock in a single language for their whole
  // lifetime (see src/routes/widget.js) - prefer that over the per-message
  // heuristic below, so replies always land in the same language the
  // visitor has been consistently chatting in.
  let targetLang = conversation.customerLanguage;
  if (!targetLang) {
    const lastInbound = await prisma.message.findFirst({
      where: { conversationId: conversation.id, direction: 'inbound' },
      orderBy: { createdAt: 'desc' },
    });
    targetLang = lastInbound?.detectedLanguage && lastInbound.detectedLanguage !== 'unknown'
      ? lastInbound.detectedLanguage
      : 'en';
  }

  // The agent always writes in the dashboard's configured primary language,
  // not something we need to guess - translateText()'s auto-detect only
  // distinguishes Arabic vs. English, so it silently skipped translation
  // whenever the primary language was anything else (e.g. Hindi got
  // misread as English and passed through untranslated). Using the known
  // primary language as the explicit source fixes that for every language.
  const settings = await prisma.settings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  const { translatedText } = await translateBetween(text, settings.primaryLanguage, targetLang);

  let sendResult = null;
  if (conversation.channel === 'whatsapp') {
    sendResult = await sendWhatsAppMessage(conversation.contactKey.replace('+', ''), translatedText);
  } else if (conversation.channel === 'messenger') {
    sendResult = await sendMessengerMessage(conversation.contactKey, translatedText);
  } else if (conversation.channel === 'instagram') {
    sendResult = await sendInstagramMessage(conversation.contactKey, translatedText);
  } else if (conversation.channel === 'webchat') {
    // No external API call needed - the widget delivers this by polling
    // GET /widget-api/messages, so it always counts as "sent".
    sendResult = { delivered: 'widget' };
    // If the visitor also linked their own WhatsApp number ("Continue on
    // WhatsApp"), send it there too so the reply reaches them even if
    // they've closed the browser tab and moved to WhatsApp entirely.
    if (conversation.linkedWhatsapp) {
      await sendWhatsAppMessage(conversation.linkedWhatsapp.replace('+', ''), translatedText);
    }
  }

  const saved = await addMessage(conversation.id, {
    direction: 'outbound',
    originalText: text,
    detectedLanguage: 'agent',
    translatedText,
    targetLanguage: targetLang,
  });

  // A human just replied by hand — stop the Groq auto-reply bot (src/groq.js)
  // from answering this conversation's future messages until it's turned
  // back on, so it never talks over the agent who's now handling this chat.
  if (conversation.botEnabled) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { botEnabled: false } });
  }

  res.json({ message: saved, sent: !!sendResult });
}));

// Update conversation flags: favourite, muted, unreadCount (used for
// mute/favourite toggles and mark-as-read / mark-as-unread). Also used to
// flip botEnabled back on after a human has taken over a conversation, and
// to clear the urgent (ambulance/emergency) flag once staff have handled it.
router.patch('/conversations/:id', asyncHandler(async (req, res) => {
  const { favourite, muted, unreadCount, displayName, botEnabled, urgent } = req.body;
  const data = {};
  if (typeof favourite === 'boolean') data.favourite = favourite;
  if (typeof muted === 'boolean') data.muted = muted;
  if (typeof unreadCount === 'number') data.unreadCount = unreadCount;
  if (typeof botEnabled === 'boolean') data.botEnabled = botEnabled;
  if (typeof urgent === 'boolean') data.urgent = urgent;
  if (typeof displayName === 'string') {
    // Empty string clears the custom name, reverting the list to show the
    // raw contactKey (e.g. the webchat visitor id) again.
    data.displayName = displayName.trim() || null;
  }

  try {
    const conversation = await prisma.conversation.update({
      where: { id: req.params.id },
      data,
    });
    res.json(conversation);
  } catch (err) {
    res.status(404).json({ error: 'Conversation not found' });
  }
}));

// Clear chat — deletes every message in the conversation but keeps the
// conversation itself (so it stays in the sidebar, just empty).
router.delete('/conversations/:id/messages', asyncHandler(async (req, res) => {
  await prisma.message.deleteMany({ where: { conversationId: req.params.id } });
  res.json({ cleared: true });
}));

// Delete chat — removes the conversation (and everything that references
// it) from the list entirely. Messages, Appointment, and TestBooking rows
// all have an ON DELETE RESTRICT foreign key back to Conversation (see
// prisma/schema.prisma) - deliberately, so a stray reminder job can never
// silently lose its conversation - which means every one of them has to be
// cleared here first or conversation.delete() below throws a foreign key
// violation. That violation used to get caught and misreported as a plain
// 404 "Conversation not found", which is why deleting a chat that had a
// booked appointment/test attached silently failed no matter how many
// times you retried it - the conversation was never actually missing.
router.delete('/conversations/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  await Promise.all([
    prisma.message.deleteMany({ where: { conversationId: id } }),
    prisma.appointment.deleteMany({ where: { conversationId: id } }),
    prisma.testBooking.deleteMany({ where: { conversationId: id } }),
  ]);
  try {
    await prisma.conversation.delete({ where: { id } });
    res.json({ deleted: true });
  } catch (err) {
    console.error(`Failed to delete conversation ${id}:`, err.message);
    res.status(404).json({ error: 'Conversation not found' });
  }
}));

// Merge two conversations that turned out to be the same person split
// across two threads (e.g. a webchat visitor's "Continue on WhatsApp" link
// got lost and their next WhatsApp message created a brand new conversation
// instead of joining the existing one). Moves every message from the
// source conversation into the target, transfers the WhatsApp link if the
// target doesn't already have one, keeps the higher unread count, then
// deletes the now-empty source. Whichever conversation you call this on
// (:id) is the one that disappears; `targetId` is the one that survives.
router.post('/conversations/:id/merge', asyncHandler(async (req, res) => {
  const sourceId = req.params.id;
  const { targetId } = req.body;
  if (!targetId) return res.status(400).json({ error: 'targetId is required' });
  if (targetId === sourceId) return res.status(400).json({ error: 'Cannot merge a conversation into itself' });

  const [source, target] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: sourceId } }),
    prisma.conversation.findUnique({ where: { id: targetId } }),
  ]);
  if (!source || !target) return res.status(404).json({ error: 'Conversation not found' });

  // Move everything that references the source conversation over to the
  // target - not just messages. Appointment/TestBooking rows have an
  // ON DELETE RESTRICT foreign key back to Conversation (see
  // prisma/schema.prisma), so leaving them behind would both strand a
  // patient's booked appointment/test on a conversation that's about to
  // disappear (breaking their 24h/1h reminders) AND make the
  // conversation.delete() below fail with a constraint violation - the
  // same bug that used to make "Delete chat" silently fail.
  await Promise.all([
    prisma.message.updateMany({ where: { conversationId: sourceId }, data: { conversationId: targetId } }),
    prisma.appointment.updateMany({ where: { conversationId: sourceId }, data: { conversationId: targetId } }),
    prisma.testBooking.updateMany({ where: { conversationId: sourceId }, data: { conversationId: targetId } }),
  ]);

  const data = { unreadCount: Math.max(source.unreadCount, target.unreadCount) };
  if (!target.linkedWhatsapp && source.linkedWhatsapp) data.linkedWhatsapp = source.linkedWhatsapp;

  const merged = await prisma.conversation.update({ where: { id: targetId }, data });
  await prisma.conversation.delete({ where: { id: sourceId } });

  res.json({ merged: true, conversation: merged });
}));

// Send an image/video/document/audio attachment. Expects a base64 data URL
// from the browser's file picker, camera capture, or voice recorder.
router.post('/conversations/:id/media', asyncHandler(async (req, res) => {
  const { dataUrl, fileName, caption } = req.body;
  if (!dataUrl) return res.status(400).json({ error: 'dataUrl is required' });

  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  let sendResult = null;
  let mimeType = 'application/octet-stream';

  if (conversation.channel === 'whatsapp') {
    const uploaded = await uploadWhatsAppMedia(dataUrl, fileName);
    if (uploaded) {
      mimeType = uploaded.mimeType;
      const type = messageTypeFromMime(mimeType);
      sendResult = await sendWhatsAppMedia(
        conversation.contactKey.replace('+', ''),
        uploaded.mediaId,
        type,
        { caption, fileName }
      );
    }
  } else {
    // Messenger/Instagram attachment sends require a publicly hosted file
    // URL (their Send API doesn't accept raw base64/binary uploads like
    // WhatsApp does). Not wired up yet — the file is still saved below so
    // it shows correctly in your own dashboard thread.
    console.warn(`⚠️  Media send not implemented for channel "${conversation.channel}" yet — saved locally only.`);
    const match = /^data:([^;]+);/.exec(dataUrl);
    if (match) mimeType = match[1];
  }

  const messageType = messageTypeFromMime(mimeType);
  const saved = await addMessage(conversation.id, {
    direction: 'outbound',
    originalText: caption || `[${messageType}]`,
    translatedText: caption || `[${messageType}]`,
    detectedLanguage: 'agent',
    messageType,
    mediaUrl: dataUrl,
    fileName: fileName || null,
  });

  res.json({ message: toPublicMessage(saved), sent: !!sendResult });
}));

// Send a location pin.
router.post('/conversations/:id/location', asyncHandler(async (req, res) => {
  const { latitude, longitude } = req.body;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.status(400).json({ error: 'latitude and longitude (numbers) are required' });
  }

  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  let sendResult = null;
  if (conversation.channel === 'whatsapp') {
    sendResult = await sendWhatsAppLocation(conversation.contactKey.replace('+', ''), latitude, longitude);
  } else {
    console.warn(`⚠️  Location send not implemented for channel "${conversation.channel}" yet — saved locally only.`);
  }

  const saved = await addMessage(conversation.id, {
    direction: 'outbound',
    originalText: '[location]',
    translatedText: '[location]',
    detectedLanguage: 'agent',
    messageType: 'location',
    extra: JSON.stringify({ latitude, longitude }),
  });

  res.json({ message: saved, sent: !!sendResult });
}));

// Send a contact card.
router.post('/conversations/:id/contact', asyncHandler(async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'name and phone are required' });

  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  let sendResult = null;
  if (conversation.channel === 'whatsapp') {
    sendResult = await sendWhatsAppContact(conversation.contactKey.replace('+', ''), name, phone);
  } else {
    console.warn(`⚠️  Contact card send not implemented for channel "${conversation.channel}" yet — saved locally only.`);
  }

  const saved = await addMessage(conversation.id, {
    direction: 'outbound',
    originalText: `[contact] ${name} — ${phone}`,
    translatedText: `[contact] ${name} — ${phone}`,
    detectedLanguage: 'agent',
    messageType: 'contact',
    extra: JSON.stringify({ name, phone }),
  });

  res.json({ message: saved, sent: !!sendResult });
}));

// Simulate an inbound message on any channel, for testing without a real
// WhatsApp/Messenger/Instagram account connected.
router.post('/simulate-message', asyncHandler(async (req, res) => {
  const { from, text, channel } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

  const settings = await prisma.settings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  const primaryLanguage = settings.primaryLanguage;
  const { translatedText, detectedLanguage } = await translateText(text, primaryLanguage);

  const ch = channel || 'whatsapp';
  const contactKey = ch === 'whatsapp'
    ? normalizePhone(from || '10000000000')
    : (from?.trim() || 'simulated_user');

  const conversation = await getOrCreateConversation(ch, contactKey, null);
  const saved = await addMessage(conversation.id, {
    direction: 'inbound',
    originalText: text,
    detectedLanguage,
    translatedText,
    targetLanguage: primaryLanguage,
  });

  // New inbound message → bump the unread badge (unless the chat is muted).
  if (!conversation.muted) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { unreadCount: { increment: 1 } },
    });
  }

  res.json(saved);
}));

// ── Appointments (created by the Groq booking flow, see src/groq.js's
// [[APPT|...]] marker and runAutoReply() in widget.js) ──────────────────
// Read-only for now - src/reminders.js is what actually acts on these rows
// (24h/1h reminders, post-visit follow-up). No dashboard UI yet; this
// exists so staff/devs can see what the bot has queued up.
router.get('/appointments', asyncHandler(async (req, res) => {
  const appointments = await prisma.appointment.findMany({
    orderBy: { scheduledAt: 'asc' },
    include: { conversation: { select: { displayName: true, contactKey: true, channel: true } } },
  });
  res.json(appointments);
}));

// ── Test bookings (standalone diagnostic tests, created by the Groq booking
// flow, see src/groq.js's [[TESTBOOK|...]] marker and runAutoReply() in
// widget.js) ─────────────────────────────────────────────────────────────
// Read-only for now, same rationale as /appointments above.
router.get('/test-bookings', asyncHandler(async (req, res) => {
  const testBookings = await prisma.testBooking.findMany({
    orderBy: { scheduledAt: 'asc' },
    include: { conversation: { select: { displayName: true, contactKey: true, channel: true } } },
  });
  res.json(testBookings);
}));

// ── Settings (primary language + theme) ─────────────────────────────────

router.get('/settings', asyncHandler(async (req, res) => {
  const settings = await prisma.settings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  res.json(settings);
}));

router.post('/settings', asyncHandler(async (req, res) => {
  const { primaryLanguage, theme } = req.body;
  const data = {};
  if (primaryLanguage) data.primaryLanguage = primaryLanguage;
  if (theme) data.theme = theme;

  const settings = await prisma.settings.upsert({
    where: { id: 1 },
    update: data,
    create: { id: 1, ...data },
  });
  res.json(settings);
}));

// ── Hijri / Gregorian calendar (unchanged) ──────────────────────────────

router.get('/calendar/today', (req, res) => res.json(today()));

router.post('/calendar/to-hijri', (req, res) => {
  if (!req.body.date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
  res.json(gregorianToHijri(req.body.date));
});

router.post('/calendar/to-gregorian', (req, res) => {
  if (!req.body.date) return res.status(400).json({ error: 'date is required (iYYYY-iMM-iDD)' });
  res.json(hijriToGregorian(req.body.date));
});

module.exports = router;
