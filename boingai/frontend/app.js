const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const messagesEl = $('#messages');
const inputEl = $('#input');
const sendBtn = $('#sendBtn');
const convListEl = $('#convList');
const chatTitleEl = $('#chatTitle');
const emptyStateEl = $('#emptyState');
const themeBtn = $('#themeBtn');
const menuBtn = $('#menuBtn');
const sidebar = $('#sidebar');
const sidebarBackdrop = $('#sidebarBackdrop');
const sidebarToggle = $('#sidebarToggle');
const searchInput = $('#searchInput');
const scrollBottomBtn = $('#scrollBottomBtn');
const toastEl = $('#toast');

let currentConvId = null;
let isSending = false;
let abortController = null;
const stopBtn = document.getElementById('stopBtn');
let conversationsCache = [];
let searchQuery = '';
let webSearchEnabled = false;
const webSearchBtn = $('#webSearchBtn');

// ---------- Theme ----------
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('boing-theme', t);
}
(function initTheme() {
  const saved = localStorage.getItem('boing-theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
})();
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('boing-theme-mode', next);
  const btns = document.querySelectorAll('#themeSeg .seg-btn');
  btns.forEach(b => b.classList.toggle('active', b.dataset.val === next));
  updateSwatchColors();
});

// ---------- Toast ----------
let toastTimer = null;
function toast(msg, ms = 2000) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ---------- Sidebar ----------
function toggleSidebar() {
  if (window.innerWidth <= 768) {
    const open = sidebar.classList.toggle('open');
    sidebarBackdrop.classList.toggle('show', open);
  } else {
    sidebar.classList.toggle('collapsed');
  }
}
menuBtn.addEventListener('click', toggleSidebar);
sidebarToggle.addEventListener('click', toggleSidebar);
sidebarBackdrop.addEventListener('click', () => {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('show');
});

