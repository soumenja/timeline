import { Timeline, Overview, parseDate, formatDate, isRange, DAY } from './timeline.js';
import { encryptJSON, decryptJSON, isEncryptedPayload } from './crypto.js';
import { GitHubStore, DATA_PATH } from './github.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'timeline.github';
const PASS_KEY = 'timeline.pass';
const PALETTE = ['#37a70b', '#a70b0b', '#1898e0', '#f56c00', '#7b3fe4', '#0e9f9a', '#d6a100', '#2c3d4d'];

const state = {
  lib: null,  // { version: 2, timelines: [...] } — everything that gets encrypted and saved
  data: null, // the timeline currently open (one of lib.timelines), or null on the home page
  pass: null,
  dirty: false,
  demo: false,
  detailId: null,
  editing: null, // event being edited (null = new)
};

let store;
let timeline;
let overview;

/* ================= helpers ================= */

function toast(msg, isErr = false, ms = 3800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

/**
 * In-page replacement for confirm()/prompt(), which some browsers and embedded views block.
 * Resolves to true (confirm), the entered text (when `input` is given), or null if cancelled.
 */
function ask(text, { ok = 'OK', danger = false, input = null } = {}) {
  return new Promise((resolve) => {
    const dlg = $('ask');
    $('ask-text').textContent = text;
    $('ask-ok').textContent = ok;
    $('ask-ok').classList.toggle('danger', danger);
    $('ask-ok').classList.toggle('primary', !danger);
    $('ask-field').hidden = !input;
    if (input) {
      $('ask-label').textContent = input.label || '';
      $('ask-input').type = input.type || 'text';
      $('ask-input').value = input.value || '';
    }
    let result = null;
    const onSubmit = () => { result = input ? $('ask-input').value : true; };
    const onCancel = () => dlg.close();
    const onClose = () => {
      $('ask-form').removeEventListener('submit', onSubmit);
      $('ask-cancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('close', onClose);
      resolve(result);
    };
    $('ask-form').addEventListener('submit', onSubmit);
    $('ask-cancel').addEventListener('click', onCancel);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    if (input) { $('ask-input').focus(); $('ask-input').select(); } else { $('ask-ok').focus(); }
  });
}

function showError(id, msg) {
  const e = $(id);
  e.textContent = msg || '';
  e.hidden = !msg;
}

const pad = (n) => String(n).padStart(2, '0');
function splitDate(s) {
  const m = /^(-?\d{1,6})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(s || '');
  if (!m) return { date: '', time: '' };
  return { date: `${m[1].padStart(4, '0')}-${pad(m[2])}-${pad(m[3])}`, time: m[4] ? `${pad(m[4])}:${m[5]}` : '' };
}
function joinDate(date, time) { return time ? `${date}T${time}` : date; }
function msToParts(t) {
  const d = new Date(t);
  return { date: `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: '' };
}

function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 12);
}

/** One timeline: { id, title, updated, events[] }. */
function normalize(raw) {
  const src = Array.isArray(raw) ? { events: raw } : (raw || {});
  const events = (Array.isArray(src.events) ? src.events : []).map((e) => ({
    id: String(e.id || newId()),
    title: String(e.title ?? ''),
    description: String(e.description ?? ''),
    start: String(e.start ?? ''),
    ...(e.end ? { end: String(e.end) } : {}),
    style: ['card', 'pill', 'span', 'bar'].includes(e.style) ? e.style : (e.end ? 'span' : 'card'),
    color: /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : PALETTE[0],
    side: e.side === 'below' ? 'below' : 'above',
  })).filter((e) => !isNaN(parseDate(e.start)));
  return {
    id: String(src.id || newId()),
    title: String(src.title || 'Untitled timeline'),
    updated: typeof src.updated === 'string' ? src.updated : new Date().toISOString(),
    events,
  };
}

/**
 * The whole library: { version: 2, timelines[], sync? }. Also accepts a single timeline (older format).
 * `sync` holds the GitHub connection (including the token). It lives inside the encrypted file, so any
 * browser that knows the passphrase can save without asking for the token again.
 */
function normalizeLib(raw) {
  if (raw && Array.isArray(raw.timelines)) {
    const lib = { version: 2, timelines: raw.timelines.map(normalize) };
    const s = raw.sync;
    if (s && typeof s.token === 'string' && s.token && s.owner && s.repo) {
      lib.sync = { owner: String(s.owner), repo: String(s.repo), branch: String(s.branch || 'main'), token: s.token };
    }
    return lib;
  }
  if (Array.isArray(raw) && raw.length && raw[0] && Array.isArray(raw[0].events)) return { version: 2, timelines: raw.map(normalize) };
  if (raw && (Array.isArray(raw.events) || Array.isArray(raw))) return { version: 2, timelines: [normalize(raw)] };
  return { version: 2, timelines: [] };
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  const m = s / 60, h = m / 60, d = h / 24;
  if (m < 60) return `${Math.floor(m)} min ago`;
  if (h < 24) return `${Math.floor(h)} h ago`;
  if (d < 2) return 'yesterday';
  if (d < 30) return `${Math.floor(d)} days ago`;
  if (d < 365) { const mo = Math.floor(d / 30.44); return mo <= 1 ? 'a month ago' : `${mo} months ago`; }
  const dt = new Date(t);
  return `${dt.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dt.getMonth()]} ${dt.getFullYear()}`;
}

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { /* ignore */ }
  // Guess owner/repo from a GitHub Pages address like https://owner.github.io/repo/
  const host = location.hostname;
  if (host.endsWith('.github.io')) {
    s.owner = s.owner || host.split('.')[0];
    const first = location.pathname.split('/').filter(Boolean)[0];
    s.repo = s.repo || first || `${host}`;
  }
  return { owner: s.owner || '', repo: s.repo || '', branch: s.branch || 'main', token: s.token || '' };
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

function rememberPass(p) {
  try { if (p) sessionStorage.setItem(PASS_KEY, p); else sessionStorage.removeItem(PASS_KEY); } catch { /* ignore */ }
}

function readJSONFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { try { resolve(JSON.parse(r.result)); } catch { reject(new Error('That file is not valid JSON.')); } };
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsText(file);
  });
}

/* ================= startup ================= */

async function init() {
  store = new GitHubStore(loadSettings());
  let payload = null;
  if (store.ready) {
    try { payload = await store.read(); } catch (e) { console.warn(e); }
  }
  if (!payload) {
    try {
      const res = await fetch(DATA_PATH, { cache: 'no-store' });
      if (res.ok) payload = await res.json();
    } catch { /* no data file published yet */ }
  }
  $('gate-loading').hidden = true;

  if (payload && isEncryptedPayload(payload)) {
    state.payload = payload;
    $('unlock-form').hidden = false;
    let saved = null;
    try { saved = sessionStorage.getItem(PASS_KEY); } catch { /* ignore */ }
    if (saved) {
      try { openApp(await decryptJSON(payload, saved), saved); return; } catch { rememberPass(null); }
    }
    $('unlock-pass').focus();
  } else {
    $('setup-form').hidden = false;
    $('setup-pass').focus();
  }
}

$('unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pass = $('unlock-pass').value;
  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = 'Unlocking…';
  try {
    const data = await decryptJSON(state.payload, pass);
    rememberPass(pass);
    openApp(data, pass);
  } catch (err) {
    showError('unlock-error', err.message);
    $('unlock-pass').select();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock';
  }
});

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p1 = $('setup-pass').value, p2 = $('setup-pass2').value;
  if (p1.length < 10) return showError('setup-error', 'Use at least 10 characters.');
  if (p1 !== p2) return showError('setup-error', 'The two passphrases do not match.');
  let data = { version: 2, timelines: [] };
  const file = $('setup-file').files[0];
  if (file) {
    try {
      const raw = await readJSONFile(file);
      if (isEncryptedPayload(raw)) return showError('setup-error', 'That file is already encrypted. Publish it to the site and unlock it instead.');
      data = raw;
    } catch (err) { return showError('setup-error', err.message); }
  }
  rememberPass(p1);
  openApp(data, p1);
  markDirty();
  toast('Created. Connect GitHub (⋯ menu) and press Save to store it.', false, 7000);
});

$('demo-btn').addEventListener('click', () => {
  state.demo = true;
  const y = new Date().getFullYear();
  openApp({ timelines: [{
    title: 'Sample timeline',
    events: [
      { title: 'Started the course', start: `${y}-01-12`, side: 'above', color: '#37a70b' },
      { title: 'Exam week', start: `${y}-02-10`, end: `${y}-02-16`, style: 'span', side: 'below', color: '#1898e0' },
      { title: 'Passed the exam!\nGot certificate', description: 'Score 92%', start: `${y}-02-20`, side: 'above', color: '#37a70b' },
      { title: 'Waiting for reply', start: `${y}-03-01`, end: `${y}-03-20`, style: 'bar', side: 'above', color: '#a70b0b' },
      { title: 'Application sent', start: `${y}-03-02T10:30`, side: 'below', color: '#f56c00' },
      { title: 'Milestone', start: `${y}-04-05`, style: 'pill', side: 'below', color: '#7b3fe4' },
    ],
  }, {
    title: 'Sample project',
    events: [
      { title: 'Kick-off', start: `${y}-05-02`, side: 'above', color: '#1898e0' },
      { title: 'Build phase', start: `${y}-05-05`, end: `${y}-06-20`, style: 'bar', side: 'below', color: '#37a70b' },
      { title: 'Review', start: `${y}-06-25`, style: 'pill', side: 'above', color: '#a70b0b' },
    ],
  }] }, null);
  toast('Sample mode: changes are not saved.', false, 5000);
});

function openApp(raw, pass) {
  state.lib = normalizeLib(raw);
  state.pass = pass;
  $('gate').hidden = true;
  $('app').hidden = false;
  if (!timeline) {
    timeline = new Timeline($('stage'), {
      onSelect: (id) => (id ? openDetail(id) : closeDetail()),
      onCreate: (t, side) => openEditor(null, { t, side }),
      onView: () => overview && overview.render(),
    });
    overview = new Overview($('overview'), timeline);
  }
  route();
  adoptSyncFromLibrary();
}

// If this browser has no token yet but the unlocked file carries one, use it, then make sure we show the
// newest saved version (the public website copy can lag a minute or two behind GitHub).
async function adoptSyncFromLibrary() {
  if (state.demo) return;
  const s = state.lib.sync;
  if (!store.ready && s) {
    store = new GitHubStore(s);
    saveSettings(s);
  } else if (store.ready && !s) {
    // Older file without the connection inside: add it on the next save.
    state.lib.sync = { owner: store.owner, repo: store.repo, branch: store.branch, token: store.token };
  }
  if (!store.ready || state.dirty) return;
  try {
    const latest = await store.read();
    if (latest && isEncryptedPayload(latest) && state.payload && latest.data !== state.payload.data && !state.dirty) {
      const fresh = await decryptJSON(latest, state.pass);
      if (state.dirty) return;
      state.payload = latest;
      const openId = state.data && state.data.id;
      state.lib = normalizeLib(fresh);
      if (!state.lib.sync) state.lib.sync = { owner: store.owner, repo: store.repo, branch: store.branch, token: store.token };
      if (openId && state.lib.timelines.some((t) => t.id === openId)) openTimeline(openId, false); else showHome(false);
    }
  } catch (err) {
    console.warn('Could not check GitHub for a newer version:', err);
  }
}

/* ================= home & navigation ================= */

// The address bar remembers which timeline is open (#t-<id>) so reload/back work.
function route() {
  const m = /^#t-(.+)$/.exec(location.hash);
  const tl = m && state.lib.timelines.find((t) => t.id === decodeURIComponent(m[1]));
  if (tl) openTimeline(tl.id, false); else showHome(false);
}
window.addEventListener('hashchange', () => { if (state.lib) route(); });

function setMode(mode) {
  $('app').classList.toggle('mode-home', mode === 'home');
  $('app').classList.toggle('mode-tl', mode === 'tl');
  $('menu').hidden = true;
}

function showHome(push = true) {
  if (push && location.hash) { history.pushState(null, '', location.pathname + location.search); }
  state.data = null;
  closeDetail();
  toggleList(false);
  setMode('home');
  document.title = 'My Timelines';
  renderHome();
}

function openTimeline(id, push = true) {
  const tl = state.lib.timelines.find((t) => t.id === id);
  if (!tl) return showHome();
  if (push) history.pushState(null, '', '#t-' + encodeURIComponent(id));
  state.data = tl;
  closeDetail();
  setMode('tl');
  refresh();
  timeline.fit();
  $('stage').focus({ preventScroll: true });
}

function renderHome() {
  const grid = $('grid');
  grid.textContent = '';
  const list = [...state.lib.timelines].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  for (const tl of list) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'tcard';
    const prev = document.createElement('div');
    prev.className = 'tcard-preview';
    const badge = document.createElement('span');
    badge.className = 'tcard-badge';
    badge.textContent = '🔒 Private';
    prev.append(badge, previewSVG(tl.events));
    const title = document.createElement('div');
    title.className = 'tcard-title';
    title.textContent = tl.title;
    const meta = document.createElement('div');
    meta.className = 'tcard-meta';
    const n = tl.events.length;
    meta.textContent = `${n} event${n === 1 ? '' : 's'} · ${relTime(tl.updated)}`;
    card.append(prev, title, meta);
    card.addEventListener('click', () => openTimeline(tl.id));
    grid.appendChild(card);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'tcard new';
  const box = document.createElement('div');
  box.className = 'tcard-preview';
  box.textContent = '＋ Create a timeline';
  add.append(box);
  add.addEventListener('click', createTimeline);
  grid.appendChild(add);
}

// Small picture of a timeline for its card: a line with dots above/below and bars for periods.
function previewSVG(events) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 240 112');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.appendChild(e); return e; };
  const AXIS = 72; // a little below centre, so dots above the line clear the "Private" badge
  mk('line', { x1: 8, x2: 232, y1: AXIS, y2: AXIS, stroke: '#4a5d72', 'stroke-width': 1 });
  const evs = events.map((e) => ({ e, s: parseDate(e.start), en: isRange(e) ? parseDate(e.end) : null })).filter((x) => !isNaN(x.s));
  if (!evs.length) return svg;
  let lo = Math.min(...evs.map((x) => x.s)), hi = Math.max(...evs.map((x) => x.en ?? x.s));
  if (hi - lo < DAY) { lo -= DAY; hi += DAY; }
  const X = (t) => 16 + ((t - lo) / (hi - lo)) * 208;
  const rows = { above: [], below: [] };
  const rowOf = (side, x1, x2) => {
    const r = rows[side];
    let i = 0;
    while (i < r.length && r[i] > x1 - 7) i++;
    r[i] = x2;
    return Math.min(i, 3);
  };
  evs.sort((a, b) => a.s - b.s);
  for (const { e, s, en } of evs) {
    const side = e.side === 'below' ? 'below' : 'above';
    const dir = side === 'above' ? -1 : 1;
    if (en !== null) {
      const x1 = X(s), x2 = Math.max(X(en), x1 + 4);
      const row = rowOf(side, x1, x2);
      mk('rect', { x: x1, y: AXIS + dir * (8 + row * 8) - 2, width: x2 - x1, height: 4, rx: 2, fill: e.color, opacity: e.style === 'span' ? 0.55 : 1 });
    } else {
      const x = X(s);
      const row = rowOf(side, x - 5, x + 5);
      mk('circle', { cx: x, cy: AXIS + dir * (12 + row * 11), r: 5, fill: e.color, stroke: '#ffffff', 'stroke-width': 1.4 });
    }
  }
  return svg;
}

async function createTimeline() {
  if (!state.lib) return;
  const name = await ask('Create a timeline', { ok: 'Create', input: { label: 'Timeline name', value: '' } });
  if (name === null) return;
  const tl = normalize({ title: name.trim() || 'Untitled timeline', events: [] });
  state.lib.timelines.push(tl);
  markDirty();
  openTimeline(tl.id);
  toast('Double-click anywhere on the timeline to add your first event.', false, 6000);
}
$('create-btn').addEventListener('click', createTimeline);
$('back-btn').addEventListener('click', () => showHome());

async function renameTimeline() {
  if (!state.data) return;
  const t = await ask('Rename this timeline', { ok: 'Rename', input: { label: 'Timeline name', value: state.data.title } });
  if (t && t.trim() && t.trim() !== state.data.title) change(() => { state.data.title = t.trim(); });
}

function duplicateTimeline() {
  if (!state.data) return;
  const copy = normalize(JSON.parse(JSON.stringify({ ...state.data, id: newId(), title: state.data.title + ' (copy)' })));
  copy.updated = new Date().toISOString();
  state.lib.timelines.push(copy);
  markDirty();
  openTimeline(copy.id);
  toast('Copy created.');
}

async function deleteTimeline() {
  if (!state.data) return;
  const tl = state.data;
  const ok = await ask(`Delete the timeline "${tl.title}" and its ${tl.events.length} events?\nThis is permanent once you press Save.`, { ok: 'Delete timeline', danger: true });
  if (!ok) return;
  state.lib.timelines = state.lib.timelines.filter((t) => t !== tl);
  markDirty();
  showHome();
  toast('Timeline deleted. Press Save to keep the change.');
}

/* ================= state changes ================= */

function markDirty() {
  if (state.demo) return;
  state.dirty = true;
  state.version = (state.version || 0) + 1;
  $('save-btn').classList.add('dirty');
  $('save-btn').textContent = 'Save •';
  scheduleAutosave();
}

/* ================= autosave ================= */

const AUTOSAVE_KEY = 'timeline.autosave';
const AUTOSAVE_DELAY = 10000; // save 10 s after the last change
let autosaveTimer = null;

function autosaveOn() {
  try { return localStorage.getItem(AUTOSAVE_KEY) !== 'off'; } catch { return true; }
}

function scheduleAutosave(delay = AUTOSAVE_DELAY) {
  clearTimeout(autosaveTimer);
  if (!autosaveOn() || state.demo || !state.dirty || !store || !store.ready) return;
  autosaveTimer = setTimeout(() => save({ auto: true }), delay);
}

function renderAutosaveItem() {
  const b = menu.querySelector('[data-action="autosave"]');
  if (b) b.textContent = `Autosave: ${autosaveOn() ? 'On' : 'Off'}`;
}

// Leaving or hiding the tab saves straight away instead of waiting.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && state.dirty && autosaveOn()) save({ auto: true });
});

function refresh() {
  if (!state.data) { renderHome(); return; }
  document.title = state.data.title;
  $('title-btn').textContent = state.data.title;
  timeline.setEvents(state.data.events);
  if (!$('list-panel').hidden) renderList();
}

// Apply a change to the open timeline.
function change(fn) {
  fn();
  if (state.data) state.data.updated = new Date().toISOString();
  markDirty();
  refresh();
}

/* ================= detail popover ================= */

function openDetail(id) {
  const ev = state.data.events.find((e) => e.id === id);
  if (!ev) return;
  state.detailId = id;
  timeline.select(id);
  $('detail-color').style.background = ev.color;
  let when = formatDate(ev.start);
  if (isRange(ev)) when += ` → ${formatDate(ev.end)}`;
  $('detail-date').textContent = when;
  $('detail-title').textContent = ev.title;
  $('detail-desc').textContent = ev.description && ev.description.trim() !== ev.title.trim() ? ev.description : '';
  $('detail').hidden = false;
}

function closeDetail() {
  state.detailId = null;
  $('detail').hidden = true;
  timeline && timeline.select(null);
}

$('detail-close').addEventListener('click', closeDetail);
$('detail-edit').addEventListener('click', () => {
  const ev = state.data.events.find((e) => e.id === state.detailId);
  if (ev) openEditor(ev);
});
$('detail-dup').addEventListener('click', () => {
  const ev = state.data.events.find((e) => e.id === state.detailId);
  if (!ev) return;
  const copy = { ...ev, id: newId() };
  change(() => state.data.events.push(copy));
  openDetail(copy.id);
  openEditor(copy);
});
$('detail-del').addEventListener('click', async () => {
  const ev = state.data.events.find((e) => e.id === state.detailId);
  if (!ev) return;
  const name = ev.title.split('\n')[0].slice(0, 60);
  if (!(await ask(`Delete "${name}"?`, { ok: 'Delete', danger: true }))) return;
  change(() => { state.data.events = state.data.events.filter((e) => e.id !== ev.id); });
  closeDetail();
  toast('Event deleted. Press Save to keep the change.');
});

/* ================= editor ================= */

let chosenColor = PALETTE[0];

function renderSwatches() {
  const box = $('ed-colors');
  box.textContent = '';
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = c;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', c);
    b.setAttribute('aria-checked', String(c.toLowerCase() === chosenColor.toLowerCase()));
    b.addEventListener('click', () => { chosenColor = c; renderSwatches(); });
    box.appendChild(b);
  }
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.className = 'swatch-custom';
  custom.title = 'Custom color';
  custom.value = chosenColor;
  custom.addEventListener('change', () => { chosenColor = custom.value; renderSwatches(); });
  box.appendChild(custom);
}

function syncRangeUI() {
  const hasEnd = $('ed-has-end').checked;
  $('ed-end-row').hidden = !hasEnd;
  const sel = $('ed-style');
  for (const opt of sel.options) opt.disabled = opt.hasAttribute('data-range') ? !hasEnd : hasEnd;
  if (sel.selectedOptions[0]?.disabled) sel.value = hasEnd ? 'span' : 'card';
}

function openEditor(ev, preset = {}) {
  state.editing = ev;
  $('editor-heading').textContent = ev ? 'Edit event' : 'New event';
  const start = ev ? splitDate(ev.start) : msToParts(preset.t ?? Date.now());
  $('ed-title').value = ev ? ev.title : '';
  $('ed-desc').value = ev ? ev.description : '';
  $('ed-date').value = start.date;
  $('ed-time').value = start.time;
  const hasEnd = !!(ev && isRange(ev));
  $('ed-has-end').checked = hasEnd;
  const end = hasEnd ? splitDate(ev.end) : msToParts(parseDate(start.date) + 7 * DAY);
  $('ed-end-date').value = end.date;
  $('ed-end-time').value = end.time;
  $('ed-style').value = ev ? ev.style : 'card';
  $('ed-side').value = ev ? ev.side : (preset.side || 'above');
  chosenColor = ev ? ev.color : PALETTE[0];
  syncRangeUI();
  renderSwatches();
  $('editor').showModal();
  $('ed-title').focus();
}

$('ed-has-end').addEventListener('change', syncRangeUI);
$('ed-cancel').addEventListener('click', () => $('editor').close());

$('editor-form').addEventListener('submit', (e) => {
  const title = $('ed-title').value.trim();
  const date = $('ed-date').value;
  if (!title || !date) { e.preventDefault(); return; }
  const hasEnd = $('ed-has-end').checked;
  const start = joinDate(date, $('ed-time').value);
  let end = hasEnd ? joinDate($('ed-end-date').value || date, $('ed-end-time').value) : undefined;
  if (end && parseDate(end) < parseDate(start)) end = start;
  const ev = {
    id: state.editing ? state.editing.id : newId(),
    title,
    description: $('ed-desc').value.trim(),
    start,
    ...(end ? { end } : {}),
    style: $('ed-style').value,
    color: chosenColor,
    side: $('ed-side').value,
  };
  change(() => {
    const i = state.data.events.findIndex((x) => x.id === ev.id);
    if (i >= 0) state.data.events[i] = ev; else state.data.events.push(ev);
  });
  if (!state.editing) timeline.focus(ev.id);
  openDetail(ev.id);
});

/* ================= list panel ================= */

function renderList() {
  const q = $('list-search').value.trim().toLowerCase();
  const items = [...state.data.events]
    .sort((a, b) => parseDate(a.start) - parseDate(b.start))
    .filter((e) => !q || (e.title + ' ' + e.description).toLowerCase().includes(q));
  const ol = $('list-items');
  ol.textContent = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'list-empty';
    li.textContent = q ? 'No matching events.' : 'No events yet. Double-click the timeline to add one.';
    ol.appendChild(li);
    return;
  }
  for (const ev of items) {
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = 'list-swatch';
    sw.style.background = ev.color;
    const body = document.createElement('div');
    const date = document.createElement('div');
    date.className = 'list-date';
    date.textContent = formatDate(ev.start, false) + (isRange(ev) ? ` → ${formatDate(ev.end, false)}` : '');
    const text = document.createElement('div');
    text.className = 'list-text';
    text.textContent = ev.title;
    body.append(date, text);
    li.append(sw, body);
    li.addEventListener('click', () => {
      timeline.focus(ev.id);
      openDetail(ev.id);
      if (window.innerWidth < 700) $('list-panel').hidden = true;
    });
    ol.appendChild(li);
  }
}

function toggleList(force) {
  const p = $('list-panel');
  p.hidden = force === undefined ? !p.hidden : !force;
  if (!p.hidden) { renderList(); $('list-search').focus(); }
}

$('list-btn').addEventListener('click', () => toggleList());
$('list-close').addEventListener('click', () => toggleList(false));
$('list-search').addEventListener('input', renderList);

/* ================= toolbar ================= */

$('new-btn').addEventListener('click', () => {
  const mid = timeline.xToTime(timeline.width / 2);
  openEditor(null, { t: Date.now() >= timeline.start && Date.now() <= timeline.end ? Date.now() : mid });
});
$('fit-btn').addEventListener('click', () => timeline.fit());
$('today-btn').addEventListener('click', () => { timeline.offsetY = 0; timeline.centerOn(Date.now()); });
$('zoom-in').addEventListener('click', () => timeline.zoomAt(1.5));
$('zoom-out').addEventListener('click', () => timeline.zoomAt(1 / 1.5));
$('title-btn').addEventListener('click', renameTimeline);
$('save-btn').addEventListener('click', () => save());

const menu = $('menu');
$('menu-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
menu.addEventListener('click', (e) => {
  const action = e.target.closest('button')?.dataset.action;
  if (!action) return;
  menu.hidden = true;
  ({
    rename: renameTimeline,
    duplicate: duplicateTimeline,
    delete: deleteTimeline,
    settings: openSettings,
    export: exportBackup,
    import: () => $('import-file').click(),
    passphrase: () => {
      if (state.demo) return toast('Not available in sample mode.');
      $('np1').value = ''; $('np2').value = ''; showError('np-error', '');
      $('pass-dialog').showModal();
    },
    autosave: () => {
      const on = !autosaveOn();
      try { localStorage.setItem(AUTOSAVE_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
      renderAutosaveItem();
      if (on) scheduleAutosave(1000); else clearTimeout(autosaveTimer);
      toast(on ? 'Autosave on: changes save 10 seconds after you stop editing.' : 'Autosave off: press Save (Ctrl+S) to save.');
    },
    help: () => $('help').showModal(),
    lock,
  })[action]();
});
renderAutosaveItem();

/* ================= save / GitHub ================= */

let saving = null; // the save in progress, so two saves never overlap

async function save({ auto = false } = {}) {
  if (state.demo) { if (!auto) toast('Sample mode: nothing is saved. Reload the page to create your own timeline.'); return; }
  if (!store.ready) {
    if (auto) return;
    toast('Connect your GitHub repository first.');
    openSettings();
    return;
  }
  if (saving) { await saving; if (!state.dirty) return; }
  if (auto && !state.dirty) return;
  clearTimeout(autosaveTimer);
  const btn = $('save-btn');
  const versionAtStart = state.version || 0;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  saving = (async () => {
    try {
      if (!state.lib.sync) state.lib.sync = { owner: store.owner, repo: store.repo, branch: store.branch, token: store.token };
      const payload = await encryptJSON(state.lib, state.pass);
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      await store.write(payload, `${auto ? 'Autosave' : 'Update'} timelines (${stamp})`);
      state.payload = payload;
      if ((state.version || 0) === versionAtStart) {
        state.dirty = false;
        btn.classList.remove('dirty');
        const t = new Date();
        btn.textContent = auto ? `Saved ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : 'Save';
        btn.title = 'All changes saved to GitHub (Ctrl+S saves now)';
        if (!auto) toast('Saved to GitHub ✓');
      } else {
        btn.textContent = 'Save •'; // edited while saving: save again shortly
        scheduleAutosave();
      }
    } catch (err) {
      btn.textContent = 'Save •';
      toast((auto ? 'Autosave failed: ' : '') + err.message, true, 8000);
    } finally {
      btn.disabled = false;
    }
  })();
  await saving;
  saving = null;
}

