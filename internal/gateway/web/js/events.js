// Live event feed: newest first, colored by level, filterable by kind, with
// relative times that keep ticking. Config, health and fault events also become
// vertical markers on the throughput and latency charts (last two minutes).

import { el } from './ui.js';
import { fmtAgo, fmtClock } from './format.js';

const MAX_RENDER = 200;
const MARK_WINDOW_S = 120;
const MARK_KINDS = new Set(['config', 'health', 'fault']);
const MARK_LABEL_MAX = 30;
const COALESCE_MS = 5000; // consecutive load events within this gap fold into one row
const AGO_TICK_MS = 1000;

const KIND_LABEL = { config: 'Config', health: 'Health', fault: 'Fault', load: 'Traffic', weights: 'Weights', secrets: 'Secrets' };
const LEVEL_GLYPH = { info: 'i', success: '✓', warn: '!', error: '✕' };
const LEVEL_COLOR = { info: 'var(--accent)', success: 'var(--ok)', warn: 'var(--warn)', error: 'var(--err)' };
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'config', label: 'Config' },
  { id: 'health', label: 'Health' },
  { id: 'fault', label: 'Faults' },
  { id: 'load', label: 'Traffic' },
  { id: 'weights', label: 'Weights' },
];

const lvl = (e) => (LEVEL_GLYPH[e.level] ? e.level : 'info');

function shorten(text, max) {
  const t = String(text || '');
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

export function initEvents(panel, store, charts) {
  return new EventFeed(panel, store, charts);
}

class EventFeed {
  constructor(panel, store, charts) {
    this.panel = panel;
    this.store = store;
    this.charts = charts;
    this.filter = 'all';
    this.lastSeq = 0;
    this.markKey = '';
    this.chips = new Map();
    this.build();
    this.reset(store.getState());
    store.subscribe(({ type, state }) => {
      if (type === 'events' || type === 'conn') this.onEvents(state);
    });
    setInterval(() => this.tick(), AGO_TICK_MS);
  }

  build() {
    const body = this.panel.querySelector('.panel-body');
    body.textContent = '';
    body.classList.add('ev-body');
    const bar = el('div', { class: 'ev-filters', role: 'group', 'aria-label': 'Filter events' });
    for (const f of FILTERS) {
      const b = el('button', { type: 'button', class: 'ev-chip', 'aria-pressed': String(f.id === this.filter), text: f.label });
      b.addEventListener('click', () => this.setFilter(f.id));
      this.chips.set(f.id, b);
      bar.append(b);
    }
    this.list = el('ol', { class: 'ev-list', 'aria-label': 'Events, newest first' });
    this.empty = el('p', { class: 'ev-empty', text: 'No events yet. Changes, health flips and faults show up here.' });
    body.append(el('div', { class: 'ev' }, bar, this.list, this.empty));
    this.countSub = this.panel.querySelector('.panel-sub');
  }

  setFilter(id) {
    this.filter = id;
    for (const [k, b] of this.chips) b.setAttribute('aria-pressed', String(k === id));
    for (const li of this.list.children) li.hidden = !this.matches(li._kind);
    this.paintEmpty();
  }

  matches(kind) {
    return this.filter === 'all' || this.filter === kind;
  }

  paintEmpty() {
    const any = !!this.list.querySelector('.ev-item:not([hidden])');
    this.empty.hidden = any;
    if (!any) {
      this.empty.textContent = this.list.children.length ? `No ${FILTERS.find((f) => f.id === this.filter).label.toLowerCase()} events yet.` : 'No events yet. Changes, health flips and faults show up here.';
    }
  }

  reset(state) {
    this.list.replaceChildren();
    this.lastSeq = 0;
    const evs = state.events.slice(-MAX_RENDER);
    for (const ev of evs) this.add(ev, false);
    this.lastSeq = state.events.length ? state.events[state.events.length - 1].seq : 0;
    this.paintEmpty();
    this.updateMarkers(state);
  }

  onEvents(state) {
    const evs = state.events;
    const newest = evs.length ? evs[evs.length - 1].seq : 0;
    if (newest < this.lastSeq || (evs.length && this.lastSeq === 0 && this.list.children.length === 0)) {
      this.reset(state);
      return;
    }
    const fresh = [];
    for (let i = evs.length - 1; i >= 0 && evs[i].seq > this.lastSeq; i--) fresh.push(evs[i]);
    fresh.reverse();
    for (const ev of fresh) this.add(ev, true);
    if (fresh.length) this.lastSeq = fresh[fresh.length - 1].seq;
    while (this.list.children.length > MAX_RENDER) this.list.lastElementChild.remove();
    this.paintEmpty();
    this.updateMarkers(state);
  }

  // add prepends one event. A burst of load events (a ramp writes one per
  // second) folds into the newest row so the feed stays readable.
  add(ev, animate) {
    const t = Date.parse(ev.time);
    const top = this.list.firstElementChild;
    if (ev.kind === 'load' && top && top._kind === 'load' && Math.abs(t - top._t) < COALESCE_MS) {
      top._t = t;
      top._time.title = fmtClock(t / 1000);
      top._n++;
      top._msg.textContent = ev.message;
      top._count.textContent = `x${top._n}`;
      top._count.hidden = false;
      this.paintTime(top);
      if (animate) {
        top.classList.remove('ev-bump');
        void top.offsetWidth;
        top.classList.add('ev-bump');
      }
      return;
    }
    const level = lvl(ev);
    const glyph = el('span', { class: 'ev-icon', 'aria-hidden': 'true', text: LEVEL_GLYPH[level] });
    const kind = el('span', { class: 'ev-kind', text: KIND_LABEL[ev.kind] || ev.kind });
    const msg = el('span', { class: 'ev-msg', text: ev.message });
    const count = el('span', { class: 'ev-count num', hidden: true, text: 'x1' });
    const time = el('time', { class: 'ev-time num' });
    const meta = el('span', { class: 'ev-meta' }, kind, count, time);
    const li = el('li', { class: `ev-item ev-${level}${animate ? ' ev-new' : ''}`, 'data-kind': ev.kind, 'data-level': level }, glyph, el('div', { class: 'ev-main' }, msg, meta));
    li._kind = ev.kind;
    li._t = t;
    li._n = 1;
    li._msg = msg;
    li._count = count;
    li._time = time;
    li.hidden = !this.matches(ev.kind);
    this.paintTime(li);
    this.list.prepend(li);
  }

  paintTime(li) {
    const text = fmtAgo(li._t);
    if (li._time.textContent !== text) li._time.textContent = text;
    if (!li._time.title && Number.isFinite(li._t)) li._time.title = fmtClock(li._t / 1000);
  }

  tick() {
    if (!document.hidden) for (const li of this.list.children) this.paintTime(li);
    this.updateMarkers(this.store.getState());
  }

  updateMarkers(state) {
    if (!this.charts) return;
    const cut = Date.now() / 1000 - MARK_WINDOW_S;
    const marks = [];
    for (const ev of state.events) {
      if (!MARK_KINDS.has(ev.kind)) continue;
      const ts = Date.parse(ev.time) / 1000;
      if (!Number.isFinite(ts) || ts < cut) continue;
      marks.push({ ts, color: LEVEL_COLOR[lvl(ev)], label: shorten(ev.message, MARK_LABEL_MAX), seq: ev.seq });
    }
    const key = marks.map((m) => m.seq).join(',');
    if (key === this.markKey) return;
    this.markKey = key;
    for (const name of ['throughput', 'latency']) {
      if (this.charts[name]) this.charts[name].setMarkers(marks);
    }
  }
}
