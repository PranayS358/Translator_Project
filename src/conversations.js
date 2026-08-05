const prisma = require('./db');

/**
 * Finds the existing conversation for this channel+contact, or creates one.
 * Because contactKey is normalized (see phone.js) before this is called,
 * the same real-world contact always maps to the same conversation, no
 * matter how the number/ID was formatted on a given message.
 */
async function getOrCreateConversation(channel, contactKey, displayName) {
  return prisma.conversation.upsert({
    where: { channel_contactKey: { channel, contactKey } },
    update: displayName ? { displayName } : {},
    create: { channel, contactKey, displayName: displayName || null },
  });
}

async function addMessage(conversationId, data) {
  return prisma.message.create({
    data: { conversationId, ...data },
  });
}

// Replaces a stored media message's full base64 data URL with a lightweight
// `/media/:id` reference before it goes out over the wire. The dashboard and
// widget both poll their message-list endpoints every few seconds - if the
// raw base64 blob were included in every one of those polls, a single photo
// would get re-transferred out of the database dozens of times a minute for
// as long as its conversation stayed open. That's what actually exhausted
// Neon's free-tier 5GB/month network transfer allowance (see src/routes/
// media.js). The real bytes are only ever served, once, from that route,
// with caching headers that stop the browser from asking again.
function toPublicMessage(message) {
  if (!message?.mediaUrl?.startsWith('data:')) return message;
  return { ...message, mediaUrl: `/media/${message.id}` };
}

function toPublicMessages(messages) {
  return messages.map(toPublicMessage);
}

module.exports = { getOrCreateConversation, addMessage, toPublicMessage, toPublicMessages };
