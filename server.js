require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');

const whatsappWebhook = require('./src/routes/webhook');
const metaWebhook = require('./src/routes/meta-webhook');
const apiRouter = require('./src/routes/api');
const { requireApiKey, apiRateLimiter } = require('./src/security');

const app = express();

// Trust the first hop proxy (ngrok locally, Render/Railway/etc. in production)
// so express-rate-limit reads the real client IP from X-Forwarded-For instead
// of throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));

// Parse JSON but also keep the raw bytes around - required for verifying
// Meta's X-Hub-Signature-256 header on webhook calls.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/webhook', whatsappWebhook);        // WhatsApp
app.use('/webhook/meta', metaWebhook);        // Facebook Messenger + Instagram (shared)

// Lets the same-origin dashboard (public/app.js) learn the current API key so
// it can attach it as x-api-key on every /api/* call below. Intentionally
// unauthenticated — it's same-origin only and the key itself is a light
// speed bump, not a secret boundary (see security.js).
app.get('/client-config', (req, res) => {
  const key = process.env.API_KEY;
  res.json({ apiKey: key && key !== 'change_me' ? key : null });
});

app.use('/api', apiRateLimiter, requireApiKey, apiRouter);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n===========================================================');
  console.log(`🚀  Translator running at http://localhost:${PORT}`);
  console.log(`📡  WhatsApp webhook:              http://localhost:${PORT}/webhook`);
  console.log(`📡  Messenger/Instagram webhook:   http://localhost:${PORT}/webhook/meta`);
  console.log('===========================================================\n');
});