// ---------- Markdown renderer ----------
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function renderInline(text) {
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__(.+?)__/g, '<u>$1</u>');
  text = text.replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, '$1<em>$2</em>');
  return text;
}
function renderMarkdown(src) {
  const lines = src.split('\n');
  let html = '';
  let i = 0;
  let inCode = false; let codeBuf = []; let codeLang = '';
  let inList = false; let listType = '';
  const closeList = () => { if (inList) { html += `</${listType}>`; inList = false; listType = ''; } };

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      if (!inCode) {
        closeList();
        inCode = true; codeLang = line.trim().slice(3).trim(); codeBuf = [];
      } else {
        inCode = false;
        const code = escapeHtml(codeBuf.join('\n'));
        const id = 'cb-' + Math.random().toString(36).slice(2, 10);
        const langLabel = codeLang ? `<span class="code-lang">${escapeHtml(codeLang)}</span>` : '';
        html += `<pre>${langLabel}<code id="${id}">${code}</code><button class="copy-btn" data-copy="${id}">Copy</button></pre>`;
      }
      i++; continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }

    const trimmed = line.trim();
    if (trimmed === '') { closeList(); i++; continue; }

    const h = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (h) { closeList(); const lvl = h[1].length; html += `<h${lvl}>${renderInline(escapeHtml(h[2]))}</h${lvl}>`; i++; continue; }

    if (trimmed.startsWith(':::tip')) {
      closeList();
      let tipLines = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(':::')) { tipLines.push(lines[i]); i++; }
      i++;
      html += `<blockquote class="tip"><span class="tip-label">Tip</span>${renderInline(escapeHtml(tipLines.join(' ').trim()))}</blockquote>`;
      continue;
    }
    if (trimmed.startsWith('>')) {
      closeList();
      const content = trimmed.replace(/^>\s?/, '');
      if (/^tip:/i.test(content)) {
        const t = content.replace(/^tip:\s*/i, '');
        html += `<blockquote class="tip"><span class="tip-label">Tip</span>${renderInline(escapeHtml(t))}</blockquote>`;
      } else {
        html += `<blockquote>${renderInline(escapeHtml(content))}</blockquote>`;
      }
      i++; continue;
    }
    const ulMatch = trimmed.match(/^[-*]\s+(.*)$/);
    const olMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') { closeList(); html += '<ul>'; inList = true; listType = 'ul'; }
      html += `<li>${renderInline(escapeHtml(ulMatch[1]))}</li>`;
      i++; continue;
    }
    if (olMatch) {
      if (!inList || listType !== 'ol') { closeList(); html += '<ol>'; inList = true; listType = 'ol'; }
      html += `<li>${renderInline(escapeHtml(olMatch[1]))}</li>`;
      i++; continue;
    }
    closeList();
    html += `<p>${renderInline(escapeHtml(trimmed))}</p>`;
    i++;
  }
  closeList();
  if (inCode) html += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`;
  return html;
}

// ---------- Conversations ----------
async function fetchConversations() {
  try {
    const r = await fetch('/api/conversations');
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

function convTitle(c) {
  // derive a readable title from first user message if possible; fallback
  return c.title || `Chat ${ (c.id || c.Id || '').slice(0,6)}`;
}

async function renderConvList() {
  const convs = await fetchConversations();
  conversationsCache = convs;
  convListEl.innerHTML = '';

  let filtered = convs;
  if (searchQuery) {
    filtered = convs.filter(c => (c.id||c.Id||'').toLowerCase().includes(searchQuery.toLowerCase()));
  }

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = searchQuery ? 'No matches' : 'No conversations yet';
    convListEl.appendChild(empty);
    return;
  }

  // group by date
  const groups = {};
  filtered.forEach(c => {
    const d = new Date(c.createdAt || c.created_at || Date.now());
    const key = d.toDateString();
    (groups[key] = groups[key] || []).push(c);
  });

  Object.keys(groups).forEach(key => {
    const label = document.createElement('div');
    label.className = 'conv-group-label';
    const d = new Date(key);
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    label.textContent = key === today ? 'Today' : key === yesterday ? 'Yesterday' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    convListEl.appendChild(label);

    groups[key].forEach(c => {
      const id = c.id || c.Id;
      const item = document.createElement('div');
      item.className = 'conv-item' + (id === currentConvId ? ' active' : '');
      item.innerHTML = `
        <svg class="conv-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        <span class="conv-title">${escapeHtml(convTitle(c))}</span>
        <div class="conv-actions">
          <button data-act="rename" title="Rename"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button data-act="delete" title="Delete"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>
        </div>`;
      item.addEventListener('click', (e) => {
        if (e.target.closest('.conv-actions')) return;
        loadConversation(id);
      });
      item.querySelector('[data-act="rename"]').addEventListener('click', (e) => {
        e.stopPropagation();
        renameConversation(id);
      });
      item.querySelector('[data-act="delete"]').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteConversation(id);
      });
      convListEl.appendChild(item);
    });
  });
}

async function loadConversation(id) {
  currentConvId = id;
  messagesEl.innerHTML = '';
  emptyStateEl.style.display = 'none';
  try {
    const r = await fetch(`/api/conversations/${id}`);
    if (!r.ok) return;
    const conv = await r.json();
    const msgs = conv.messages || conv.Messages || [];
    msgs.forEach(m => appendMessage(m.role || m.Role, m.content || m.Content, false));
    chatTitleEl.textContent = convTitle(conv);
    scrollToBottom(true);
  } catch (e) { console.error(e); }
  renderConvList();
  if (window.innerWidth <= 768) { sidebar.classList.remove('open'); sidebarBackdrop.classList.remove('show'); }
}

async function renameConversation(id) {
  const name = prompt('Rename conversation:');
  if (!name) return;
  // store title client-side only (backend has no title field); cache in localStorage
  const titles = JSON.parse(localStorage.getItem('boing-titles') || '{}');
  titles[id] = name;
  localStorage.setItem('boing-titles', JSON.stringify(titles));
  toast('Renamed');
  renderConvList();
  if (currentConvId === id) chatTitleEl.textContent = name;
}

function convTitle(c) {
  const id = c.id || c.Id;
  const titles = JSON.parse(localStorage.getItem('boing-titles') || '{}');
  if (titles[id]) return titles[id];
  return `Chat ${id.slice(0,6)}`;
}

async function deleteConversation(id) {
  if (!confirm('Delete this conversation?')) return;
  try {
    await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  } catch {}
  if (currentConvId === id) newChat();
  else renderConvList();
  toast('Deleted');
}

function newChat() {
  currentConvId = null;
  messagesEl.innerHTML = '';
  messagesEl.appendChild(emptyStateEl);
  emptyStateEl.style.display = '';
  chatTitleEl.textContent = 'New conversation';
  renderConvList();
  inputEl.focus();
}

// ---------- Messages ----------
function appendMessage(role, content, animate = true) {
  if (emptyStateEl.parentNode === messagesEl) emptyStateEl.style.display = 'none';
  const msg = document.createElement('div');
  msg.className = `msg ${role}`;
  if (!animate) msg.style.animation = 'none';

  const avatar = document.createElement('div');
  avatar.className = `avatar ${role}`;
  avatar.textContent = role === 'user' ? 'You' : 'B';

  const wrap = document.createElement('div');
  wrap.className = 'bubble-wrap';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (role === 'assistant') {
    bubble.innerHTML = renderMarkdown(content);
    bubble.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const codeEl = document.getElementById(btn.dataset.copy);
        if (codeEl) {
          navigator.clipboard.writeText(codeEl.textContent).then(() => {
            btn.textContent = 'Copied';
            btn.classList.add('copied');
            setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
          });
        }
      });
    });
  } else {
    bubble.textContent = content;
  }
  wrap.appendChild(bubble);

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  wrap.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  if (role === 'assistant') {
    const copyMsg = document.createElement('button');
    copyMsg.className = 'msg-action';
    copyMsg.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy`;
    copyMsg.addEventListener('click', () => {
      navigator.clipboard.writeText(content).then(() => { copyMsg.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg> Copied`; setTimeout(() => copyMsg.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy`, 1500); });
    });
    actions.appendChild(copyMsg);

    const regen = document.createElement('button');
    regen.className = 'msg-action';
    regen.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg> Regenerate`;
    regen.addEventListener('click', () => regenerateLast());
    actions.appendChild(regen);

    const speak = document.createElement('button');
    speak.className = 'msg-action'; speak.textContent = 'Speak';
    speak.addEventListener('click', () => speakText(content));
    actions.appendChild(speak);

    const bookmark = document.createElement('button');
    bookmark.className = 'msg-action'; bookmark.textContent = 'Bookmark';
    bookmark.addEventListener('click', () => {
      const bms = JSON.parse(localStorage.getItem('boing-bookmarks') || '[]');
      bms.push({ conv: currentConvId, text: content.slice(0, 200), ts: Date.now() });
      localStorage.setItem('boing-bookmarks', JSON.stringify(bms));
      toast('Bookmarked');
    });
    actions.appendChild(bookmark);
  } else {
    const editBtn = document.createElement('button');
    editBtn.className = 'msg-action';
    editBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit`;
    editBtn.addEventListener('click', () => {
      inputEl.value = content;
      autoResize();
      inputEl.focus();
      // remove this user msg + following assistant from UI? just focus edit
    });
    actions.appendChild(editBtn);
  }
  wrap.appendChild(actions);

  msg.appendChild(avatar);
  msg.appendChild(wrap);
  messagesEl.appendChild(msg);
  return msg;
}

