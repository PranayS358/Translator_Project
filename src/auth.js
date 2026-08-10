// Patient account auth for the embeddable webchat widget. Signing in is
// required before a patient can chat at all (see the requireAuth
// middleware below, used on every /widget-api route except /signup,
// /login, and OPTIONS preflight) - this is what makes "one account, many
// chats" possible: without a stable identity, there's nothing to hang
// multiple Conversation rows off of for the same real person.
//
// Tokens are plain JWTs (not server-side sessions) because the widget is
// embedded cross-origin on client sites (e.g. the healthcare demo) -
// cookies would need SameSite=None + Secure and still get blocked by a lot
// of browsers' third-party-cookie rules. A bearer token in localStorage,
// sent as "Authorization: Bearer <token>", works everywhere the widget is
// dropped in.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_insecure_secret_change_me_in_env';
const TOKEN_TTL = '30d';

if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET is not set - using an insecure default. Set JWT_SECRET in your .env for production.');
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signPatientToken(patient) {
  return jwt.sign(
    { sub: patient.id, email: patient.email, name: patient.name },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function verifyPatientToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return { id: payload.sub, email: payload.email, name: payload.name };
  } catch (err) {
    return null; // expired, tampered, or malformed - caller treats this as "not logged in"
  }
}

// Express middleware: requires a valid "Authorization: Bearer <token>"
// header, attaches the decoded identity to req.patient, or 401s. Every
// route this guards is a route that touches a specific patient's chat
// data, so req.patient.id doubles as the ownership check callers need to
// run against whatever conversation they're about to read or write.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const patient = token && verifyPatientToken(token);
  if (!patient) return res.status(401).json({ error: 'Please log in to continue.' });
  req.patient = patient;
  next();
}

module.exports = { hashPassword, verifyPassword, signPatientToken, verifyPatientToken, requireAuth };
