// Free instant auto-reply for the HC website chat widget, powered by Groq's
// OpenAI-compatible chat completions API (console.groq.com — free tier, no
// credit card). Scoped tightly to clinic logistics (hours, services,
// booking, location, symptom routing) via the system prompt below; anything
// it isn't confident answering from CLINIC_INFO/the doctor directory —
// medical questions, a specific patient's records, complaints, anything
// ambiguous — it's instructed to escalate to a human instead of guessing.
//
// There's no real scheduling backend behind this demo, so "booking" here
// means: walk the patient through department -> doctor -> time slot (or,
// for standalone diagnostic tests, department -> test -> time slot) using
// real (if fictional) names/slots/costs we hand it below, then hand the
// collected request to a human to actually confirm — never claim to
// complete a booking itself (see the rules in systemPrompt()). It DOES
// create a real Appointment row (doctor bookings) or TestBooking row (test
// bookings) once a slot is picked (see the [[APPT|...]] / [[TESTBOOK|...]]
// markers below) so src/reminders.js has something concrete to send
// reminders against - the "never claim it's booked" rule is about what the
// bot tells the PATIENT, not about whether we track the request internally.
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
// JSON in this same shape: { "Department": [{ "name": "...", "popular": true,
// "degree": "...", "experienceYears": 0, "fee": 0 }] }. degree/experienceYears/fee
// are optional per-doctor (formatRoster() below just omits whatever's missing)
// but are what let the bot answer "who are the doctors" with real credentials
// and cost instead of vague/invented ones. The first doctor marked
// popular:true in a department is who the bot recommends when a patient says
// they have no preference. fee is in INR, per visit.
const DEFAULT_DOCTOR_ROSTER = {
  'General Checkup': [
    { name: 'Dr. Aisha Rahman', popular: true, degree: 'MBBS, MD (General Medicine)', experienceYears: 12, fee: 500 },
    { name: 'Dr. Vikram Shah', degree: 'MBBS', experienceYears: 8, fee: 400 },
    { name: 'Dr. Leena Fernandes', degree: 'MBBS, MD (General Medicine)', experienceYears: 15, fee: 550 },
  ],
  'Cardiology': [
    { name: 'Dr. Rohan Mehta', popular: true, degree: 'MBBS, MD, DM (Cardiology)', experienceYears: 14, fee: 900 },
    { name: 'Dr. Priya Nair', degree: 'MBBS, DNB (Cardiology)', experienceYears: 9, fee: 750 },
  ],
  'Pediatrics': [
    { name: 'Dr. Sana Iqbal', popular: true, degree: 'MBBS, MD (Pediatrics)', experienceYears: 11, fee: 600 },
    { name: 'Dr. Karan Bhatt', degree: 'MBBS, DCH', experienceYears: 7, fee: 500 },
  ],
  'Dermatology': [
    { name: 'Dr. Farah Sheikh', popular: true, degree: 'MBBS, MD (Dermatology)', experienceYears: 10, fee: 700 },
    { name: 'Dr. Imran Qureshi', degree: 'MBBS, DDVL', experienceYears: 6, fee: 550 },
  ],
  'Emergency Care': [
    { name: 'Dr. Omar Siddiqui', popular: true, degree: 'MBBS, MD (Emergency Medicine)', experienceYears: 13, fee: 650 },
    { name: 'Dr. Meera Iyer', degree: 'MBBS, DNB (Emergency Medicine)', experienceYears: 8, fee: 550 },
  ],
  'Dental Care': [
    { name: 'Dr. Neha Kapoor', popular: true, degree: 'BDS, MDS (Orthodontics)', experienceYears: 9, fee: 400 },
    { name: 'Dr. Arjun Malhotra', degree: 'BDS', experienceYears: 5, fee: 300 },
    { name: 'Dr. Simran Kaur', degree: 'BDS, MDS (Periodontics)', experienceYears: 12, fee: 450 },
  ],
};