function openSettings() {
  const s = { owner: store.owner, repo: store.repo, branch: store.branch, token: store.token };
  $('gh-owner').value = s.owner;
  $('gh-repo').value = s.repo;
  $('gh-branch').value = s.branch || 'main';
  $('gh-token').value = s.token;
  $('gh-status').hidden = true;
  $('settings').showModal();
}

$('gh-cancel').addEventListener('click', () => $('settings').close());
$('gh-forget').addEventListener('click', () => {
  const s = { owner: store.owner, repo: store.repo, branch: store.branch, token: '' };
  saveSettings(s);
  store = new GitHubStore(s);
  $('gh-token').value = '';
  clearTimeout(autosaveTimer);
  if (state.lib && state.lib.sync) {
    delete state.lib.sync;
    state.dirty = true;
    $('save-btn').classList.add('dirty');
    $('save-btn').textContent = 'Save •';
  }
  toast('Token removed from this browser. To also remove it from the saved file, paste a new token and save once.', false, 8000);
});

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = {
    owner: $('gh-owner').value.trim(),
    repo: $('gh-repo').value.trim(),
    branch: $('gh-branch').value.trim() || 'main',
    token: $('gh-token').value.trim(),
  };
  const status = $('gh-status');
  status.hidden = false;
  status.className = 'small';
  status.textContent = 'Checking…';
  const candidate = new GitHubStore(s);
  try {
    if (!s.token) throw new Error('Paste a token first.');
    await candidate.check();
    const existing = await candidate.read();
    if (existing && !isEncryptedPayload(existing)) throw new Error(`${DATA_PATH} in the repo is not an encrypted timeline file.`);
    if (existing && state.pass) {
      try { await decryptJSON(existing, state.pass); } catch {
        throw new Error('That repo already has a timeline locked with a different passphrase. Saving would replace it, so it was not connected.');
      }
    }
    store = candidate;
    saveSettings(s);
    $('settings').close();
    if (state.lib && !state.demo) {
      state.lib.sync = s; // remembered inside the encrypted file, so other browsers only need the passphrase
      markDirty();
      toast('Connected ✓ Saving now. Next time, your passphrase is all you need.');
      save({ auto: true });
    } else {
      toast('Connected to GitHub ✓');
    }
  } catch (err) {
    status.className = 'small error';
    status.textContent = err.message;
  }
});

