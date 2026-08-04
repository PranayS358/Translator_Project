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

// Converts a "data:<mime>;base64,<data>" string into a Buffer + mime type.
function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Expected a base64 data URL');
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

// Uploads a file to WhatsApp's media endpoint so it can be referenced by ID
// in a subsequent message send. Uses Node's built-in FormData/Blob (Node 18+).
async function uploadWhatsAppMedia(dataUrl, fileName) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    console.warn('⚠️  WhatsApp credentials not configured — skipping media upload.');
    return null;
  }

  const { mimeType, buffer } = parseDataUrl(dataUrl);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }), fileName || 'upload');

  try {
    const res = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/media`,
      form,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return { mediaId: res.data.id, mimeType };
  } catch (err) {
    console.error('Error uploading WhatsApp media:', err.response?.data || err.message);
    return null;
  }
}

// type: "image" | "video" | "document" | "audio"
async function sendWhatsAppMedia(to, mediaId, type, { caption, fileName } = {}) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return null;

  const mediaObject = { id: mediaId };
  if (caption && (type === 'image' || type === 'video' || type === 'document')) mediaObject.caption = caption;
  if (fileName && type === 'document') mediaObject.filename = fileName;

  try {
    const res = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to, type, [type]: mediaObject },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return res.data;
  } catch (err) {
    console.error('Error sending WhatsApp media message:', err.response?.data || err.message);
    return null;
  }
}

async function sendWhatsAppLocation(to, latitude, longitude) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return null;

  try {
    const res = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'location', location: { latitude, longitude } },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return res.data;
  } catch (err) {
    console.error('Error sending WhatsApp location:', err.response?.data || err.message);
    return null;
  }
}

async function sendWhatsAppContact(to, name, phone) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return null;

  try {
    const res = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'contacts',
        contacts: [{ name: { formatted_name: name, first_name: name }, phones: [{ phone }] }],
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return res.data;
  } catch (err) {
    console.error('Error sending WhatsApp contact:', err.response?.data || err.message);
    return null;
  }
}

// Downloads media a CUSTOMER sent us via WhatsApp (image/video/audio/
// document) - the inverse of uploadWhatsAppMedia. Meta's webhook payload
// only ever includes a media ID, never the file itself; getting the actual
// bytes takes two authenticated calls: resolve the ID to a short-lived CDN
// URL via GET /{media-id}, then fetch that URL with the same bearer token
// (it 401s without it). Returns a data URL so inbound media can be stored
// and rendered with the exact same code path the dashboard already uses
// for outbound media (see the "image"/"video"/etc. cases in app.js's
// renderBubbleContent and the widget's render()). Returns null on any
// failure (missing credentials, expired CDN URL, network error, etc.) so
// callers can fall back to a text-only placeholder instead of crashing.
async function downloadWhatsAppMedia(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token || !mediaId) return null;

  try {
    const meta = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { url, mime_type: mimeType } = meta.data;
    if (!url) return null;

    const file = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
    });
    const base64 = Buffer.from(file.data).toString('base64');
    return { dataUrl: `data:${mimeType};base64,${base64}`, mimeType };
  } catch (err) {
    console.error('Error downloading WhatsApp media:', err.response?.data || err.message);
    return null;
  }
}

module.exports = {
  sendWhatsAppMessage,
  uploadWhatsAppMedia,
  sendWhatsAppMedia,
  sendWhatsAppLocation,
  sendWhatsAppContact,
  downloadWhatsAppMedia,
  parseDataUrl,
};
