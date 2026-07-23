const el = (id) => document.getElementById(id);
let activeConversationId = null;
let conversationsCache = [];
let messagesCache = [];
let apiKey = null;
let mediaRecorder = null;
let recordedChunks = [];
let cameraStream = null;

async function fetchJSON(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (apiKey) headers['x-api-key'] = apiKey;
  const res = await fetch(url, { ...options, headers });
  return res.json();
}

// Fetches the API key (if one is set) so every /api/* call below is
// authorized. Must resolve before anything else touches /api/*.
async function loadClientConfig() {
  try {
    const cfg = await fetchJSON('/client-config');
    apiKey = cfg.apiKey || null;
  } catch {
    apiKey = null;
  }
}

// ── Theme ────────────────────────────────────────────────────────────────

const THEME_LIST = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'whatsapp', label: 'WhatsApp Green' },
  { value: 'ocean', label: 'Ocean' },
  { value: 'rose', label: 'Rose' },
];
const VALID_THEMES = THEME_LIST.map((t) => t.value);

// Simple line-style icons using currentColor, so they automatically pick up
// each theme's --text color on the --panel background (dark icon on a light
// button in light mode, light icon on a dark button in dark mode).
const SUN_ICON = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
const MOON_ICON = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

function applyTheme(theme) {
  if (!VALID_THEMES.includes(theme)) theme = 'light';
  document.documentElement.setAttribute('data-theme', theme);
  el('theme-toggle').innerHTML = theme === 'dark' ? MOON_ICON : SUN_ICON;
  localStorage.setItem('theme', theme);
}

el('theme-toggle').addEventListener('click', async () => {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  await fetchJSON('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: next }),
  });
});

// ── Chat theme picker modal (grid preview + Save/Cancel) ────────────────

let pendingTheme = null;

function renderThemeOptions() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  pendingTheme = current;

  el('theme-options').innerHTML = THEME_LIST.map((t) => `
    <div class="theme-card ${t.value === pendingTheme ? 'selected' : ''}" data-theme-choice="${t.value}">
      <div class="theme-preview" data-theme="${t.value}">
        <div class="preview-bg">
          <div class="preview-bubble in"></div>
          <div class="preview-bubble out"></div>
        </div>
      </div>
      <span class="theme-name">${t.label}</span>
    </div>
  `).join('');

  el('theme-options').querySelectorAll('.theme-card').forEach((card) => {
    card.addEventListener('click', () => {
      pendingTheme = card.dataset.themeChoice;
      el('theme-options').querySelectorAll('.theme-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
    });
  });
}

function openThemeModal() {
  renderThemeOptions();
  el('theme-modal').classList.remove('hidden');
}

el('theme-save').addEventListener('click', async () => {
  applyTheme(pendingTheme);
  await fetchJSON('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: pendingTheme }),
  });
  el('theme-modal').classList.add('hidden');
});

el('theme-cancel').addEventListener('click', () => {
  // Discard the in-modal selection — the theme already applied to the app
  // never changed, since Save is what applies it.
  el('theme-modal').classList.add('hidden');
});

// ── Settings ─────────────────────────────────────────────────────────────

async function loadSettings() {
  const settings = await fetchJSON('/api/settings');
  el('primary-language').value = settings.primaryLanguage || 'en';
  applyTheme(localStorage.getItem('theme') || settings.theme || 'light');
}

el('primary-language').addEventListener('change', async (e) => {
  await fetchJSON('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primaryLanguage: e.target.value }),
  });
});

// ── Calendar panel ───────────────────────────────────────────────────────

el('calendar-toggle').addEventListener('click', () => {
  el('calendar-panel').classList.toggle('hidden');
});

async function loadToday() {
  const t = await fetchJSON('/api/calendar/today');
  el('today-box').innerHTML = `
    <div><span style="color:var(--text-muted)">Gregorian:</span><br><strong>${t.gregorianReadable}</strong></div>
    <div style="margin-top:8px"><span style="color:var(--text-muted)">Hijri:</span><br><strong>${t.hijriReadable}</strong></div>
  `;
}

