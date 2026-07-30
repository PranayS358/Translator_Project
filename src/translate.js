const axios = require('axios');
const { googleTranslate } = require('./googleTranslate');

const MYMEMORY_ENDPOINT = 'https://api.mymemory.translated.net/get';

// Arabic script Unicode ranges (covers Arabic, plus Arabic Supplement/Extended-A,
// which also catches Persian/Urdu text written in Arabic script).
const ARABIC_PATTERN = /[؀-ۿݐ-ݿࢠ-ࣿ]/;

// MyMemory needs an explicit "source|target" pair — it doesn't auto-detect.
// This project only deals with Arabic <-> English, so a quick script check
// is all we need (and it's instant + free, no API call required).
function detectLanguage(text) {
  return ARABIC_PATTERN.test(text) ? 'ar' : 'en';
}

async function callMyMemory(text, source, target) {
  const res = await axios.get(MYMEMORY_ENDPOINT, {
    params: {
      q: text,
      langpair: `${source}|${target}`,
      // Optional: a valid email raises the free daily limit from 5,000 to
      // 50,000 characters. Leave MYMEMORY_EMAIL unset to skip this.
      de: process.env.MYMEMORY_EMAIL || undefined,
    },
  });

  const translated = res.data?.responseData?.translatedText;
  const status = res.data?.responseStatus;

  if (!translated || (status && Number(status) >= 400)) {
    throw new Error(res.data?.responseDetails || 'MyMemory returned no translation');
  }

  return translated;
}

async function translateText(text, targetLang) {
  if (!text || !text.trim()) {
    return { translatedText: '', detectedLanguage: 'unknown' };
  }

  const target = targetLang || 'en';
  const detected = detectLanguage(text);

  // Already in the target language — nothing to translate.
  if (detected === target) {
    return { translatedText: text, detectedLanguage: detected };
  }

  try {
    const translated = await callMyMemory(text, detected, target);
    return { translatedText: translated, detectedLanguage: detected };
  } catch (err) {
    console.error('Translation error:', err.response?.data || err.message);
    return { translatedText: text, detectedLanguage: detected, error: err.message };
  }
}

// Explicit source/target translation — used where the source language is
// already known (rather than guessed), e.g. a locked-in webchat conversation
// language. Tries Google Translate first (when GOOGLE_TRANSLATE_API_KEY is
// configured) since it's much higher quality across every language pair;
// falls back to the free MyMemory API otherwise or if Google errors out.
async function translateBetween(text, sourceLang, targetLang) {
  if (!text || !text.trim()) {
    return { translatedText: '', detectedLanguage: sourceLang || 'unknown' };
  }

  const source = sourceLang || 'en';
  const target = targetLang || 'en';

  if (source === target) {
    return { translatedText: text, detectedLanguage: source };
  }

  try {
    const google = await googleTranslate(text, target, source);
    if (google) return { translatedText: google.translatedText, detectedLanguage: source };
  } catch (err) {
    console.error('Google Translate error, falling back to MyMemory:', err.response?.data || err.message);
  }

  try {
    const translated = await callMyMemory(text, source, target);
    return { translatedText: translated, detectedLanguage: source };
  } catch (err) {
    console.error('Translation error:', err.response?.data || err.message);
    return { translatedText: text, detectedLanguage: source, error: err.message };
  }
}

// For the very first message of a new conversation, where the source
// language isn't known yet. Prefers Google's own auto-detect (omit
// `source` and it returns detectedSourceLanguage) - critically, this is
// what actually handles Hinglish and other script-ambiguous text, since
// our own franc-based detectLanguage() (src/langDetect.js) has no way to
// tell Romanized Hindi apart from plain English. Falls back to franc +
// MyMemory when Google isn't configured or errors out.
async function detectAndTranslate(text, targetLang) {
  if (!text || !text.trim()) {
    return { translatedText: '', detectedLanguage: 'unknown' };
  }
  const target = targetLang || 'en';

  try {
    const google = await googleTranslate(text, target);
    if (google?.detectedLanguage) {
      return { translatedText: google.translatedText, detectedLanguage: google.detectedLanguage };
    }
  } catch (err) {
    console.error('Google Translate error, falling back to franc + MyMemory:', err.response?.data || err.message);
  }

  const { detectLanguage } = require('./langDetect');
  const detected = await detectLanguage(text, 'en');
  const { translatedText } = await translateBetween(text, detected, target);
  return { translatedText, detectedLanguage: detected };
}

module.exports = { translateText, translateBetween, detectAndTranslate };