function showTyping() {
  const msg = document.createElement('div');
  msg.className = 'msg assistant'; msg.id = 'typingMsg';
  const avatar = document.createElement('div'); avatar.className = 'avatar assistant'; avatar.textContent = 'B';
  const wrap = document.createElement('div'); wrap.className = 'bubble-wrap';
  const bubble = document.createElement('div'); bubble.className = 'bubble typing';
  bubble.innerHTML = '<span></span><span></span><span></span>';
  wrap.appendChild(bubble);
  msg.appendChild(avatar); msg.appendChild(wrap);
  messagesEl.appendChild(msg);
  scrollToBottom();
}
function removeTyping() { const t = $('#typingMsg'); if (t) t.remove(); }

function scrollToBottom(force = false) {
  requestAnimationFrame(() => {
    const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
    if (force || nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    updateScrollBtn();
  });
}
function updateScrollBtn() {
  const far = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight > 200;
  scrollBottomBtn.classList.toggle('show', far);
}
messagesEl.addEventListener('scroll', updateScrollBtn);
scrollBottomBtn.addEventListener('click', () => messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' }));

// ---------- Slash commands ----------
function handleSlashCommand(cmd) {
  const parts = cmd.slice(1).split(' ');
  const name = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ');
  switch (name) {
    case 'new': newChat(); break;
    case 'clear':
      if (currentConvId) fetch(`/api/conversations/${currentConvId}`, { method: 'DELETE' }).catch(()=>{});
      newChat(); toast('Cleared'); break;
    case 'export': exportConversation(arg === 'json' ? 'json' : 'md'); break;
    case 'theme': applyThemeMode(arg || 'system'); toast('Theme: ' + (arg||'system')); break;
    case 'accent': if (arg) { applyAccent(arg); toast('Accent: ' + arg); } else toast('Usage: /accent <name>'); break;
    case 'focus': toggleFocusMode(); break;
    case 'settings': openSettings(); break;
    case 'shortcuts': openShortcuts(); break;
    case 'help':
      appendMessage('assistant', 'Available commands: /new, /clear, /export [json], /theme [light|dark|system], /accent <name>, /focus, /settings, /shortcuts, /help'); break;
    default: toast('Unknown command: ' + name);
  }
}

// ---------- Send ----------
async function sendMessage(text) {
  text = text.trim();
  if (!text) return;
  // Slash commands
  if (text.startsWith('/')) {
    handleSlashCommand(text);
    inputEl.value = '';
    autoResize();
    return;
  }
  if (isSending) return;
  isSending = true;
  sendBtn.style.display = 'none';
  stopBtn.style.display = 'grid';
  inputEl.disabled = true;

  appendMessage('user', text);
  inputEl.value = '';
  autoResize();

  if (emptyStateEl.parentNode === messagesEl) emptyStateEl.style.display = 'none';
  const msg = document.createElement('div');
  msg.className = 'msg assistant';
  const avatar = document.createElement('div'); avatar.className = 'avatar assistant'; avatar.textContent = 'B';
  const wrap = document.createElement('div'); wrap.className = 'bubble-wrap';
  const bubble = document.createElement('div'); bubble.className = 'bubble';
  bubble.textContent = '';
  wrap.appendChild(bubble);
  const meta = document.createElement('div'); meta.className = 'msg-meta'; meta.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  wrap.appendChild(meta);
  msg.appendChild(avatar); msg.appendChild(wrap);
  messagesEl.appendChild(msg);
  scrollToBottom(true);

  abortController = new AbortController();
  let accumulated = '';
  let convId = currentConvId;

  try {
    const r = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
      conversation_id: currentConvId,
      message: text,
      system_prompt: getSystemPrompt(),
      temperature: parseFloat(localStorage.getItem('boing-temp') || '0.7'),
      top_p: parseFloat(localStorage.getItem('boing-topp') || '0.9'),
      web_search: webSearchEnabled,
    }),
      signal: abortController.signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;
        try {
          const data = JSON.parse(payload);
          if (data.token) {
            accumulated += data.token;
            bubble.textContent = accumulated;
            if (isToggle('boing-autoscroll')) scrollToBottom();
          }
          if (data.done) {
            convId = data.conversation_id || convId;
            currentConvId = convId;
            const finalReply = data.reply || accumulated;
            accumulated = finalReply;
            bubble.innerHTML = renderMarkdown(finalReply);
            bubble.querySelectorAll('.copy-btn').forEach(btn => {
              btn.addEventListener('click', () => {
                const codeEl = document.getElementById(btn.dataset.copy);
                if (codeEl) {
                  navigator.clipboard.writeText(codeEl.textContent).then(() => {
                    btn.textContent = 'Copied'; btn.classList.add('copied');
                    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
                  });
                }
              });
            });
            const actions = document.createElement('div');
            actions.className = 'msg-actions';
            const copyMsg = document.createElement('button');
            copyMsg.className = 'msg-action';
            copyMsg.textContent = 'Copy';
            copyMsg.addEventListener('click', () => {
              navigator.clipboard.writeText(accumulated).then(() => { copyMsg.textContent = 'Copied!'; setTimeout(() => copyMsg.textContent = 'Copy', 1500); });
            });
            actions.appendChild(copyMsg);
            const regen = document.createElement('button');
            regen.className = 'msg-action'; regen.textContent = 'Regenerate';
            regen.addEventListener('click', () => regenerateLast());
            actions.appendChild(regen);

            const speak = document.createElement('button');
            speak.className = 'msg-action'; speak.textContent = 'Speak';
            speak.addEventListener('click', () => speakText(accumulated));
            actions.appendChild(speak);

            const bookmark = document.createElement('button');
            bookmark.className = 'msg-action'; bookmark.textContent = 'Bookmark';
            bookmark.addEventListener('click', () => {
              const bms = JSON.parse(localStorage.getItem('boing-bookmarks') || '[]');
              bms.push({ conv: currentConvId, text: accumulated.slice(0, 200), ts: Date.now() });
              localStorage.setItem('boing-bookmarks', JSON.stringify(bms));
              toast('Bookmarked');
            });
            actions.appendChild(bookmark);

            wrap.appendChild(actions);

            notifyComplete(accumulated);
            if (currentConvId && chatTitleEl.textContent === 'New conversation') {
              const t = text.length > 40 ? text.slice(0,40) + '\u2026' : text;
              const titles = JSON.parse(localStorage.getItem('boing-titles') || '{}');
              if (!titles[currentConvId]) { titles[currentConvId] = t; localStorage.setItem('boing-titles', JSON.stringify(titles)); }
              chatTitleEl.textContent = titles[currentConvId] || t;
            }
            renderConvList();
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      bubble.textContent = accumulated || 'Sorry, something went wrong. Please try again.';
      toast('Failed to send');
      console.error(e);
    } else {
      if (accumulated) bubble.innerHTML = renderMarkdown(accumulated);
      toast('Stopped');
    }
  } finally {
    isSending = false;
    sendBtn.style.display = 'grid';
    stopBtn.style.display = 'none';
    inputEl.disabled = false;
    inputEl.focus();
    abortController = null;
  }
}


async function regenerateLast() {
  // find last user message
  const msgs = Array.from(messagesEl.querySelectorAll('.msg'));
  // remove last assistant msg from UI
  let lastAssistant = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].classList.contains('assistant') && msgs[i].id !== 'typingMsg') { lastAssistant = msgs[i]; break; }
  }
  // find preceding user text
  let userText = '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].classList.contains('user')) {
      const b = msgs[i].querySelector('.bubble');
      userText = b ? b.textContent : '';
      break;
    }
  }
  if (!userText) { toast('Nothing to regenerate'); return; }
  if (lastAssistant) lastAssistant.remove();
  // re-send by calling sendMessage won't add user msg again; instead call API directly
  isSending = true; sendBtn.disabled = true; showTyping();
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: currentConvId, message: userText, web_search: webSearchEnabled }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    currentConvId = data.conversation_id;
    removeTyping();
    appendMessage('assistant', data.reply);
  } catch (e) {
    removeTyping();
    appendMessage('assistant', 'Sorry, something went wrong. Please try again.');
    toast('Regenerate failed');
  } finally {
    isSending = false; sendBtn.disabled = false;
  }
}

