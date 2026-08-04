const express = require('express');
const router = express.Router();
const prisma = require('../db');
const { translateText, translateBetween } = require('../translate');
const { normalizePhone } = require('../phone');
const { getOrCreateConversation, addMessage } = require('../conversations');
const { verifyMetaSignature } = require('../security');
const { downloadWhatsAppMedia } = require('../whatsapp');

// Turns a raw WhatsApp webhook `message` object into the shape addMessage()
// expects, downloading the actual file for media types (the webhook payload
// only ever contains a media ID, never the bytes). Returns null for message
// types this demo doesn't support yet (stickers, reactions, interactive
// replies, ...) so the caller can skip them instead of crashing.
async function extractIncoming(message) {
  const type = message.type;

  if (type === 'text') {
    return { messageType: 'text', originalText: message.text?.body || '', mediaUrl: null, fileName: null, extra: null };
  }

  if (type === 'image' || type === 'video' || type === 'audio' || type === 'document') {
    const field = message[type] || {};
    const media = field.id ? await downloadWhatsAppMedia(field.id) : null;
    return {
      messageType: type,
      originalText: field.caption || `[${type}]`,
      mediaUrl: media?.dataUrl || null,
      fileName: field.filename || null,
      extra: null,
    };
  }

  if (type === 'location') {
    const loc = message.location || {};
    return {
      messageType: 'location',
      originalText: '[location]',
      mediaUrl: null,
      fileName: null,
      extra: JSON.stringify({ latitude: loc.latitude, longitude: loc.longitude }),
    };
  }

  if (type === 'contacts') {
    const c = message.contacts?.[0];
    return {
      messageType: 'contact',
      originalText: '[contact]',
      mediaUrl: null,
      fileName: null,
      extra: JSON.stringify({ name: c?.name?.formatted_name || '', phone: c?.phones?.[0]?.phone || '' }),
    };
  }

  return null;
}

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

    const content = await extractIncoming(message);
    if (!content) {
      console.log(`ℹ️  Received an unsupported WhatsApp message (type: ${message.type}) - skipped.`);
      return;
    }

    const contactKey = normalizePhone(message.from);
    const displayName = value?.contacts?.[0]?.profile?.name || null;

    const settings = await prisma.settings.upsert({
      where: { id: 1 }, update: {}, create: { id: 1 },
    });
    const primaryLanguage = settings.primaryLanguage;

    // If this number was linked from a webchat widget session ("Continue on
    // WhatsApp"), route the message into that SAME conversation instead of
    // creating a separate whatsapp-channel one - that's what makes the two
    // channels feel like one continuous thread to the customer.
    const linkedConversation = await prisma.conversation.findFirst({
      where: { linkedWhatsapp: contactKey },
    });

    // Media without a caption (originalText is just a "[image]"-style
    // placeholder) and location/contact shares have nothing meaningful to
    // translate - skip the API call and store the placeholder as-is. A
    // caption on an image/video/document, or plain text, still gets
    // translated exactly like before.
    const text = content.originalText;
    const hasRealText = text && !/^\[[a-z]+\]$/.test(text);

    let conversation, translatedText, detectedLanguage;

    if (linkedConversation) {
      conversation = linkedConversation;
      if (hasRealText) {
        const lastInbound = await prisma.message.findFirst({
          where: { conversationId: conversation.id, direction: 'inbound' },
          orderBy: { createdAt: 'desc' },
        });
        const sourceLang = lastInbound?.detectedLanguage && lastInbound.detectedLanguage !== 'unknown'
          ? lastInbound.detectedLanguage
          : 'en';
        ({ translatedText, detectedLanguage } = await translateBetween(text, sourceLang, primaryLanguage));
      } else {
        translatedText = text;
        detectedLanguage = 'n/a';
      }
    } else {
      conversation = await getOrCreateConversation('whatsapp', contactKey, displayName);
      if (hasRealText) {
        ({ translatedText, detectedLanguage } = await translateText(text, primaryLanguage));
      } else {
        translatedText = text;
        detectedLanguage = 'n/a';
      }
    }

    await addMessage(conversation.id, {
      direction: 'inbound',
      originalText: text,
      detectedLanguage,
      translatedText,
      targetLanguage: primaryLanguage,
      messageType: content.messageType,
      mediaUrl: content.mediaUrl,
      fileName: content.fileName,
      extra: content.extra,
    });

    if (!conversation.muted) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { unreadCount: { increment: 1 } },
      });
    }

    console.log(`📩 [whatsapp${linkedConversation ? '→webchat' : ''}] [${content.messageType}] [${detectedLanguage} → ${primaryLanguage}] ${contactKey}: "${text}" → "${translatedText}"`);
  } catch (err) {
    console.error('WhatsApp webhook processing error:', err.message);
  }
});

module.exports = router;
