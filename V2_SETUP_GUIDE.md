# WA Translator v2 — Step-by-Step Setup Guide

Everything from the roadmap plus your four feature requests is already
built into the code in `wa-translator-v2.zip`. This guide walks you through
getting it running, then all the way to a live, publicly reachable app.

## What changed vs. v1, mapped to your requests

| Your request | What was built |
|---|---|
| Dark/light theme | Toggle button (🌙/☀️) in the top bar, saved per-browser and in settings |
| Sending/receiving on one page | New `Conversation` + `Message` model — every message (in AND out) attaches to one thread; the dashboard now shows a WhatsApp-style two-pane chat view with a reply box built in |
| Facebook/Instagram integration | New shared `/webhook/meta` route handles both; `src/meta-channels.js` sends to either |
| Same number ≠ new inbox | `src/phone.js` normalizes every phone number to E.164 before it's used as the conversation key |
| Roadmap: real database | Prisma + PostgreSQL schema (`prisma/schema.prisma`) |
| Roadmap: security | Webhook signature verification, API key middleware, rate limiting — all in `src/security.js` |
| Roadmap: better translation | MyMemory Translation API — free, no signup (`src/translate.js`) |

---

## Step 1 — Set up Neon (free Postgres database)

1. Go to **https://neon.tech**, sign up (no credit card needed)
2. Click **Create a project** — any name, e.g. `wa-translator`
3. On the project dashboard, find **Connection Details** and copy the
   connection string — looks like:
   ```
   postgresql://user:password@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require
   ```

---

## Step 2 — Get the new project running locally

1. Unzip `wa-translator-v2.zip` and open the folder in VS Code
2. In the terminal:
   ```bash
   npm install
   cp .env.example .env
   ```
3. Open `.env` and paste your Neon connection string:
   ```
   DATABASE_URL=postgresql://user:password@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require
   ```
4. Create the database tables from the schema:
   ```bash
   npx prisma migrate dev --name init
   ```
   This reads `prisma/schema.prisma` and creates the `Conversation`,
   `Message`, and `Settings` tables in your Neon database automatically.
5. Start the server:
   ```bash
   npm start
   ```
6. Open `http://localhost:3000` — you should see the new two-pane interface.
   Try the **theme toggle** and the **Simulate a message** box (pick a
   channel, type something) to confirm the UI and database are both working
   before touching any real integrations.

---

## Step 3 — Reconnect WhatsApp (same values as before)

Copy your existing WhatsApp values from your old `.env` into the new one:
```
WHATSAPP_TOKEN=<your token>
WHATSAPP_PHONE_NUMBER_ID=<your phone number ID>
WEBHOOK_VERIFY_TOKEN=demo_verify_token
AUTO_REPLY=true
```
Restart the server, run `ngrok http 3000` again, and re-register the
webhook URL in Meta exactly as before — nothing about that process changed.
Send a test WhatsApp message and confirm it now appears as a proper chat
thread in the left sidebar, with your reply box working underneath it.

---

## Step 4 — Add webhook signature verification

1. Go to your Meta app → **App Settings → Basic**
2. Copy the **App Secret** (click "Show")
3. Add it to `.env`:
   ```
   META_APP_SECRET=your_app_secret_here
   ```
4. Restart the server

From now on, any webhook call without a valid Meta signature is silently
rejected — check your terminal for `⚠️ Rejected ... invalid signature` if
you ever see unexpected entries.

---

## Step 5 — Get a permanent access token ✅ *(done)*

1. **Meta Business Suite → Business Settings → Users → System Users**
2. Create a system user (Admin role) if you don't have one
3. **Generate Token** → select your app → choose **Never** expiration →
   grant `whatsapp_business_management` and `whatsapp_business_messaging`
4. Replace `WHATSAPP_TOKEN` in `.env` with this new permanent token
5. Restart the server

No more daily token expiration.

---

## Step 6 — Translation is free, nothing to sign up for

This project uses the **MyMemory Translation API** — no account, no API key,
no credit card. `src/translate.js` calls it as a plain HTTPS request (using
`axios`, already a dependency).

Since MyMemory needs an explicit source/target language pair rather than
auto-detecting, the code detects Arabic vs. English itself by checking for
Arabic-script Unicode characters in the message — instant, free, and no
extra request needed.

1. Nothing to install or configure — it works out of the box.
2. *(Optional)* Free limit is 5,000 characters/day per IP anonymously, or
   50,000/day if you add an email MyMemory can reach you at. To raise the
   limit, add to `.env`:
   ```
   MYMEMORY_EMAIL=your_email@example.com
   ```
3. Restart the server, test with a real or simulated message — translations
   now come from MyMemory. If the API is unreachable or the daily limit is
   hit, the app logs a warning and passes the message through untranslated
   instead of crashing.