function autoResize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
}

// ---------- Events ----------
sendBtn.addEventListener('click', () => sendMessage(inputEl.value));
stopBtn.addEventListener('click', () => { if (abortController) abortController.abort(); });
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(inputEl.value); }
});
inputEl.addEventListener('input', autoResize);

webSearchBtn.addEventListener('click', () => {
  webSearchEnabled = !webSearchEnabled;
  webSearchBtn.style.opacity = webSearchEnabled ? '1' : '0.5';
  webSearchBtn.setAttribute('aria-pressed', String(webSearchEnabled));
  toast('Web search ' + (webSearchEnabled ? 'on' : 'off'));
});

$$('.suggestion').forEach(b => {
  b.addEventListener('click', () => sendMessage(b.dataset.text));
});

$('#newChatBtn').addEventListener('click', newChat);
$('#clearBtn')?.addEventListener('click', () => {
  if (currentConvId) fetch(`/api/conversations/${currentConvId}`, { method: 'DELETE' }).catch(()=>{});
  newChat();
});

searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  renderConvList();
});

// keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    newChat();
  }
  if (e.key === '/' && document.activeElement !== inputEl) {
    e.preventDefault();
    inputEl.focus();
  }
  if (e.key === '?' && document.activeElement !== inputEl) {
    e.preventDefault();
    openShortcuts();
  }
  if (e.key === 'Escape') {
    closeShortcuts();
    closeSettings();
    if (isSending && abortController) abortController.abort();
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    exportConversation();
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    toggleFocusMode();
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && document.activeElement !== inputEl) {
    e.preventDefault();
    searchInConversation();
  }
});

// ---------- Settings / Customization ----------
const accentPresets = [
  { name: 'amber', color: '#b45309', dark: '#fbbf24' },
  { name: 'blue', color: '#2563eb', dark: '#60a5fa' },
  { name: 'emerald', color: '#059669', dark: '#34d399' },
  { name: 'rose', color: '#e11d48', dark: '#fb7185' },
  { name: 'violet', color: '#7c3aed', dark: '#a78bfa' },
  { name: 'teal', color: '#0d9488', dark: '#2dd4bf' },
  { name: 'orange', color: '#ea580c', dark: '#fb923c' },
  { name: 'slate', color: '#475569', dark: '#94a3b8' },
];

function applyAccent(name) {
  document.documentElement.setAttribute('data-accent', name);
  localStorage.setItem('boing-accent', name);
}
function applyThemeMode(mode) {
  localStorage.setItem('boing-theme-mode', mode);
  if (mode === 'system') {
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(prefersDark ? 'dark' : 'light');
  } else {
    applyTheme(mode);
  }
}
function applyFontSize(size) {
  document.documentElement.setAttribute('data-fontsize', size);
  localStorage.setItem('boing-fontsize', size);
}
function applyDensity(d) {
  document.documentElement.setAttribute('data-density', d);
  localStorage.setItem('boing-density', d);
}

// init settings from storage
(function initSettings() {
  const accent = localStorage.getItem('boing-accent') || 'amber';
  applyAccent(accent);
  const mode = localStorage.getItem('boing-theme-mode') || 'system';
  if (!localStorage.getItem('boing-theme-mode')) localStorage.setItem('boing-theme-mode', mode);
  applyThemeMode(mode);
  const fs = localStorage.getItem('boing-fontsize') || 'medium';
  applyFontSize(fs);
  const den = localStorage.getItem('boing-density') || 'comfortable';
  applyDensity(den);
})();

