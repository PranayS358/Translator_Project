const axios = require('axios');

const GRAPH_VERSION = 'v25.0';

async function sendWhatsAppMessage(to, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.warn('⚠️  WhatsApp credentials not configured — skipping outbound send.');
    return null;
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;

  try {
    const res = await axios.post(
      url,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return res.data;
  } catch (err) {
    console.error('Error sending WhatsApp message:', err.response?.data || err.message);
    return null;
  }
}

module.exports = { sendWhatsAppMessage };
