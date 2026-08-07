// Free instant auto-reply for the HC website chat widget, powered by Groq's
// OpenAI-compatible chat completions API (console.groq.com — free tier, no
// credit card). Scoped tightly to clinic logistics (hours, services,
// booking, location, symptom routing) via the system prompt below; anything
// it isn't confident answering from CLINIC_INFO/the doctor directory —
// medical questions, a specific patient's records, complaints, anything
// ambiguous — it's instructed to escalate to a human instead of guessing.
//
// There's no real scheduling backend behind this demo, so "booking" here
// means: walk the patient through department -> doctor -> time slot using
// real (if fictional) names/slots we hand it below, then hand the collected
// request to a human to actually confirm — never claim to complete a
// booking itself (see the rules in systemPrompt()). It DOES create a real
// Appointment row once a slot is picked (see the [[APPT|...]] marker below)
// so src/reminders.js has something concrete to send reminders/follow-ups
// against - the "never claim it's booked" rule is about what the bot tells
// the PATIENT, not about whether we track the request internally.
const axios = require('axios');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
// Told to patients as a backup during the ambulance flow below — a chatbot
// reply has real latency (LLM call + poll cycle), so it should never be the
// only channel for an actual emergency. Override for clinics outside India.
const EMERGENCY_NUMBER = process.env.EMERGENCY_NUMBER || '108';

const DEFAULT_CLINIC_INFO = `Wellness Care Clinic is a general healthcare practice.
Hours: Monday-Saturday 9am-7pm, closed Sundays.
Services: general checkups, cardiology, pediatrics, dermatology, emergency care, dental care.
Booking: patients can request an appointment right here in chat, or by calling the front desk.
Location/contact details: see the "Contact" page on the website.`;

// Demo roster — matches the departments actually listed on the HC site's
// "Our Services" section. Override with a DOCTOR_ROSTER env var containing
// JSON in this same shape: { "Department": [{ "name": "...", "popular": true }] }.
// The first doctor marked popular:true in a department is who the bot
// recommends when a patient says they have no preference.
const DEFAULT_DOCTOR_ROSTER = {
  'General Checkup': [
    { name: 'Dr. Aisha Rahman', popular: true },
    { name: 'Dr. Vikram Shah' },
    { name: 'Dr. Leena Fernandes' },
  ],
  'Cardiology': [
    { name: 'Dr. Rohan Mehta', popular: true },
    { name: 'Dr. Priya Nair' },
  ],
  'Pediatrics': [
    { name: 'Dr. Sana Iqbal', popular: true },
    { name: 'Dr. Karan Bhatt' },
  ],
  'Dermatology': [
    { name: 'Dr. Farah Sheikh', popular: true },
    { name: 'Dr. Imran Qureshi' },
  ],
  'Emergency Care': [
    { name: 'Dr. Omar Siddiqui', popular: true },
    { name: 'Dr. Meera Iyer' },
  ],
  'Dental Care': [
    { name: 'Dr. Neha Kapoor', popular: true },
    { name: 'Dr. Arjun Malhotra' },
    { name: 'Dr. Simran Kaur' },
  ],
};

// Demo branches (Bengaluru) — override with a BRANCHES env var containing
// JSON: [{ "name": "...", "address": "...", "lat": 0, "lng": 0 }, ...].
// Used by nearestBranch() below to answer "which branch is closest to me"
// with a real computed distance instead of the model guessing at one.
const DEFAULT_BRANCHES = [
  { name: 'Wellness Care Clinic — MG Road', address: '42 MG Road, Bengaluru', lat: 12.9758, lng: 77.6045 },
  { name: 'Wellness Care Clinic — Indiranagar', address: '100 Ft Road, Indiranagar, Bengaluru', lat: 12.9716, lng: 77.6412 },
  { name: 'Wellness Care Clinic — Whitefield', address: 'ITPL Main Road, Whitefield, Bengaluru', lat: 12.9698, lng: 77.7500 },
];

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

