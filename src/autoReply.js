// Shared Groq auto-reply runner. Originally lived only in src/routes/
// widget.js (webchat visitors), moved out here so src/routes/webhook.js
// (native WhatsApp messages, including ones merged in via a webchat
// conversation's linkedWhatsapp - see "Continue on WhatsApp" in widget.js)
// can call the exact same logic. The point: a patient should be able to
// get bot help on whichever channel they're actually messaging from,
// including after linking their own WhatsApp - not just on webchat.
const prisma = require('./db');
const { translateBetween } = require('./translate');
const { addMessage } = require('./conversations');
const { getAutoReply, nearestBranch } = require('./groq');
const { sendWhatsAppMessage } = require('./whatsapp');

// Turns a stored message into one line of context for the bot. Plain
// placeholders like "[image]" carry no useful text, but a shared location
// is exactly the thing the ambulance flow AND the nearest-branch finder
// (src/groq.js) need to see and react to - so unlike other placeholders,
// describe it with an actual coordinate/maps link (and the nearest branch,
// computed here rather than left for the model to guess at) instead of
// dropping it from history entirely.
function describeForBot(message) {
  if (message.messageType === 'location') {
    let coords = {};
    try { coords = JSON.parse(message.extra || '{}'); } catch (err) { /* ignore */ }
    if (coords.latitude != null && coords.longitude != null) {
      const mapsUrl = `https://www.google.com/maps?q=${coords.latitude},${coords.longitude}`;
      const branch = nearestBranch(coords.latitude, coords.longitude);
      const branchNote = branch
        ? ` Nearest branch: ${branch.name}, ${branch.address} (~${branch.distanceKm} km away).`
        : '';
      return `[Patient shared their location: ${mapsUrl}.${branchNote}]`;
    }
  }
  const text = message.direction === 'inbound' ? (message.translatedText || message.originalText) : message.originalText;
  if (text && /^\[[a-z]+\]$/i.test(text)) return null; // other placeholders (e.g. "[image]") - nothing useful to hand the bot
  return text;
}

// Runs the bot (src/groq.js) against a conversation's recent history and,
// if it produces a reply, translates + saves it AND pushes it out over
// WhatsApp when applicable (this IS a native 'whatsapp'-channel
// conversation, or it's a webchat one linked to the patient's own WhatsApp
// number) - same delivery pattern src/reminders.js's deliver() uses, so the
// reply actually reaches the patient wherever they're chatting from, not
// just wherever they happened to send THIS particular message. Also flips
// conversation.urgent on when the bot signals an active ambulance/emergency
// exchange (see the [[URGENT]] marker in groq.js's systemPrompt), and
// creates Appointment/TestBooking rows when a booking request was noted -
// unless this is an anonymous (not logged in) webchat visitor, in which
// case the request is intentionally NOT saved as a real booking yet (see
// the loggedIn check below); the caller surfaces the returned
// requiresLogin flag so the widget can prompt them to sign in.
//
// Returns { requiresLogin } - true the moment a booking was attempted by an
// anonymous webchat visitor, so src/routes/widget.js's /message and
// /location handlers can pass it through to the widget.
async function runAutoReply(conversation, primaryLanguage, customerLanguage) {
  if (conversation.muted || !conversation.botEnabled) return { requiresLogin: false };
  try {
    const recent = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    const history = recent
      .reverse()
      .map((m) => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: describeForBot(m) }))
      .filter((m) => m.content);

    // Only webchat has a login concept at all (see src/auth.js,
    // window.watAuth in chat-widget.js) - a native WhatsApp conversation
    // (or one merged in via linkedWhatsapp) is always treated as "logged
    // in" here, since a real phone number is already a strong identity on
    // its own and WhatsApp has no sign-in UI to send anyone to.
    const loggedIn = conversation.channel !== 'webchat' || !!conversation.patientId;

    const auto = await getAutoReply(history, { loggedIn });
    if (!auto || auto.escalate || !auto.reply) return { requiresLogin: false };

    const { translatedText: botReplyTranslated } = await translateBetween(auto.reply, primaryLanguage, customerLanguage);
    await addMessage(conversation.id, {
      direction: 'outbound',
      originalText: auto.reply,
      detectedLanguage: 'bot',
      translatedText: botReplyTranslated,
      targetLanguage: customerLanguage,
    });

    // Deliver over WhatsApp too when this conversation has a WhatsApp
    // side - native 'whatsapp' channel, or a webchat conversation that's
    // been linked via "Continue on WhatsApp". A webchat-only conversation
    // has neither, so this is a no-op there and the reply just shows up on
    // the widget's next poll like before.
    const waNumber = conversation.channel === 'whatsapp'
      ? conversation.contactKey.replace('+', '')
      : (conversation.linkedWhatsapp ? conversation.linkedWhatsapp.replace('+', '') : null);
    if (waNumber) await sendWhatsAppMessage(waNumber, botReplyTranslated);

    if (auto.urgent) {
      await prisma.conversation.update({ where: { id: conversation.id }, data: { urgent: true } });
    }

    // The bot only ever tells the PATIENT their request is "noted, front
    // desk will confirm" (see the booking rules in groq.js) - but we still
    // track it as a real Appointment row internally so src/reminders.js has
    // something concrete to send 24h/1h reminders and a post-visit
    // follow-up against. Skipped for an anonymous webchat visitor - the
    // system prompt already asks the bot to tell them to log in instead of
    // confirming, but that's just phrasing; this is the actual gate, so a
    // booking can never be created without a real patient behind it even if
    // the model's wording slips.
    let requiresLogin = false;
    if (auto.appointment) {
      if (loggedIn) {
        await prisma.appointment.create({
          data: {
            conversationId: conversation.id,
            department: auto.appointment.department,
            doctorName: auto.appointment.doctor,
            scheduledAt: auto.appointment.scheduledAt,
          },
        });
      } else {
        requiresLogin = true;
      }
    }

    // Same pattern as auto.appointment above, but for a standalone
    // diagnostic test booking (see the [[TESTBOOK|...]] marker and test
    // booking flow in groq.js) - gives src/reminders.js a TestBooking row
    // to send 24h/1h reminders against.
    if (auto.testBooking) {
      if (loggedIn) {
        await prisma.testBooking.create({
          data: {
            conversationId: conversation.id,
            department: auto.testBooking.department,
            testName: auto.testBooking.test,
            fee: auto.testBooking.fee,
            scheduledAt: auto.testBooking.scheduledAt,
          },
        });
      } else {
        requiresLogin = true;
      }
    }

    return { requiresLogin };
  } catch (err) {
    console.error('Auto-reply (Groq) failed, leaving for a human:', err.message);
    return { requiresLogin: false };
  }
}

module.exports = { runAutoReply, describeForBot };