el('greg-to-hijri-btn').addEventListener('click', async () => {
  const date = el('greg-input').value;
  if (!date) return;
  const result = await fetchJSON('/api/calendar/to-hijri', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }),
  });
  el('greg-result').textContent = result.error || `Hijri: ${result.hijriReadable}`;
});

el('hijri-to-greg-btn').addEventListener('click', async () => {
  const date = el('hijri-input').value;
  if (!date) return;
  const result = await fetchJSON('/api/calendar/to-gregorian', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }),
  });
  el('hijri-result').textContent = result.error || `Gregorian: ${result.gregorianReadable}`;
});

// ── Conversations list ───────────────────────────────────────────────────

function escapeHTML(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function closeAllDropdowns(except) {
  document.querySelectorAll('.dropdown-menu').forEach((d) => {
    if (d !== except) d.classList.add('hidden');
  });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.dropdown-menu') && !e.target.closest('.conv-menu-btn')
      && !e.target.closest('#menu-toggle') && !e.target.closest('#attach-toggle')) {
    closeAllDropdowns();
  }
});

async function loadConversations() {
  conversationsCache = await fetchJSON('/api/conversations');
  const container = el('conversation-list');

  if (!conversationsCache.length) {
    container.innerHTML = '<p class="empty-hint">No conversations yet.</p>';
    return;
  }

  // Favourites first, then most recent.
  const sorted = [...conversationsCache].sort((a, b) => (b.favourite - a.favourite));

  container.innerHTML = sorted.map((c) => {
    const last = c.messages?.[0];
    const preview = last ? escapeHTML(last.translatedText || last.originalText) : '';
    const active = c.id === activeConversationId ? 'active' : '';
    const icons = [
      c.favourite ? '⭐' : '',
      c.muted ? '🔇' : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="conversation-item ${active}" data-id="${c.id}">
        <div class="conv-top">
          <div class="conv-top-left">
            <span class="conv-name">${escapeHTML(c.displayName || c.contactKey)}</span>
            <span>${icons}</span>
          </div>
          <div class="conv-menu-wrap">
            <button class="conv-menu-btn" data-menu-id="${c.id}" title="Chat options">⋮</button>
            <div class="dropdown-menu hidden" data-menu-for="${c.id}">
              <button data-conv-action="clear" data-id="${c.id}">Clear chat</button>
              <button data-conv-action="mute" data-id="${c.id}">${c.muted ? 'Unmute chat' : 'Mute chat'}</button>
              <button data-conv-action="read" data-id="${c.id}">Mark all as read</button>
              <button data-conv-action="unread" data-id="${c.id}">Mark as unread</button>
              <button data-conv-action="favourite" data-id="${c.id}">${c.favourite ? 'Remove favourite' : 'Favourite'}</button>
              <button data-conv-action="delete" data-id="${c.id}" class="danger">Delete chat</button>
            </div>
          </div>
        </div>
        <div class="conv-preview-row">
          <span class="conv-channel-badge">${c.channel}</span>
          <span class="conv-preview">${preview}</span>
          ${c.unreadCount > 0 ? `<span class="conv-unread-badge">${c.unreadCount}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.conversation-item').forEach((node) => {
    node.addEventListener('click', (e) => {
      if (e.target.closest('.conv-menu-wrap')) return; // menu clicks handled separately
      openConversation(node.dataset.id);
    });
  });

  container.querySelectorAll('.conv-menu-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = container.querySelector(`.dropdown-menu[data-menu-for="${btn.dataset.menuId}"]`);
      const isHidden = menu.classList.contains('hidden');
      closeAllDropdowns();
      if (isHidden) menu.classList.remove('hidden');
    });
  });

  container.querySelectorAll('[data-conv-action]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const action = btn.dataset.convAction;
      const conv = conversationsCache.find((c) => c.id === id);
      closeAllDropdowns();

      if (action === 'clear') {
        if (!confirm('Clear all messages in this chat? This cannot be undone.')) return;
        await fetchJSON(`/api/conversations/${id}/messages`, { method: 'DELETE' });
        if (activeConversationId === id) await loadThreadMessages();
      } else if (action === 'mute') {
        await fetchJSON(`/api/conversations/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ muted: !conv.muted }),
        });
      } else if (action === 'read') {
        await fetchJSON(`/api/conversations/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ unreadCount: 0 }),
        });
      } else if (action === 'unread') {
        await fetchJSON(`/api/conversations/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ unreadCount: Math.max(1, conv.unreadCount) }),
        });
      } else if (action === 'favourite') {
        await fetchJSON(`/api/conversations/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ favourite: !conv.favourite }),
        });
      } else if (action === 'delete') {
        if (!confirm('Delete this chat? It will be removed from your list entirely.')) return;
        await fetchJSON(`/api/conversations/${id}`, { method: 'DELETE' });
        if (activeConversationId === id) {
          activeConversationId = null;
          el('thread-header').textContent = 'Select a conversation';
          el('thread-messages').innerHTML = '';
          el('reply-form').style.display = 'none';
          el('menu-toggle').style.display = 'none';
        }
      }
      await loadConversations();
    });
  });
}

el('refresh-conversations').addEventListener('click', loadConversations);

// ── Thread view (unified send + receive) ────────────────────────────────

async function openConversation(id) {
  activeConversationId = id;

  const conv = conversationsCache.find((c) => c.id === id);
  el('thread-header').textContent = conv ? `${conv.displayName || conv.contactKey} · ${conv.channel}` : '';
  el('reply-form').style.display = 'flex';
  el('menu-toggle').style.display = 'inline-block';
  el('search-bar').classList.add('hidden');
  el('media-panel').classList.add('hidden');
  el('search-input').value = '';

  // Opening a conversation marks it read.
  if (conv && conv.unreadCount > 0) {
    await fetchJSON(`/api/conversations/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unreadCount: 0 }),
    });
  }

  await loadConversations(); // re-render to highlight active + clear badge
  await loadThreadMessages();
}

