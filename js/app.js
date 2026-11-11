import { Timeline, Overview, parseDate, formatDate, isRange, DAY } from './timeline.js';
import { encryptJSON, decryptJSON, isEncryptedPayload } from './crypto.js';
import { GitHubStore, DATA_PATH } from './github.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'timeline.github';
const PASS_KEY = 'timeline.pass';
const PALETTE = ['#37a70b', '#a70b0b', '#1898e0', '#f56c00', '#7b3fe4', '#0e9f9a', '#d6a100', '#2c3d4d'];

const state = {
  data: { title: 'My Timeline', events: [] },
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
  return { title: String(src.title || 'My Timeline'), events };
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
  let data = { title: 'My Timeline', events: [] };
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
  toast('Timeline created. Connect GitHub (⋯ menu) and press Save to store it.', false, 7000);
});

$('demo-btn').addEventListener('click', () => {
  state.demo = true;
  const y = new Date().getFullYear();
  openApp({
    title: 'Sample timeline',
    events: [
      { title: 'Started the course', start: `${y}-01-12`, side: 'above', color: '#37a70b' },
      { title: 'Exam week', start: `${y}-02-10`, end: `${y}-02-16`, style: 'span', side: 'below', color: '#1898e0' },
      { title: 'Passed the exam!\nGot certificate', description: 'Score 92%', start: `${y}-02-20`, side: 'above', color: '#37a70b' },
      { title: 'Waiting for reply', start: `${y}-03-01`, end: `${y}-03-20`, style: 'bar', side: 'above', color: '#a70b0b' },
      { title: 'Application sent', start: `${y}-03-02T10:30`, side: 'below', color: '#f56c00' },
      { title: 'Milestone', start: `${y}-04-05`, style: 'pill', side: 'below', color: '#7b3fe4' },
    ],
  }, null);
  toast('Sample mode: changes are not saved.', false, 5000);
});

function openApp(raw, pass) {
  state.data = normalize(raw);
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
  refresh();
  timeline.fit();
  $('stage').focus({ preventScroll: true });
}

/* ================= state changes ================= */

function markDirty() {
  if (state.demo) return;
  state.dirty = true;
  $('save-btn').classList.add('dirty');
  $('save-btn').textContent = 'Save •';
}

function refresh() {
  document.title = state.data.title;
  $('title-btn').textContent = state.data.title;
  timeline.setEvents(state.data.events);
  if (!$('list-panel').hidden) renderList();
}

function change(fn) {
  fn();
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
$('detail-del').addEventListener('click', () => {
  const ev = state.data.events.find((e) => e.id === state.detailId);
  if (!ev) return;
  const name = ev.title.split('\n')[0].slice(0, 60);
  if (!confirm(`Delete "${name}"?`)) return;
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
$('title-btn').addEventListener('click', () => {
  const t = prompt('Timeline name', state.data.title);
  if (t && t.trim() && t.trim() !== state.data.title) change(() => { state.data.title = t.trim(); });
});
$('save-btn').addEventListener('click', save);

const menu = $('menu');
$('menu-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
menu.addEventListener('click', (e) => {
  const action = e.target.closest('button')?.dataset.action;
  if (!action) return;
  menu.hidden = true;
  ({
    settings: openSettings,
    export: exportBackup,
    import: () => $('import-file').click(),
    passphrase: () => {
      if (state.demo) return toast('Not available in sample mode.');
      $('np1').value = ''; $('np2').value = ''; showError('np-error', '');
      $('pass-dialog').showModal();
    },
    help: () => $('help').showModal(),
    lock,
  })[action]();
});

/* ================= save / GitHub ================= */

async function save() {
  if (state.demo) return toast('Sample mode: nothing is saved. Reload the page to create your own timeline.');
  if (!store.ready) {
    toast('Connect your GitHub repository first.');
    openSettings();
    return;
  }
  const btn = $('save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const payload = await encryptJSON(state.data, state.pass);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    await store.write(payload, `Update timeline (${stamp})`);
    state.dirty = false;
    btn.classList.remove('dirty');
    btn.textContent = 'Save';
    toast('Saved to GitHub ✓ The website shows it in about a minute.');
  } catch (err) {
    btn.textContent = state.dirty ? 'Save •' : 'Save';
    toast(err.message, true, 7000);
  } finally {
    btn.disabled = false;
  }
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
  toast('Token removed from this browser.');
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
    toast(state.dirty ? 'Connected ✓ Press Save to store your changes.' : 'Connected to GitHub ✓');
  } catch (err) {
    status.className = 'small error';
    status.textContent = err.message;
  }
});

/* ================= export / import / passphrase / lock ================= */

function exportBackup() {
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
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
      const p = prompt('This file is encrypted. Enter its passphrase:');
      if (!p) return;
      raw = await decryptJSON(raw, p);
    }
    const incoming = normalize(raw);
    if (!incoming.events.length) return toast('No events found in that file.', true);
    if (!confirm(`Add ${incoming.events.length} events from "${file.name}"?\nEvents with the same id are replaced.`)) return;
    change(() => {
      const byId = new Map(state.data.events.map((x) => [x.id, x]));
      for (const ev of incoming.events) byId.set(ev.id, ev);
      state.data.events = [...byId.values()];
      if (state.data.title === 'My Timeline' && incoming.title !== 'My Timeline') state.data.title = incoming.title;
    });
    timeline.fit();
    toast(`Imported ${incoming.events.length} events. Press Save to keep them.`);
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

function lock() {
  if (state.dirty && !confirm('You have unsaved changes. Lock anyway and lose them?')) return;
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
  if (k === 'escape') { closeDetail(); toggleList(false); menu.hidden = true; }
  else if (k === 'n') { e.preventDefault(); $('new-btn').click(); }
  else if (k === 'l') toggleList();
  else if (k === 'f') timeline.fit();
  else if (k === 't') $('today-btn').click();
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

init();