> **Note:** if you outgrow the free daily limit (e.g. real customer volume),
> two options: self-host [LibreTranslate](https://github.com/LibreTranslate/LibreTranslate)
> for unlimited free translation, or switch back to a paid provider like
> Amazon Translate or Azure Translator — both have generous free tiers too,
> just require billing to be enabled on the account.

---

## Step 7 — Add the API key (protects your dashboard's data)

1. Generate any long random string (a password manager's generator works
   fine) — this doesn't need to be memorable
2. Set it in `.env`:
   ```
   API_KEY=your_long_random_string_here
   ```
3. Restart the server

The dashboard's own JavaScript doesn't send this header yet in this build
(since it's same-origin and meant for you alone) — this mainly matters once
you connect the Android app or any external client, same as covered
earlier; add `.addHeader("x-api-key", "...")` there when you do.

---

## Step 8 — Connect Facebook Messenger (optional)

> **Updated for Meta's redesigned dashboard:** the old **Add Product** button
> is gone. Products are now added as **"use cases"** instead. If you land on
> the **Dashboard** and don't see an "Add Product" option, this is why —
> follow the steps below instead of any older guide/video.

1. In your Meta app, go to **Use cases** in the left sidebar, then click
   **Add use cases** (top-right button)
2. Choose **Messenger from Meta** (may also show as "Connect with customers
   through Messenger") and add it
3. Back on **Use cases**, open the Messenger use case → **Customize**. You'll
   see a left-hand tab list instead of a single "Settings" page:
   - **Permissions and features**
   - **Messenger API Settings** ← this is the one you want
   - **API integration helper**
   - **Instagram settings**
4. Click **Messenger API Settings** and generate a **Page Access Token** for
   a Facebook Page you manage (or create a free test Page)
5. Add to `.env`:
   ```
   PAGE_ACCESS_TOKEN=your_page_token
   ```
6. Still under **Messenger API Settings**, find **Webhooks** and set the
   callback URL to:
   ```
   https://<your-ngrok-or-production-url>/webhook/meta
   ```
   Verify token: same `WEBHOOK_VERIFY_TOKEN` as before
7. Subscribe to the `messages` field
8. Message your Page from a personal Facebook account to test — it'll
   appear in your dashboard tagged `messenger`

---

## Step 9 — Connect Instagram (optional)

1. Your Instagram account needs to be a **Professional account** linked to
   the same Facebook Page
2. In the same Meta app, under the Messenger use case's **Customize** screen
   (see Step 8), click the **Instagram settings** tab — connect the linked
   IG account there (there's no separate "Instagram product" to add anymore;
   it lives inside the same use case as Messenger)
3. If it needs its own token, add it as:
   ```
   IG_PAGE_ACCESS_TOKEN=your_ig_token
   ```
   (if it's the same as your Page token, you can leave this blank — the
   code falls back to `PAGE_ACCESS_TOKEN` automatically)
4. Same webhook URL as Messenger (`/webhook/meta`) — Meta tells your server
   which platform each message came from automatically
5. Test by DMing the connected Instagram account

---

## Step 10 — Deploy to Render (removes the need for ngrok)

Render's free tier is the easiest zero-cost way to get a real, HTTPS,
publicly reachable URL — which Meta's webhooks require. Read the caveat at
the end of this step before pointing real customer traffic at it.

1. Push this project to a GitHub repository (Render deploys from Git):
   ```bash
   git init
   git add .
   git commit -m "wa-translator v2"
   ```
   Push it to a new GitHub repo. **Make sure `.env` is in `.gitignore`** —
   never commit real secrets; only `.env.example` should be tracked.
2. Go to **https://render.com**, sign up free, **New → Web Service**
3. Connect your GitHub repo (if `wa-translator-v2` is nested inside a
   parent folder, set that as the service's **Root Directory**)
4. Settings:
   - Build command: `npm install && npx prisma generate`
   - Start command: `npm start`
   - Instance type: **Free** to start (see caveat below) 
   - Region: pick whichever is closest to most of your users
5. Under **Environment**, add every variable from your local `.env` — same
   names, same values: `DATABASE_URL`, `WHATSAPP_TOKEN`,
   `WHATSAPP_PHONE_NUMBER_ID`, `WEBHOOK_VERIFY_TOKEN`, `META_APP_SECRET`,
   `API_KEY`, `MYMEMORY_EMAIL`, `PAGE_ACCESS_TOKEN`, `IG_PAGE_ACCESS_TOKEN`,
   `AUTO_REPLY`
   (`DATABASE_URL` stays your Neon connection string — Render doesn't need
   its own database for this)
6. Deploy — Render builds the app and gives you a permanent HTTPS URL like
   `https://wa-translator.onrender.com` (HTTPS is automatic and required by
   Meta's webhook verification)
7. Apply the database schema to production once: either temporarily change
   the build command to
   `npm install && npx prisma generate && npx prisma migrate deploy`, or run
   `npx prisma migrate deploy` locally with `DATABASE_URL` pointed at the
   same Neon database (it's external, so either approach reaches it)
8. Update the Callback URL for every webhook you've configured in Meta
   (WhatsApp, and Messenger/Instagram if used) to your new Render URL:
   - `https://your-app.onrender.com/webhook`
   - `https://your-app.onrender.com/webhook/meta`
9. ngrok is no longer needed — you can close it for good

> **Free tier caveat:** Render's free web services spin down after ~15
> minutes with no traffic and take 30–60 seconds to wake up on the next
> request. Meta expects a fast webhook response and may treat a slow or
> timed-out endpoint as unhealthy, dropping messages during that cold
> start. Fine for testing; before relying on this for real customers,
> upgrade to the **Starter** instance (~$7/mo), which stays awake
> permanently — cheap insurance once you're actually live.

---

## Step 11 — Testing the four feature fixes specifically

**Dark/light theme:** click the moon/sun icon top-right. Refresh the page —
your choice should persist (stored in the browser and in Settings).

**Unified send/receive:** click any conversation in the left sidebar, type
in the reply box at the bottom, hit send. Your message and the customer's
messages should appear as alternating bubbles in one thread, not separate
lists.

**Facebook/Instagram:** after Steps 8–9, message your Page/IG account from
a personal account — a new conversation should appear in the sidebar
tagged with the right channel badge.

**Duplicate-number fix:** try the Simulate box with the same number in two
different formats, e.g. `+91 77199 56774` and `917719956774` — both should
land in the exact same conversation thread instead of creating two.

---

## Step 12 — Take WhatsApp out of test mode (this is what "going global" actually requires)

Steps 1–11 get your server live and reachable at a real HTTPS URL — but
Meta still restricts who's allowed to message it until you complete this
step. **This is the actual gate between "working for me" and "working for
anyone in the world."**

1. **Business verification** — Meta renamed/reshuffled this a while back, so
   if you go looking for "Business Settings" inside Meta Business Suite and
   can't find it, that's expected — it's no longer a tab in there. Use one
   of these instead:
   - **Fastest:** go directly to **https://business.facebook.com/settings**
     — this drops you straight into the back-end admin area (now sometimes
     labeled **Meta Business Portfolio**) regardless of which front-end
     dashboard you were just in.
   - **Manual path:** from Meta Business Suite, click the **☰ "All tools"**
     menu (far left) → **Ads Manager** → click **☰ "All tools"** again
     (yes, a second time, inside Ads Manager this time) → under **Manage
     Business**, click **Business Settings**.
   Once you're in Business Settings, business verification itself lives
   under **Business Info** (or a **Security Center** entry if your account
   still shows one — Meta is mid-rollout on this, so it varies by account).
   You'll need a registered business (legal business name, address, and a
   document like a tax/company registration number) tied to your Meta
   Business Portfolio. A purely personal account generally can't complete
   this.
2. **App Review** — in your Meta App dashboard → **App Review → Permissions
   and Features**, request `whatsapp_business_messaging` (and
   `pages_messaging` too if you're using Messenger/Instagram). Meta will
   ask for a screen recording showing the full flow: a message coming in,
   translating, and a reply going out.
3. **Switch the app from Development to Live mode** — toggle at the top of
   the App dashboard. This unlocks once Business Verification is approved
   and at least one requested permission is granted.
4. **Message templates** — outside the 24-hour customer service window
   (i.e. you messaging someone who hasn't messaged you recently), WhatsApp
   only allows pre-approved template messages. Create these under
   **WhatsApp Manager → Message Templates**; approval usually takes minutes
   to a couple of days.
5. **Messaging tier / rate limits** — a new WhatsApp Business number starts
   capped (e.g. 250 unique conversations per 24h) and the cap rises
   automatically as your number keeps a healthy quality rating. Don't
   mass-message on day one.
6. **Verified display name (optional but recommended)** — submit a
   business display name for review under **WhatsApp Manager → Phone
   Numbers** so customers see your business name instead of just the raw
   phone number.

Once Business Verification and App Review are both approved and the app is
switched to **Live**, anyone worldwide can message your WhatsApp number —
not just the 5 numbers you manually added as testers.

---

## Final go-live checklist

- [ ] Server deployed on Render with HTTPS and a permanent URL (Step 10)
- [ ] Render on a paid Starter instance (or equivalent) so it never sleeps
- [ ] Neon database schema migrated in production (`prisma migrate deploy`)
- [ ] All `.env` variables set in Render's Environment tab, not just locally
- [ ] `META_APP_SECRET` set — webhook signature verification is active
- [ ] `API_KEY` set to a real random string
- [ ] Permanent WhatsApp token (Step 5) is the one in production
- [ ] Translation verified working in production (MyMemory needs no
      credentials, just confirm it's reachable from your host)
- [ ] Meta webhook Callback URLs updated to the production domain
- [ ] Business Verification submitted and approved
- [ ] App Review approved, app switched to **Live**
- [ ] At least one message template approved, if you'll message customers
      outside the 24-hour window
