const express = require('express');
const router = express.Router();
const prisma = require('../db');
const { translateText } = require('../translate');
const { getOrCreateConversation, addMessage } = require('../conversations');
const { verifyMetaSignature } = require('../security');

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'demo_verify_token';

router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Messenger/Instagram webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  console.warn('❌ Messenger/Instagram webhook verification failed (token mismatch)');
  return res.sendStatus(403);
});

router.post('/', async (req, res) => {
  res.sendStatus(200);

  if (process.env.META_APP_SECRET && !verifyMetaSignature(req)) {
    console.warn('⚠️  Rejected Messenger/Instagram webhook call with invalid signature');
    return;
  }

  // Meta tells us which platform this payload is from via req.body.object:
  // "page" = Facebook Messenger, "instagram" = Instagram Messaging
  const channel = req.body.object === 'instagram' ? 'instagram' : 'messenger';

  try {
    const entries = req.body.entry || [];

    for (const entry of entries) {
      const messagingEvent = entry.messaging?.[0];
      const senderId = messagingEvent?.sender?.id;
      const text = messagingEvent?.message?.text;

      if (!senderId || !text) continue; // skip read receipts, postbacks, etc. in this demo

      const settings = await prisma.settings.upsert({
        where: { id: 1 }, update: {}, create: { id: 1 },
      });
      const primaryLanguage = settings.primaryLanguage;

      const { translatedText, detectedLanguage } = await translateText(text, primaryLanguage);

      const conversation = await getOrCreateConversation(channel, senderId, null);

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

      console.log(`📩 [${channel}] [${detectedLanguage} → ${primaryLanguage}] ${senderId}: "${text}" → "${translatedText}"`);
    }
  } catch (err) {
    console.error('Messenger/Instagram webhook processing error:', err.message);
  }
});

module.exports = router;