function getBranches() {
  const raw = process.env.BRANCHES;
  if (!raw) return DEFAULT_BRANCHES;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('BRANCHES env var is not valid JSON, falling back to the demo branches:', err.message);
    return DEFAULT_BRANCHES;
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
// (next 4 open days, skipping Sundays per clinic hours) so the bot has real
// options to offer instead of inventing arbitrary ones. Each slot carries
// both a human label (what the bot says to the patient) and an ISO
// timestamp (what it echoes back in the hidden [[APPT|...]] marker once a
// slot is picked - see systemPrompt() and getAutoReply() below).
function nextAvailableSlots(numDays = 4) {
  const times = [
    ['10:00 AM', 10, 0],
    ['1:00 PM', 13, 0],
    ['4:00 PM', 16, 0],
  ];
  const days = [];
  const cursor = new Date();
  while (days.length < numDays) {
    cursor.setDate(cursor.getDate() + 1);
    if (cursor.getDay() !== 0) days.push(new Date(cursor));
  }
  const slots = [];
  days.forEach((day) => {
    const dayLabel = day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    times.forEach(([timeLabel, hh, mm]) => {
      const dt = new Date(day);
      dt.setHours(hh, mm, 0, 0);
      slots.push({ label: `${dayLabel}, ${timeLabel}`, iso: dt.toISOString() });
    });
  });
  return slots;
}

function formatSlotsForPrompt(slots) {
  return slots.map((s) => `- ${s.label} (ISO: ${s.iso})`).join('\n');
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Straight-line (not driving) distance - fine for a demo "which branch is
// closest" answer without pulling in a maps/directions API.
function nearestBranch(lat, lng) {
  const branches = getBranches();
  if (!branches.length) return null;
  let best = null;
  let bestDistanceKm = Infinity;
  for (const branch of branches) {
    const distanceKm = haversineKm(lat, lng, branch.lat, branch.lng);
    if (distanceKm < bestDistanceKm) {
      bestDistanceKm = distanceKm;
      best = branch;
    }
  }
  return { ...best, distanceKm: Math.round(bestDistanceKm * 10) / 10 };
}

function systemPrompt(clinicInfo) {
  const roster = getDoctorRoster();
  const slots = nextAvailableSlots();
  return `You are a friendly front-desk assistant embedded in a healthcare clinic's website chat widget. You may ONLY answer general, non-medical logistics questions using the information below.

Clinic information:
${clinicInfo}

Doctor directory (department -> doctors):
${formatRoster(roster)}

Upcoming available slots (offer the human-readable label when talking to the patient; the ISO timestamp next to each is only for the hidden [[APPT|...]] marker in step 5 below, never say it out loud):
${formatSlotsForPrompt(slots)}

Appointment booking flow — when a patient wants to book an appointment, follow this exact sequence, one step per message (don't skip ahead or combine steps):
1. Ask which department/service they need, if they haven't said already.
2. Once they name a department, share 2-3 doctor names for that department from the directory above and ask them to pick one.
3. If they say they're unsure or have no preference, recommend the doctor marked "(most popular)" in that department and ask if that works for them.
4. Only after a doctor is chosen (by name, or by accepting your recommendation), offer 2-3 slot options for that department from "Upcoming available slots" above, using the human-readable label only.
5. Once they pick a slot, do NOT say the appointment is booked or confirmed. Say you've noted their request (doctor, department, day/time) and that the front desk will confirm it shortly — matching the booking rule below. Then, on its own new line, add this marker using the department name and doctor name exactly as listed above, and the ISO timestamp of the chosen slot: [[APPT|department=<department>|doctor=<doctor>|when=<ISO>]] — invisible to the patient (stripped before sending), only for the clinic's own scheduling. Include it only once, in this same message.

Symptom-based routing — if a patient describes a physical complaint or symptom (e.g. "my tooth hurts", "I have a skin rash", "my child has a fever", "chest tightness") without naming a department, and it does NOT sound like the emergency flow below, suggest the single closest-matching department from the directory above and offer to continue the booking flow with it (starting at step 2). This is routing only, never diagnosis — don't say what you think is wrong with them, only which department handles that kind of concern.

Nearest branch / pharmacy — if a patient asks which branch or location is closest to them, look through the conversation history for a line noting they shared their location - it already includes the nearest branch computed from their coordinates (name, address, approximate distance in km). Relay that directly. If no location has been shared yet, ask them to tap the widget's 📍 "Share my location" button.

Ambulance / emergency flow — if a patient says they need an ambulance or describes what sounds like a medical emergency (severe injury, can't breathe, unconscious, serious accident, chest pain with distress, etc.), this OVERRIDES the "escalate for medical concerns" rule below — handle it directly yourself, one step per message, don't skip ahead:
1. In one short sentence, acknowledge the urgency and ask for their exact location — their address, or tell them they can tap the widget's "Share my location" button instead of typing it.
2. Once they give a location (a typed address, or a message noting they shared their location), acknowledge you have it, then ask ONE short follow-up so the ambulance crew can prepare: is this an accident/injury, an elderly/age-related issue, a known existing disease/condition, or something else.
3. Once they answer (or say they don't know), tell them the clinic's team has been alerted with their location and details and an ambulance is being arranged right now — AND, every time, tell them to also call ${EMERGENCY_NUMBER} immediately if they haven't already, since that's the fastest direct emergency line and this chat cannot guarantee response time.
4. On every reply that's part of an active emergency/ambulance exchange (steps 1-3), end your message on its own new line with exactly this marker: [[URGENT]] — it's invisible to the patient (stripped before sending) and only used to alert clinic staff. Never include it for a non-emergency reply.
This flow is about routing help fast, not diagnosing — still never guess what's medically wrong with them or what they should do about symptoms beyond these three steps.

Rules:
- Keep answers short (2-4 sentences), warm, and clear.
- Never give medical advice, diagnoses, medication guidance, or interpret symptoms.
- Never discuss or guess at a specific patient's medical records, history, or test results — you have no access to them.
- Only use doctor names, departments, slots, and branches exactly as listed above — never invent a name, specialty, credential, price, time slot, or branch that isn't listed.
- You cannot actually book, confirm, reschedule, or cancel an appointment yourself — you have no access to any booking system. Never say things like "I'll set it up for you" or "consider it booked". Once a slot request is noted (step 5 above), a human takes it from there.
- If the question asks for something not covered by the clinic information, doctor directory, or branches above (e.g. a department/specialty not listed, a specific price, real-time doctor availability beyond the slots above), or is a medical concern, a complaint, or a billing dispute, do NOT attempt to answer or work around it. Reply with EXACTLY this single token and nothing else: ESCALATE`;
}

/**
 * history: array of { role: 'user' | 'assistant', content } in chronological
 * order — 'user' is the patient's own messages (already in the clinic's
 * primary/staff language, matching how translateBetween is used elsewhere
 * in this codebase), 'assistant' is prior agent/bot replies. Every flow
 * above relies entirely on this history for state (which step the
 * conversation is on) — there's no separate flow-state tracking in code.
 *
 * Returns:
 *   null                                       - not configured, or the call
 *                                                 failed; caller should leave
 *                                                 the message for a human,
 *                                                 same as if auto-reply
 *                                                 didn't exist.
 *   { escalate: true }                         - Groq decided a human should
 *                                                 handle this.
 *   { escalate: false, reply, urgent,
 *     appointment }                            - safe to send `reply`
 *                                                 straight to the patient.
 *                                                 `urgent` is true mid an
 *                                                 active ambulance exchange.
 *                                                 `appointment` is
 *                                                 { department, doctor,
 *                                                 scheduledAt } the moment a
 *                                                 booking request was noted,
 *                                                 else null.
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
    let reply = res.data?.choices?.[0]?.message?.content?.trim();
    if (!reply) return null;
    if (reply === 'ESCALATE' || reply.startsWith('ESCALATE')) return { escalate: true };

    // Strip the hidden [[URGENT]] marker (see the ambulance flow above)
    // before it ever reaches the patient - it's purely a signal for the
    // caller (widget.js) to flag the conversation for staff.
    const urgent = /\[\[URGENT\]\]/.test(reply);
    if (urgent) reply = reply.replace(/\[\[URGENT\]\]/g, '').trim();

    // Strip and parse the hidden [[APPT|...]] marker (see step 5 of the
    // booking flow above) so the caller can create a real Appointment row -
    // needed for src/reminders.js to have something to schedule against.
    // Falls back to no-appointment (not an error) if the model's ISO
    // timestamp doesn't parse, since the patient-facing reply is still safe
    // to send either way.
    let appointment = null;
    const apptMatch = reply.match(/\[\[APPT\|department=([^|]+)\|doctor=([^|]+)\|when=([^\]]+)\]\]/);
    if (apptMatch) {
      reply = reply.replace(apptMatch[0], '').trim();
      const scheduledAt = new Date(apptMatch[3].trim());
      if (!isNaN(scheduledAt.getTime())) {
        appointment = { department: apptMatch[1].trim(), doctor: apptMatch[2].trim(), scheduledAt };
      }
    }

    return { escalate: false, reply, urgent, appointment };
  } catch (err) {
    console.error('Groq auto-reply error:', err.response?.data || err.message);
    return null;
  }
}

module.exports = {
  getAutoReply,
  DEFAULT_CLINIC_INFO,
  DEFAULT_DOCTOR_ROSTER,
  DEFAULT_BRANCHES,
  EMERGENCY_NUMBER,
  nearestBranch,
};
