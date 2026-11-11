// Dashboard entry point: boots the live store and renders the top bar, KPI
// strip and charts. Later panels (topology, routes, traffic, events) plug in
// below with their own init calls; nothing is exposed globally.

import { createStore } from './store.js';
import { Sparkline, TimeChart } from './charts.js';
import { initTopology } from './topology.js';
import { colorFor, colorSlot, fmtDuration, fmtMs, fmtMsParts, fmtNum, fmtPct, fmtRate, fmtRateParts } from './format.js';

const $ = (id) => document.getElementById(id);

// KPI thresholds. Success counts every non-5xx response as served: 4xx are
// client errors (such as rejected JWTs) and not gateway failures.
const SUCCESS_WARN = 99;
const SUCCESS_ERR = 95;
const P99_WARN = 250;
const P99_ERR = 1000;
const SPARK_SECONDS = 60;

const STATE_LABEL = { warn: 'Degraded', err: 'Critical' };
const CONN_LABEL = { connecting: 'CONNECTING', live: 'LIVE', reconnecting: 'RECONNECTING', offline: 'OFFLINE' };

function initTopBar(store) {
  const conn = $('conn');
  const label = conn.querySelector('.pill-label');
  const setConn = (c) => {
    conn.dataset.state = c;
    label.textContent = CONN_LABEL[c] || c.toUpperCase();
  };
  const chip = (id, text, title) => {
    const v = $(id).querySelector('.chip-v');
    if (v.textContent !== text) v.textContent = text;
    if (title !== undefined) $(id).title = title;
  };
  setConn(store.getState().conn);
  store.subscribe(({ type, state }) => {
    if (type === 'conn') setConn(state.conn);
    if (state.revision != null) chip('chip-rev', `rev ${state.revision}`);
    const f = state.frame;
    if (type !== 'frame' || !f) return;
    const secret = String(f.secret_revision ?? '-');
    chip('chip-secret', secret, `Secrets revision ${secret}`);
    const up = f.totals && f.totals.uptime_seconds;
    chip('chip-uptime', fmtDuration(up));
  });
}

function kpi(name) {
  const root = document.querySelector(`[data-kpi="${name}"]`);
  const badge = root.querySelector('.kpi-badge');
  const note = root.querySelector('.kpi-note');
  return {
    root,
    set(sel, { value, unit }) {
      const box = root.querySelector(sel);
      const v = box.querySelector('.v');
      const u = box.querySelector('.u');
      if (v.textContent !== value) v.textContent = value;
      if (u && unit !== undefined && u.textContent !== unit) u.textContent = unit;
    },
    state(s) {
      if (root.dataset.state === s) return;
      root.dataset.state = s;
      badge.hidden = !STATE_LABEL[s];
      badge.textContent = STATE_LABEL[s] || '';
    },
    note(text) {
      if (note && note.textContent !== text) note.textContent = text;
    },
  };
}

function level(v, warn, err, higherIsWorse = true) {
  if (v == null || !Number.isFinite(v)) return 'idle';
  if (higherIsWorse) return v > err ? 'err' : v > warn ? 'warn' : 'ok';
  return v < err ? 'err' : v < warn ? 'warn' : 'ok';
}

function initKpis(store) {
  const k = {
    rps: kpi('rps'),
    success: kpi('success'),
    latency: kpi('latency'),
    errors: kpi('errors'),
    inflight: kpi('inflight'),
    jwt: kpi('jwt'),
    shed: kpi('shed'),
  };
  const spark = new Sparkline(k.rps.root.querySelector('.kpi-spark'), { color: 'var(--accent)' });

  store.subscribe(({ type, state }) => {
    if (type !== 'frame' && type !== 'conn') return;
    spark.update(state.points.slice(-SPARK_SECONDS).map((p) => p.total.rps));
    const f = state.frame;
    if (!f) return;
    const w = (f.window && f.window.total) || {};
    const rps = w.rps || 0;
    const hasTraffic = rps > 0;

    k.rps.set('.kpi-value', fmtRateParts(rps, 'rps'));
    k.rps.state(hasTraffic ? 'ok' : 'idle');

    const success = hasTraffic ? (1 - (w.error_rps || 0) / rps) * 100 : null;
    k.success.set('.kpi-value', { value: success == null ? '-' : fmtPct(success).replace('%', ''), unit: '%' });
    k.success.state(level(success, SUCCESS_WARN, SUCCESS_ERR, false));
    k.success.note(hasTraffic ? 'non-5xx responses, 5s' : 'no traffic');

    for (const q of ['p50', 'p95', 'p99']) {
      k.latency.set(`[data-q="${q}"]`, hasTraffic ? fmtMsParts(w[`${q}_ms`]) : { value: '-', unit: 'ms' });
    }
    k.latency.state(hasTraffic ? level(w.p99_ms, P99_WARN, P99_ERR) : 'idle');

    const e5 = w.error_rps || 0;
    const e5pct = hasTraffic ? (e5 / rps) * 100 : null;
    k.errors.set('.kpi-value', fmtRateParts(e5, '/s'));
    k.errors.state(level(e5pct, 100 - SUCCESS_WARN, 100 - SUCCESS_ERR));
    k.errors.note(hasTraffic ? `${fmtPct(e5pct)} of requests` : 'no traffic');

    const inflight = f.inflight ? f.inflight.total : 0;
    k.inflight.set('.kpi-value', { value: fmtNum(inflight) });
    k.inflight.state('ok');

    const jwt = f.totals ? f.totals.jwt_rejections : 0;
    k.jwt.set('.kpi-value', { value: fmtNum(jwt) });
    k.jwt.state('ok');

    const load = f.load;
    if (load) {
      const attempted = (load.sent_per_sec || 0) + (load.shed_per_sec || 0);
      const shedPct = attempted > 0 ? (load.shed_per_sec / attempted) * 100 : 0;
      k.shed.set('.kpi-value', fmtRateParts(load.shed_per_sec || 0, '/s'));
      k.shed.state(load.shed_per_sec > 0 ? (shedPct > 25 ? 'err' : 'warn') : 'ok');
      k.shed.note(`sent ${fmtRate(load.sent_per_sec || 0, '/s')}`);
    } else {
      k.shed.set('.kpi-value', { value: '-' });
      k.shed.state('idle');
      k.shed.note('generator unavailable');
    }
  });
}