// swatches
const swatchRow = $('#accentSwatches');
accentPresets.forEach(p => {
  const btn = document.createElement('button');
  btn.className = 'swatch';
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  btn.style.background = isDark ? p.dark : p.color;
  btn.dataset.accent = p.name;
  btn.title = p.name;
  btn.addEventListener('click', () => {
    applyAccent(p.name);
    // update active
    $$('.swatch').forEach(s => s.classList.toggle('active', s.dataset.accent === p.name));
    // update swatch colors for theme
    updateSwatchColors();
    toast('Accent: ' + p.name);
  });
  swatchRow.appendChild(btn);
});
function updateSwatchColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  $$('.swatch').forEach(s => {
    const p = accentPresets.find(x => x.name === s.dataset.accent);
    if (p) s.style.background = isDark ? p.dark : p.color;
  });
  $$('.swatch').forEach(s => s.classList.toggle('active', s.dataset.accent === (localStorage.getItem('boing-accent') || 'amber')));
}
updateSwatchColors();

// seg buttons
function wireSeg(containerId, applyFn, storageKey) {
  const container = $(containerId);
  if (!container) return;
  const btns = container.querySelectorAll('.seg-btn');
  btns.forEach(b => {
    b.addEventListener('click', () => {
      applyFn(b.dataset.val);
      btns.forEach(x => x.classList.toggle('active', x === b));
      toast(b.textContent);
    });
  });
  // set initial active
  const val = localStorage.getItem(storageKey);
  if (val) {
    const active = Array.from(btns).find(b => b.dataset.val === val);
    if (active) active.classList.add('active');
  } else {
    // default first
    btns[0].classList.add('active');
  }
}
wireSeg('#themeSeg', (v) => {
  applyThemeMode(v);
  updateSwatchColors();
}, 'boing-theme-mode');
wireSeg('#fontSeg', applyFontSize, 'boing-fontsize');
wireSeg('#densitySeg', applyDensity, 'boing-density');

// shortcuts modal
const shortcutsBackdrop = $('#shortcutsBackdrop');
const shortcutsModal = $('#shortcutsModal');
const shortcutsClose = $('#shortcutsClose');
function openShortcuts() { shortcutsBackdrop.classList.add('show'); shortcutsModal.classList.add('show'); }
function closeShortcuts() { shortcutsBackdrop.classList.remove('show'); shortcutsModal.classList.remove('show'); }
shortcutsClose.addEventListener('click', closeShortcuts);
shortcutsBackdrop.addEventListener('click', closeShortcuts);

// settings modal
const settingsBtn = $('#settingsBtn');
const settingsModal = $('#settingsModal');
const settingsBackdrop = $('#settingsBackdrop');
const settingsClose = $('#settingsClose');
function openSettings() {
  settingsBackdrop.classList.add('show');
  settingsModal.classList.add('show');
  // default tab
  switchSettingsTab('appearance');
}
function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.modal-body .setting-group').forEach(g => {
    g.style.display = (g.dataset.tab === tab) ? '' : 'none';
  });
}
document.querySelectorAll('.settings-tab').forEach(t => {
  t.addEventListener('click', () => switchSettingsTab(t.dataset.tab));
});
function closeSettings() {
  settingsBackdrop.classList.remove('show');
  settingsModal.classList.remove('show');
}
settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsBackdrop.addEventListener('click', closeSettings);

// system theme listener
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (localStorage.getItem('boing-theme-mode') === 'system') {
      applyTheme(e.matches ? 'dark' : 'light');
      updateSwatchColors();
    }
  });
}

// ---------- Voice input ----------
const micBtn = $('#micBtn');
let recognition = null;
if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  recognition.onresult = (e) => {
    let transcript = '';
    for (let i = e.resultIndex; i < e.results.length; i++) transcript += e.results[i][0].transcript;
    inputEl.value = transcript;
    autoResize();
  };
  recognition.onend = () => micBtn.classList.remove('listening');
  recognition.onerror = () => { micBtn.classList.remove('listening'); toast('Voice input error'); };
}
micBtn.addEventListener('click', () => {
  if (!recognition) { toast('Voice input not supported'); return; }
  if (micBtn.classList.contains('listening')) {
    recognition.stop();
    micBtn.classList.remove('listening');
  } else {
    micBtn.classList.add('listening');
    recognition.start();
  }
});

