// Live topology: Clients -> Gateway -> routes -> upstreams.
//
// Nodes are HTML cards positioned in four columns from the measured container
// size and tweened to new positions on resize or config change. Edges are SVG
// cubic curves under the cards. Requests are drawn as particles on a canvas
// overlay: each edge spawns particles at a sqrt-scaled share of its live rate,
// colored by its status mix, and moving at a speed set by that hop's latency.
// JWT rejections travel to the route node and burst there.
//
// initTopology(panel, store) takes the #topology panel and the live store.

import { getUpstreams, injectFault, resetFault } from './api.js';
import { colorFor, colorSlot, cssVar, fmtAgo, fmtDuration, fmtMs, fmtMsParts, fmtNum, fmtPct, fmtRate, fmtRateParts } from './format.js';
import { el, openPopover, toast } from './ui.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// "Breaking" thresholds. Error % counts 5xx only: 4xx are client errors (such
// as rejected JWTs) and would otherwise keep every JWT route amber.
const WARN_ERR_PCT = 2;
const ERR_ERR_PCT = 10;
const WARN_P99 = 250;
const ERR_P99 = 1000;

// Particles.
const SPAWN_K = 2.2; // particles/s = SPAWN_K * sqrt(rps)
const MAX_PER_EDGE = 40;
const MAX_ALIVE = 600;
const MAX_BURSTS = 80;
const TRAVEL_BASE = 0.8; // seconds; plus latency_ms / TRAVEL_MS_PER_S
const TRAVEL_MS_PER_S = 320;
const MIN_TRAVEL = 0.4;
const MAX_TRAVEL = 4;
const RATE_TAU = 0.6; // seconds of smoothing on particle rates

const INFLIGHT_CAP = 64;
const POLL_MS = 3000;
const HOVER_DELAY = 260;
const MIN_HEIGHT = 440;
const COL_TOP = 34;
const COL_BOTTOM = 14;
const V_GAP = 12;
// Column width shares and caps: clients, gateway, routes, upstreams.
const COL_RATIO = [0.17, 0.25, 0.29, 0.29];
const COL_MAX = [190, 240, 260, 260];
const GAP_WEIGHT = [0.75, 1, 1.25];
// Candidate positions (curve parameter) for weight labels, best first.
const LABEL_TS = [0.5, 0.36, 0.64, 0.26, 0.74, 0.18, 0.82];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

function setText(n, s) {
  if (n.textContent !== s) n.textContent = s;
}

function setData(n, k, v) {
  if (v == null) {
    if (k in n.dataset) delete n.dataset[k];
  } else if (n.dataset[k] !== v) n.dataset[k] = v;
}

function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url || '-';
  }
}

function faultActive(f) {
  return !!f && (f.delay_ms > 0 || f.status > 0 || f.unhealthy || f.error_rate_percent > 0);
}

function faultSummary(f) {
  if (!faultActive(f)) return 'none';
  const parts = [];
  if (f.delay_ms > 0) parts.push(`+${fmtMs(f.delay_ms)}`);
  if (f.error_rate_percent > 0) parts.push(`${f.error_rate_percent}% errors`);
  if (f.status > 0) parts.push(`returns ${f.status}`);
  if (f.unhealthy) parts.push('fails health');
  return parts.join(', ');
}

function errPct(s) {
  return s && s.rps > 0 ? (num(s.error_rps) / s.rps) * 100 : 0;
}

// level maps stats to idle|ok|warn|err using the breaking thresholds.
function level(s, down = false) {
  if (down) return 'err';
  if (!s || !(s.rps > 0)) return 'idle';
  const e = errPct(s);
  const p99 = num(s.p99_ms);
  if (e > ERR_ERR_PCT || p99 > ERR_P99) return 'err';
  if (e > WARN_ERR_PCT || p99 > WARN_P99) return 'warn';
  return 'ok';
}

function lockIcon() {
  const s = svg('svg', { class: 'tn-lock', viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  s.append(
    svg('rect', { x: 3, y: 7, width: 10, height: 7.5, rx: 1.6 }),
    svg('path', { d: 'M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7', fill: 'none' }),
  );
  return s;
}

function stat(label) {
  const v = el('b', { class: 'tn-v' });
  const u = el('small', { class: 'tn-u' });
  const root = el('div', { class: 'tn-stat' }, el('span', { class: 'tn-val num' }, v, u), el('span', { class: 'tn-k', text: label }));
  return {
    root,
    set(p) {
      setText(v, p.value);
      setText(u, p.unit || '');
    },
  };
}

// The stat label already says rps, so rates carry no unit of their own.
const rateP = (v) => ({ value: fmtRateParts(v, '').value, unit: '' });
const msP = (s) => (s && s.rps > 0 ? fmtMsParts(s.p95_ms) : { value: '-', unit: '' });
const pctP = (s) => (s && s.rps > 0 ? { value: fmtPct(errPct(s)).replace('%', ''), unit: '%' } : { value: '-', unit: '' });

// Cubic bezier point for g = [x0,y0,x1,y1,x2,y2,x3,y3].
function bez(g, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * g[0] + b * g[2] + c * g[4] + d * g[6], a * g[1] + b * g[3] + c * g[5] + d * g[7]];
}

function sprite(color) {
  const s = 32;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.16, color);
  g.addColorStop(0.42, withAlpha(color, 0.38));
  g.addColorStop(1, withAlpha(color, 0));
  x.fillStyle = g;
  x.fillRect(0, 0, s, s);
  return c;
}