// Axis tick formats: short and exact, no trailing zeros.
const tickRate = (v) => fmtNum(v);
const tickPct = (v) => `${+v.toFixed(2)}%`;
const tickMs = (v) => (v >= 1000 ? `${+(v / 1000).toFixed(2)} s` : `${+v.toPrecision(3)} ms`);
const rateFmt = (v) => fmtRate(v, '');

function upstreamIds(state) {
  const ids = [];
  const add = (id) => {
    if (!ids.includes(id)) ids.push(id);
  };
  const routes = (state.config && state.config.routes) || [];
  for (const r of routes) for (const u of r.upstreams || []) add(u.id);
  for (const p of state.points.slice(-120)) for (const id of Object.keys(p.upstreams || {})) add(id);
  // Assign palette slots in this order so colors match across panels.
  ids.forEach(colorSlot);
  return ids;
}

function initCharts(store) {
  const body = (id) => $(id).querySelector('.chart-body');
  const charts = {
    throughput: new TimeChart(body('chart-throughput'), {
      stacked: true,
      yFormat: rateFmt,
      tickFormat: tickRate,
      yMaxFloor: 10,
      series: [
        { key: 'ok', label: '2xx-3xx', color: 'var(--ok)' },
        { key: 'c4', label: '4xx', color: 'var(--warn)' },
        { key: 'c5', label: '5xx', color: 'var(--err)' },
      ],
    }),
    latency: new TimeChart(body('chart-latency'), {
      log: true,
      yMin: 0.1,
      yMaxFloor: 10,
      yFormat: fmtMs,
      tickFormat: tickMs,
      series: [
        { key: 'p50', label: 'p50', color: 'var(--lat1)' },
        { key: 'p95', label: 'p95', color: 'var(--lat2)' },
        { key: 'p99', label: 'p99', color: 'var(--lat3)' },
      ],
    }),
    upstreams: new TimeChart(body('chart-upstreams'), {
      stacked: true,
      yFormat: rateFmt,
      tickFormat: tickRate,
      yMaxFloor: 10,
      series: [],
    }),
    errors: new TimeChart(body('chart-errors'), {
      yFormat: (v) => fmtPct(v),
      tickFormat: tickPct,
      yMaxFloor: 5,
      series: [
        { key: 'e5', label: '5xx', color: 'var(--err)' },
        { key: 'e4', label: '4xx', color: 'var(--warn)' },
      ],
    }),
  };

  let upKey = '';
  const render = (state) => {
    const ids = upstreamIds(state);
    if (ids.join('\u0000') !== upKey) {
      upKey = ids.join('\u0000');
      charts.upstreams.setSeries(ids.map((id) => ({ key: id, label: id, color: colorFor(id) })));
    }
    const pts = state.points;
    charts.throughput.update(
      pts.map((p) => {
        const t = p.total;
        return { ts: p.ts, values: { ok: Math.max(0, t.rps - t.error_rps - t.client_error_rps), c4: t.client_error_rps, c5: t.error_rps } };
      }),
    );
    charts.latency.update(
      pts.map((p) => {
        const t = p.total;
        const has = t.rps > 0;
        return { ts: p.ts, values: has ? { p50: t.p50_ms, p95: t.p95_ms, p99: t.p99_ms } : {} };
      }),
    );
    charts.upstreams.update(
      pts.map((p) => {
        const values = {};
        for (const id of ids) values[id] = (p.upstreams && p.upstreams[id] && p.upstreams[id].rps) || 0;
        return { ts: p.ts, values };
      }),
    );
    charts.errors.update(
      pts.map((p) => {
        const t = p.total;
        return { ts: p.ts, values: t.rps > 0 ? { e5: (t.error_rps / t.rps) * 100, e4: (t.client_error_rps / t.rps) * 100 } : {} };
      }),
    );
  };
  store.subscribe(({ type, state }) => {
    if (type === 'frame' || type === 'conn' || type === 'config') render(state);
  });
  return charts;
}

const store = createStore();
initTopBar(store);
initKpis(store);
// charts is {throughput, latency, upstreams, errors}; the event feed uses it for setMarkers.
const charts = initCharts(store);
initTopology($('topology'), store);
// Later panels plug in here, before start():
//   initRoutes($('routes'), store);
//   initTraffic($('traffic'), store); initEvents($('events'), store, charts);
void charts;
store.start();