// ---------- Text-to-speech ----------
function speakText(text) {
  if (!('speechSynthesis' in window)) { toast('TTS not supported'); return; }
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.0;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

// ---------- Export conversation ----------
async function exportConversation(format = 'md') {
  if (!currentConvId) { toast('No conversation'); return; }
  try {
    const r = await fetch(`/api/conversations/${currentConvId}`);
    if (!r.ok) throw new Error();
    const conv = await r.json();
    const msgs = conv.messages || conv.Messages || [];
    let content = '';
    if (format === 'md') {
      content = '# Conversation ' + currentConvId.slice(0,8) + '\\n\\n';
      msgs.forEach(m => {
        const role = (m.role || m.Role);
        const c = (m.content || m.Content);
        content += '## ' + (role === 'user' ? 'You' : 'BoingAI') + '\\n' + c + '\\n\\n';
      });
    } else {
      content = JSON.stringify(conv, null, 2);
    }
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `boingai-${currentConvId.slice(0,8)}.${format === 'md' ? 'md' : 'json'}`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Exported');
  } catch { toast('Export failed'); }
}

// ---------- Focus mode ----------
function toggleFocusMode() {
  document.body.classList.toggle('focus-mode');
  toast(document.body.classList.contains('focus-mode') ? 'Focus mode on' : 'Focus mode off');
}

// ---------- Search in conversation ----------
function searchInConversation() {
  const q = prompt('Search in conversation:');
  if (!q) return;
  const bubbles = document.querySelectorAll('.bubble');
  let found = 0;
  bubbles.forEach(b => {
    b.innerHTML = b.innerHTML; // reset not needed
  });
  // highlight
  bubbles.forEach(b => {
    const text = b.textContent;
    if (text.toLowerCase().includes(q.toLowerCase())) {
      b.style.outline = '2px solid var(--accent)';
      found++;
    } else {
      b.style.outline = '';
    }
  });
  toast(found + ' matches');
  setTimeout(() => bubbles.forEach(b => b.style.outline = ''), 3000);
}

// ---------- Pin conversation ----------
function pinConversation(id) {
  const pins = JSON.parse(localStorage.getItem('boing-pins') || '[]');
  if (pins.includes(id)) {
    const idx = pins.indexOf(id); pins.splice(idx, 1);
    toast('Unpinned');
  } else {
    pins.push(id);
    toast('Pinned');
  }
  localStorage.setItem('boing-pins', JSON.stringify(pins));
  renderConvList();
}

// ---------- Archive conversation ----------
function archiveConversation(id) {
  const arch = JSON.parse(localStorage.getItem('boing-archive') || '[]');
  if (arch.includes(id)) {
    const idx = arch.indexOf(id); arch.splice(idx, 1);
    toast('Unarchived');
  } else {
    arch.push(id);
    toast('Archived');
    if (currentConvId === id) newChat();
  }
  localStorage.setItem('boing-archive', JSON.stringify(arch));
  renderConvList();
}

// ---------- Sort conversations ----------
let convSort = localStorage.getItem('boing-sort') || 'recent';
function sortConversations(convs) {
  const pins = JSON.parse(localStorage.getItem('boing-pins') || '[]');
  const arch = JSON.parse(localStorage.getItem('boing-archive') || '[]');
  let list = convs.filter(c => !arch.includes(c.id || c.Id));
  if (convSort === 'alpha') {
    list.sort((a,b) => (a.id||a.Id).localeCompare(b.id||b.Id));
  } else {
    list.sort((a,b) => new Date(b.createdAt||b.created_at||0) - new Date(a.createdAt||a.created_at||0));
  }
  // pins first
  list.sort((a,b) => {
    const ap = pins.includes(a.id||a.Id) ? 0 : 1;
    const bp = pins.includes(b.id||b.Id) ? 0 : 1;
    return ap - bp;
  });
  return list;
}

// override renderConvList to use sort + pins + archive + preview
const _origRenderConvList = renderConvList;
renderConvList = async function() {
  const convs = await fetchConversations();
  conversationsCache = convs;
  convListEl.innerHTML = '';

  let filtered = convs;
  if (searchQuery) {
    filtered = convs.filter(c => (c.id||c.Id||'').toLowerCase().includes(searchQuery.toLowerCase()));
  }
  filtered = sortConversations(filtered);

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = searchQuery ? 'No matches' : 'No conversations yet';
    convListEl.appendChild(empty);
    return;
  }

  const pins = JSON.parse(localStorage.getItem('boing-pins') || '[]');
  const groups = {};
  filtered.forEach(c => {
    const d = new Date(c.createdAt || c.created_at || Date.now());
    const key = d.toDateString();
    (groups[key] = groups[key] || []).push(c);
  });

  Object.keys(groups).forEach(key => {
    const label = document.createElement('div');
    label.className = 'conv-group-label';
    const d = new Date(key);
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    label.textContent = key === today ? 'Today' : key === yesterday ? 'Yesterday' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    convListEl.appendChild(label);

    groups[key].forEach(c => {
      const id = c.id || c.Id;
      const item = document.createElement('div');
      item.className = 'conv-item' + (id === currentConvId ? ' active' : '');
      const isPinned = pins.includes(id);
      const colors = JSON.parse(localStorage.getItem('boing-colors') || '{}');
      if (colors[id]) item.style.borderLeft = '3px solid ' + colors[id];
      item.innerHTML = `
        <svg class="conv-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        <span class="conv-title">${escapeHtml(convTitle(c))}${isPinned ? ' 📌' : ''}</span>
        <div class="conv-actions">
          <button data-act="color" title="Color">🎨</button>
          <button data-act="pin" title="Pin">📌</button>
          <button data-act="archive" title="Archive">🗄️</button>
          <button data-act="rename" title="Rename">✏️</button>
          <button data-act="delete" title="Delete">🗑️</button>
        </div>`;
      item.addEventListener('click', (e) => {
        if (e.target.closest('.conv-actions')) return;
        loadConversation(id);
      });
      item.querySelector('[data-act="color"]').addEventListener('click', (e) => {
        e.stopPropagation();
        const palette = ['#b45309','#2563eb','#059669','#e11d48','#7c3aed','#0d9488','#ea580c','#475569'];
        const colors = JSON.parse(localStorage.getItem('boing-colors') || '{}');
        const cur = colors[id];
        const idx = cur ? palette.indexOf(cur) : -1;
        const next = palette[(idx + 1) % palette.length];
        colors[id] = next;
        localStorage.setItem('boing-colors', JSON.stringify(colors));
        toast('Color set');
        renderConvList();
      });
      item.querySelector('[data-act="pin"]').addEventListener('click', (e) => { e.stopPropagation(); pinConversation(id); });
      item.querySelector('[data-act="archive"]').addEventListener('click', (e) => { e.stopPropagation(); archiveConversation(id); });
      item.querySelector('[data-act="rename"]').addEventListener('click', (e) => { e.stopPropagation(); renameConversation(id); });
      item.querySelector('[data-act="delete"]').addEventListener('click', (e) => { e.stopPropagation(); deleteConversation(id); });
      convListEl.appendChild(item);
    });
  });
};