function withAlpha(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

class Topology {
  constructor(panel, store) {
    this.store = store;
    this.nodes = new Map();
    this.edges = new Map();
    this.particles = [];
    this.bursts = [];
    this.upInfo = new Map(); // id -> {fault, health, url} from the 3s poll
    this.routeOrder = [];
    this.upOrder = [];
    this.configKey = '';
    this.W = 0;
    this.H = 0;
    this.dpr = 1;
    this.raf = 0;
    this.last = 0;
    this.visible = true;
    this.moving = false;
    this.staticDirty = true;
    this.hover = null;
    this.hoverTimer = 0;
    this.pinned = null;
    this.lastPinnedClose = null;

    this.buildDom(panel);
    this.colors = {
      ok: cssVar('--ok'),
      c4: cssVar('--warn'),
      c5: cssVar('--err'),
      rej: cssVar('--warn'),
    };
    this.sprites = {};
    for (const [k, c] of Object.entries(this.colors)) this.sprites[k] = sprite(c);

    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.root);
    this.io = new IntersectionObserver((entries) => {
      this.visible = entries.some((e) => e.isIntersecting);
      this.kick();
    });
    this.io.observe(this.root);
    document.addEventListener('visibilitychange', () => {
      this.last = 0;
      if (!document.hidden) {
        this.pollUpstreams();
        this.kick();
      }
    });
    reducedMotion.addEventListener('change', () => {
      this.particles.length = 0;
      this.bursts.length = 0;
      this.staticDirty = true;
      this.kick();
    });

    store.subscribe(({ type, state }) => {
      if (type === 'config' || (type === 'conn' && state.config)) this.sync(state);
      if (type === 'frame' || type === 'conn') this.update(state);
    });
    const st = store.getState();
    if (st.config) this.sync(st);
    this.update(st);

    this.pollUpstreams();
    setInterval(() => {
      if (!document.hidden) this.pollUpstreams();
    }, POLL_MS);
  }

  buildDom(panel) {
    const body = panel.querySelector('.panel-body');
    body.classList.add('topo-body');
    this.root = el('div', { class: 'topo', 'data-conn': 'live' });
    this.svg = svg('svg', { class: 'topo-edges', 'aria-hidden': 'true' });
    this.trackLayer = svg('g');
    this.edgeLayer = svg('g');
    this.labelLayer = svg('g');
    this.svg.append(this.trackLayer, this.edgeLayer, this.labelLayer);
    const labels = ['Clients', 'Gateway', 'Routes by priority', 'Upstreams'];
    this.colLabels = labels.map((t) => el('span', { class: 'topo-col', text: t }));
    this.cols = el('div', { class: 'topo-cols', 'aria-hidden': 'true' }, this.colLabels);
    this.nodeLayer = el('div', { class: 'topo-nodes' });
    this.canvas = el('canvas', { class: 'topo-particles', 'aria-hidden': 'true' });
    this.ctx = this.canvas.getContext('2d');
    this.hint = el('div', { class: 'topo-hint', hidden: true }, el('span', { class: 'topo-hint-dot', 'aria-hidden': 'true' }), 'No traffic. Start the load generator to watch requests flow.');
    this.empty = el('p', { class: 'topo-empty', text: 'Waiting for the active configuration...' });
    this.root.append(this.svg, this.cols, this.nodeLayer, this.canvas, this.hint, this.empty);
    body.replaceChildren(this.root);

    const head = panel.querySelector('.panel-head');
    if (head) {
      const item = (cls, text) => el('li', {}, el('span', { class: `tl-key ${cls}`, 'aria-hidden': 'true' }), text);
      head.append(
        el(
          'ul',
          { class: 'topo-legend', 'aria-label': 'Legend' },
          item('tl-ok', '2xx-3xx'),
          item('tl-c4', '4xx'),
          item('tl-c5', '5xx'),
          item('tl-rej', '401 rejected'),
          item('tl-dash', 'weight 0 / ejected'),
        ),
      );
    }
  }

  // ---- Config -> nodes and edges -------------------------------------------

  sync(state) {
    const cfg = state.config;
    if (!cfg) return;
    this.empty.hidden = true;
    const routes = [...(cfg.routes || [])].sort((a, b) => num(b.priority) - num(a.priority));
    const upOrder = [];
    const upUrl = new Map();
    for (const r of routes) {
      for (const u of r.upstreams || []) {
        if (!upUrl.has(u.id)) {
          upUrl.set(u.id, u.url);
          upOrder.push(u.id);
        }
      }
    }
    // Keep upstream colors in the same first-seen order as the charts.
    upOrder.forEach(colorSlot);
    this.routes = new Map(routes.map((r) => [r.id, r]));
    this.routeOrder = routes.map((r) => r.id);
    this.upOrder = upOrder;
    this.upUrl = upUrl;

    const want = new Set(['clients', 'gateway', ...this.routeOrder.map((id) => `r:${id}`), ...upOrder.map((id) => `u:${id}`)]);
    for (const [id, n] of this.nodes) {
      if (!want.has(id)) this.removeNode(id, n);
    }
    if (!this.nodes.has('clients')) this.addNode(this.makeClients());
    if (!this.nodes.has('gateway')) this.addNode(this.makeGateway());
    for (const r of routes) {
      const id = `r:${r.id}`;
      if (!this.nodes.has(id)) this.addNode(this.makeRoute(r.id));
      this.nodes.get(id).configure(r);
    }
    for (const uid of upOrder) {
      const id = `u:${uid}`;
      if (!this.nodes.has(id)) this.addNode(this.makeUpstream(uid));
      this.nodes.get(id).configure(upUrl.get(uid));
    }

    // Edges.
    const wantEdges = new Map();
    wantEdges.set('clients>gateway', { kind: 'cg', from: 'clients', to: 'gateway' });
    for (const r of routes) {
      wantEdges.set(`gateway>r:${r.id}`, { kind: 'gr', from: 'gateway', to: `r:${r.id}`, route: r.id });
      for (const u of r.upstreams || []) {
        wantEdges.set(`r:${r.id}>u:${u.id}`, { kind: 'ru', from: `r:${r.id}`, to: `u:${u.id}`, route: r.id, up: u.id });
      }
    }
    for (const [id, e] of this.edges) {
      if (!wantEdges.has(id)) {
        e.track.remove();
        e.path.remove();
        if (e.label) e.label.remove();
        this.edges.delete(id);
      }
    }
    for (const [id, spec] of wantEdges) {
      if (!this.edges.has(id)) this.edges.set(id, this.makeEdge(id, spec));
    }
    this.particles = this.particles.filter((p) => this.edges.get(p.e.id) === p.e);
    this.assignPorts();
    this.layout();
    this.update(state);
  }

  addNode(n) {
    n.el.classList.add('is-entering');
    this.nodeLayer.append(n.el);
    this.nodes.set(n.id, n);
    this.ro.observe(n.el);
    n.el.addEventListener('pointerenter', () => this.hoverStart(n));
    n.el.addEventListener('pointerleave', () => this.hoverEnd(n));
    n.el.addEventListener('click', () => this.activate(n));
    n.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.activate(n);
      }
    });
  }

  removeNode(id, n) {
    this.ro.unobserve(n.el);
    this.nodes.delete(id);
    if (this.hover && this.hover.id === id) this.hover.close();
    if (this.pinned && this.pinned.id === id) this.pinned.close();
    n.el.classList.add('is-leaving');
    setTimeout(() => n.el.remove(), reducedMotion.matches ? 0 : 350);
  }

  makeEdge(id, spec) {
    const track = svg('path', { class: 'topo-track' });
    const path = svg('path', { class: 'topo-edge', 'data-kind': spec.kind });
    this.trackLayer.append(track);
    this.edgeLayer.append(path);
    const e = { id, ...spec, track, path, g: null, outOff: 0, inOff: 0, rate: 0, target: 0, acc: Math.random(), mix: [1, 1, 1, 1], lat: [1, 1] };
    if (spec.kind === 'ru') {
      e.label = svg('g', { class: 'topo-wlabel' });
      e.labelRect = svg('rect', { rx: 9, ry: 9, height: 22 });
      e.labelText = svg('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' });
      e.label.append(e.labelRect, e.labelText);
      this.labelLayer.append(e.label);
      e.path.style.setProperty('--edge-tint', colorFor(spec.up));
    }
    return e;
  }

  // assignPorts spreads multiple edges along a node side in the order of their
  // far ends, so curves fan out instead of crossing.
  assignPorts() {
    const rIdx = new Map(this.routeOrder.map((id, i) => [`r:${id}`, i]));
    const uIdx = new Map(this.upOrder.map((id, i) => [`u:${id}`, i]));
    const pos = (id) => (rIdx.has(id) ? rIdx.get(id) : uIdx.has(id) ? uIdx.get(id) : 0);
    const out = new Map();
    const inn = new Map();
    for (const e of this.edges.values()) {
      if (!out.has(e.from)) out.set(e.from, []);
      if (!inn.has(e.to)) inn.set(e.to, []);
      out.get(e.from).push(e);
      inn.get(e.to).push(e);
    }
    for (const list of out.values()) {
      list.sort((a, b) => pos(a.to) - pos(b.to));
      list.forEach((e, i) => {
        e.outIdx = i;
        e.outN = list.length;
      });
    }
    for (const list of inn.values()) {
      list.sort((a, b) => pos(a.from) - pos(b.from));
      list.forEach((e, i) => {
        e.inIdx = i;
        e.inN = list.length;
      });
    }
  }

  // ---- Node builders --------------------------------------------------------

  card(id, kind, label, interactive) {
    const n = el('div', { class: `tn tn-${kind}`, 'data-state': 'idle' });
    if (interactive) {
      n.tabIndex = 0;
      n.setAttribute('role', 'button');
      n.setAttribute('aria-label', label);
    }
    return { id, kind, el: n, x: null, y: null, tx: 0, ty: 0, w: 0, h: 0, configure() {}, update() {} };
  }

  makeClients() {
    const n = this.card('clients', 'clients', 'Clients', false);
    const sent = stat('sent');
    const shed = stat('shed');
    const note = el('div', { class: 'tn-note num' });
    n.el.append(
      el('div', { class: 'tn-head' }, el('span', { class: 'tn-title', text: 'Clients' })),
      el('div', { class: 'tn-sub', text: 'Traffic generator + external' }),
      el('div', { class: 'tn-stats tn-stats-2' }, sent.root, shed.root),
      note,
    );
    n.update = (f) => {
      const load = f && f.load;
      if (!load) {
        sent.set({ value: '-' });
        shed.set({ value: '-' });
        setText(note, 'generator unavailable');
        setData(n.el, 'state', 'idle');
        return;
      }
      sent.set(rateP(load.sent_per_sec));
      shed.set(fmtRateParts(load.shed_per_sec, '/s'));
      const target = load.settings ? load.settings.rps : 0;
      setText(note, target > 0 ? `target ${fmtNum(target)} rps` : 'generator stopped');
      const attempted = num(load.sent_per_sec) + num(load.shed_per_sec);
      const shedPct = attempted > 0 ? (num(load.shed_per_sec) / attempted) * 100 : 0;
      setData(n.el, 'state', load.shed_per_sec > 0 ? (shedPct > ERR_ERR_PCT ? 'err' : 'warn') : load.sent_per_sec > 0 ? 'ok' : 'idle');
    };
    return n;
  }

  makeGateway() {
    const n = this.card('gateway', 'gateway', 'Gateway', false);
    const rev = el('span', { class: 'tn-chip num' });
    const C = 2 * Math.PI * 25;
    const arc = svg('circle', { class: 'tn-gauge-arc', cx: 32, cy: 32, r: 25, 'stroke-dasharray': C.toFixed(2), 'stroke-dashoffset': C.toFixed(2), transform: 'rotate(-90 32 32)' });
    const gsvg = svg('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true' });
    gsvg.append(svg('circle', { class: 'tn-gauge-track', cx: 32, cy: 32, r: 25 }), arc);
    const gv = el('span', { class: 'tn-gauge-v num' });
    const gauge = el('div', { class: 'tn-gauge' }, gsvg, el('div', { class: 'tn-gauge-txt' }, gv, el('span', { class: 'tn-gauge-k', text: 'success' })));
    const row = (k) => {
      const v = el('b', { class: 'num' });
      return { root: el('div', { class: 'tn-row' }, el('span', { text: k }), v), v };
    };
    const rps = row('rps');
    const p99 = row('p99');
    const inf = row('in flight');
    n.el.append(
      el('div', { class: 'tn-head' }, el('span', { class: 'tn-title', text: 'Gateway' }), rev),
      el('div', { class: 'tn-gw' }, gauge, el('div', { class: 'tn-rows' }, rps.root, p99.root, inf.root)),
    );
    n.update = (f, st) => {
      setText(rev, st.revision != null ? `rev ${st.revision}` : 'rev -');
      const t = f && f.window ? f.window.total : null;
      const has = t && t.rps > 0;
      setText(rps.v, fmtRate(t ? t.rps : 0, ''));
      setText(p99.v, has ? fmtMs(t.p99_ms) : '-');
      setText(inf.v, fmtNum(f && f.inflight ? num(f.inflight.total) : 0));
      const succ = has ? 100 - errPct(t) : null;
      setText(gv, succ == null ? '-' : fmtPct(succ, succ >= 99.95 || succ < 10 ? 0 : 1));
      arc.setAttribute('stroke-dashoffset', (C * (1 - (succ == null ? 0 : succ / 100))).toFixed(2));
      const lv = level(t);
      setData(n.el, 'state', lv);
      setData(gauge, 'state', has ? (errPct(t) > ERR_ERR_PCT ? 'err' : errPct(t) > WARN_ERR_PCT ? 'warn' : 'ok') : 'idle');
    };
    return n;
  }

  makeRoute(rid) {
    const n = this.card(`r:${rid}`, 'route', `Route ${rid}, edit`, true);
    n.route = rid;
    const title = el('span', { class: 'tn-title', text: rid });
    const lock = lockIcon();
    const auto = el('span', { class: 'tn-badge tn-badge-auto', text: 'AUTO' });
    const match = el('div', { class: 'tn-sub tn-mono' });
    const rps = stat('rps');
    const err = stat('5xx');
    const p95 = stat('p95');
    n.el.append(el('div', { class: 'tn-head' }, title, lock, el('span', { class: 'tn-spacer' }), auto), match, el('div', { class: 'tn-stats' }, rps.root, err.root, p95.root));
    n.configure = (r) => {
      const jwt = !!(r.jwt && r.jwt.required);
      lock.style.display = jwt ? '' : 'none';
      auto.hidden = !r.auto_weight;
      const m = r.match || {};
      const methods = m.methods && m.methods.length ? m.methods.join(',') : 'ANY';
      const text = `${methods} ${m.path_prefix || '/'}`;
      setText(match, text);
      match.title = text;
      n.el.setAttribute('aria-label', `Route ${rid}${jwt ? ', JWT required' : ''}. Activate to edit.`);
    };
    n.update = (f) => {
      const s = f && f.window && f.window.routes ? f.window.routes[rid] : null;
      rps.set(rateP(s ? s.rps : 0));
      err.set(pctP(s));
      p95.set(msP(s));
      setData(n.el, 'state', level(s));
    };
    return n;
  }

  makeUpstream(uid) {
    const n = this.card(`u:${uid}`, 'upstream', `Upstream ${uid}, inject fault`, true);
    n.up = uid;
    n.el.style.setProperty('--node-accent', colorFor(uid));
    const badge = el('span', { class: 'tn-badge tn-badge-health' });
    const host = el('div', { class: 'tn-sub tn-mono' });
    const fault = el('div', { class: 'tn-fault', hidden: true });
    const rps = stat('rps');
    const p95 = stat('p95');
    const inf = stat('in flight');
    const fill = el('span', { class: 'tn-bar-fill' });
    const bar = el('div', { class: 'tn-bar', title: `in flight vs ${INFLIGHT_CAP}` }, fill);
    n.el.append(
      el('div', { class: 'tn-head' }, el('span', { class: 'tn-dot', 'aria-hidden': 'true' }), el('span', { class: 'tn-title', text: uid }), el('span', { class: 'tn-spacer' }), badge),
      el('div', { class: 'tn-body' }, host, fault, el('div', { class: 'tn-stats' }, rps.root, p95.root, inf.root), bar),
    );
    n.configure = (url) => {
      const h = hostOf(url);
      setText(host, h);
      host.title = url || '';
    };
    n.update = (f) => {
      const s = f && f.window && f.window.upstreams ? f.window.upstreams[uid] : null;
      const health = (f && f.health && f.health[uid]) || (this.upInfo.get(uid) || {}).health || null;
      const ejected = !!health && health.healthy === false;
      const fl = (this.upInfo.get(uid) || {}).fault;
      const faulted = faultActive(fl);
      const inflight = f && f.inflight && f.inflight.upstreams ? num(f.inflight.upstreams[uid]) : 0;
      rps.set(rateP(s ? s.rps : 0));
      p95.set(msP(s));
      inf.set({ value: fmtNum(inflight) });
      const pct = clamp(inflight / INFLIGHT_CAP, 0, 1);
      fill.style.width = `${(pct * 100).toFixed(1)}%`;
      setData(fill, 'level', pct >= 0.9 ? 'err' : pct >= 0.5 ? 'warn' : 'ok');
      const hs = ejected ? 'ejected' : faulted ? 'fault' : health ? 'healthy' : 'unknown';
      setData(n.el, 'health', hs);
      setText(badge, hs.toUpperCase());
      fault.hidden = !faulted;
      if (faulted) setText(fault, `Fault: ${faultSummary(fl)}`);
      setData(n.el, 'state', level(s, ejected));
      n.ejected = ejected;
    };
    return n;
  }

  // ---- Layout ---------------------------------------------------------------

  layout() {
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    if (!W || !H) return;
    if (W !== this.W || H !== this.H) {
      this.W = W;
      this.H = H;
      this.dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.round(W * this.dpr);
      this.canvas.height = Math.round(H * this.dpr);
      this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      this.staticDirty = true;
    }
    if (!this.nodes.size) return;

    const avail = W - 4;
    // Gaps grow with width: about 52px on a 1366 laptop, 100px on 1920.
    const gap = clamp(52 + (avail - 866) * 0.135, 46, 150);
    const widths = COL_RATIO.map((r, i) => Math.min(COL_MAX[i], Math.floor((avail - 3 * gap) * r)));
    // Leftover width goes to the gaps, weighted toward the route->upstream span
    // where most edges and the weight labels live.
    const spare = avail - widths.reduce((a, b) => a + b, 0);
    const gaps = GAP_WEIGHT.map((g) => (spare * g) / GAP_WEIGHT.reduce((a, b) => a + b, 0));
    const xs = [2];
    for (let i = 1; i < 4; i++) xs.push(xs[i - 1] + widths[i - 1] + gaps[i - 1]);

    const columns = [['clients'], ['gateway'], this.routeOrder.map((id) => `r:${id}`), this.upOrder.map((id) => `u:${id}`)];
    for (let c = 0; c < 4; c++) {
      for (const id of columns[c]) {
        const n = this.nodes.get(id);
        if (!n) continue;
        const w = `${widths[c]}px`;
        if (n.el.style.width !== w) n.el.style.width = w;
      }
    }
    let need = 0;
    const heights = columns.map((ids) => {
      let total = 0;
      for (const id of ids) {
        const n = this.nodes.get(id);
        if (!n) continue;
        n.w = n.el.offsetWidth;
        n.h = n.el.offsetHeight;
        total += n.h;
      }
      total += V_GAP * Math.max(0, ids.length - 1);
      need = Math.max(need, total);
      return total;
    });
    const minH = Math.ceil(Math.max(MIN_HEIGHT, need + COL_TOP + COL_BOTTOM));
    if (this.root.style.minHeight !== `${minH}px`) this.root.style.minHeight = `${minH}px`;

    const area = H - COL_TOP - COL_BOTTOM;
    for (let c = 0; c < 4; c++) {
      let y = COL_TOP + Math.max(0, (area - heights[c]) / 2);
      for (const id of columns[c]) {
        const n = this.nodes.get(id);
        if (!n) continue;
        n.tx = xs[c];
        n.ty = Math.round(y);
        y += n.h + V_GAP;
        if (n.x == null || reducedMotion.matches) {
          n.x = n.tx;
          n.y = n.ty;
          this.place(n);
        }
      }
      const lab = this.colLabels[c];
      lab.style.left = `${Math.round(xs[c])}px`;
      lab.style.width = `${widths[c]}px`;
      lab.hidden = !columns[c].length;
    }
    this.moving = true;
    this.updateEdges();
    this.kick();
  }

  place(n) {
    n.el.style.transform = `translate(${Math.round(n.x)}px, ${Math.round(n.y)}px)`;
    if (n.el.classList.contains('is-entering')) {
      // Next frame, so the opacity transition runs from 0.
      requestAnimationFrame(() => n.el.classList.remove('is-entering'));
    }
  }

  // animateNodes eases nodes toward their targets; returns true while moving.
  animateNodes(dt) {
    let moving = false;
    const k = 1 - Math.exp(-dt * 9);
    for (const n of this.nodes.values()) {
      if (n.x == null) continue;
      const dx = n.tx - n.x;
      const dy = n.ty - n.y;
      if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) {
        if (dx || dy) {
          n.x = n.tx;
          n.y = n.ty;
          this.place(n);
        }
        continue;
      }
      n.x += dx * k;
      n.y += dy * k;
      this.place(n);
      moving = true;
    }
    return moving;
  }

  updateEdges() {
    for (const e of this.edges.values()) {
      const a = this.nodes.get(e.from);
      const b = this.nodes.get(e.to);
      if (!a || !b || a.x == null || b.x == null) continue;
      const step = (h, n) => (n > 1 ? Math.min(14, (h * 0.5) / (n - 1)) : 0);
      const so = (e.outIdx - (e.outN - 1) / 2) * step(a.h, e.outN);
      const si = (e.inIdx - (e.inN - 1) / 2) * step(b.h, e.inN);
      const x0 = a.x + a.w;
      const y0 = a.y + a.h / 2 + so;
      const x3 = b.x;
      const y3 = b.y + b.h / 2 + si;
      const dx = Math.max(24, (x3 - x0) * 0.5);
      e.g = [x0, y0, x0 + dx, y0, x3 - dx, y3, x3, y3];
      const d = `M${x0.toFixed(1)},${y0.toFixed(1)} C${(x0 + dx).toFixed(1)},${y0.toFixed(1)} ${(x3 - dx).toFixed(1)},${y3.toFixed(1)} ${x3.toFixed(1)},${y3.toFixed(1)}`;
      e.path.setAttribute('d', d);
      e.track.setAttribute('d', d);
    }
    this.placeLabels();
    this.staticDirty = true;
  }

  // placeLabels puts each weight label on its curve, trying positions away
  // from the middle when the preferred spot overlaps a label already placed.
  placeLabels() {
    const placed = [];
    const overlaps = (b) => placed.some((p) => b.x < p.x + p.w && p.x < b.x + b.w && b.y < p.y + p.h && p.y < b.y + b.h);
    for (const e of this.edges.values()) {
      if (!e.label || !e.g) continue;
      const w = (e.labelW || 40) + 6;
      let best = null;
      for (const t of LABEL_TS) {
        const [x, y] = bez(e.g, t);
        const box = { x: x - w / 2, y: y - 14, w, h: 28, cx: x, cy: y };
        if (!best) best = box;
        if (!overlaps(box)) {
          best = box;
          break;
        }
      }
      placed.push(best);
      e.label.setAttribute('transform', `translate(${best.cx.toFixed(1)},${best.cy.toFixed(1)})`);
    }
  }

  // ---- Live data ------------------------------------------------------------

  update(state) {
    const f = state.frame;
    const live = state.conn === 'live';
    setData(this.root, 'conn', live ? 'live' : 'off');
    for (const n of this.nodes.values()) n.update(f, state);
    if (!f) return;
    const pt = f.point || {};
    const win = f.window || {};
    const gwTotal = win.total ? num(win.total.rps) : 0;
    this.hint.hidden = !live || gwTotal > 0 || !this.nodes.size;

    // Sum edge 4xx per route so the remainder of a route's 4xx is attributed
    // to rejections that never reached an upstream (JWT 401s).
    const edge4xx = (src, rid) => {
      let s = 0;
      const r = this.routes && this.routes.get(rid);
      if (!r || !src.edges) return 0;
      for (const u of r.upstreams || []) s += num((src.edges[`${rid}>${u.id}`] || {}).client_error_rps);
      return s;
    };
    const statOf = (src, e) => {
      if (e.kind === 'cg') return src.total;
      if (e.kind === 'gr') return src.routes ? src.routes[e.route] : null;
      return src.edges ? src.edges[`${e.route}>${e.up}`] : null;
    };
    const weights = f.weights || {};

    for (const e of this.edges.values()) {
      const p = statOf(pt, e);
      const w = statOf(win, e);
      const down = e.kind === 'ru' && this.nodes.get(e.to) && this.nodes.get(e.to).ejected;
      e.target = live && p ? num(p.rps) : 0;
      const mixSrc = p && p.rps > 0 ? p : w && w.rps > 0 ? w : null;
      if (mixSrc) {
        const rps = mixSrc.rps;
        const c5 = num(mixSrc.error_rps);
        let c4 = num(mixSrc.client_error_rps);
        let rej = 0;
        if (e.kind === 'gr') {
          rej = Math.max(0, c4 - edge4xx(mixSrc === p ? pt : win, e.route));
          c4 -= rej;
        }
        const ok = Math.max(0, rps - c5 - c4 - rej);
        e.mix = [ok / rps, (ok + c4) / rps, (ok + c4 + c5) / rps, 1];
      }
      if (w && w.rps > 0) e.lat = [num(w.p50_ms), Math.max(num(w.p50_ms), num(w.p95_ms))];

      const share = gwTotal > 0 && w ? clamp(num(w.rps) / gwTotal, 0, 1) : 0;
      e.path.style.strokeWidth = `${(1.6 + 5.4 * Math.sqrt(share)).toFixed(2)}`;
      e.track.style.strokeWidth = `${(8 + 8 * Math.sqrt(share)).toFixed(2)}`;
      setData(e.path, 'state', down ? 'down' : level(w));
      setData(e.track, 'state', down ? 'down' : level(w));

      if (e.kind === 'ru') {
        const rw = weights[e.route] || {};
        const cfgR = this.routes && this.routes.get(e.route);
        const cfgW = cfgR ? (cfgR.upstreams || []).find((u) => u.id === e.up) : null;
        const wt = e.up in rw ? num(rw[e.up]) : cfgW ? num(cfgW.weight) : 0;
        const sum = Object.keys(rw).length
          ? Object.values(rw).reduce((a, b) => a + num(b), 0)
          : ((cfgR && cfgR.upstreams) || []).reduce((a, u) => a + num(u.weight), 0);
        const pctW = sum > 0 ? Math.round((wt / sum) * 100) : 0;
        const text = `${pctW}%`;
        if (e.labelText.textContent !== text) {
          e.labelText.textContent = text;
          e.labelW = 16 + 9 * text.length;
          e.labelRect.setAttribute('width', String(e.labelW));
          e.labelRect.setAttribute('x', String(-e.labelW / 2));
          e.labelRect.setAttribute('y', '-11');
          this.placeLabels();
        }
        e.weight = wt;
        e.weightPct = pctW;
        setData(e.path, 'dashed', wt === 0 || down ? 'true' : null);
        setData(e.label, 'state', down ? 'down' : wt === 0 ? 'zero' : null);
        e.blocked = down;
      }
    }
    this.staticDirty = true;
    if (this.hover) this.hover.refresh();
    this.kick();
  }

  async pollUpstreams() {
    try {
      const list = await getUpstreams();
      for (const u of list) this.upInfo.set(u.id, { fault: u.fault, health: u.health, url: u.url });
      this.update(this.store.getState());
    } catch {
      // Keep the last known fault state; the stream drives the rest.
    }
  }

  // ---- Animation ------------------------------------------------------------

  kick() {
    if (!this.raf && this.visible && !document.hidden) this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  tick(now) {
    this.raf = 0;
    if (!this.visible || document.hidden) {
      this.last = 0;
      return;
    }
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    if (this.moving) {
      this.moving = this.animateNodes(dt);
      this.updateEdges();
    }
    if (reducedMotion.matches) {
      if (this.staticDirty) this.drawStatic();
      if (this.moving) this.kick();
      else this.last = 0;
      return;
    }
    this.step(dt, now);
    this.draw(now);
    // Idle when nothing is in flight on screen and no edge carries traffic.
    const busy = this.moving || this.particles.length || this.bursts.length || [...this.edges.values()].some((e) => e.rate > 0.01 || e.target > 0);
    if (busy) this.kick();
    else this.last = 0;
  }

  step(dt, now) {
    const k = 1 - Math.exp(-dt / RATE_TAU);
    for (const e of this.edges.values()) {
      e.rate += (e.target - e.rate) * k;
      if (!e.g || e.blocked || e.rate < 0.05) {
        e.acc = Math.min(e.acc, 1);
        continue;
      }
      const r = Math.min(MAX_PER_EDGE, SPAWN_K * Math.sqrt(e.rate));
      e.acc += r * dt;
      while (e.acc >= 1) {
        e.acc -= 1;
        if (this.particles.length >= MAX_ALIVE) break;
        this.spawn(e, now - (e.acc / r) * 1000);
      }
    }
  }

  spawn(e, t0) {
    const x = Math.random();
    const cat = x < e.mix[0] ? 'ok' : x < e.mix[1] ? 'c4' : x < e.mix[2] ? 'c5' : 'rej';
    const lat = e.lat[0] + (e.lat[1] - e.lat[0]) * Math.random() ** 2;
    const dur = clamp(TRAVEL_BASE + lat / TRAVEL_MS_PER_S, MIN_TRAVEL, MAX_TRAVEL) * (0.92 + Math.random() * 0.16);
    this.particles.push({ e, t0, dur: dur * 1000, cat, size: cat === 'ok' ? 5 : 6 });
  }

  draw(now) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    // Normal blending: additive glow washes dense, slow traffic out to white
    // and hides the status color, which is the point of the particles.
    const ps = this.particles;
    let j = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const t = (now - p.t0) / p.dur;
      if (t >= 1 || !p.e.g) {
        if (p.cat === 'rej' && p.e.g && this.bursts.length < MAX_BURSTS) this.bursts.push({ x: p.e.g[6], y: p.e.g[7], t0: now });
        continue;
      }
      ps[j++] = p;
      if (t < 0) continue;
      const img = this.sprites[p.cat];
      for (let k = 3; k >= 0; k--) {
        const tt = t - k * 0.028;
        if (tt < 0) continue;
        const [x, y] = bez(p.e.g, tt);
        const s = p.size * (1 - k * 0.2);
        ctx.globalAlpha = k ? 0.45 - k * 0.1 : 1;
        ctx.drawImage(img, x - s, y - s, s * 2, s * 2);
      }
    }
    ps.length = j;

    ctx.globalAlpha = 1;
    const bs = this.bursts;
    j = 0;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      const a = (now - b.t0) / 650;
      if (a >= 1) continue;
      bs[j++] = b;
      const ease = 1 - (1 - a) ** 3;
      const r = 3 + 15 * ease;
      ctx.globalAlpha = (1 - a) * 0.9;
      ctx.strokeStyle = this.colors.rej;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      for (let s = 0; s < 6; s++) {
        const ang = (s / 6) * Math.PI * 2 + 0.4;
        const r0 = r + 2;
        const r1 = r + 2 + 6 * (1 - a);
        ctx.moveTo(b.x + Math.cos(ang) * r0, b.y + Math.sin(ang) * r0);
        ctx.lineTo(b.x + Math.cos(ang) * r1, b.y + Math.sin(ang) * r1);
      }
      ctx.stroke();
    }
    bs.length = j;
    ctx.globalAlpha = 1;
  }

  // drawStatic renders reduced-motion flow indicators: chevrons along each
  // carrying edge (count by rate, color by dominant status) and a ring where a
  // route rejects requests.
  drawStatic() {
    this.staticDirty = false;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const e of this.edges.values()) {
      if (!e.g || e.blocked || !(e.target > 0.05)) continue;
      const m = e.mix;
      const okS = m[0];
      const c4S = m[1] - m[0];
      const c5S = m[2] - m[1];
      const rejS = 1 - m[2];
      const color = c5S > 0.1 ? this.colors.c5 : c4S + rejS > 0.25 ? this.colors.c4 : okS > 0 ? this.colors.ok : this.colors.c4;
      const count = clamp(Math.round(1 + Math.sqrt(e.target) / 3), 1, 5);
      ctx.strokeStyle = color;
      for (let i = 0; i < count; i++) {
        const t = (i + 1) / (count + 1);
        const [x, y] = bez(e.g, t);
        const [xa, ya] = bez(e.g, Math.max(0, t - 0.01));
        const [xb, yb] = bez(e.g, Math.min(1, t + 0.01));
        const ang = Math.atan2(yb - ya, xb - xa);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.moveTo(-4, -5);
        ctx.lineTo(3, 0);
        ctx.lineTo(-4, 5);
        ctx.stroke();
        ctx.restore();
      }
      if (e.kind === 'gr' && rejS > 0.005) {
        ctx.strokeStyle = this.colors.rej;
        ctx.beginPath();
        ctx.arc(e.g[6], e.g[7], 9, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // ---- Interaction ----------------------------------------------------------

  hoverStart(n) {
    clearTimeout(this.hoverTimer);
    if (this.pinned) return;
    this.hoverTimer = setTimeout(() => this.openHover(n), HOVER_DELAY);
  }

  hoverEnd(n) {
    clearTimeout(this.hoverTimer);
    if (this.hover && this.hover.id === n.id) this.hover.close();
  }

  openHover(n) {
    if (this.pinned || !this.nodes.has(n.id)) return;
    const title = el('strong', { class: 'tp-title' });
    const kind = el('span', { class: 'tp-kind' });
    const dl = el('dl', { class: 'tp-rows num' });
    const hint = el('p', { class: 'tp-hint' });
    const box = el('div', { class: 'topo-pop' }, el('header', { class: 'tp-head' }, title, kind), dl, hint);
    const refresh = () => {
      const d = this.details(n);
      setText(title, d.title);
      setText(kind, d.kind);
      hint.hidden = !d.hint;
      setText(hint, d.hint || '');
      const rows = d.rows.flatMap(([k, v, cls]) => [el('dt', { text: k }), el('dd', { text: v, class: cls || null })]);
      dl.replaceChildren(...rows);
    };
    refresh();
    const hover = { id: n.id, refresh, close: () => {} };
    hover.close = openPopover(n.el.getBoundingClientRect(), box, {
      onClose: () => {
        if (this.hover === hover) this.hover = null;
      },
    });
    box.parentElement.classList.add('popover-passive');
    this.hover = hover;
  }

  details(n) {
    const st = this.store.getState();
    const f = st.frame || {};
    const win = f.window || {};
    const lat = (s) =>
      s && s.rps > 0
        ? [
            ['p50', fmtMs(s.p50_ms)],
            ['p95', fmtMs(s.p95_ms)],
            ['p99', fmtMs(s.p99_ms), num(s.p99_ms) > ERR_P99 ? 'is-err' : num(s.p99_ms) > WARN_P99 ? 'is-warn' : null],
          ]
        : [['Latency', 'no traffic']];
    const mix = (s, rej) => {
      if (!s || !(s.rps > 0)) return [['Throughput', '0 rps']];
      const c4 = num(s.client_error_rps);
      const rows = [
        ['Throughput', fmtRate(s.rps)],
        ['5xx', `${fmtRate(num(s.error_rps), '/s')} (${fmtPct(errPct(s))})`, errPct(s) > ERR_ERR_PCT ? 'is-err' : errPct(s) > WARN_ERR_PCT ? 'is-warn' : null],
        ['4xx', `${fmtRate(c4, '/s')} (${fmtPct((c4 / s.rps) * 100)})`],
      ];
      if (rej != null) rows.push(['JWT rejected', fmtRate(rej, '/s')]);
      return rows;
    };
    if (n.kind === 'clients') {
      const l = f.load;
      if (!l) return { title: 'Clients', kind: 'traffic source', rows: [['Generator', 'unavailable']] };
      const s = l.settings || {};
      return {
        title: 'Clients',
        kind: 'traffic generator + external',
        rows: [
          ['Target', s.rps > 0 ? fmtRate(s.rps) : 'stopped'],
          ['Sent', fmtRate(num(l.sent_per_sec))],
          ['Shed', fmtRate(num(l.shed_per_sec), '/s'), l.shed_per_sec > 0 ? 'is-warn' : null],
          ['In flight', fmtNum(num(l.in_flight))],
          ['Concurrency', fmtNum(num(s.concurrency))],
          ['Invalid tokens', `${num(s.invalid_token_percent)}%`],
          ['Total sent', fmtNum(num(l.total_sent))],
        ],
      };
    }
    if (n.kind === 'gateway') {
      const t = win.total;
      const tot = f.totals || {};
      return {
        title: 'Gateway',
        kind: 'last 5s',
        rows: [
          ...mix(t),
          ...lat(t),
          ['In flight', fmtNum(f.inflight ? num(f.inflight.total) : 0)],
          ['Config', st.revision != null ? `revision ${st.revision}` : '-'],
          ['JWT rejections', fmtNum(num(tot.jwt_rejections))],
          ['Uptime', fmtDuration(tot.uptime_seconds)],
        ],
      };
    }
    if (n.kind === 'route') {
      const r = (this.routes && this.routes.get(n.route)) || {};
      const m = r.match || {};
      const s = win.routes ? win.routes[n.route] : null;
      let rej = null;
      if (r.jwt && r.jwt.required && s) {
        let e4 = 0;
        for (const u of r.upstreams || []) e4 += num(((win.edges || {})[`${n.route}>${u.id}`] || {}).client_error_rps);
        rej = Math.max(0, num(s.client_error_rps) - e4);
      }
      const ew = (f.weights || {})[n.route] || {};
      const ws = (r.upstreams || []).map((u) => `${u.id} ${u.id in ew ? ew[u.id] : u.weight}`).join(', ');
      const rows = [
        ['Match', `${m.methods && m.methods.length ? m.methods.join(',') : 'ANY'} ${m.path_prefix || '/'}`],
      ];
      if (m.hosts && m.hosts.length) rows.push(['Hosts', m.hosts.join(', ')]);
      if (m.headers && Object.keys(m.headers).length) rows.push(['Headers', Object.keys(m.headers).join(', ')]);
      if (r.rewrite_prefix) rows.push(['Rewrite', r.rewrite_prefix]);
      rows.push(
        ['Priority', String(num(r.priority))],
        ['Timeout', r.timeout_ms ? fmtMs(r.timeout_ms) : 'default'],
        ['Retries', String(num(r.retry_attempts))],
        ['JWT', r.jwt && r.jwt.required ? 'required' : 'not required'],
        [r.auto_weight ? 'Weights (auto)' : 'Weights', ws || '-'],
        ...mix(s, rej),
        ...lat(s),
      );
      return { title: n.route, kind: 'route, last 5s', rows, hint: 'Click to edit this route' };
    }
    const info = this.upInfo.get(n.up) || {};
    const h = (f.health && f.health[n.up]) || info.health;
    const s = win.upstreams ? win.upstreams[n.up] : null;
    const used = [];
    for (const rid of this.routeOrder) {
      const r = this.routes.get(rid);
      if ((r.upstreams || []).some((u) => u.id === n.up)) {
        const e = this.edges.get(`r:${rid}>u:${n.up}`);
        used.push(`${rid} ${e && e.weightPct != null ? `${e.weightPct}%` : ''}`.trim());
      }
    }
    const rows = [
      ['URL', (this.upUrl && this.upUrl.get(n.up)) || info.url || '-'],
      ['Health', h ? (h.healthy ? 'healthy' : 'ejected') : 'unknown', h && !h.healthy ? 'is-err' : null],
    ];
    if (h && h.failures) rows.push(['Probe failures', String(h.failures)]);
    if (h && h.last_change) rows.push(['Last change', fmtAgo(h.last_change)]);
    rows.push(
      ['Fault', faultSummary(info.fault), faultActive(info.fault) ? 'is-warn' : null],
      ...mix(s),
      ...lat(s),
      ['In flight', `${fmtNum(f.inflight && f.inflight.upstreams ? num(f.inflight.upstreams[n.up]) : 0)} / ${INFLIGHT_CAP}`],
      ['Routes', used.join(', ') || '-'],
    );
    return { title: n.up, kind: 'upstream, last 5s', rows, hint: 'Click to inject a fault' };
  }

  activate(n) {
    if (n.kind === 'route') {
      clearTimeout(this.hoverTimer);
      if (this.hover) this.hover.close();
      document.dispatchEvent(new CustomEvent('route:edit', { detail: { id: n.route } }));
      return;
    }
    if (n.kind !== 'upstream') return;
    clearTimeout(this.hoverTimer);
    // The popover closes itself on the pointerdown that precedes this click;
    // treat that as a toggle instead of reopening it.
    const lc = this.lastPinnedClose;
    if (lc && lc.id === n.id && performance.now() - lc.at < 400) {
      this.lastPinnedClose = null;
      return;
    }
    if (this.pinned && this.pinned.id === n.id) {
      this.pinned.close();
      this.lastPinnedClose = null;
      return;
    }
    if (this.hover) this.hover.close();
    this.openFault(n);
  }

  openFault(n) {
    const id = n.up;
    const cur = (this.upInfo.get(id) || {}).fault || {};
    const slider = (label, min, max, step, value, fmt) => {
      const out = el('output', { class: 'tf-out num' });
      const input = el('input', { type: 'range', min, max, step, value: String(value), 'aria-label': label });
      const sync = () => setText(out, fmt(+input.value));
      input.addEventListener('input', sync);
      sync();
      return { input, root: el('label', { class: 'tf-field' }, el('span', { class: 'tf-label' }, el('span', { text: label }), out), input) };
    };
    const toggle = (label, checked, desc) => {
      const input = el('input', { type: 'checkbox', role: 'switch', class: 'tf-check' });
      input.checked = !!checked;
      return { input, root: el('label', { class: 'tf-toggle' }, input, el('span', { class: 'tf-switch', 'aria-hidden': 'true' }), el('span', { class: 'tf-tl' }, el('span', { text: label }), el('small', { text: desc }))) };
    };
    const delay = slider('Latency', 0, 3000, 50, clamp(num(cur.delay_ms), 0, 3000), (v) => (v ? `+${fmtMs(v)}` : 'none'));
    const rate = slider('Error rate', 0, 100, 5, clamp(num(cur.error_rate_percent), 0, 100), (v) => `${v}%`);
    const unhealthy = toggle('Fail health checks', cur.unhealthy, 'probes fail, gateway ejects it');
    const s503 = toggle('Return 503', cur.status === 503, 'every request fails');
    const apply = el('button', { type: 'button', class: 'btn btn-primary', text: 'Apply fault' });
    const reset = el('button', { type: 'button', class: 'btn btn-ghost', text: 'Reset' });
    const box = el(
      'div',
      { class: 'topo-pop topo-fault' },
      el('header', { class: 'tp-head' }, el('span', { class: 'tf-dot', 'aria-hidden': 'true' }), el('strong', { class: 'tp-title', text: `Fault injection: ${id}` })),
      el('p', { class: 'tp-sub', text: `Now: ${faultSummary(cur)}` }),
      delay.root,
      rate.root,
      unhealthy.root,
      s503.root,
      el('footer', { class: 'tf-actions' }, reset, apply),
    );
    box.querySelector('.tf-dot').style.background = colorFor(id);
    const busy = (b) => {
      apply.disabled = b;
      reset.disabled = b;
    };
    let close = () => {};
    apply.addEventListener('click', async () => {
      const body = {
        delay_ms: +delay.input.value,
        status: s503.input.checked ? 503 : 0,
        unhealthy: unhealthy.input.checked,
        error_rate_percent: +rate.input.value,
      };
      busy(true);
      try {
        await injectFault(id, body);
        this.upInfo.set(id, { ...(this.upInfo.get(id) || {}), fault: body });
        toast(faultActive(body) ? `Fault on ${id}: ${faultSummary(body)}` : `No fault set on ${id}`, faultActive(body) ? 'warn' : 'success');
        close();
        this.pollUpstreams();
      } catch (e) {
        toast(`Fault on ${id} failed: ${e.message}`, 'error');
        busy(false);
      }
    });
    reset.addEventListener('click', async () => {
      busy(true);
      try {
        await resetFault(id);
        this.upInfo.set(id, { ...(this.upInfo.get(id) || {}), fault: { delay_ms: 0, status: 0, unhealthy: false, error_rate_percent: 0 } });
        toast(`Faults cleared on ${id}`, 'success');
        close();
        this.pollUpstreams();
      } catch (e) {
        toast(`Reset of ${id} failed: ${e.message}`, 'error');
        busy(false);
      }
    });
    const pinned = { id: n.id, close: () => {} };
    close = openPopover(n.el.getBoundingClientRect(), box, {
      onClose: () => {
        if (this.pinned === pinned) this.pinned = null;
        this.lastPinnedClose = { id: n.id, at: performance.now() };
        // Keyboard users land back on the card that opened the controls.
        if (!document.activeElement || document.activeElement === document.body) n.el.focus({ preventScroll: true });
      },
    });
    pinned.close = close;
    this.pinned = pinned;
    delay.input.focus();
  }
}

export function initTopology(panel, store) {
  return new Topology(panel, store);
}
