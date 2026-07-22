const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

/**
 * Verifies the X-Hub-Signature-256 header Meta sends on every real webhook
 * call, using your App Secret. Rejects forged requests to /webhook and
 * /webhook/meta from anyone who isn't actually Meta.
 */
function verifyMetaSignature(req) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature || !req.rawBody || !process.env.META_APP_SECRET) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.META_APP_SECRET)
    .update(req.rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Simple shared-secret check for /api/* routes, so your dashboard/Android
 * app data isn't wide open to anyone who finds your server URL. Disabled
 * automatically if API_KEY is left at its placeholder value, for easy local
 * dev.
 */
function requireApiKey(req, res, next) {
  const key = process.env.API_KEY;
  if (!key || key === 'change_me') return next();
  if (req.header('x-api-key') !== key) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const apiRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { verifyMetaSignature, requireApiKey, apiRateLimiter };
