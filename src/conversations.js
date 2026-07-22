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

module.exports = { getOrCreateConversation, addMessage };
