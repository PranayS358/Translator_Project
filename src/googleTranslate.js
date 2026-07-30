const axios = require('axios');

const ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';

// Thin wrapper around Google Cloud Translation API v2 (REST, API-key auth -
// simpler than v3's service-account auth for a project this size). Used as
// the primary translation engine everywhere in src/translate.js when
// GOOGLE_TRANSLATE_API_KEY is set; every call there falls back to the free
// MyMemory API automatically if the key is missing or a call fails.
//
// Why bother: Google's neural model is dramatically better than MyMemory
// across the board, and - unlike MyMemory - can actually make sense of
// Hinglish (Hindi written in Latin script, e.g. "mujhe appointment book
// karna hai"), since it's been trained on huge volumes of real code-mixed
// chat text. MyMemory just echoes such text back unchanged or mangles it.
//
// sourceLang is optional. Omit it to let Google auto-detect the source
// language itself (returned as detectedSourceLanguage) - for exactly the
// script-ambiguous cases (Hinglish, short messages, etc.) this is far more
// reliable than our own franc-based detection in src/langDetect.js.
async function googleTranslate(text, targetLang, sourceLang) {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!key) return null;

  const body = { q: text, target: targetLang, format: 'text' };
  if (sourceLang) body.source = sourceLang;

  const res = await axios.post(`${ENDPOINT}?key=${key}`, body);
  const result = res.data?.data?.translations?.[0];
  if (!result?.translatedText) return null;

  // Google returns plain ISO 639-1 codes (en, hi, ar, ...) - same scheme
  // this app already uses everywhere, so no remapping needed like franc's
  // ISO 639-3 codes required. Strip any region subtag (e.g. "zh-CN") just
  // in case, and normalize casing.
  const detected = result.detectedSourceLanguage
    ? result.detectedSourceLanguage.split('-')[0].toLowerCase()
    : sourceLang || null;

  return { translatedText: result.translatedText, detectedLanguage: detected };
}

module.exports = { googleTranslate };