/* ================= export / import / passphrase / lock ================= */

function exportBackup() {
  const { sync, ...withoutToken } = state.lib; // never put the token in an unencrypted file
  const blob = new Blob([JSON.stringify(withoutToken, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `timeline-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Backup downloaded. It is NOT encrypted: keep it private and never upload it to the repo.', false, 7000);
}

$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    let raw = await readJSONFile(file);
    if (isEncryptedPayload(raw)) {
      const p = await ask('This file is encrypted.', { ok: 'Unlock', input: { label: 'Its passphrase', type: 'password' } });
      if (!p) return;
      raw = await decryptJSON(raw, p);
    }
    const incoming = normalizeLib(raw).timelines.filter((t) => t.events.length);
    if (!incoming.length) return toast('No events found in that file.', true);
    const nEv = incoming.reduce((n, t) => n + t.events.length, 0);
    const names = incoming.map((t) => '• ' + t.title).slice(0, 8).join('\n') + (incoming.length > 8 ? '\n…' : '');
    if (!(await ask(`Add ${incoming.length} timeline${incoming.length === 1 ? '' : 's'} (${nEv} events) from "${file.name}"?\n${names}\n\nA timeline with the same id is replaced.`, { ok: 'Import' }))) return;
    for (const t of incoming) {
      const i = state.lib.timelines.findIndex((x) => x.id === t.id);
      if (i >= 0) state.lib.timelines[i] = t; else state.lib.timelines.push(t);
    }
    markDirty();
    showHome();
    toast(`Imported ${incoming.length} timeline${incoming.length === 1 ? '' : 's'}. Press Save to keep them.`);
  } catch (err) {
    toast(err.message, true);
  }
});

$('np-cancel').addEventListener('click', () => $('pass-dialog').close());
$('pass-form').addEventListener('submit', (e) => {
  const a = $('np1').value, b = $('np2').value;
  if (a.length < 10) { e.preventDefault(); return showError('np-error', 'Use at least 10 characters.'); }
  if (a !== b) { e.preventDefault(); return showError('np-error', 'The two passphrases do not match.'); }
  state.pass = a;
  rememberPass(a);
  state.dirty = false; // force the dirty flag on even if nothing else changed
  markDirty();
  toast('Passphrase changed. Press Save to re-encrypt the file with it.');
});

$('help-close').addEventListener('click', () => $('help').close());

async function lock() {
  if (state.dirty && !(await ask('You have unsaved changes. Lock anyway and lose them?', { ok: 'Lock', danger: true }))) return;
  state.dirty = false;
  rememberPass(null);
  location.reload();
}

/* ================= global keys ================= */

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (!$('app').hidden) save();
    return;
  }
  if ($('app').hidden || document.querySelector('dialog[open]')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const inTimeline = !!state.data;
  if (k === 'escape') {
    const somethingOpen = !$('detail').hidden || !$('list-panel').hidden || !menu.hidden;
    closeDetail(); toggleList(false); menu.hidden = true;
    if (!somethingOpen && inTimeline) showHome();
    return;
  }
  if (!inTimeline) return;
  if (k === 'n') { e.preventDefault(); $('new-btn').click(); }
  else if (k === 'l') toggleList();
  else if (k === 'f') timeline.fit();
  else if (k === 't') $('today-btn').click();
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

init();