// Demo diagnostic test catalog — for patients who want to book a standalone
// test (X-ray, blood work, etc.) rather than a doctor consultation. Override
// with a TEST_CATALOG env var containing JSON in this same shape:
// { "Department": [{ "name": "...", "fee": 0 }] }. fee is in INR.
const DEFAULT_TEST_CATALOG = {
  'Radiology': [
    { name: 'Chest X-Ray', fee: 800 },
    { name: 'Abdominal Ultrasound', fee: 1200 },
    { name: 'CT Scan - Head', fee: 3500 },
    { name: 'MRI - Brain', fee: 4500 },
  ],
  'Pathology / Lab Tests': [
    { name: 'Complete Blood Count (CBC) - incl. Platelet Count', fee: 300 },
    { name: 'Blood Sugar (Fasting & PP)', fee: 250 },
    { name: 'Lipid Profile', fee: 600 },
    { name: 'Thyroid Profile (T3, T4, TSH)', fee: 700 },
    { name: 'Liver Function Test (LFT)', fee: 650 },
  ],
  'Cardiology Diagnostics': [
    { name: 'ECG', fee: 400 },
    { name: 'Echocardiogram (2D Echo)', fee: 1800 },
    { name: 'TMT (Treadmill Test)', fee: 1500 },
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

function getTestCatalog() {
  const raw = process.env.TEST_CATALOG;
  if (!raw) return DEFAULT_TEST_CATALOG;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('TEST_CATALOG env var is not valid JSON, falling back to the demo catalog:', err.message);
    return DEFAULT_TEST_CATALOG;
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
      const lines = doctors.map((d) => {
        const label = `${d.name}${d.popular ? ' (most popular)' : ''}`;
        const details = [];
        if (d.degree) details.push(d.degree);
        if (d.experienceYears != null) details.push(`${d.experienceYears} yrs experience`);
        if (d.fee != null) details.push(`₹${d.fee} per visit`);
        return details.length ? `  - ${label} — ${details.join(', ')}` : `  - ${label}`;
      });
      return `- ${dept}:\n${lines.join('\n')}`;
    })
    .join('\n');
}

