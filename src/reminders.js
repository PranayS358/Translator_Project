// Sends appointment reminders (24h and 1h before) and a post-visit
// follow-up/feedback request, based on Appointment rows created by the
// Groq booking flow (see the [[APPT|...]] marker in src/groq.js and
// runAutoReply() in src/routes/widget.js).
//
// IMPORTANT caveat: this runs as a setInterval inside the same long-lived
// Node process as the rest of the app. Render's free tier spins the dyno
// down after inactivity - while it's asleep, this loop isn't running at
// all, so a reminder due during that window won't fire until some request
// wakes the service back up again. The time windows below are deliberately
// wide (hours, not minutes) so a wake-up shortly after the "ideal" moment
// still catches it, but there's no way to guarantee on-time delivery on
// this hosting tier short of an always-on paid plan or an external pinger
// that keeps hitting the site. Worth knowing before relying on this for a
// real clinic.
const prisma = require('./db');
const { translateBetween } = require('./translate');
const { addMessage } = require('./conversations');
const { sendWhatsAppMessage } = require('./whatsapp');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function getPrimaryLanguage() {
  const settings = await prisma.settings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  return settings.primaryLanguage;
}

// Saves the message (translated into the patient's language, same pattern
// as every other outbound message in this codebase) so it's there next
// time they open the widget, AND pushes it over WhatsApp directly when
// possible - a reminder that only shows up if the patient happens to
// reopen a browser tab defeats the point of a reminder.
async function deliver(conversation, primaryLanguage, textInPrimaryLanguage) {
  const targetLang = conversation.customerLanguage || primaryLanguage;
  const { translatedText } = await translateBetween(textInPrimaryLanguage, primaryLanguage, targetLang);

  await addMessage(conversation.id, {
    direction: 'outbound',
    originalText: textInPrimaryLanguage,
    detectedLanguage: 'bot',
    translatedText,
    targetLanguage: targetLang,
  });

  if (!conversation.muted) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { unreadCount: { increment: 1 } } });
  }

  const waNumber = conversation.channel === 'whatsapp'
    ? conversation.contactKey.replace('+', '')
    : (conversation.linkedWhatsapp ? conversation.linkedWhatsapp.replace('+', '') : null);
  if (waNumber) await sendWhatsAppMessage(waNumber, translatedText);
}

async function sendReminders() {
  const now = new Date();
  const primaryLanguage = await getPrimaryLanguage();
  const hours = (n) => n * 60 * 60 * 1000;

  // 24h-before reminders — wide 2-hour catch window (23-25h out).
  const in24h = await prisma.appointment.findMany({
    where: {
      status: { in: ['requested', 'confirmed'] },
      reminder24hSent: false,
      scheduledAt: { gte: new Date(now.getTime() + hours(23)), lte: new Date(now.getTime() + hours(25)) },
    },
    include: { conversation: true },
  });
  for (const appt of in24h) {
    try {
      const when = appt.scheduledAt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
      await deliver(appt.conversation, primaryLanguage,
        `Reminder: you have an appointment tomorrow with ${appt.doctorName} (${appt.department}) at ${when}. Reply here if you need to reschedule.`);
      await prisma.appointment.update({ where: { id: appt.id }, data: { reminder24hSent: true } });
    } catch (err) {
      console.error(`24h reminder failed for appointment ${appt.id}:`, err.message);
    }
  }

  // 1h-before reminders — 1-hour catch window (30-90 min out).
  const in1h = await prisma.appointment.findMany({
    where: {
      status: { in: ['requested', 'confirmed'] },
      reminder1hSent: false,
      scheduledAt: { gte: new Date(now.getTime() + 30 * 60 * 1000), lte: new Date(now.getTime() + 90 * 60 * 1000) },
    },
    include: { conversation: true },
  });
  for (const appt of in1h) {
    try {
      const when = appt.scheduledAt.toLocaleString('en-IN', { timeStyle: 'short' });
      await deliver(appt.conversation, primaryLanguage,
        `Reminder: your appointment with ${appt.doctorName} (${appt.department}) is in about an hour, at ${when}. See you soon!`);
      await prisma.appointment.update({ where: { id: appt.id }, data: { reminder1hSent: true } });
    } catch (err) {
      console.error(`1h reminder failed for appointment ${appt.id}:`, err.message);
    }
  }

  // Post-visit follow-up — 2 to 26h AFTER the appointment time, so it still
  // fires once even if the server was asleep right at the 2h mark. Also
  // marks the appointment "completed", since reaching this point means the
  // scheduled time has passed.
  const followUps = await prisma.appointment.findMany({
    where: {
      status: { not: 'cancelled' },
      followUpSent: false,
      scheduledAt: { gte: new Date(now.getTime() - hours(26)), lte: new Date(now.getTime() - hours(2)) },
    },
    include: { conversation: true },
  });
  for (const appt of followUps) {
    try {
      await deliver(appt.conversation, primaryLanguage,
        `Hi! How are you feeling after your visit with ${appt.doctorName} (${appt.department})? Reply and let us know how it went, or rate your visit 1-5.`);
      await prisma.appointment.update({ where: { id: appt.id }, data: { followUpSent: true, status: 'completed' } });
    } catch (err) {
      console.error(`Follow-up failed for appointment ${appt.id}:`, err.message);
    }
  }
}

let started = false;
function startReminderScheduler() {
  if (started) return; // guard against being required/called more than once
  started = true;
  // Run once shortly after boot (catches anything that came due while the
  // server was down or asleep), then on a fixed interval from there.
  setTimeout(() => sendReminders().catch((err) => console.error('Reminder scheduler error:', err.message)), 30 * 1000);
  setInterval(() => sendReminders().catch((err) => console.error('Reminder scheduler error:', err.message)), CHECK_INTERVAL_MS);
}

module.exports = { startReminderScheduler, sendReminders };
