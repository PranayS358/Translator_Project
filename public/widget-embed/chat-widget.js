/**
 * Embeddable multilingual chat widget.
 *
 * Drop this on any client site with:
 *   <script src="https://<your-translator-domain>/widget-embed/chat-widget.js"
 *           data-api-base="https://<your-translator-domain>"
 *           data-title="Chat with us"
 *           data-color="#0f766e"></script>
 *
 * The visitor types in whatever language they pick; the site's agent always
 * sees/replies in the primary language configured in the translator
 * dashboard's Settings. Everything is translated both ways automatically.
 */
(function () {
  var THIS_SCRIPT = document.currentScript;

  var API_BASE = (THIS_SCRIPT && THIS_SCRIPT.getAttribute('data-api-base')) || window.location.origin;
  var TITLE = (THIS_SCRIPT && THIS_SCRIPT.getAttribute('data-title')) || 'Chat with us';
  var ACCENT = (THIS_SCRIPT && THIS_SCRIPT.getAttribute('data-color')) || '#0f766e';

  var LANGUAGES = [
    ['en', 'English'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['es', 'Spanish'],
    ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['ru', 'Russian'],
    ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['tr', 'Turkish'],
    ['ur', 'Urdu'], ['bn', 'Bengali'], ['id', 'Indonesian'],
  ];

  function uid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'v-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  var visitorId = localStorage.getItem('wat_visitor_id');
  if (!visitorId) {
    visitorId = uid();
    localStorage.setItem('wat_visitor_id', visitorId);
  }
  var visitorLanguage = localStorage.getItem('wat_visitor_language') || '';

  // ---- Styles (scoped with a wat- prefix so it can't collide with the host page) ----
  var style = document.createElement('style');
  style.textContent =
    '.wat-bubble{position:fixed;bottom:20px;right:20px;width:58px;height:58px;border-radius:50%;' +
    'background:' + ACCENT + ';color:#fff;display:flex;align-items:center;justify-content:center;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer;z-index:999998;border:none;}' +
    '.wat-bubble svg{width:26px;height:26px;}' +
    '.wat-panel{position:fixed;bottom:90px;right:20px;width:340px;max-width:92vw;height:480px;max-height:75vh;' +
    'background:#fff;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.3);display:none;flex-direction:column;' +
    'overflow:hidden;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}' +
    '.wat-panel.open{display:flex;}' +
    '.wat-header{background:' + ACCENT + ';color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:14px;gap:8px;}' +
    '.wat-header button{background:none;border:none;color:#fff;font-size:18px;cursor:pointer;line-height:1;}' +
    '.wat-header .wat-lang-select{margin-right:4px;padding:4px 6px;border-radius:6px;border:1px solid rgba(255,255,255,.6);' +
    'background:rgba(255,255,255,.15);color:#fff;font-size:12px;font-weight:600;cursor:pointer;max-width:110px;}' +
    '.wat-header .wat-lang-select option{color:#111827;}' +
    '.wat-body{flex:1;overflow-y:auto;padding:12px;background:#f6f7f9;display:flex;flex-direction:column;gap:8px;}' +
    '.wat-msg{max-width:78%;padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.4;word-wrap:break-word;}' +
    '.wat-msg.me{align-self:flex-end;background:' + ACCENT + ';color:#fff;}' +
    '.wat-msg.agent{align-self:flex-start;background:#e5e7eb;color:#111827;}' +
    '.wat-footer{border-top:1px solid #e5e7eb;padding:10px;display:flex;gap:8px;background:#fff;}' +
    '.wat-footer input{flex:1;border:1px solid #d1d5db;border-radius:20px;padding:8px 14px;font-size:13px;outline:none;}' +
    '.wat-footer button{background:' + ACCENT + ';color:#fff;border:none;border-radius:20px;padding:0 16px;font-weight:600;cursor:pointer;}' +
    '.wat-loc-btn{background:none!important;color:' + ACCENT + '!important;border:1px solid #d1d5db!important;' +
    'border-radius:50%!important;width:34px;height:34px;padding:0!important;flex-shrink:0;font-size:16px;' +
    'display:flex;align-items:center;justify-content:center;}' +
    '.wat-wa-row{padding:6px 12px;background:#ecfdf5;border-top:1px solid #d1fae5;font-size:11px;color:#065f46;display:flex;gap:6px;align-items:center;justify-content:space-between;}' +
    '.wat-wa-row a, .wat-wa-row button{font-size:11px;color:' + ACCENT + ';background:none;border:none;cursor:pointer;font-weight:600;text-decoration:underline;padding:0;}' +
    '.wat-wa-form{padding:8px 12px;background:#ecfdf5;display:none;gap:6px;}' +
    '.wat-wa-form.open{display:flex;}' +
    '.wat-wa-form input{flex:1;border:1px solid #a7f3d0;border-radius:8px;padding:6px 8px;font-size:12px;}' +
    '.wat-wa-form button{background:' + ACCENT + ';color:#fff;border:none;border-radius:8px;padding:0 10px;font-size:12px;cursor:pointer;}';
  document.head.appendChild(style);

  // ---- DOM ----
  var bubble = document.createElement('button');
  bubble.className = 'wat-bubble';
  bubble.setAttribute('aria-label', 'Open chat');
  bubble.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  var panel = document.createElement('div');
  panel.className = 'wat-panel';
  panel.innerHTML =
    '<div class="wat-header"><span>' + TITLE + '</span>' +
      '<span style="display:flex;align-items:center;">' +
        '<select class="wat-lang-select" title="Change language" aria-label="Change language"></select>' +
        '<button class="wat-close" aria-label="Close">✕</button>' +
      '</span>' +
    '</div>' +
    '<div class="wat-body" style="display:none"></div>' +
    '<div class="wat-wa-row" style="display:none">' +
      '<span>Prefer WhatsApp?</span>' +
      '<button class="wat-wa-toggle">Continue there</button>' +
    '</div>' +
    '<div class="wat-wa-form">' +
      '<input class="wat-wa-phone" placeholder="Your WhatsApp number, e.g. 9198xxxxxxx" />' +
      '<button class="wat-wa-send">Link</button>' +
    '</div>' +
    '<div class="wat-footer" style="display:none">' +
      '<button class="wat-loc-btn" type="button" title="Share my current location" aria-label="Share my current location">📍</button>' +
      '<input class="wat-input" placeholder="Type a message…" />' +
      '<button class="wat-send">Send</button>' +
    '</div>';

  document.body.appendChild(bubble);
  document.body.appendChild(panel);

  var langSelect = panel.querySelector('.wat-lang-select');
  var body = panel.querySelector('.wat-body');
  var footer = panel.querySelector('.wat-footer');
  var input = panel.querySelector('.wat-input');
  var sendBtn = panel.querySelector('.wat-send');
  var locBtn = panel.querySelector('.wat-loc-btn');
  var waRow = panel.querySelector('.wat-wa-row');
  // No separate `waToggle` reference kept here - waRow's "Continue there"
  // button gets replaced/re-bound by syncWaRow() below every time the
  // linked status changes (or on first load), so the toggle listener lives
  // there instead of on a variable that could go stale the moment that
  // happens.
  var waForm = panel.querySelector('.wat-wa-form');
  var waPhone = panel.querySelector('.wat-wa-phone');
  var waSend = panel.querySelector('.wat-wa-send');

  LANGUAGES.forEach(function (pair) {
    var opt = document.createElement('option');
    opt.value = pair[0];
    opt.textContent = pair[1];
    langSelect.appendChild(opt);
  });
  // Preselect whatever's already known (explicit prior choice, or whatever
  // the backend auto-detected on an earlier message) rather than defaulting
  // to English, so the dropdown always reflects the conversation's actual
  // current language.
  langSelect.value = visitorLanguage || localStorage.getItem('wat_visitor_language') || 'en';

  function showChatUI() {
    body.style.display = 'flex';
    footer.style.display = 'flex';
    waRow.style.display = 'flex';
    loadMessages();
  }

  // No more forcing a language pick before chatting starts - the backend
  // auto-detects the visitor's language from their first message and locks
  // it in for the rest of the conversation. The always-visible dropdown in
  // the header lets them correct it at any point instead.
  showChatUI();

  // Every message from here on uses the newly selected language, both for
  // what they send and for how the agent's replies are translated back.
  langSelect.addEventListener('change', function () {
    visitorLanguage = langSelect.value;
    localStorage.setItem('wat_visitor_language', visitorLanguage);
  });

  bubble.addEventListener('click', function () {
    panel.classList.add('open');
  });
  panel.querySelector('.wat-close').addEventListener('click', function () {
    panel.classList.remove('open');
  });

  // The dashboard and this widget both receive mediaUrl as a lightweight
  // `/media/:id` reference (see toPublicMessage in src/conversations.js) -
  // a relative path deliberately, since the dashboard is served from the
  // SAME origin as that route. This widget isn't: it's embedded on a
  // client's own site (e.g. the healthcare demo), so a bare "/media/..."
  // resolves against THAT site's origin instead of the translator API's,
  // producing a broken image. Resolve it against API_BASE explicitly.
  function resolveMediaUrl(url) {
    if (!url) return url;
    if (/^https?:\/\//i.test(url) || url.indexOf('data:') === 0) return url;
    return API_BASE.replace(/\/$/, '') + url;
  }

  var renderedCount = 0;
  function render(messages) {
    if (messages.length === renderedCount) return;
    body.innerHTML = '';
    messages.forEach(function (m) {
      var div = document.createElement('div');
      div.className = 'wat-msg ' + (m.direction === 'inbound' ? 'me' : 'agent');
      var text = m.direction === 'inbound' ? m.originalText : (m.translatedText || m.originalText);
      var mediaUrl = resolveMediaUrl(m.mediaUrl);

      if (m.messageType === 'image' && mediaUrl) {
        var img = document.createElement('img');
        img.src = mediaUrl;
        img.style.cssText = 'max-width:100%;border-radius:8px;display:block;';
        div.appendChild(img);
        if (text && text !== '[image]') {
          var caption = document.createElement('div');
          caption.style.marginTop = '4px';
          caption.textContent = text;
          div.appendChild(caption);
        }
      } else if (m.messageType === 'video' && mediaUrl) {
        var video = document.createElement('video');
        video.src = mediaUrl;
        video.controls = true;
        video.style.cssText = 'max-width:100%;border-radius:8px;display:block;';
        div.appendChild(video);
      } else if (m.messageType === 'audio' && mediaUrl) {
        var audio = document.createElement('audio');
        audio.src = mediaUrl;
        audio.controls = true;
        audio.style.maxWidth = '100%';
        div.appendChild(audio);
      } else if (m.messageType === 'document' && mediaUrl) {
        var docLink = document.createElement('a');
        docLink.href = mediaUrl;
        docLink.download = m.fileName || 'file';
        docLink.textContent = '📄 ' + (m.fileName || 'Document');
        docLink.style.cssText = 'color:inherit;text-decoration:underline;';
        div.appendChild(docLink);
      } else if (m.messageType === 'location') {
        var coords = {};
        try { coords = JSON.parse(m.extra || '{}'); } catch (e) {}
        var mapLink = document.createElement('a');
        mapLink.href = 'https://www.google.com/maps?q=' + coords.latitude + ',' + coords.longitude;
        mapLink.target = '_blank';
        mapLink.rel = 'noopener';
        mapLink.textContent = '📍 Shared location';
        mapLink.style.cssText = 'color:inherit;text-decoration:underline;';
        div.appendChild(mapLink);
      } else if (m.messageType === 'contact') {
        var c = {};
        try { c = JSON.parse(m.extra || '{}'); } catch (e) {}
        div.textContent = '👤 ' + (c.name || '') + (c.phone ? ' — ' + c.phone : '');
      } else {
        div.textContent = text;
      }

      body.appendChild(div);
    });
    body.scrollTop = body.scrollHeight;
    renderedCount = messages.length;
  }

  // Keeps the "Prefer WhatsApp?" row honest on every poll, instead of only
  // ever being set once client-side at the moment of a successful link (see
  // the waSend handler below) and never touched again. That one-time flag
  // used to go stale: if this conversation got deleted (e.g. via "Delete
  // chat" in the dashboard) and the visitor kept the same tab open, the
  // NEXT message they sent silently created a brand new, unlinked
  // conversation row under the same visitorId - but the banner kept saying
  // "Linked!" from the old, now-gone one, so a patient could reply on
  // WhatsApp and never see it reflected here (their message went to
  // whichever OTHER conversation, if any, still actually held that link).
  var waLinkedShown = null; // tri-state cache (null/true/false) - avoids re-touching the DOM every 4s poll when nothing changed
  function syncWaRow(linkedWhatsapp, waLink) {
    var isLinked = !!linkedWhatsapp;
    if (isLinked === waLinkedShown) return;
    waLinkedShown = isLinked;
    if (isLinked) {
      waForm.classList.remove('open');
      waRow.innerHTML = '<span>Linked! </span><a href="' + waLink + '" target="_blank" rel="noopener">Open WhatsApp</a>';
    } else {
      waRow.innerHTML = '<span>Prefer WhatsApp?</span><button class="wat-wa-toggle">Continue there</button>';
      waRow.querySelector('.wat-wa-toggle').addEventListener('click', function () {
        waForm.classList.toggle('open');
      });
    }
  }

  function loadMessages() {
    fetch(API_BASE + '/widget-api/messages?visitorId=' + encodeURIComponent(visitorId))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        render(data.messages || []);
        syncWaRow(data.linkedWhatsapp, data.waLink);
      })
      .catch(function () {});
  }

  function send() {
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    // Only send `language` when the visitor explicitly picked one via
    // "change language" - otherwise leave it out so the backend auto-detects
    // (first message) or keeps using the conversation's already-locked
    // language (every message after that).
    fetch(API_BASE + '/widget-api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: visitorId, text: text, language: visitorLanguage || undefined }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        // Keep local state (and the header dropdown) in sync with whatever
        // the backend locked in - auto-detected on message 1, or whatever
        // was explicitly picked - so the dropdown always shows the
        // conversation's actual current language.
        if (data.detectedLanguage) {
          visitorLanguage = data.detectedLanguage;
          localStorage.setItem('wat_visitor_language', visitorLanguage);
          langSelect.value = visitorLanguage;
        }
        loadMessages();
      })
      .catch(function () {});
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') send();
  });

  // Lets a patient share their live GPS position instead of typing an
  // address — mainly useful mid-way through the bot's ambulance/emergency
  // flow (src/groq.js), which explicitly points them at this button, but
  // works any time (e.g. "which branch is closest to me").
  locBtn.addEventListener('click', function () {
    if (!navigator.geolocation) {
      alert('Location sharing isn\'t supported by this browser.');
      return;
    }
    locBtn.disabled = true;
    locBtn.textContent = '…';
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        fetch(API_BASE + '/widget-api/location', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            visitorId: visitorId,
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
          }),
        })
          .then(function () { loadMessages(); })
          .catch(function () {})
          .finally(function () { locBtn.disabled = false; locBtn.textContent = '📍'; });
      },
      function () {
        alert('Couldn\'t get your location — please check your browser\'s location permission, or just type your address instead.');
        locBtn.disabled = false;
        locBtn.textContent = '📍';
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // Not attached here anymore - the very first loadMessages() poll (fired by
  // showChatUI() above) immediately rebuilds waRow's markup via syncWaRow()
  // and (re)attaches this same toggle behavior to whatever button ends up in
  // it. See syncWaRow()'s "not linked" branch.

  waSend.addEventListener('click', function () {
    var phone = waPhone.value.trim();
    if (!phone) return;
    // This request silently doing nothing on failure is exactly how a
    // patient can walk away believing they're linked when they're not -
    // they see no error, switch to WhatsApp, and their reply lands in a
    // brand new, unlinked conversation instead of this one. So: disable
    // the button while in flight (no accidental double-submits), and make
    // BOTH a server-side error and a network/CORS failure clearly visible
    // and retryable, instead of failing silently.
    waSend.disabled = true;
    var originalLabel = waSend.textContent;
    waSend.textContent = '…';
    fetch(API_BASE + '/widget-api/link-whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: visitorId, phone: phone }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.waLink) {
          waForm.classList.remove('open');
          // Instant feedback rather than waiting up to 4s for the next
          // poll - syncWaRow() (called from loadMessages()) will also pick
          // this up on schedule and is what keeps it honest from here on.
          // Deliberately NOT calling window.open() here: that call happens
          // async (after this fetch resolves), which most mobile browsers'
          // popup blockers treat as not user-initiated and silently block -
          // another way this "worked" but the patient never actually saw
          // WhatsApp open. The rendered "Open WhatsApp" link below is a
          // real click the patient makes themselves, so it always works.
          waLinkedShown = true;
          waRow.innerHTML = '<span>Linked! </span><a href="' + data.waLink + '" target="_blank" rel="noopener">Open WhatsApp</a>';
        } else if (data.error) {
          alert('Couldn\'t link WhatsApp: ' + data.error);
        } else {
          alert('Couldn\'t link WhatsApp - please try again.');
        }
      })
      .catch(function () {
        alert('Couldn\'t link WhatsApp - check your connection and try again.');
      })
      .finally(function () {
        waSend.disabled = false;
        waSend.textContent = originalLabel;
      });
  });

  setInterval(function () {
    if (panel.classList.contains('open')) loadMessages();
  }, 4000);
})();
