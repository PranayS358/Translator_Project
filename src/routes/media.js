// Serves stored message media (images/video/audio/documents) as an actual
// binary response instead of embedding base64 in JSON. See toPublicMessage
// in src/conversations.js for why: the dashboard and widget both poll their
// message-list endpoints every few seconds, and if the raw data URL were
// included in every poll response, a single photo would get re-transferred
// out of the database dozens of times a minute for as long as its
// conversation stayed open - which is what exhausted Neon's free-tier
// 5GB/month network transfer allowance in August 2026.
//
// Unauthenticated like /widget-api - message IDs are unguessable cuids, and
// a plain <img src="..."> / <a href="..." download> can't attach an
// x-api-key header anyway. The aggressive Cache-Control means a browser
// only ever fetches a given message's media once, no matter how many times
// its conversation gets polled afterward.
const express = require('express');
const router = express.Router();
const prisma = require('../db');
const asyncHandler = require('../asyncHandler');
const { parseDataUrl } = require('../whatsapp');

router.get('/:messageId', asyncHandler(async (req, res) => {
  const message = await prisma.message.findUnique({
    where: { id: req.params.messageId },
    select: { mediaUrl: true },
  });
  if (!message?.mediaUrl) return res.sendStatus(404);

  const { mimeType, buffer } = parseDataUrl(message.mediaUrl);
  res.set('Content-Type', mimeType);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(buffer);
}));

module.exports = router;
