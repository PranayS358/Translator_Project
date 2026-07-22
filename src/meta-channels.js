const axios = require('axios');

const GRAPH_VERSION = 'v25.0';

async function sendMessengerMessage(recipientId, text) {
  const token = process.env.PAGE_ACCESS_TOKEN;
  if (!token) {
    console.warn('⚠️  PAGE_ACCESS_TOKEN not set — skipping Messenger send.');
    return null;
  }
  try {
    const res = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/me/messages?access_token=${token}`,
      { recipient: { id: recipientId }, message: { text } }
    );
    return res.data;
  } catch (err) {
    console.error('Error sending Messenger message:', err.response?.data || err.message);
    return null;
  }
}

async function sendInstagramMessage(recipientId, text) {
  const token = process.env.IG_PAGE_ACCESS_TOKEN || process.env.PAGE_ACCESS_TOKEN;
  if (!token) {
    console.warn('⚠️  IG_PAGE_ACCESS_TOKEN not set — skipping Instagram send.');
    return null;
  }
  try {
    const res = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/me/messages?access_token=${token}`,
      { recipient: { id: recipientId }, message: { text } }
    );
    return res.data;
  } catch (err) {
    console.error('Error sending Instagram message:', err.response?.data || err.message);
    return null;
  }
}

module.exports = { sendMessengerMessage, sendInstagramMessage };
