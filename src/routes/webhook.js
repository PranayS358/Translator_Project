const express = require('express');
const router = express.Router();
const prisma = require('../db');
const { translateText } = require('../translate');
const { normalizePhone } = require('../phone');
const { getOrCreateConversation, addMessage } = require('../conversations');
const { verifyMetaSignature } = require('../security');

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'demo_verify_token';

router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ WhatsApp webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  console.warn('❌ WhatsApp webhook verification failed (token mismatch)');
  return res.sendStatus(403);
});

router.post('/', async (req, res) => {
  res.sendStatus(200); // ack immediately, Meta requires this

  if (process.env.META_APP_SECRET && !verifyMetaSignature(req)) {
    console.warn('⚠️  Rejected WhatsApp webhook call with invalid signature');
    return;
  }

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      const status = value?.statuses?.[0];
      if (status) {
        const errInfo = status.errors?.[0];
        console.log(
          `📶 WhatsApp delivery status: id=${status.id} recipient=${status.recipient_id} status=${status.status}` +
          (errInfo ? ` ERROR code=${errInfo.code} title="${errInfo.title}" detail="${errInfo.error_data?.details || ''}"` : '')
        );
      }
      return; // delivery/read status update, not a new message
    }

    const text = message.text?.body;
    if (!text) {
      console.log(`ℹ️  Received a non-text WhatsApp message (type: ${message.type}) - skipped.`);
      return;
    }

    const contactKey = normalizePhone(message.from);
    const displayName = value?.contacts?.[0]?.profile?.name || null;

    const settings = await prisma.settings.upsert({
      where: { id: 1 }, update: {}, create: { id: 1 },
    });
    const primaryLanguage = settings.primaryLanguage;

    const { translatedText, detectedLanguage } = await translateText(text, primaryLanguage);

    const conversation = await getOrCreateConversation('whatsapp', contactKey, displayName);

    await addMessage(conversation.id, {
      direction: 'inbound',
      originalText: text,
      detectedLanguage,
      translatedText,
      targetLanguage: primaryLanguage,
    });

    if (!conversation.muted) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { unreadCount: { increment: 1 } },
      });
    }

    console.log(`📩 [whatsapp] [${detectedLanguage} → ${primaryLanguage}] ${contactKey}: "${text}" → "${translatedText}"`);
  } catch (err) {
    console.error('WhatsApp webhook processing error:', err.message);
  }
});

module.exports = router;