// ---------- Drag and drop files ----------
document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = e.dataTransfer.files;
  if (!files.length) return;
  const file = files[0];
  const reader = new FileReader();
  reader.onload = (ev) => {
    inputEl.value = ev.target.result;
    autoResize();
    toast('File loaded: ' + file.name);
  };
  reader.readAsText(file);
});

// ---------- Quick replies ----------
function showQuickReplies(replies) {
  // remove existing
  document.querySelectorAll('.quick-replies').forEach(x => x.remove());
  if (!replies || !replies.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'quick-replies';
  wrap.style.cssText = 'max-width:760px;margin:0 auto 16px;display:flex;gap:6px;flex-wrap:wrap;padding:0 20px;';
  replies.forEach(r => {
    const btn = document.createElement('button');
    btn.className = 'msg-action';
    btn.textContent = r;
    btn.addEventListener('click', () => sendMessage(r));
    wrap.appendChild(btn);
  });
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

// ---------- Notifications ----------
function notifyComplete(text) {
  if (localStorage.getItem('boing-notify') === 'on' && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('BoingAI', { body: text.slice(0, 120), icon: '/static/logo.png' });
  }
  if (localStorage.getItem('boing-sound') === 'on') {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; g.gain.value = 0.05;
      o.start(); o.stop(ctx.currentTime + 0.12);
    } catch {}
  }
}

// ---------- Toggles & extras ----------
function isToggle(key) { return localStorage.getItem(key) === 'on'; }
function setToggle(key, val) { localStorage.setItem(key, val ? 'on' : 'off'); }

const togTimestamps = $('#togTimestamps');
const togTokens = $('#togTokens');
const togNotify = $('#togNotify');
const togSound = $('#togSound');
const togLineNums = $('#togLineNums');
const togWordWrap = $('#togWordWrap');

function initToggle(el, key, defaultOn = false) {
  const on = localStorage.getItem(key) === null ? defaultOn : localStorage.getItem(key) === 'on';
  if (on) el.checked = true;
  el.addEventListener('change', () => setToggle(key, el.checked));
}
initToggle(togTimestamps, 'boing-timestamps', true);
initToggle(togTokens, 'boing-tokens', false);
initToggle(togNotify, 'boing-notify', false);
initToggle(togSound, 'boing-sound', false);
initToggle(togLineNums, 'boing-linenum', false);
initToggle(togWordWrap, 'boing-wordwrap', true);
const togAutoScroll = $('#togAutoScroll');
initToggle(togAutoScroll, 'boing-autoscroll', true);

// notification permission
togNotify.addEventListener('change', () => {
  if (togNotify.checked && 'Notification' in window && Notification.permission !== 'granted') {
    Notification.requestPermission();
  }
});

// font family
const fontFamilySeg = $('#fontFamilySeg');
if (fontFamilySeg) {
  fontFamilySeg.querySelectorAll('.seg-btn').forEach(b => {
    b.addEventListener('click', () => {
      fontFamilySeg.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const v = b.dataset.val;
      const fam = v === 'sans'
        ? "'BoingSans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
        : v === 'mono'
        ? "ui-monospace, 'DejaVu Sans Mono', 'Cascadia Code', monospace"
        : "'Fira Code', ui-monospace, 'DejaVu Sans Mono', 'Cascadia Code', monospace";
      document.documentElement.style.setProperty('--font', fam);
      localStorage.setItem('boing-fontfamily-v2', v);
      toast('Font: ' + b.textContent);
    });
  });
  // v2 key: existing installs get Fira Code as the new default
  let savedFF = localStorage.getItem('boing-fontfamily-v2') || 'fira';
  const btn = Array.from(fontFamilySeg.querySelectorAll('.seg-btn')).find(b => b.dataset.val === savedFF);
  if (btn) btn.click();
}

// system prompt
const sysPromptInput = $('#systemPromptInput');
// temp/topp sliders
const tempSlider = $('#tempSlider');
const toppSlider = $('#toppSlider');
const tempVal = $('#tempVal');
const toppVal = $('#toppVal');
if (tempSlider) {
  tempSlider.value = localStorage.getItem('boing-temp') || '0.7';
  tempVal.textContent = tempSlider.value;
  tempSlider.addEventListener('input', () => {
    tempVal.textContent = tempSlider.value;
    localStorage.setItem('boing-temp', tempSlider.value);
  });
}
if (toppSlider) {
  toppSlider.value = localStorage.getItem('boing-topp') || '0.9';
  toppVal.textContent = toppSlider.value;
  toppSlider.addEventListener('input', () => {
    toppVal.textContent = toppSlider.value;
    localStorage.setItem('boing-topp', toppSlider.value);
  });
}

const saveSysPrompt = $('#saveSystemPrompt');
if (sysPromptInput) {
  sysPromptInput.value = localStorage.getItem('boing-systemprompt') || '';
  saveSysPrompt.addEventListener('click', () => {
    localStorage.setItem('boing-systemprompt', sysPromptInput.value);
    toast('System prompt saved');
  });
}

// word wrap toggle applies to code blocks
function applyWordWrap() {
  document.querySelectorAll('.bubble pre').forEach(pre => {
    pre.style.whiteSpace = isToggle('boing-wordwrap') ? 'pre-wrap' : 'pre';
  });
}

// timestamp visibility
function applyTimestamps() {
  document.querySelectorAll('.msg-meta').forEach(m => {
    m.style.display = isToggle('boing-timestamps') ? '' : 'none';
  });
}

// ---------- Bookmarks & clear all ----------
const bookmarksBtn = $('#bookmarksBtn');
const bookmarksBackdrop = $('#bookmarksBackdrop');
const bookmarksModal = $('#bookmarksModal');
const bookmarksClose = $('#bookmarksClose');
const bookmarksList = $('#bookmarksList');
const clearAllBtn = $('#clearAllBtn');

function renderBookmarks() {
  const bms = JSON.parse(localStorage.getItem('boing-bookmarks') || '[]');
  bookmarksList.innerHTML = '';
  if (!bms.length) { bookmarksList.textContent = 'No bookmarks yet.'; return; }
  bms.slice().reverse().forEach(bm => {
    const div = document.createElement('div');
    div.style.cssText = 'padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-2);';
    div.textContent = bm.text;
    bookmarksList.appendChild(div);
  });
}
function openBookmarks() { renderBookmarks(); bookmarksBackdrop.classList.add('show'); bookmarksModal.classList.add('show'); }
function closeBookmarks() { bookmarksBackdrop.classList.remove('show'); bookmarksModal.classList.remove('show'); }
bookmarksBtn.addEventListener('click', openBookmarks);
bookmarksClose.addEventListener('click', closeBookmarks);
bookmarksBackdrop.addEventListener('click', closeBookmarks);

clearAllBtn.addEventListener('click', async () => {
  if (!confirm('Delete all conversations?')) return;
  const convs = await fetchConversations();
  for (const c of convs) {
    await fetch(`/api/conversations/${c.id || c.Id}`, { method: 'DELETE' }).catch(()=>{});
  }
  newChat();
  toast('All cleared');
});

// ---------- Mode (normal / coding) ----------
const modeSeg = $('#modeSeg');
const modeSuggestions = {
  normal: [
    { icon: '💬', text: 'Explain quantum computing simply', prompt: 'Explain quantum computing in simple terms.' },
    { icon: '🌸', text: 'Write a poem about spring', prompt: 'Write a short poem about spring.' },
    { icon: '⚡', text: '5 productivity tips', prompt: 'Give me 5 productivity tips.' },
    { icon: '🦀', text: 'How do I learn Rust?', prompt: 'How do I learn Rust?' },
  ],
  coding: [
    { icon: '🖥️', text: 'Build a landing page', prompt: 'Build a modern responsive landing page in HTML/CSS/JS with a hero, features, and footer.' },
    { icon: '🐍', text: 'Python web scraper', prompt: 'Write a Python web scraper using requests and BeautifulSoup.' },
    { icon: '⚛️', text: 'React todo app', prompt: 'Create a React todo app with add, toggle, and delete.' },
    { icon: '🎨', text: 'Design a dashboard UI', prompt: 'Design a beautiful analytics dashboard UI in HTML/CSS with charts placeholders.' },
    { icon: '🦀', text: 'Rust HTTP server', prompt: 'Write a minimal HTTP server in Rust using axum.' },
    { icon: '🗄️', text: 'SQL query help', prompt: 'Explain SQL joins with examples.' },
  ],
};

function getMode() { return localStorage.getItem('boing-mode') || 'normal'; }
function setMode(mode) {
  localStorage.setItem('boing-mode', mode);
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  renderSuggestions();
  toast(mode === 'coding' ? 'Coding mode' : 'Normal mode');
}

function renderSuggestions() {
  const container = document.querySelector('.suggestions');
  if (!container) return;
  const mode = getMode();
  container.innerHTML = '';
  modeSuggestions[mode].forEach(s => {
    const btn = document.createElement('button');
    btn.className = 'suggestion';
    btn.dataset.text = s.prompt;
    btn.innerHTML = `<span class="sug-icon">${s.icon}</span><span class="sug-text">${s.text}</span>`;
    btn.addEventListener('click', () => sendMessage(s.prompt));
    container.appendChild(btn);
  });
}

function getSystemPrompt() {
  const custom = localStorage.getItem('boing-systemprompt') || '';
  const mode = getMode();
  const base = mode === 'coding'
    ? 'You are BoingAI, an expert software engineer and UI/UX designer. You can write code in any programming language (Rust, C++, C#, Python, JavaScript, TypeScript, Go, Java, etc.). You produce clean, well-structured, production-ready code. You excel at creating beautiful, modern, accessible user interfaces. When asked to create a UI, generate complete HTML/CSS/JS with attention to typography, spacing, color, responsiveness, and micro-interactions. Use markdown with fenced code blocks and specify the language. Be concise but thorough.'
    : 'You are BoingAI, a helpful, concise and friendly assistant. Keep answers clear and minimal.';
  return custom ? base + '\\n\\nAdditional instructions: ' + custom : base;
}

// wire mode seg
if (modeSeg) {
  modeSeg.querySelectorAll('.mode-btn').forEach(b => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  });
}
// init mode
setMode(getMode());

