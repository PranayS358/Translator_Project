const express = require('express');
const router = express.Router();
const prisma = require('../db');
const { translateText } = require('../translate');
const { sendWhatsAppMessage } = require('../whatsapp');
const { sendMessengerMessage, sendInstagramMessage } = require('../meta-channels');
const { normalizePhone } = require('../phone');
const { getOrCreateConversation, addMessage } = require('../conversations');
const { gregorianToHijri, hijriToGregorian, today } = require('../hijri');

// ── Conversations ────────────────────────────────────────────────────────

// List all conversations with a preview of the last message - powers the
// left-hand contact list in the UI.
router.get('/conversations', async (req, res) => {
  const conversations = await prisma.conversation.findMany({
    include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(conversations);
});

// Full message thread (both inbound and outbound, in order) for one
// conversation - this is what makes sending/receiving live on one page.
router.get('/conversations/:id/messages', async (req, res) => {
  const messages = await prisma.message.findMany({
    where: { conversationId: req.params.id },
    orderBy: { createdAt: 'asc' },
  });
  res.json(messages);
});

// Manually send a reply from the dashboard itself. Translates the agent's
// text (assumed written in the primary language) into whatever language the
// customer has been writing in, then sends it out on the right channel.
router.post('/conversations/:id/reply', async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  const lastInbound = await prisma.message.findFirst({
    where: { conversationId: conversation.id, direction: 'inbound' },
    orderBy: { createdAt: 'desc' },
  });
  const targetLang = lastInbound?.detectedLanguage && lastInbound.detectedLanguage !== 'unknown'
    ? lastInbound.detectedLanguage
    : 'en';

  const { translatedText } = await translateText(text, targetLang);

  let sendResult = null;
  if (conversation.channel === 'whatsapp') {
    sendResult = await sendWhatsAppMessage(conversation.contactKey.replace('+', ''), translatedText);
  } else if (conversation.channel === 'messenger') {
    sendResult = await sendMessengerMessage(conversation.contactKey, translatedText);
  } else if (conversation.channel === 'instagram') {
    sendResult = await sendInstagramMessage(conversation.contactKey, translatedText);
  }

  const saved = await addMessage(conversation.id, {
    direction: 'outbound',
    originalText: text,
    detectedLanguage: 'agent',
    translatedText,
    targetLanguage: targetLang,
  });

  res.json({ message: saved, sent: !!sendResult });
});

// Simulate an inbound message on any channel, for testing without a real
// WhatsApp/Messenger/Instagram account connected.
router.post('/simulate-message', async (req, res) => {
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

  res.json(saved);
});

// ── Settings (primary language + theme) ─────────────────────────────────

router.get('/settings', async (req, res) => {
  const settings = await prisma.settings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  res.json(settings);
});

router.post('/settings', async (req, res) => {
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
});

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
