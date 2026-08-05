require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');

const whatsappWebhook = require('./src/routes/webhook');
const metaWebhook = require('./src/routes/meta-webhook');
const apiRouter = require('./src/routes/api');
const widgetApiRouter = require('./src/routes/widget');
const { requireApiKey, apiRateLimiter } = require('./src/security');

const app = express();

// Trust the first hop proxy (ngrok locally, Render/Railway/etc. in production)
// so express-rate-limit reads the real client IP from X-Forwarded-For instead
// of throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);

// crossOriginResourcePolicy defaults to "same-origin", which silently blocks
// the embeddable widget script (public/widget-embed/chat-widget.js) and the
// /widget-api/* responses from ever loading on a client's own site (Netlify,
// Myntra, Amazon, whoever) - the whole point of this widget is to be fetched
// cross-origin, so that policy has to be relaxed.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// Parse JSON but also keep the raw bytes around - required for verifying
// Meta's X-Hub-Signature-256 header on webhook calls.
app.use(express.json({
  limit: '20mb', // raised from the default 100kb so base64 image/audio/video
                 // attachments from the dashboard's attach/camera/mic buttons fit
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

// Public embeddable chat widget API (no API key - see src/routes/widget.js
// for why). Rate-limited the same as everything else to curb abuse.
app.use('/widget-api', apiRateLimiter, widgetApiRouter);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Catch-all error handler. Every async route handler is wrapped in
// asyncHandler (see src/asyncHandler.js), which forwards rejected promises
// here via next(err) instead of letting them crash the process. This is
// what actually stops a transient failure (e.g. Neon's free-tier Postgres
// waking up from suspend) from taking down the whole site for every visitor.
app.use((err, req, res, next) => {
  console.error('Unhandled request error:', err);
  if (res.headersSent) return next(err);
  const dbUnreachable = err?.name === 'PrismaClientInitializationError'
    || /Can't reach database server/i.test(err?.message || '');
  res.status(dbUnreachable ? 503 : 500).json({
    error: dbUnreachable
      ? 'Database is temporarily unreachable — please try again in a few seconds.'
      : 'Something went wrong on the server.',
  });
});

// Last-resort safety net. asyncHandler + the error middleware above should
// catch everything that happens inside a request, but this guarantees that
// even a bug we didn't anticipate logs and keeps the process alive instead
// of exiting (which is what turned one flaky DB call into a full 502 outage
// on 2026-08-05 — see the git history of src/asyncHandler.js).
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (process kept alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (process kept alive):', err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n===========================================================');
  console.log(`🚀  Translator running at http://localhost:${PORT}`);
  console.log(`📡  WhatsApp webhook:              http://localhost:${PORT}/webhook`);
  console.log(`📡  Messenger/Instagram webhook:   http://localhost:${PORT}/webhook/meta`);
  console.log(`💬  Widget script:                 http://localhost:${PORT}/widget-embed/chat-widget.js`);
  console.log('===========================================================\n');
});
