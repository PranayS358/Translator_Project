const { parsePhoneNumberFromString } = require('libphonenumber-js');

// Fallback country for numbers typed without a country code (e.g. a widget
// visitor entering "7719956774" instead of "917719956774"). Configurable
// since this project's actual users are India-based, but a different
// deployment could set this to whatever market it serves.
const DEFAULT_COUNTRY = process.env.DEFAULT_PHONE_COUNTRY || 'IN';

/**
 * Normalizes any phone number format (with/without +, spaces, dashes,
 * different country-code styles) to a single canonical E.164 string, e.g.
 * "+917719956774". Used as the conversation grouping key so "917719956774",
 * "+91 77199 56774", and "0091-7719956774" all map to the SAME conversation
 * instead of creating duplicate threads.
 */
function normalizePhone(raw) {
  if (!raw) return raw;
  const trimmed = String(raw).trim();

  if (trimmed.startsWith('+')) {
    const parsed = parsePhoneNumberFromString(trimmed);
    return parsed ? parsed.number : trimmed;
  }

  // No leading "+" - this is very likely a national-format number (someone
  // typed their own number without a country code), NOT an international
  // number missing its "+". Blindly prepending "+" here was the bug: for
  // "7719956774" it produced "+7719956774", which libphonenumber-js reads
  // as country code 7 (Russia) plus a mangled number, instead of the
  // intended Indian number. Parsing as a national number in DEFAULT_COUNTRY
  // first gets this right; only fall back to the naive "+"-prepend
  // behavior if that doesn't produce a valid number (e.g. the digits
  // already include a different country's calling code without a "+").
  const asNational = parsePhoneNumberFromString(trimmed, DEFAULT_COUNTRY);
  if (asNational && asNational.isValid()) return asNational.number;

  const withPlus = `+${trimmed}`;
  const parsed = parsePhoneNumberFromString(withPlus);
  return parsed ? parsed.number : withPlus;
}

module.exports = { normalizePhone };