function renderBubbleContent(m) {
  const isOut = m.direction === 'outbound';
  const showOriginal = m.translatedText && m.translatedText !== m.originalText && m.messageType === 'text';
  let body = '';

  switch (m.messageType) {
    case 'image':
      body = `<img class="bubble-media" src="${m.mediaUrl}" alt="image" />`;
      if (m.originalText && m.originalText !== '[image]') body += `<div>${escapeHTML(m.originalText)}</div>`;
      break;
    case 'video':
      body = `<video class="bubble-media" src="${m.mediaUrl}" controls></video>`;
      break;
    case 'audio':
      body = `<audio class="bubble-media" src="${m.mediaUrl}" controls></audio>`;
      break;
    case 'document':
      body = `<div class="bubble-doc">📄 <a href="${m.mediaUrl}" download="${escapeHTML(m.fileName || 'file')}">${escapeHTML(m.fileName || 'Document')}</a></div>`;
      break;
    case 'location': {
      let coords = {};
      try { coords = JSON.parse(m.extra || '{}'); } catch {}
      const mapsUrl = `https://www.google.com/maps?q=${coords.latitude},${coords.longitude}`;
      body = `<div class="bubble-location">📍 <a href="${mapsUrl}" target="_blank" rel="noopener">Shared location</a></div>`;
      break;
    }
    case 'contact': {
      let c = {};
      try { c = JSON.parse(m.extra || '{}'); } catch {}
      body = `<div class="bubble-contact">👤 ${escapeHTML(c.name || '')} — ${escapeHTML(c.phone || '')}</div>`;
      break;
    }
    default:
      body = `${showOriginal ? `<div class="original">${escapeHTML(m.originalText)}</div>` : ''}<div>${escapeHTML(m.translatedText || m.originalText)}</div>`;
  }

  return `
    <div class="bubble ${isOut ? 'out' : 'in'}" data-msg-id="${m.id}" data-search-text="${escapeHTML((m.translatedText || m.originalText || '').toLowerCase())}">
      ${body}
      <div class="meta">${new Date(m.createdAt).toLocaleString()}</div>
    </div>
  `;
}

