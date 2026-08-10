/**
 * Embeddable multilingual chat widget.
 *
 * Drop this on any client site with:
 *   <script src="https://<your-translator-domain>/widget-embed/chat-widget.js"
 *           data-api-base="https://<your-translator-domain>"
 *           data-title="Chat with us"
 *           data-color="#0f766e"></script>
 *
 * Patients sign up / log in before they can chat (see the auth screen
 * below) - that's what lets one patient have several separate chats (one
 * per booking, say) all listed together, and what makes booking an
 * appointment or any other service require an account. The patient types
 * in whatever language they pick; the site's agent always sees/replies in
 * the primary language configured in the translator dashboard's Settings.
 * Everything is translated both ways automatically.
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

  var TOKEN_KEY = 'wat_patient_token';
  var authToken = localStorage.getItem(TOKEN_KEY) || null;
  var authPatient = null; // { id, name, email } - set once /me or /login or /signup succeeds
  var activeChatId = null; // current chat's contactKey - null until a chat is loaded/created
  var visitorLanguage = localStorage.getItem('wat_visitor_language') || '';

  function authHeaders() {
    return authToken ? { 'Authorization': 'Bearer ' + authToken } : {};
  }

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
    '.wat-header .wat-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.wat-header-actions{display:flex;align-items:center;gap:4px;flex-shrink:0;}' +
    '.wat-header button{background:none;border:none;color:#fff;font-size:18px;cursor:pointer;line-height:1;}' +
    '.wat-icon-btn{background:rgba(255,255,255,.15)!important;border-radius:6px!important;padding:4px 7px!important;font-size:12px!important;font-weight:600;white-space:nowrap;}' +
    '.wat-header .wat-lang-select{margin-right:4px;padding:4px 6px;border-radius:6px;border:1px solid rgba(255,255,255,.6);' +
    'background:rgba(255,255,255,.15);color:#fff;font-size:12px;font-weight:600;cursor:pointer;max-width:90px;}' +
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
    '.wat-wa-form button{background:' + ACCENT + ';color:#fff;border:none;border-radius:8px;padding:0 10px;font-size:12px;cursor:pointer;}' +
    // Auth screen (login/signup) - fills the body area in place of messages
    // until the patient signs in.
    '.wat-auth{flex:1;overflow-y:auto;padding:20px 18px;background:#fff;display:flex;flex-direction:column;gap:10px;}' +
    '.wat-auth h3{margin:0 0 2px;font-size:15px;color:#111827;}' +
    '.wat-auth p.wat-auth-sub{margin:0 0 8px;font-size:12px;color:#6b7280;}' +
    '.wat-auth input{border:1px solid #d1d5db;border-radius:8px;padding:9px 12px;font-size:13px;outline:none;}' +
    '.wat-auth input:focus{border-color:' + ACCENT + ';}' +
    '.wat-auth-submit{background:' + ACCENT + ';color:#fff;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;margin-top:4px;}' +
    '.wat-auth-submit:disabled{opacity:.6;cursor:default;}' +
    '.wat-auth-toggle{background:none;border:none;color:' + ACCENT + ';font-size:12px;cursor:pointer;text-decoration:underline;padding:0;margin-top:2px;align-self:flex-start;}' +
    '.wat-auth-error{color:#b91c1c;font-size:12px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:6px 8px;display:none;}' +
    '.wat-auth-error.show{display:block;}' +
    // Chat list overlay - toggled by the "Chats" header button
    '.wat-chats-panel{position:absolute;top:52px;left:0;right:0;bottom:0;background:#fff;z-index:5;display:none;flex-direction:column;overflow-y:auto;}' +
    '.wat-chats-panel.open{display:flex;}' +
    '.wat-chats-panel-header{padding:10px 14px;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.03em;border-bottom:1px solid #f0f0f0;}' +
    '.wat-chat-item{padding:12px 14px;border-bottom:1px solid #f3f4f6;cursor:pointer;display:flex;flex-direction:column;gap:2px;}' +
    '.wat-chat-item:hover{background:#f9fafb;}' +
    '.wat-chat-item.active{background:#ecfdf5;}' +
    '.wat-chat-item .wat-chat-preview{font-size:12px;color:#4b5563;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.wat-chat-item .wat-chat-time{font-size:10px;color:#9ca3af;}' +
    '.wat-chats-empty{padding:20px 14px;font-size:12px;color:#9ca3af;text-align:center;}';
  document.head.appendChild(style);

  // ---- DOM ----
  var bubble = document.createElement('button');
  bubble.className = 'wat-bubble';
  bubble.setAttribute('aria-label', 'Open chat');
  bubble.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  var panel = document.createElement('div');
  panel.className = 'wat-panel';
  // No inline position here - the .wat-panel CSS class already sets
  // position:fixed (floating bottom-right), which on its own already
  // establishes the containing block the absolutely-positioned
  // .wat-chats-panel overlay needs. Setting position:relative here as an
  // inline style used to override that fixed positioning entirely (inline
  // styles beat class rules) and silently broke the whole panel - it was
  // still in the DOM and "open", just laid out in normal document flow
  // instead of floating over the page, so nobody could see it.
  panel.innerHTML =
    '<div class="wat-header">' +
      '<span class="wat-title">' + TITLE + '</span>' +
      '<span class="wat-header-actions">' +
        '<button class="wat-icon-btn wat-chats-toggle" title="Your chats" style="display:none">Chats</button>' +
        '<button class="wat-icon-btn wat-new-chat" title="Start a new chat" style="display:none">+ New</button>' +
        '<select class="wat-lang-select" title="Change language" aria-label="Change language"></select>' +
        '<button class="wat-close" aria-label="Close">✕</button>' +
      '</span>' +
    '</div>' +
    '<div class="wat-auth" style="display:none"></div>' +
    '<div class="wat-chats-panel"></div>' +
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
  var authBox = panel.querySelector('.wat-auth');
  var chatsPanel = panel.querySelector('.wat-chats-panel');
  var chatsToggle = panel.querySelector('.wat-chats-toggle');
  var newChatBtn = panel.querySelector('.wat-new-chat');
  var body = panel.querySelector('.wat-body');
  var footer = panel.querySelector('.wat-footer');
  var input = panel.querySelector('.wat-input');
  var sendBtn = panel.querySelector('.wat-send');
  var locBtn = panel.querySelector('.wat-loc-btn');
  var waRow = panel.querySelector('.wat-wa-row');
  var waForm = panel.querySelector('.wat-wa-form');
  var waPhone = panel.querySelector('.wat-wa-phone');
  var waSend = panel.querySelector('.wat-wa-send');

  LANGUAGES.forEach(function (pair) {
    var opt = document.createElement('option');
    opt.value = pair[0];
    opt.textContent = pair[1];
    langSelect.appendChild(opt);
  });
  langSelect.value = visitorLanguage || 'en';

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

  // ── Auth screen ──────────────────────────────────────────────────────
  var authMode = 'login'; // 'login' | 'signup'

  function renderAuthScreen() {
    var isLogin = authMode === 'login';
    authBox.innerHTML =
      '<h3>' + (isLogin ? 'Log in to chat' : 'Create your account') + '</h3>' +
      '<p class="wat-auth-sub">' + (isLogin
        ? 'Sign in to start chatting and book appointments or other services.'
        : 'One account lets you keep track of every chat - appointments, tests, and more.') + '</p>' +
      '<div class="wat-auth-error"></div>' +
      (isLogin ? '' : '<input class="wat-auth-name" placeholder="Full name" />') +
      '<input class="wat-auth-email" type="email" placeholder="Email address" />' +
      '<input class="wat-auth-password" type="password" placeholder="Password" />' +
      '<button class="wat-auth-submit">' + (isLogin ? 'Log in' : 'Sign up') + '</button>' +
      '<button class="wat-auth-toggle">' + (isLogin
        ? "Don't have an account? Sign up"
        : 'Already have an account? Log in') + '</button>';

    authBox.querySelector('.wat-auth-toggle').addEventListener('click', function () {
      authMode = isLogin ? 'signup' : 'login';
      renderAuthScreen();
    });
    authBox.querySelector('.wat-auth-submit').addEventListener('click', submitAuthForm);
    [].forEach.call(authBox.querySelectorAll('input'), function (el) {
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAuthForm(); });
    });
  }

  function showAuthError(message) {
    var el = authBox.querySelector('.wat-auth-error');
    el.textContent = message;
    el.classList.add('show');
  }

  function submitAuthForm() {
    var isLogin = authMode === 'login';
    var email = authBox.querySelector('.wat-auth-email').value.trim();
    var password = authBox.querySelector('.wat-auth-password').value;
    var name = !isLogin ? authBox.querySelector('.wat-auth-name').value.trim() : undefined;

    if (!email || !password || (!isLogin && !name)) {
      showAuthError('Please fill in all fields.');
      return;
    }

    var submitBtn = authBox.querySelector('.wat-auth-submit');
    submitBtn.disabled = true;
    var originalLabel = submitBtn.textContent;
    submitBtn.textContent = '…';

    fetch(API_BASE + '/widget-api/' + (isLogin ? 'login' : 'signup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isLogin ? { email: email, password: password } : { name: name, email: email, password: password }),
    })
      .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
      .then(function (res) {
        if (res.status >= 200 && res.status < 300 && res.data.token) {
          authToken = res.data.token;
          authPatient = res.data.patient;
          localStorage.setItem(TOKEN_KEY, authToken);
          enterChatUI();
        } else {
          showAuthError(res.data.error || 'Something went wrong - please try again.');
        }
      })
      .catch(function () {
        showAuthError('Network error - please check your connection and try again.');
      })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      });
  }

  function showAuthScreen() {
    authToken = null;
    authPatient = null;
    activeChatId = null;
    localStorage.removeItem(TOKEN_KEY);
    authMode = 'login';
    renderAuthScreen();
    authBox.style.display = 'flex';
    chatsPanel.classList.remove('open');
    body.style.display = 'none';
    footer.style.display = 'none';
    waRow.style.display = 'none';
    waForm.classList.remove('open');
    chatsToggle.style.display = 'none';
    newChatBtn.style.display = 'none';
  }

  // ── Chat UI (post-login) ────────────────────────────────────────────

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

  var waLinkedShown = null; // tri-state cache (null/true/false), reset whenever the active chat changes
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

  // Handles an expired/invalid token showing up mid-session (e.g. the JWT's
  // 30-day expiry lapses while the tab's been open) - bounce back to the
  // auth screen instead of silently failing every request from here on.
  function handleAuthFailure() {
    showAuthScreen();
  }

  function loadMessages() {
    if (!activeChatId) return;
    fetch(API_BASE + '/widget-api/messages?chatId=' + encodeURIComponent(activeChatId), { headers: authHeaders() })
      .then(function (r) {
        if (r.status === 401) { handleAuthFailure(); return null; }
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        render(data.messages || []);
        syncWaRow(data.linkedWhatsapp, data.waLink);
      })
      .catch(function () {});
  }

  function send() {
    var text = input.value.trim();
    if (!text || !activeChatId) return;
    input.value = '';
    fetch(API_BASE + '/widget-api/message', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ chatId: activeChatId, text: text, language: visitorLanguage || undefined }),
    })
      .then(function (r) {
        if (r.status === 401) { handleAuthFailure(); return null; }
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.detectedLanguage) {
          visitorLanguage = data.detectedLanguage;
          localStorage.setItem('wat_visitor_language', visitorLanguage);
          langSelect.value = visitorLanguage;
        }
        loadMessages();
        refreshChatsList(); // keeps the chat list's preview/order in sync
      })
      .catch(function () {});
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') send();
  });

  locBtn.addEventListener('click', function () {
    if (!activeChatId) return;
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
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
          body: JSON.stringify({
            chatId: activeChatId,
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
          }),
        })
          .then(function (r) { if (r.status === 401) handleAuthFailure(); })
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

  waSend.addEventListener('click', function () {
    var phone = waPhone.value.trim();
    if (!phone || !activeChatId) return;
    waSend.disabled = true;
    var originalLabel = waSend.textContent;
    waSend.textContent = '…';
    fetch(API_BASE + '/widget-api/link-whatsapp', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ chatId: activeChatId, phone: phone }),
    })
      .then(function (r) {
        if (r.status === 401) { handleAuthFailure(); return null; }
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.waLink) {
          waForm.classList.remove('open');
          // Not calling window.open() here - it happens async (after this
          // fetch resolves), which most mobile browsers' popup blockers
          // treat as not user-initiated and silently block. The rendered
          // "Open WhatsApp" link below is a real click the patient makes
          // themselves, so it always works.
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

  // ── Multiple chats per patient ──────────────────────────────────────
  // "New Chat" starts a fresh, empty thread (e.g. one to book an
  // appointment, a separate one later for a diagnostic test); the "Chats"
  // button lists every thread this patient has started so far so they can
  // switch back to an older one instead of losing track of it.

  function formatChatTime(iso) {
    try {
      var d = new Date(iso);
      var now = new Date();
      var sameDay = d.toDateString() === now.toDateString();
      return sameDay
        ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  var chatsCache = [];
  function renderChatsList() {
    if (!chatsCache.length) {
      chatsPanel.innerHTML = '<div class="wat-chats-panel-header">Your chats</div><div class="wat-chats-empty">No chats yet — tap "+ New" to start one.</div>';
      return;
    }
    var html = '<div class="wat-chats-panel-header">Your chats</div>';
    chatsCache.forEach(function (c) {
      var preview = c.lastMessage ? c.lastMessage : 'No messages yet';
      html += '<div class="wat-chat-item' + (c.chatId === activeChatId ? ' active' : '') + '" data-chat-id="' + c.chatId + '">' +
        '<div class="wat-chat-preview">' + preview.replace(/</g, '&lt;') + '</div>' +
        '<div class="wat-chat-time">' + formatChatTime(c.lastMessageAt) + '</div>' +
      '</div>';
    });
    chatsPanel.innerHTML = html;
    [].forEach.call(chatsPanel.querySelectorAll('.wat-chat-item'), function (el) {
      el.addEventListener('click', function () { switchChat(el.getAttribute('data-chat-id')); });
    });
  }

  function refreshChatsList() {
    if (!authToken) return;
    fetch(API_BASE + '/widget-api/chats', { headers: authHeaders() })
      .then(function (r) {
        if (r.status === 401) { handleAuthFailure(); return null; }
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        chatsCache = data.chats || [];
        renderChatsList();
      })
      .catch(function () {});
  }

  function switchChat(chatId) {
    if (chatId === activeChatId) { chatsPanel.classList.remove('open'); return; }
    activeChatId = chatId;
    renderedCount = 0;
    waLinkedShown = null;
    chatsPanel.classList.remove('open');
    renderChatsList();
    loadMessages();
  }

  function startNewChat() {
    if (!authToken) return;
    newChatBtn.disabled = true;
    fetch(API_BASE + '/widget-api/chats', {
      method: 'POST',
      headers: authHeaders(),
    })
      .then(function (r) {
        if (r.status === 401) { handleAuthFailure(); return null; }
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.chatId) return;
        activeChatId = data.chatId;
        renderedCount = 0;
        waLinkedShown = null;
        render([]);
        chatsPanel.classList.remove('open');
        loadMessages();
        refreshChatsList();
      })
      .catch(function () {})
      .finally(function () { newChatBtn.disabled = false; });
  }

  newChatBtn.addEventListener('click', startNewChat);
  chatsToggle.addEventListener('click', function () {
    chatsPanel.classList.toggle('open');
    if (chatsPanel.classList.contains('open')) refreshChatsList();
  });

  // ── Boot ─────────────────────────────────────────────────────────────

  function showChatUI() {
    authBox.style.display = 'none';
    body.style.display = 'flex';
    footer.style.display = 'flex';
    waRow.style.display = 'flex';
    chatsToggle.style.display = '';
    newChatBtn.style.display = '';
  }

  // After a successful login/signup (or a valid token restored on page
  // load): show the chat UI, then load this patient's chats - resuming
  // their most recently active one, or creating their very first chat if
  // they have none yet.
  function enterChatUI() {
    showChatUI();
    fetch(API_BASE + '/widget-api/chats', { headers: authHeaders() })
      .then(function (r) {
        if (r.status === 401) { handleAuthFailure(); return null; }
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        chatsCache = data.chats || [];
        if (chatsCache.length) {
          activeChatId = chatsCache[0].chatId; // most recently created/updated - see GET /widget-api/chats ordering
          renderChatsList();
          loadMessages();
        } else {
          startNewChat();
        }
      })
      .catch(function () {});
  }

  if (authToken) {
    // Validate the stored token before committing to the chat UI - it may
    // have expired since the last visit.
    fetch(API_BASE + '/widget-api/me', { headers: authHeaders() })
      .then(function (r) { return r.status === 200 ? r.json() : null; })
      .then(function (data) {
        if (data && data.patient) {
          authPatient = data.patient;
          enterChatUI();
        } else {
          showAuthScreen();
        }
      })
      .catch(function () { showAuthScreen(); });
  } else {
    showAuthScreen();
  }

  setInterval(function () {
    if (panel.classList.contains('open') && authToken && activeChatId) loadMessages();
  }, 4000);
})();
