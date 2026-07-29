const axios = require('axios');

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
// already known (rather than guessed), e.g. a webchat visitor who picked
// their language from a dropdown. Skips the Arabic/English-only detector
// entirely, so it works correctly for any language pair MyMemory supports.
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
    const translated = await callMyMemory(text, source, target);
    return { translatedText: translated, detectedLanguage: source };
  } catch (err) {
    console.error('Translation error:', err.response?.data || err.message);
    return { translatedText: text, detectedLanguage: source, error: err.message };
  }
}

module.exports = { translateText, translateBetween };
