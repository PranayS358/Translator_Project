const { parsePhoneNumberFromString } = require('libphonenumber-js');

/**
 * Normalizes any phone number format (with/without +, spaces, dashes,
 * different country-code styles) to a single canonical E.164 string, e.g.
 * "+917719956774". Used as the conversation grouping key so "917719956774",
 * "+91 77199 56774", and "0091-7719956774" all map to the SAME conversation
 * instead of creating duplicate threads.
 */
function normalizePhone(raw) {
  if (!raw) return raw;
  const withPlus = String(raw).trim().startsWith('+') ? String(raw).trim() : `+${String(raw).trim()}`;
  const parsed = parsePhoneNumberFromString(withPlus);
  return parsed ? parsed.number : withPlus;
}

module.exports = { normalizePhone };