function formatTestCatalog(catalog) {
  return Object.entries(catalog)
    .map(([dept, tests]) => {
      const lines = tests.map((t) => `  - ${t.name} — ₹${t.fee}`);
      return `- ${dept}:\n${lines.join('\n')}`;
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

function systemPrompt(clinicInfo, loggedIn) {
  const roster = getDoctorRoster();
  const testCatalog = getTestCatalog();
  const slots = nextAvailableSlots();
  return `You are a friendly front-desk assistant embedded in a healthcare clinic's website chat widget. You may ONLY answer general, non-medical logistics questions using the information below.

Clinic information:
${clinicInfo}

Doctor directory (department -> doctors, with each doctor's degree, years of experience, and appointment fee):
${formatRoster(roster)}

Diagnostic test catalog (department -> standalone tests, with each test's cost — for patients booking a test/lab work directly, not a doctor consultation):
${formatTestCatalog(testCatalog)}

Upcoming available slots (offer the human-readable label when talking to the patient; the ISO timestamp next to each is only for the hidden [[APPT|...]] / [[TESTBOOK|...]] markers below, never say it out loud):
${formatSlotsForPrompt(slots)}

Appointment booking flow — when a patient wants to book an appointment WITH A DOCTOR, follow this exact sequence, one step per message (don't skip ahead or combine steps):
1. Ask which department/service they need, if they haven't said already.
2. Once they name a department, share 2-3 doctors for that department from the directory above and ask them to pick one. For EACH doctor you name, always state their degree, years of experience, and appointment fee exactly as listed (e.g. "Dr. X — MBBS, MD; 10 yrs experience; ₹500 per visit") — never just the name alone.
3. If they say they're unsure or have no preference, recommend the doctor marked "(most popular)" in that department — again including their degree, experience, and fee — and ask if that works for them.
4. Only after a doctor is chosen (by name, or by accepting your recommendation), offer 2-3 slot options for that department from "Upcoming available slots" above, using the human-readable label only.
5. Once they pick a slot, do NOT say the appointment is booked or confirmed. ${loggedIn
    ? 'Say you\'ve noted their request (doctor, department, day/time) and that the front desk will confirm it shortly — matching the booking rule below.'
    : 'The patient is NOT logged in yet, so tell them (briefly, warmly) that they\'ll need to log in first using the "Login / Signup" button at the top of the page before this request can be finalized — say their details are noted for now and they should confirm again once logged in.'
  } Then, on its own new line, add this marker using the department name and doctor name exactly as listed above, and the ISO timestamp of the chosen slot: [[APPT|department=<department>|doctor=<doctor>|when=<ISO>]] — invisible to the patient (stripped before sending), only for the clinic's own scheduling. Include it only once, in this same message.

Test booking flow — when a patient wants to book a TEST (e.g. "book a test", "I need an X-ray", "blood test", "lab work") rather than see a doctor, use this separate sequence instead of the appointment flow above, one step per message (don't skip ahead or combine steps):
1. Ask which department/type of test they need, if they haven't said already, and mention the department options from the test catalog above (Radiology, Pathology / Lab Tests, Cardiology Diagnostics).
2. Once they name a department, list the available tests in that department from the catalog above, each with its cost exactly as listed (e.g. "Chest X-Ray — ₹800"), and ask them to pick one.
3. Once a test is chosen, offer 2-3 slot options from "Upcoming available slots" above, using the human-readable label only.
4. Once they pick a slot, do NOT say the test is booked or confirmed. ${loggedIn
    ? 'Say you\'ve noted their request (test, department, cost, day/time) and that the lab/front desk will confirm it shortly.'
    : 'The patient is NOT logged in yet, so tell them (briefly, warmly) that they\'ll need to log in first using the "Login / Signup" button at the top of the page before this request can be finalized — say their details are noted for now and they should confirm again once logged in.'
  } Then, on its own new line, add this marker using the department and test name exactly as listed above, the test's fee, and the ISO timestamp of the chosen slot: [[TESTBOOK|department=<department>|test=<test>|fee=<fee>|when=<ISO>]] — invisible to the patient (stripped before sending), only for the clinic's own scheduling. Include it only once, in this same message.

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
- Only use doctor names, departments, slots, branches, and test names/costs exactly as listed above — never invent a name, specialty, credential, price, time slot, test, or branch that isn't listed.
- Any time you mention a doctor by name, anywhere in the conversation, always include their degree, years of experience, and appointment fee from the directory above in that same message — not just on first mention. Same for tests: any time you mention a test by name, always include its cost from the catalog above.
- You cannot actually book, confirm, reschedule, or cancel an appointment or test yourself — you have no access to any booking system. Never say things like "I'll set it up for you" or "consider it booked". Once a request is noted (step 5 of the appointment flow, or step 4 of the test flow), a human takes it from there.
- If the question asks for something not covered by the clinic information, doctor directory, test catalog, or branches above (e.g. a department/specialty/test not listed, a specific price not listed, real-time availability beyond the slots above), or is a medical concern, a complaint, or a billing dispute, do NOT attempt to answer or work around it. Reply with EXACTLY this single token and nothing else: ESCALATE`;
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
 *     appointment, testBooking }               - safe to send `reply`
 *                                                 straight to the patient.
 *                                                 `urgent` is true mid an
 *                                                 active ambulance exchange.
 *                                                 `appointment` is
 *                                                 { department, doctor,
 *                                                 scheduledAt } the moment a
 *                                                 doctor booking request was
 *                                                 noted, else null.
 *                                                 `testBooking` is
 *                                                 { department, test, fee,
 *                                                 scheduledAt } the moment a
 *                                                 test booking request was
 *                                                 noted, else null.
 */
async function getAutoReply(history, options) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  // loggedIn defaults to true (normal "noted, front desk will confirm"
  // phrasing) unless the caller explicitly says otherwise - only
  // src/autoReply.js's webchat path ever passes loggedIn: false (an
  // anonymous website visitor mid-booking), so every other caller (native
  // WhatsApp, a claimed webchat conversation) behaves exactly as before.
  const loggedIn = !options || options.loggedIn !== false;

  const clinicInfo = process.env.CLINIC_INFO || DEFAULT_CLINIC_INFO;
  const messages = [{ role: 'system', content: systemPrompt(clinicInfo, loggedIn) }, ...history];

  let reply;
  try {
    const res = await axios.post(
      GROQ_API_URL,
      { model: MODEL, messages, temperature: 0.3, max_tokens: 400 },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 15000 }
    );
    reply = res.data?.choices?.[0]?.message?.content?.trim();
  } catch (err) {
    // Groq's openai/gpt-oss-20b occasionally wraps a perfectly good
    // plain-text reply in a bogus "tool call" envelope instead of returning
    // it as normal content - its harmony chat template leaking a
    // channel/tool-call structure through even though we never define any
    // tools - which the API then rejects with a tool_use_failed error. Seen
    // in practice on longer, list-heavy replies (e.g. reciting the
    // doctor/test directories below).
    //
    // The reply text the model actually meant to send is still sitting in
    // that rejected call's "arguments", so recover it from there instead of
    // dropping the reply / silently escalating to a human over what's
    // really just a formatting quirk. failed_generation isn't reliably
    // valid JSON though - in production this has shown up both as a
    // properly quoted arguments value (e.g. `"arguments": "text..."}`,
    // which JSON.parse can handle) AND as a raw unquoted one (e.g.
    // `"arguments": text...}`, which is NOT valid JSON and makes
    // JSON.parse throw every time). A plain regex pull of everything after
    // `"arguments":` handles both shapes, plus a fully truncated one with
    // no closing brace at all, since it doesn't require the value to be
    // well-formed JSON in the first place.
    const errData = err.response?.data?.error;
    if (errData?.code === 'tool_use_failed' && typeof errData.failed_generation === 'string') {
      const argsMatch = errData.failed_generation.match(/"arguments":\s*([\s\S]*)$/);
      if (argsMatch) {
        let recovered = argsMatch[1].replace(/^"/, '').replace(/["}\s]+$/, '').trim();
        // The unquoted shape above contains real newline characters already,
        // but the properly-quoted shape (a genuine JSON string) still has
        // them as literal \n escapes at this point since we bypassed
        // JSON.parse - unescape the common ones so the patient sees actual
        // line breaks either way instead of literal backslash-n text.
        recovered = recovered
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
        if (recovered) reply = recovered;
      }
    }
    if (reply === undefined) {
      console.error('Groq auto-reply error:', errData || err.message);
      return null;
    }
  }

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

  // Strip and parse the hidden [[TESTBOOK|...]] marker (see step 4 of the
  // test booking flow above) so the caller can create a real TestBooking
  // row - same pattern as [[APPT|...]] above, just for standalone
  // diagnostic tests instead of doctor consultations.
  let testBooking = null;
  const testMatch = reply.match(/\[\[TESTBOOK\|department=([^|]+)\|test=([^|]+)\|fee=([^|]+)\|when=([^\]]+)\]\]/);
  if (testMatch) {
    reply = reply.replace(testMatch[0], '').trim();
    const scheduledAt = new Date(testMatch[4].trim());
    const fee = parseInt(testMatch[3].trim(), 10);
    if (!isNaN(scheduledAt.getTime()) && !isNaN(fee)) {
      testBooking = { department: testMatch[1].trim(), test: testMatch[2].trim(), fee, scheduledAt };
    }
  }

  return { escalate: false, reply, urgent, appointment, testBooking };
}

module.exports = {
  getAutoReply,
  DEFAULT_CLINIC_INFO,
  DEFAULT_DOCTOR_ROSTER,
  DEFAULT_TEST_CATALOG,
  DEFAULT_BRANCHES,
  EMERGENCY_NUMBER,
  nearestBranch,
};