// patch sendMessage to use mode system prompt: override the system_prompt in fetch body
const _origSendMessage = sendMessage;

// ---------- Window controls (Electron) ----------
const windowControls = $('#windowControls');
const winMin = $('#winMin');
const winMax = $('#winMax');
const winFull = $('#winFull');
const winClose = $('#winClose');
if (winMin) winMin.addEventListener('click', async () => {
  if (window.boingWindow) await window.boingWindow.minimize();
  else { try { await fetch('/api/window/minimize', { method: 'POST' }); } catch {} }
});
if (winMax) winMax.addEventListener('click', async () => {
  if (window.boingWindow) await window.boingWindow.maximize();
  else {
    // toggle a maximized-like state via window resize not possible; use fullscreen
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(()=>{});
    else document.exitFullscreen();
  }
});
if (winFull) winFull.addEventListener('click', async () => {
  if (window.boingWindow) await window.boingWindow.fullscreen();
  else {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(()=>{});
    else document.exitFullscreen();
  }
});
if (winClose) winClose.addEventListener('click', async () => {
  if (window.boingWindow) await window.boingWindow.close();
  else {
    try { await fetch('/api/window/close', { method: 'POST' }); } catch {}
    window.close();
  }
});

// ---------- Init ----------
renderConvList();
inputEl.focus();
autoResize();