async function loadThreadMessages() {
  if (!activeConversationId) return;
  messagesCache = await fetchJSON(`/api/conversations/${activeConversationId}/messages`);
  const container = el('thread-messages');
  container.innerHTML = messagesCache.map(renderBubbleContent).join('');
  container.scrollTop = container.scrollHeight;
}

el('reply-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = el('reply-text').value;
  if (!text.trim() || !activeConversationId) return;

  await fetchJSON(`/api/conversations/${activeConversationId}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  el('reply-text').value = '';
  await loadThreadMessages();
  await loadConversations();
});

// ── Thread hamburger menu: search / media / theme ───────────────────────

el('menu-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = el('menu-dropdown');
  const isHidden = menu.classList.contains('hidden');
  closeAllDropdowns();
  if (isHidden) menu.classList.remove('hidden');
});

el('menu-dropdown').querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    closeAllDropdowns();
    const action = btn.dataset.action;
    el('search-bar').classList.add('hidden');
    el('media-panel').classList.add('hidden');

    if (action === 'search') {
      el('search-bar').classList.remove('hidden');
      el('search-input').focus();
    } else if (action === 'theme') {
      openThemeModal();
    } else if (action === 'media') {
      renderMediaPanel();
      el('media-panel').classList.remove('hidden');
    }
  });
});

el('search-close').addEventListener('click', () => {
  el('search-bar').classList.add('hidden');
  el('search-input').value = '';
  applySearchFilter('');
});

el('search-input').addEventListener('input', (e) => applySearchFilter(e.target.value.toLowerCase()));

function applySearchFilter(query) {
  document.querySelectorAll('#thread-messages .bubble').forEach((bubble) => {
    const matches = !query || bubble.dataset.searchText.includes(query);
    bubble.classList.toggle('dimmed', !matches);
  });
}

el('media-panel-close').addEventListener('click', () => el('media-panel').classList.add('hidden'));

const URL_PATTERN = /(https?:\/\/[^\s]+)/gi;

function renderMediaPanel() {
  const media = messagesCache.filter((m) => ['image', 'video', 'audio'].includes(m.messageType));
  const docs = messagesCache.filter((m) => m.messageType === 'document');
  const links = [];
  messagesCache.forEach((m) => {
    const text = m.translatedText || m.originalText || '';
    const found = text.match(URL_PATTERN);
    if (found) links.push(...found);
  });

  const body = el('media-panel-body');
  body.innerHTML = `
    <h4>Media (${media.length})</h4>
    ${media.length ? media.map((m) => (
      m.messageType === 'image' ? `<img class="media-thumb" src="${m.mediaUrl}" />`
      : m.messageType === 'video' ? `<video class="media-thumb" src="${m.mediaUrl}" controls></video>`
      : `<audio class="media-thumb" src="${m.mediaUrl}" controls></audio>`
    )).join('') : '<p class="empty-hint">No media yet.</p>'}

    <h4>Docs (${docs.length})</h4>
    ${docs.length ? docs.map((m) => `<a class="media-doc" href="${m.mediaUrl}" download="${escapeHTML(m.fileName || 'file')}">📄 ${escapeHTML(m.fileName || 'Document')}</a>`).join('') : '<p class="empty-hint">No documents yet.</p>'}

    <h4>Links (${links.length})</h4>
    ${links.length ? links.map((l) => `<a class="media-link" href="${escapeHTML(l)}" target="_blank" rel="noopener">${escapeHTML(l)}</a>`).join('') : '<p class="empty-hint">No links shared yet.</p>'}
  `;
}

// ── Attach menu (image / document / video / contact / location / poll / event)

el('attach-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = el('attach-menu');
  const isHidden = menu.classList.contains('hidden');
  closeAllDropdowns();
  if (isHidden) menu.classList.remove('hidden');
});

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function sendMediaFile(file) {
  if (!activeConversationId || !file) return;
  const dataUrl = await readFileAsDataURL(file);
  await fetchJSON(`/api/conversations/${activeConversationId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, fileName: file.name }),
  });
  await loadThreadMessages();
  await loadConversations();
}

