// Free instant auto-reply for the HC website chat widget, powered by Groq's
// OpenAI-compatible chat completions API (console.groq.com — free tier, no
// credit card). Scoped tightly to clinic logistics (hours, services,
// booking, location) via the system prompt below; anything it isn't
// confident answering from CLINIC_INFO — medical questions, a specific
// patient's records, complaints, anything ambiguous — it's instructed to
// escalate to a human instead of guessing.
const axios = require('axios');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

const DEFAULT_CLINIC_INFO = `Wellness Care Clinic is a general healthcare practice.
Hours: Monday-Saturday 9am-7pm, closed Sundays.
Services: general checkups, family medicine, vaccinations, lab tests, dental care.
Booking: patients can request an appointment right here in chat, or by calling the front desk.
Location/contact details: see the "Contact" page on the website.`;

function systemPrompt(clinicInfo) {
  return `You are a friendly front-desk assistant embedded in a healthcare clinic's website chat widget. You may ONLY answer general, non-medical logistics questions using the clinic information below.

Clinic information:
${clinicInfo}

Rules:
- Keep answers short (2-4 sentences), warm, and clear.
- Never give medical advice, diagnoses, medication guidance, or interpret symptoms.
- Never discuss or guess at a specific patient's medical records, history, or test results — you have no access to them.
- Never invent information that isn't in the clinic information above — this includes doctor/staff names, specialties, individual schedules, prices, and wait times. If the clinic information doesn't mention it, you don't know it.
- You cannot actually book, confirm, reschedule, or cancel an appointment yourself — you have no access to any booking system. Never say things like "I'll set it up for you" or "consider it booked". You may only tell the patient how to book (the methods listed in the clinic information above) and invite them to share their preferred time so a human can arrange it.
- If the question asks for something not covered by the clinic information above (e.g. which doctor/specialist is available, a specific price, real-time availability), or is a medical concern, a complaint, or a billing dispute, do NOT attempt to answer or work around it. Reply with EXACTLY this single token and nothing else: ESCALATE`;
}

/**
 * history: array of { role: 'user' | 'assistant', content } in chronological
 * order — 'user' is the patient's own messages (already in the clinic's
 * primary/staff language, matching how translateBetween is used elsewhere
 * in this codebase), 'assistant' is prior agent/bot replies.
 *
 * Returns:
 *   null                       - not configured, or the call failed; caller
 *                                 should leave the message for a human, same
 *                                 as if auto-reply didn't exist.
 *   { escalate: true }         - Groq decided a human should handle this.
 *   { escalate: false, reply } - safe to send `reply` straight to the patient.
 */
async function getAutoReply(history) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const clinicInfo = process.env.CLINIC_INFO || DEFAULT_CLINIC_INFO;
  const messages = [{ role: 'system', content: systemPrompt(clinicInfo) }, ...history];

  try {
    const res = await axios.post(
      GROQ_API_URL,
      { model: MODEL, messages, temperature: 0.3, max_tokens: 300 },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 15000 }
    );
    const reply = res.data?.choices?.[0]?.message?.content?.trim();
    if (!reply) return null;
    if (reply === 'ESCALATE' || reply.startsWith('ESCALATE')) return { escalate: true };
    return { escalate: false, reply };
  } catch (err) {
    console.error('Groq auto-reply error:', err.response?.data || err.message);
    return null;
  }
}

module.exports = { getAutoReply, DEFAULT_CLINIC_INFO };
