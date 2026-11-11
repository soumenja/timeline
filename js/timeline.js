// Zoomable, draggable horizontal timeline rendered with plain DOM elements.

export const DAY = 864e5;
const HOUR = 36e5;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MIN_SPAN = 6 * HOUR;          // most zoomed-in: 6 hours across the screen
const MAX_SPAN = 400 * 365.25 * DAY; // most zoomed-out: 400 years across the screen

export const isRange = (ev) => (ev.style === 'span' || ev.style === 'bar') && !!ev.end;

/** "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" in local time -> epoch ms (NaN if invalid). */
export function parseDate(s) {
  const m = /^(-?\d{1,6})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(s || '');
  if (!m) return NaN;
  const d = new Date(2000, 0, 1);
  d.setFullYear(+m[1], +m[2] - 1, +m[3]);
  d.setHours(m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, 0, 0);
  return d.getTime();
}

export function formatDate(s, withTime = true) {
  const t = parseDate(s);
  if (isNaN(t)) return '';
  const d = new Date(t);
  let out = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (withTime && /[T ]\d/.test(s)) out += `, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return out;
}

const TICK_LEVELS = [
  ['hour', 1], ['hour', 3], ['hour', 6], ['hour', 12],
  ['day', 1], ['day', 2], ['day', 5],
  ['month', 1], ['month', 3], ['month', 6],
  ['year', 1], ['year', 2], ['year', 5], ['year', 10], ['year', 25], ['year', 50], ['year', 100],
];
const APPROX = { hour: HOUR, day: DAY, month: 30.44 * DAY, year: 365.25 * DAY };

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

export class Timeline {
  constructor(root, { onSelect, onCreate, onView } = {}) {
    this.root = root;
    this.onSelect = onSelect || (() => {});
    this.onCreate = onCreate || (() => {});
    this.onView = onView || (() => {});
    this.events = [];
    this.nodes = new Map();
    this.selectedId = null;
    this.offsetY = 0;
    this.pxPerMs = 1;
    this.start = Date.now() - 30 * DAY;

    this.gridLayer = el('div', 'tl-layer', root);
    this.axisLayer = el('div', 'tl-layer', root);
    this.evLayer = el('div', 'tl-layer', root);

    this.bindInput();
    new ResizeObserver(() => this.schedule()).observe(root);
  }

  get width() { return this.root.clientWidth || 1; }
  get height() { return this.root.clientHeight || 1; }
  get end() { return this.start + this.width / this.pxPerMs; }
  timeToX(t) { return (t - this.start) * this.pxPerMs; }
  xToTime(x) { return this.start + x / this.pxPerMs; }

  /* ---------------- view control ---------------- */

  setView(start, end) {
    const span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, end - start));
    const mid = (start + end) / 2;
    this.pxPerMs = this.width / span;
    this.start = mid - span / 2;
    this.schedule();
  }

  zoomAt(factor, x = this.width / 2) {
    const t = this.xToTime(x);
    const span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, this.width / (this.pxPerMs * factor)));
    this.pxPerMs = this.width / span;
    this.start = t - x / this.pxPerMs;
    this.schedule();
  }

  panBy(dx, dy = 0) {
    this.start -= dx / this.pxPerMs;
    this.offsetY += dy;
    this.schedule();
  }

  centerOn(t) {
    this.start = t - this.width / 2 / this.pxPerMs;
    this.schedule();
  }

  extent() {
    if (!this.events.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (const ev of this.events) {
      lo = Math.min(lo, ev._s);
      hi = Math.max(hi, ev._e ?? ev._s);
    }
    return [lo, hi];
  }

  fit() {
    const ext = this.extent();
    this.offsetY = 0;
    if (!ext) { this.setView(Date.now() - 45 * DAY, Date.now() + 45 * DAY); return; }
    const pad = Math.max((ext[1] - ext[0]) * 0.08, 4 * DAY);
    this.setView(ext[0] - pad, ext[1] + pad * 2.5); // extra room on the right for card widths
  }

  focus(id) {
    const ev = this.events.find((e) => e.id === id);
    if (!ev) return;
    if (ev._e) this.centerOn((ev._s + ev._e) / 2); else this.centerOn(ev._s);
    this.offsetY = 0;
    this.select(id);
    const n = this.nodes.get(id);
    if (n) {
      n.el.classList.remove('flash');
      void n.el.offsetWidth;
      n.el.classList.add('flash');
    }
  }

  select(id) {
    this.selectedId = id;
    for (const [nid, n] of this.nodes) n.el.classList.toggle('selected', nid === id);
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  /* ---------------- data ---------------- */

  setEvents(list) {
    this.events = list
      .map((e) => ({ ...e, _s: parseDate(e.start), _e: isRange(e) ? parseDate(e.end) : null }))
      .filter((e) => !isNaN(e._s))
      .map((e) => (e._e !== null && (isNaN(e._e) || e._e < e._s) ? { ...e, _e: e._s } : e))
      .sort((a, b) => a._s - b._s);
    this.buildNodes();
    this.render();
  }

  buildNodes() {
    this.evLayer.textContent = '';
    this.nodes.clear();
    for (const ev of this.events) {
      const color = ev.color || '#37a70b';
      const up = ev.side !== 'below';
      const wrap = el('div', 'ev', this.evLayer);
      wrap.dataset.id = ev.id;
      wrap.title = ev.description ? ev.description : '';
      const n = { el: wrap, ev };

      if (isRange(ev)) {
        wrap.classList.add('range', ev.style);
        if (up) wrap.classList.add('up');
        n.fill = el('div', 'rg-fill', wrap);
        n.brace = el('div', 'rg-brace', wrap);
        const label = el('div', 'rg-label', wrap);
        label.textContent = ev.title;
        if (ev.style === 'span') {
          n.fill.style.background = color + '22';
          n.fill.style.boxShadow = `inset 0 0 0 1px ${color}33`;
        } else {
          n.fill.style.background = color;
          label.style.color = color;
        }
        n.brace.style.borderColor = color;
        n.labelEl = label;
      } else {
        const box = el('div', ev.style === 'pill' ? 'ev-pill' : 'ev-card', wrap);
        box.textContent = ev.title;
        box.style.background = color;
        n.stem = el('div', 'ev-stem', this.evLayer);
        n.stem.style.borderColor = color;
        n.dot = el('div', 'ev-dot', this.evLayer);
        n.dot.style.background = color;
      }
      if (ev.id === this.selectedId) wrap.classList.add('selected');
      this.nodes.set(ev.id, n);
    }
    this.measure();
  }

  // Measure once; sizes don't change with zoom (range widths are set per frame).
  measure() {
    this.needsMeasure = this.root.clientWidth === 0; // hidden: try again on the next visible render
    if (this.needsMeasure) return;
    for (const n of this.nodes.values()) {
      n.el.style.display = '';
      if (n.labelEl) {
        n.fill.style.width = '0px';
        n.brace.style.width = '0px';
        n.labelW = n.labelEl.offsetWidth;
        n.h = n.el.offsetHeight;
      } else {
        n.w = n.el.offsetWidth;
        n.h = n.el.offsetHeight;
      }
    }
  }

  /* ---------------- rendering ---------------- */

  render() {
    if (this.needsMeasure) this.measure();
    const W = this.width, H = this.height;
    const maxOff = H * 3;
    this.offsetY = Math.max(-maxOff, Math.min(maxOff, this.offsetY));
    const axisY = Math.round(H * 0.5) + this.offsetY;
    this.renderAxis(W, H, axisY);
    this.renderEvents(W, axisY);
    this.onView();
  }

  renderAxis(W, H, axisY) {
    const spanPx = (u, s) => APPROX[u] * s * this.pxPerMs;
    let level = TICK_LEVELS[TICK_LEVELS.length - 1];
    for (const lv of TICK_LEVELS) {
      const minPx = lv[0] === 'day' && lv[1] === 1 ? 26 : 44;
      if (spanPx(lv[0], lv[1]) >= minPx) { level = lv; break; }
    }
    const [unit, step] = level;
    const t0 = this.start, t1 = this.end;
    const ticks = [];
    const d = new Date(t0);

    if (unit === 'hour') {
      d.setMinutes(0, 0, 0);
      d.setHours(Math.floor(d.getHours() / step) * step);
      for (; d.getTime() <= t1; d.setHours(d.getHours() + step)) {
        const h = d.getHours();
        ticks.push([d.getTime(), h === 0 ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : `${String(h).padStart(2, '0')}:00`]);
      }
    } else if (unit === 'day') {
      d.setHours(0, 0, 0, 0);
      for (; d.getTime() <= t1; d.setDate(d.getDate() + 1)) {
        const day = d.getDate();
        const keep = step === 1 ? true : step === 2 ? day % 2 === 1 && day < 31 : day === 1 || (day % 5 === 0 && day < 30);
        if (keep) ticks.push([d.getTime(), String(day)]);
      }
    } else if (unit === 'month') {
      d.setHours(0, 0, 0, 0);
      d.setDate(1);
      for (; d.getTime() <= t1; d.setMonth(d.getMonth() + 1)) {
        if (d.getMonth() % step === 0) ticks.push([d.getTime(), MONTHS[d.getMonth()]]);
      }
    } else {
      d.setHours(0, 0, 0, 0);
      d.setMonth(0, 1);
      d.setFullYear(Math.floor(d.getFullYear() / step) * step);
      for (; d.getTime() <= t1; d.setFullYear(d.getFullYear() + step)) ticks.push([d.getTime(), String(d.getFullYear())]);
    }

    // Grid + ticks
    const grid = document.createDocumentFragment();
    const axis = document.createDocumentFragment();
    for (const [t, label] of ticks) {
      const x = Math.round(this.timeToX(t));
      if (x < -40 || x > W + 40) continue;
      const g = el('div', 'tl-grid-line', grid);
      g.style.left = x + 'px';
      const tk = el('div', 'tl-tick', axis);
      tk.style.left = x + 'px';
      tk.style.top = axisY + 3 + 'px';
      const lb = el('div', 'tl-tick-label', axis);
      lb.textContent = label;
      lb.style.left = x + 'px';
      lb.style.top = axisY + 10 + 'px';
    }

    // Bands: months when showing days/hours, years when showing months.
    const bands = [];
    if (unit === 'hour' || unit === 'day') {
      const b = new Date(t0); b.setHours(0, 0, 0, 0); b.setDate(1);
      while (b.getTime() <= t1) {
        const s = b.getTime(); const name = `${MONTHS[b.getMonth()].toLowerCase()}${b.getMonth() === 0 || bands.length === 0 ? ' ' + b.getFullYear() : ''}`;
        b.setMonth(b.getMonth() + 1);
        bands.push([s, b.getTime(), name]);
      }
    } else if (unit === 'month') {
      const b = new Date(t0); b.setHours(0, 0, 0, 0); b.setMonth(0, 1);
      while (b.getTime() <= t1) {
        const s = b.getTime(); const name = String(b.getFullYear());
        b.setFullYear(b.getFullYear() + 1);
        bands.push([s, b.getTime(), name]);
      }
    }
    for (const [s, e, name] of bands) {
      const x1 = this.timeToX(s) + 3, x2 = this.timeToX(e) - 3;
      if (x2 < 0 || x1 > W) continue;
      const band = el('div', 'tl-band', axis);
      band.style.left = x1 + 'px';
      band.style.width = Math.max(0, x2 - x1) + 'px';
      band.style.top = axisY - 16 + 'px';
      const vis1 = Math.max(x1, 0), vis2 = Math.min(x2, W);
      if (vis2 - vis1 > 40) {
        const lb = el('div', 'tl-band-label', axis);
        lb.textContent = name;
        lb.style.left = (vis1 + vis2) / 2 + 'px';
        lb.style.top = axisY - 9 + 'px';
      }
    }

    const line = el('div', 'tl-axis', axis);
    line.style.top = axisY + 'px';

    // Today marker
    const nowX = this.timeToX(Date.now());
    if (nowX >= 0 && nowX <= W) {
      const today = el('div', 'tl-today', grid);
      today.style.left = nowX + 'px';
      const tl = el('div', 'tl-today-label', grid);
      tl.textContent = 'today';
      tl.style.left = nowX + 'px';
    }

    this.gridLayer.replaceChildren(grid);
    this.axisLayer.replaceChildren(axis);
  }

  renderEvents(W, axisY) {
    const sides = { above: [], below: [] };
    for (const ev of this.events) {
      const n = this.nodes.get(ev.id);
      if (!n) continue;
      const x = this.timeToX(ev._s);
      let item;
      if (n.labelEl) {
        const x2 = this.timeToX(ev._e);
        const bw = Math.max(3, x2 - x);
        item = { n, ev, x, bw, l: x, w: Math.max(bw, n.labelW), h: n.h, range: true };
      } else {
        const l = ev.style === 'pill' ? x - n.w / 2 : x - 12;
        item = { n, ev, x, l, w: n.w, h: n.h, range: false };
      }
      sides[ev.side === 'below' ? 'below' : 'above'].push(item);
    }

    for (const side of ['above', 'below']) {
      const items = sides[side];
      items.sort((a, b) => (b.range - a.range) || (a.l - b.l));
      const placed = [];
      for (const it of items) {
        let d = it.range ? 8 : 26;
        for (let guard = 0; guard < 500; guard++) {
          let hit = null;
          for (const p of placed) {
            if (p.l < it.l + it.w + 8 && it.l < p.l + p.w + 8 && p.d < d + it.h + 6 && d < p.d + p.h + 6) {
              if (!hit || p.d + p.h > hit.d + hit.h) hit = p;
            }
          }
          if (!hit) break;
          d = hit.d + hit.h + 6;
        }
        it.d = d;
        placed.push(it);
        this.place(it, side === 'above', axisY, W);
      }
    }
  }

  place(it, up, axisY, W) {
    const { n } = it;
    const top = up ? axisY - it.d - it.h : axisY + it.d;
    const visible = it.l + it.w > -300 && it.l < W + 300;
    n.el.style.display = visible ? '' : 'none';
    if (n.stem) {
      n.stem.style.display = visible ? '' : 'none';
      n.dot.style.display = visible ? '' : 'none';
    }
    if (!visible) return;

    n.el.style.transform = `translate(${Math.round(it.l)}px, ${Math.round(top)}px)`;
    if (n.labelEl) {
      n.fill.style.width = it.bw + 'px';
      n.brace.style.width = it.bw + 'px';
    } else {
      const x = Math.round(it.x);
      const stemTop = up ? axisY - it.d : axisY;
      n.stem.style.transform = `translate(${x - 1}px, ${stemTop}px)`;
      n.stem.style.height = it.d + 'px';
      n.dot.style.transform = `translate(${x}px, ${axisY}px)`;
    }
  }

  /* ---------------- input ---------------- */

  bindInput() {
    const root = this.root;
    const pointers = new Map();
    let drag = null;
    let pinch = null;
    let lastTap = { t: 0, x: 0, y: 0 };

    root.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      root.focus({ preventScroll: true });
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      root.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
        drag = null;
        return;
      }
      const target = e.target.closest?.('.ev');
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, id: target?.dataset.id || null };
    });

    root.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const rect = root.getBoundingClientRect();
        this.zoomAt(dist / pinch.dist, (a.x + b.x) / 2 - rect.left);
        pinch.dist = dist;
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) {
        drag.moved = true;
        root.classList.add('dragging');
      }
      if (drag.moved) {
        this.panBy(dx, dy);
        drag.x = e.clientX;
        drag.y = e.clientY;
      }
    });

    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      root.classList.remove('dragging');
      if (!drag || e.type === 'pointercancel') { drag = null; return; }
      const d = drag;
      drag = null;
      if (d.moved) return;
      if (d.id) { this.onSelect(d.id); return; }
      const rect = root.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const now = performance.now();
      if (now - lastTap.t < 400 && Math.hypot(x - lastTap.x, y - lastTap.y) < 12) {
        lastTap.t = 0;
        const axisY = Math.round(this.height * 0.5) + this.offsetY;
        this.onCreate(this.xToTime(x), y > axisY ? 'below' : 'above');
      } else {
        lastTap = { t: now, x, y };
        this.onSelect(null);
      }
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);

    root.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      const scale = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        if (e.shiftKey) { this.panBy(-e.deltaY * scale, 0); return; }
        this.zoomAt(Math.exp(-e.deltaY * scale * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - rect.left);
      } else {
        this.panBy(-e.deltaX * scale, 0);
      }
    }, { passive: false });

    root.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const W = this.width;
      const k = e.key;
      if (k === 'ArrowLeft') this.panBy(W / 6);
      else if (k === 'ArrowRight') this.panBy(-W / 6);
      else if (k === 'ArrowUp') this.panBy(0, 80);
      else if (k === 'ArrowDown') this.panBy(0, -80);
      else if (k === '+' || k === '=') this.zoomAt(1.4);
      else if (k === '-' || k === '_') this.zoomAt(1 / 1.4);
      else return;
      e.preventDefault();
    });
  }
}

/* ---------------- overview strip ---------------- */

export class Overview {
  constructor(root, timeline) {
    this.root = root;
    this.tl = timeline;
    this.range = [Date.now() - 365 * DAY, Date.now()];
    let dragging = false;
    const go = (e) => {
      const r = root.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      timeline.centerOn(this.range[0] + f * (this.range[1] - this.range[0]));
    };
    root.addEventListener('pointerdown', (e) => { dragging = true; root.setPointerCapture(e.pointerId); go(e); });
    root.addEventListener('pointermove', (e) => { if (dragging) go(e); });
    root.addEventListener('pointerup', () => { dragging = false; });
    root.addEventListener('pointercancel', () => { dragging = false; });
    new ResizeObserver(() => this.render()).observe(root);
  }

  render() {
    const tl = this.tl;
    const ext = tl.extent() || [Date.now() - 90 * DAY, Date.now()];
    let lo = Math.min(ext[0], Date.now()), hi = Math.max(ext[1], Date.now());
    const pad = Math.max((hi - lo) * 0.06, 7 * DAY);
    lo -= pad; hi += pad;
    this.range = [lo, hi];
    const W = this.root.clientWidth || 1;
    const X = (t) => ((t - lo) / (hi - lo)) * W;
    const frag = document.createDocumentFragment();

    // Year ticks if the range spans more than one year boundary.
    const y0 = new Date(lo).getFullYear() + 1, y1 = new Date(hi).getFullYear();
    const every = Math.max(1, Math.ceil((y1 - y0 + 1) / 12));
    for (let y = y0; y <= y1; y += every) {
      const d = new Date(2000, 0, 1); d.setFullYear(y);
      const lb = el('div', 'ov-year', frag);
      lb.textContent = y;
      lb.style.left = X(d.getTime()) + 'px';
    }
    for (const ev of tl.events) {
      if (ev._e) {
        const r = el('div', 'ov-range', frag);
        r.style.left = X(ev._s) + 'px';
        r.style.width = Math.max(3, X(ev._e) - X(ev._s)) + 'px';
        r.style.background = ev.color || '#37a70b';
      } else {
        const dot = el('div', 'ov-dot', frag);
        dot.style.left = X(ev._s) + 'px';
        dot.style.background = ev.color || '#37a70b';
      }
    }
    const today = el('div', 'ov-today', frag);
    today.style.left = X(Date.now()) + 'px';
    const win = el('div', 'ov-window', frag);
    const a = Math.max(-4, X(tl.start)), b = Math.min(W + 4, X(tl.end));
    win.style.left = a + 'px';
    win.style.width = Math.max(6, b - a) + 'px';
    this.root.replaceChildren(frag);
  }
}
