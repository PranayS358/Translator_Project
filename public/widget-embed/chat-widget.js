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
    '.wat-header{background:' + ACCENT + ';color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:14px;}' +
    '.wat-header button{background:none;border:none;color:#fff;font-size:18px;cursor:pointer;line-height:1;}' +
    '.wat-header .wat-lang-change{font-size:15px;margin-right:10px;}' +
    '.wat-body{flex:1;overflow-y:auto;padding:12px;background:#f6f7f9;display:flex;flex-direction:column;gap:8px;}' +
    '.wat-msg{max-width:78%;padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.4;word-wrap:break-word;}' +
    '.wat-msg.me{align-self:flex-end;background:' + ACCENT + ';color:#fff;}' +
    '.wat-msg.agent{align-self:flex-start;background:#e5e7eb;color:#111827;}' +
    '.wat-lang{padding:16px;font-size:13px;color:#374151;}' +
    '.wat-lang select{width:100%;padding:8px;margin-top:8px;border-radius:8px;border:1px solid #d1d5db;font-size:13px;}' +
    '.wat-lang button{margin-top:12px;width:100%;padding:9px;border:none;border-radius:8px;background:' + ACCENT + ';color:#fff;font-weight:600;cursor:pointer;}' +
    '.wat-footer{border-top:1px solid #e5e7eb;padding:10px;display:flex;gap:8px;background:#fff;}' +
    '.wat-footer input{flex:1;border:1px solid #d1d5db;border-radius:20px;padding:8px 14px;font-size:13px;outline:none;}' +
    '.wat-footer button{background:' + ACCENT + ';color:#fff;border:none;border-radius:20px;padding:0 16px;font-weight:600;cursor:pointer;}' +
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
      '<span>' +
        '<button class="wat-lang-change" aria-label="Change language" title="Change language">🌐</button>' +
        '<button class="wat-close" aria-label="Close">✕</button>' +
      '</span>' +
    '</div>' +
    '<div class="wat-lang" style="display:none">' +
      'Pick your language to start chatting:' +
      '<select class="wat-lang-select"></select>' +
      '<button class="wat-lang-go">Start chat</button>' +
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
      '<input class="wat-input" placeholder="Type a message…" />' +
      '<button class="wat-send">Send</button>' +
    '</div>';

  document.body.appendChild(bubble);
  document.body.appendChild(panel);

  var langBox = panel.querySelector('.wat-lang');
  var langSelect = panel.querySelector('.wat-lang-select');
  var langGo = panel.querySelector('.wat-lang-go');
  var body = panel.querySelector('.wat-body');
  var footer = panel.querySelector('.wat-footer');
  var input = panel.querySelector('.wat-input');
  var sendBtn = panel.querySelector('.wat-send');
  var waRow = panel.querySelector('.wat-wa-row');
  var waToggle = panel.querySelector('.wat-wa-toggle');
  var waForm = panel.querySelector('.wat-wa-form');
  var waPhone = panel.querySelector('.wat-wa-phone');
  var waSend = panel.querySelector('.wat-wa-send');

  LANGUAGES.forEach(function (pair) {
    var opt = document.createElement('option');
    opt.value = pair[0];
    opt.textContent = pair[1];
    langSelect.appendChild(opt);
  });

  function showChatUI() {
    langBox.style.display = 'none';
    body.style.display = 'flex';
    footer.style.display = 'flex';
    waRow.style.display = 'flex';
    loadMessages();
  }

  // No more forcing a language pick before chatting starts - the backend
  // auto-detects the visitor's language from their first message and locks
  // it in for the rest of the conversation. The picker only reappears if
  // they explicitly tap "change language" below.
  showChatUI();

  langGo.addEventListener('click', function () {
    visitorLanguage = langSelect.value;
    localStorage.setItem('wat_visitor_language', visitorLanguage);
    showChatUI();
  });

  // Lets a visitor correct their language at any point instead of being
  // stuck with whatever they (or a stale browser session) picked first -
  // every message from here on uses the newly selected language, both
  // for what they send and for how the agent's replies are translated back.
  panel.querySelector('.wat-lang-change').addEventListener('click', function () {
    // Preselect whatever they're currently using (explicit override, or
    // whatever the backend auto-detected, echoed back on the last send)
    // rather than defaulting the dropdown back to English.
    var current = visitorLanguage || localStorage.getItem('wat_visitor_language');
    if (current) langSelect.value = current;
    body.style.display = 'none';
    footer.style.display = 'none';
    waRow.style.display = 'none';
    langBox.style.display = 'block';
  });

  bubble.addEventListener('click', function () {
    panel.classList.add('open');
  });
  panel.querySelector('.wat-close').addEventListener('click', function () {
    panel.classList.remove('open');
  });

  var renderedCount = 0;
  function render(messages) {
    if (messages.length === renderedCount) return;
    body.innerHTML = '';
    messages.forEach(function (m) {
      var div = document.createElement('div');
      div.className = 'wat-msg ' + (m.direction === 'inbound' ? 'me' : 'agent');
      div.textContent = m.direction === 'inbound' ? m.originalText : (m.translatedText || m.originalText);
      body.appendChild(div);
    });
    body.scrollTop = body.scrollHeight;
    renderedCount = messages.length;
  }

  function loadMessages() {
    fetch(API_BASE + '/widget-api/messages?visitorId=' + encodeURIComponent(visitorId))
      .then(function (r) { return r.json(); })
      .then(function (data) { render(data.messages || []); })
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
        // Keep local state in sync with whatever the backend locked in
        // (auto-detected on message 1, or whatever we explicitly sent) so
        // the "change language" picker preselects the right one later.
        if (data.detectedLanguage) {
          visitorLanguage = data.detectedLanguage;
          localStorage.setItem('wat_visitor_language', visitorLanguage);
        }
        loadMessages();
      })
      .catch(function () {});
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') send();
  });

  waToggle.addEventListener('click', function () {
    waForm.classList.toggle('open');
  });

  waSend.addEventListener('click', function () {
    var phone = waPhone.value.trim();
    if (!phone) return;
    fetch(API_BASE + '/widget-api/link-whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: visitorId, phone: phone }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.waLink) {
          waForm.classList.remove('open');
          waRow.innerHTML = '<span>Linked! </span><a href="' + data.waLink + '" target="_blank" rel="noopener">Open WhatsApp</a>';
          window.open(data.waLink, '_blank');
        } else if (data.error) {
          alert(data.error);
        }
      })
      .catch(function () {});
  });

  setInterval(function () {
    if (panel.classList.contains('open')) loadMessages();
  }, 4000);
})();
