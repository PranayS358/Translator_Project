const el = (id) => document.getElementById(id);
let activeConversationId = null;
let conversationsCache = [];
let apiKey = null;

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

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  el('theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙';
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
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadConversations() {
  conversationsCache = await fetchJSON('/api/conversations');
  const container = el('conversation-list');

  if (!conversationsCache.length) {
    container.innerHTML = '<p class="empty-hint">No conversations yet.</p>';
    return;
  }

  container.innerHTML = conversationsCache.map((c) => {
    const last = c.messages?.[0];
    const preview = last ? escapeHTML(last.translatedText || last.originalText) : '';
    const active = c.id === activeConversationId ? 'active' : '';
    return `
      <div class="conversation-item ${active}" data-id="${c.id}">
        <div class="conv-top">
          <span>${escapeHTML(c.displayName || c.contactKey)}</span>
          <span class="conv-channel-badge">${c.channel}</span>
        </div>
        <div class="conv-preview">${preview}</div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.conversation-item').forEach((node) => {
    node.addEventListener('click', () => openConversation(node.dataset.id));
  });
}

el('refresh-conversations').addEventListener('click', loadConversations);

// ── Thread view (unified send + receive) ────────────────────────────────

async function openConversation(id) {
  activeConversationId = id;
  loadConversations(); // re-render to highlight active

  const conv = conversationsCache.find((c) => c.id === id);
  el('thread-header').textContent = conv ? `${conv.displayName || conv.contactKey} · ${conv.channel}` : '';
  el('reply-form').style.display = 'flex';

  await loadThreadMessages();
}

async function loadThreadMessages() {
  if (!activeConversationId) return;
  const messages = await fetchJSON(`/api/conversations/${activeConversationId}/messages`);
  const container = el('thread-messages');

  container.innerHTML = messages.map((m) => {
    const isOut = m.direction === 'outbound';
    return `
      <div class="bubble ${isOut ? 'out' : 'in'}">
        ${m.translatedText && m.translatedText !== m.originalText
          ? `<div class="original">${escapeHTML(m.originalText)}</div>`
          : ''}
        <div>${escapeHTML(m.translatedText || m.originalText)}</div>
        <div class="meta">${new Date(m.createdAt).toLocaleString()}</div>
      </div>
    `;
  }).join('');

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