el('attach-menu').querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    closeAllDropdowns();
    const type = btn.dataset.attach;
    if (!activeConversationId) return;

    if (type === 'image') el('file-image').click();
    else if (type === 'document') el('file-document').click();
    else if (type === 'video') el('file-video').click();
    else if (type === 'contact') {
      const name = prompt('Contact name?');
      if (!name) return;
      const phone = prompt('Contact phone number (with country code)?');
      if (!phone) return;
      await fetchJSON(`/api/conversations/${activeConversationId}/contact`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone }),
      });
      await loadThreadMessages();
      await loadConversations();
    } else if (type === 'location') {
      if (!navigator.geolocation) { alert('Location is not available in this browser.'); return; }
      navigator.geolocation.getCurrentPosition(async (pos) => {
        await fetchJSON(`/api/conversations/${activeConversationId}/location`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
        });
        await loadThreadMessages();
        await loadConversations();
      }, () => alert('Could not get your location — check browser permissions.'));
    } else if (type === 'poll' || type === 'event') {
      alert(
        `WhatsApp's Business API doesn't currently support sending ${type === 'poll' ? 'polls' : 'event invites'} from a business account — ` +
        `this is only available in the regular consumer WhatsApp app right now. Leaving this here for when/if Meta adds API support.`
      );
    }
  });
});

el('file-image').addEventListener('change', (e) => { if (e.target.files[0]) sendMediaFile(e.target.files[0]); e.target.value = ''; });
el('file-document').addEventListener('change', (e) => { if (e.target.files[0]) sendMediaFile(e.target.files[0]); e.target.value = ''; });
el('file-video').addEventListener('change', (e) => { if (e.target.files[0]) sendMediaFile(e.target.files[0]); e.target.value = ''; });

// ── Camera capture ───────────────────────────────────────────────────────

el('camera-toggle').addEventListener('click', async () => {
  if (!activeConversationId) return;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
    el('camera-video').srcObject = cameraStream;
    el('camera-modal').classList.remove('hidden');
  } catch {
    alert('Could not access your camera — check browser permissions.');
  }
});

function stopCameraStream() {
  if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  el('camera-modal').classList.add('hidden');
}

el('camera-cancel').addEventListener('click', stopCameraStream);

el('camera-capture').addEventListener('click', async () => {
  const video = el('camera-video');
  const canvas = el('camera-canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const dataUrl = canvas.toDataURL('image/png');

  stopCameraStream();

  if (!activeConversationId) return;
  await fetchJSON(`/api/conversations/${activeConversationId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, fileName: `photo-${Date.now()}.png` }),
  });
  await loadThreadMessages();
  await loadConversations();
});

// ── Voice recording ──────────────────────────────────────────────────────

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

el('mic-toggle').addEventListener('click', async () => {
  if (!activeConversationId) return;

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      el('mic-toggle').classList.remove('recording');
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      const dataUrl = await blobToDataURL(blob);
      await fetchJSON(`/api/conversations/${activeConversationId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl, fileName: `voice-${Date.now()}.webm` }),
      });
      await loadThreadMessages();
      await loadConversations();
    };
    mediaRecorder.start();
    el('mic-toggle').classList.add('recording');
  } catch {
    alert('Could not access your microphone — check browser permissions.');
  }
});

// ── Simulate ─────────────────────────────────────────────────────────────

el('sim-send').addEventListener('click', async () => {
  const channel = el('sim-channel').value;
  const from = el('sim-from').value;
  const text = el('sim-text').value;
  if (!text.trim()) return;

  await fetchJSON('/api/simulate-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, from, text }),
  });

  el('sim-text').value = '';
  await loadConversations();
  if (activeConversationId) await loadThreadMessages();
});

// ── Init ─────────────────────────────────────────────────────────────────

loadClientConfig().then(() => {
  loadSettings();
  loadConversations();
  loadToday();
});

setInterval(() => {
  loadConversations();
  if (activeConversationId) loadThreadMessages();
}, 5000);
