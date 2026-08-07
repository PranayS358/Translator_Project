// Free instant auto-reply for the HC website chat widget, powered by Groq's
// OpenAI-compatible chat completions API (console.groq.com — free tier, no
// credit card). Scoped tightly to clinic logistics (hours, services,
// booking, location) via the system prompt below; anything it isn't
// confident answering from CLINIC_INFO/the doctor directory — medical
// questions, a specific patient's records, complaints, anything ambiguous —
// it's instructed to escalate to a human instead of guessing.
//
// There's no real scheduling backend behind this demo, so "booking" here
// means: walk the patient through department -> doctor -> time slot using
// real (if fictional) names/slots we hand it below, then hand the collected
// request to a human to actually confirm — never claim to complete a
// booking itself (see the rules in systemPrompt()).
const axios = require('axios');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

const DEFAULT_CLINIC_INFO = `Wellness Care Clinic is a general healthcare practice.
Hours: Monday-Saturday 9am-7pm, closed Sundays.
Services: general checkups, family medicine, vaccinations, lab tests, dental care.
Booking: patients can request an appointment right here in chat, or by calling the front desk.
Location/contact details: see the "Contact" page on the website.`;

// Demo roster — override with a DOCTOR_ROSTER env var containing JSON in
// this same shape: { "Department": [{ "name": "...", "popular": true }] }.
// The first doctor marked popular:true in a department is who the bot
// recommends when a patient says they have no preference.
const DEFAULT_DOCTOR_ROSTER = {
  'General Checkups': [
    { name: 'Dr. Aisha Rahman', popular: true },
    { name: 'Dr. Vikram Shah' },
    { name: 'Dr. Leena Fernandes' },
  ],
  'Family Medicine': [
    { name: 'Dr. Rohan Mehta', popular: true },
    { name: 'Dr. Priya Nair' },
  ],
  'Vaccinations': [
    { name: 'Dr. Sana Iqbal', popular: true },
    { name: 'Dr. Karan Bhatt' },
  ],
  'Lab Tests': [
    { name: 'Dr. Farah Sheikh', popular: true },
    { name: 'Dr. Imran Qureshi' },
  ],
  'Dental Care': [
    { name: 'Dr. Neha Kapoor', popular: true },
    { name: 'Dr. Arjun Malhotra' },
    { name: 'Dr. Simran Kaur' },
  ],
};

function getDoctorRoster() {
  const raw = process.env.DOCTOR_ROSTER;
  if (!raw) return DEFAULT_DOCTOR_ROSTER;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('DOCTOR_ROSTER env var is not valid JSON, falling back to the demo roster:', err.message);
    return DEFAULT_DOCTOR_ROSTER;
  }
}

function formatRoster(roster) {
  return Object.entries(roster)
    .map(([dept, doctors]) => {
      const names = doctors.map((d) => `${d.name}${d.popular ? ' (most popular)' : ''}`).join(', ');
      return `- ${dept}: ${names}`;
    })
    .join('\n');
}

// No real calendar behind this demo — generate plausible near-term slots
// (next 4 open days, skipping Sundays per clinic hours) so the bot has
// real options to offer instead of inventing arbitrary ones.
function nextAvailableSlots(numDays = 4) {
  const timesPerDay = ['10:00 AM', '1:00 PM', '4:00 PM'];
  const days = [];
  const d = new Date();
  while (days.length < numDays) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0) {
      days.push(d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));
    }
  }
  return days.map((day) => `- ${day}: ${timesPerDay.join(', ')}`).join('\n');
}

function systemPrompt(clinicInfo) {
  const roster = getDoctorRoster();
  return `You are a friendly front-desk assistant embedded in a healthcare clinic's website chat widget. You may ONLY answer general, non-medical logistics questions using the information below.

Clinic information:
${clinicInfo}

Doctor directory (department -> doctors):
${formatRoster(roster)}

Upcoming available slots (offer these when a doctor has been chosen; if none suit the patient, ask for their preferred day/time instead):
${nextAvailableSlots()}

Appointment booking flow — when a patient wants to book an appointment, follow this exact sequence, one step per message (don't skip ahead or combine steps):
1. Ask which department/service they need, if they haven't said already.
2. Once they name a department, share 2-3 doctor names for that department from the directory above and ask them to pick one.
3. If they say they're unsure or have no preference, recommend the doctor marked "(most popular)" in that department and ask if that works for them.
4. Only after a doctor is chosen (by name, or by accepting your recommendation), offer 2-3 slot options for that department from "Upcoming available slots" above.
5. Once they pick a slot, do NOT say the appointment is booked or confirmed. Say you've noted their request (doctor, department, day/time) and that the front desk will confirm it shortly — matching the booking rule below.

Rules:
- Keep answers short (2-4 sentences), warm, and clear.
- Never give medical advice, diagnoses, medication guidance, or interpret symptoms.
- Never discuss or guess at a specific patient's medical records, history, or test results — you have no access to them.
- Only use doctor names, departments, and slots exactly as listed above — never invent a name, specialty, credential, price, or time slot that isn't listed.
- You cannot actually book, confirm, reschedule, or cancel an appointment yourself — you have no access to any booking system. Never say things like "I'll set it up for you" or "consider it booked". Once a slot request is noted (step 5 above), a human takes it from there.
- If the question asks for something not covered by the clinic information or doctor directory above (e.g. a department/specialty not listed, a specific price, real-time doctor availability beyond the slots above), or is a medical concern, a complaint, or a billing dispute, do NOT attempt to answer or work around it. Reply with EXACTLY this single token and nothing else: ESCALATE`;
}

/**
 * history: array of { role: 'user' | 'assistant', content } in chronological
 * order — 'user' is the patient's own messages (already in the clinic's
 * primary/staff language, matching how translateBetween is used elsewhere
 * in this codebase), 'assistant' is prior agent/bot replies. The booking
 * flow above relies entirely on this history for state (which step the
 * conversation is on) — there's no separate flow-state tracking in code.
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

module.exports = { getAutoReply, DEFAULT_CLINIC_INFO, DEFAULT_DOCTOR_ROSTER };
