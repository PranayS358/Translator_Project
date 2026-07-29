// Real language detection (via franc) for the webchat widget - replaces
// asking the visitor to manually pick a language. franc is ESM-only, so it's
// loaded with a dynamic import() and cached; that works fine from this
// CommonJS module since dynamic import() is allowed inside require()'d files.
let francPromise;
function getFranc() {
  if (!francPromise) francPromise = import('franc').then((m) => m.franc);
  return francPromise;
}

// Maps our app's 2-letter codes (used everywhere else - MyMemory langpairs,
// the widget's language picker, Settings' primaryLanguage, etc.) to the
// ISO 639-3 codes franc actually detects.
const TO_ISO3 = {
  en: 'eng', ar: 'arb', hi: 'hin', es: 'spa', fr: 'fra', de: 'deu',
  pt: 'por', ru: 'rus', zh: 'cmn', ja: 'jpn', ko: 'kor', tr: 'tur',
  ur: 'urd', bn: 'ben', id: 'ind',
};
// Restricting franc to exactly these candidates (via its `only` option)
// dramatically improves accuracy on the short messages a chat widget
// actually sees, versus guessing freely across all ~180 languages it knows.
const ONLY = Object.values(TO_ISO3);
const FROM_ISO3 = Object.fromEntries(Object.entries(TO_ISO3).map(([two, three]) => [three, two]));
// A couple of alternate/macrolanguage codes franc can return for the same
// languages, mapped to the same 2-letter code as a safety net.
FROM_ISO3.zho = 'zh';
FROM_ISO3.ara = 'ar';

/**
 * Detects which of our 15 supported languages a piece of text is written
 * in. Falls back (rather than guessing wildly) when the text is too short
 * or franc can't confidently place it in the restricted candidate set.
 */
async function detectLanguage(text, fallback) {
  const trimmed = (text || '').trim();
  if (trimmed.length < 3) return fallback || 'en';

  const franc = await getFranc();
  const code3 = franc(trimmed, { only: ONLY });
  if (code3 === 'und') return fallback || 'en';
  return FROM_ISO3[code3] || fallback || 'en';
}

module.exports = { detectLanguage };
