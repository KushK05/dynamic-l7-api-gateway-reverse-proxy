// Canvas time-series charts with a smoothly scrolling 120-second window.
//
// TimeChart(container, {series:[{key,label,color,fill}], stacked, yFormat, yMin,
//   yMaxFloor, log, tickFormat, emptyText})
//   yFormat formats values (legend, tooltip); tickFormat formats axis ticks and
//   defaults to yFormat.
//   update(points)      points: [{ts, values:{key:number}}], oldest first, 1s apart
//   setMarkers(list)    [{ts, color, label}] vertical annotations
//   setSeries(series)   replace the series list (colors follow series keys)
// Sparkline(container, {color}) .update(values)

import { cssVar, fmtClock, fmtNum, resolveColor } from './format.js';
import { el } from './ui.js';

const WINDOW = 120; // visible seconds
const FONT = '500 14px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const PAD = { top: 12, right: 14, bottom: 28, gap: 10 };

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// One requestAnimationFrame loop drives every chart; it idles when nothing
// needs drawing and is paused by the browser while the tab is hidden.
const live = new Set();
let rafId = 0;

function kick() {
  if (!rafId) rafId = requestAnimationFrame(loop);
}

function loop(now) {
  rafId = 0;
  let again = false;
  for (const c of live) {
    if (c.visible && c.wantsFrame(now)) {
      c.draw(now);
      again = again || c.animating(now);
    }
  }
  if (again) kick();
}

reducedMotion.addEventListener('change', () => {
  for (const c of live) c.dirty = true;
  kick();
});

function chrome() {
  return {
    grid: cssVar('--grid'),
    axis: cssVar('--axis'),
    muted: cssVar('--muted'),
    text: cssVar('--text'),
    surface: cssVar('--panel'),
    surface2: cssVar('--panel-2'),
  };
}

function withAlpha(color, a) {
  const c = resolveColor(color);
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) return c;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// linearTicks returns ~4 nice ticks covering [min, max].
function linearTicks(min, max) {
  const step = niceStep((max - min) / 4);
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= top + step / 2; v += step) ticks.push(+v.toPrecision(12));
  return { top, ticks };
}

// logTicks returns decade ticks, adding 2x and 5x steps when the range is short.
function logTicks(lo, hi) {
  const ticks = [];
  const d0 = Math.floor(Math.log10(lo) + 1e-9);
  const d1 = Math.ceil(Math.log10(hi) - 1e-9);
  const mults = d1 - d0 <= 2 ? [1, 2, 5] : [1];
  for (let d = d0; d <= d1; d++) {
    for (const m of mults) {
      const v = +(m * 10 ** d).toPrecision(12);
      if (v >= lo * 0.999 && v <= hi * 1.001) ticks.push(v);
    }
  }
  return ticks;
}

function logCeil(v) {
  const d = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * d >= v * 0.999) return m * d;
  return 10 * d;
}

class CanvasBox {
  constructor(container, cls) {
    this.wrap = el('div', { class: cls });
    this.canvas = el('canvas', { 'aria-hidden': 'true' });
    this.wrap.append(this.canvas);
    container.append(this.wrap);
    this.ctx = this.canvas.getContext('2d');
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.visible = true;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.wrap);
    this.io = new IntersectionObserver((entries) => {
      this.visible = entries[entries.length - 1].isIntersecting;
      if (this.visible) {
        this.dirty = true;
        kick();
      }
    });
    this.io.observe(this.wrap);
  }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.dirty = true;
    kick();
  }

  begin() {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    return ctx;
  }

  destroy() {
    this.ro.disconnect();
    this.io.disconnect();
    live.delete(this);
    this.wrap.remove();
  }
}

export class TimeChart extends CanvasBox {
  constructor(container, opts = {}) {
    const root = el('div', { class: 'tc' });
    container.append(root);
    const legend = el('ul', { class: 'tc-legend' });
    root.append(legend);
    super(root, 'tc-plot');
    this.root = root;
    this.legend = legend;
    this.tip = el('div', { class: 'tc-tip', hidden: true });
    this.wrap.append(this.tip);
    this.opts = {
      stacked: false,
      yFormat: fmtNum,
      yMin: undefined,
      yMaxFloor: 1,
      log: false,
      emptyText: 'Waiting for data',
      ...opts,
    };
    if (!this.opts.tickFormat) this.opts.tickFormat = this.opts.yFormat;
    this.points = [];
    this.byTs = new Map();
    this.lastTs = null;
    this.arrival = 0;
    this.markers = [];
    this.hover = null; // pointer x in CSS px, or null
    this.tipTs = null;
    this.scale = null; // displayed y domain, eased toward the target
    this.lastDraw = 0;
    this.setSeries(opts.series || []);
    this.wrap.addEventListener('pointermove', (e) => this.onPointer(e));
    this.wrap.addEventListener('pointerdown', (e) => this.onPointer(e));
    this.wrap.addEventListener('pointerleave', () => {
      this.hover = null;
      this.tip.hidden = true;
      this.tipTs = null;
      this.renderLegendValues();
      this.dirty = true;
      kick();
    });
    live.add(this);
  }

  setSeries(series) {
    this.series = series.map((s) => ({ ...s, rgb: resolveColor(s.color) }));
    this.legend.replaceChildren(
      ...this.series.map((s) => {
        const sw = el('span', { class: `tc-key ${this.opts.stacked || s.fill ? 'tc-key-area' : 'tc-key-line'}` });
        sw.style.background = s.rgb;
        const val = el('span', { class: 'tc-legend-val num', text: '-' });
        s.legendVal = val;
        return el('li', {}, sw, el('span', { class: 'tc-legend-label', text: s.label }), val);
      }),
    );
    this.renderLegendValues();
    this.dirty = true;
    kick();
  }

  update(points) {
    this.points = points;
    this.byTs = new Map(points.map((p) => [p.ts, p]));
    const last = points.length ? points[points.length - 1].ts : null;
    if (last !== this.lastTs) {
      this.lastTs = last;
      this.arrival = performance.now();
    }
    this.tipTs = null; // force tooltip refresh with new data
    this.renderLegendValues();
    this.dirty = true;
    kick();
  }

  setMarkers(markers) {
    this.markers = Array.isArray(markers) ? markers : [];
    this.dirty = true;
    kick();
  }

  value(p, key) {
    const v = p && p.values ? p.values[key] : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  renderLegendValues() {
    const ts = this.tipTs ?? this.lastTs;
    const p = ts == null ? null : this.byTs.get(ts);
    for (const s of this.series) {
      if (!s.legendVal) continue;
      const v = this.value(p, s.key);
      s.legendVal.textContent = v == null ? '-' : this.opts.yFormat(v);
    }
  }

  onPointer(e) {
    const r = this.wrap.getBoundingClientRect();
    this.hover = e.clientX - r.left;
    this.dirty = true;
    kick();
  }

  // viewEnd is the timestamp at the right edge: the newest second plus the
  // time since it arrived (capped at one second), so the plot glides left
  // between frames instead of jumping.
  viewEnd(now) {
    if (this.lastTs == null) return Date.now() / 1000;
    if (reducedMotion.matches) return this.lastTs;
    return this.lastTs + Math.min(1, Math.max(0, (now - this.arrival) / 1000));
  }

  animating(now) {
    if (reducedMotion.matches || this.lastTs == null) return false;
    return now - this.arrival < 1100 || this.easing;
  }

  wantsFrame(now) {
    return this.dirty || this.animating(now);
  }

  targetDomain(start) {
    const { stacked, log, yMaxFloor } = this.opts;
    let max = 0;
    for (const p of this.points) {
      if (p.ts < start - 1) continue;
      let sum = 0;
      for (const s of this.series) {
        const v = this.value(p, s.key) || 0;
        if (stacked) sum += v;
        else if (v > max) max = v;
      }
      if (stacked && sum > max) max = sum;
    }
    if (log) {
      const lo = this.opts.yMin ?? 0.1;
      const hi = logCeil(Math.max(max * 1.15, yMaxFloor, lo * 10));
      return { lo, hi, ticks: logTicks(lo, hi) };
    }
    const lo = this.opts.yMin ?? 0;
    const { top, ticks } = linearTicks(lo, Math.max(max * 1.1, yMaxFloor));
    return { lo, hi: top, ticks };
  }

  draw(now) {
    this.dirty = false;
    if (!this.w || !this.h) return;
    const dt = this.lastDraw ? Math.min(0.1, (now - this.lastDraw) / 1000) : 1;
    this.lastDraw = now;
    const ctx = this.begin();
    const col = chrome();
    const { log, stacked, tickFormat } = this.opts;
    const end = this.viewEnd(now);
    const start = end - WINDOW;

    // Ease the y domain toward its target so autoscale never jumps.
    const target = this.targetDomain(start);
    const tHi = log ? Math.log10(target.hi) : target.hi;
    if (!this.scale || reducedMotion.matches || this.scale.log !== log) {
      this.scale = { hi: tHi, log };
    } else {
      this.scale.hi += (tHi - this.scale.hi) * Math.min(1, dt * 6);
    }
    this.easing = Math.abs(this.scale.hi - tHi) > Math.abs(tHi) * 0.002 + 1e-6;
    if (!this.easing) this.scale.hi = tHi;
    const lo = log ? Math.log10(target.lo) : target.lo;
    const hi = this.scale.hi;

    ctx.font = FONT;
    const labels = target.ticks.map((v) => tickFormat(v));
    const labelW = Math.max(24, ...labels.map((t) => ctx.measureText(t).width));
    const L = Math.ceil(labelW + PAD.gap + 4);
    const T = PAD.top;
    const R = this.w - PAD.right;
    const B = this.h - PAD.bottom;
    const pw = Math.max(1, R - L);
    const ph = Math.max(1, B - T);
    const x = (ts) => L + ((ts - start) / WINDOW) * pw;
    const yv = (v) => {
      const t = log ? Math.log10(Math.max(v, target.lo)) : v;
      return B - ((t - lo) / (hi - lo || 1)) * ph;
    };

    // Grid and y labels.
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.lineWidth = 1;
    target.ticks.forEach((v, i) => {
      const y = Math.round(yv(v)) + 0.5;
      if (y < T - 1 || y > B + 1) return;
      ctx.strokeStyle = i === 0 ? col.axis : col.grid;
      ctx.beginPath();
      ctx.moveTo(L, y);
      ctx.lineTo(R, y);
      ctx.stroke();
      ctx.fillStyle = col.muted;
      ctx.fillText(labels[i], L - PAD.gap, y);
    });

    // X labels: clock time on 30-second boundaries; they scroll with the data.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const first = Math.ceil(start / 30) * 30;
    for (let ts = first; ts <= end; ts += 30) {
      const xx = x(ts);
      const label = fmtClock(ts);
      const w = ctx.measureText(label).width;
      if (xx - w / 2 < L - 4 || xx + w / 2 > this.w - 2) continue;
      ctx.strokeStyle = col.grid;
      ctx.beginPath();
      ctx.moveTo(Math.round(xx) + 0.5, B);
      ctx.lineTo(Math.round(xx) + 0.5, B + 5);
      ctx.stroke();
      ctx.fillStyle = col.muted;
      ctx.fillText(label, xx, this.h - 8);
    }

    const visible = this.points.filter((p) => p.ts >= start - 1 && p.ts <= end + 1);
    if (!visible.length) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = col.muted;
      ctx.fillText(this.opts.emptyText, L + pw / 2, T + ph / 2);
      this.tip.hidden = true;
      return;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(L, T - 6, pw, ph + 6);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const xs = visible.map((p) => x(p.ts));
    const tops = [];
    if (stacked) {
      const cum = visible.map(() => 0);
      const bands = this.series.map((s) => {
        const lower = cum.slice();
        visible.forEach((p, i) => (cum[i] += this.value(p, s.key) || 0));
        return { s, lower, upper: cum.slice() };
      });
      for (const { s, lower, upper } of bands) {
        ctx.beginPath();
        xs.forEach((xx, i) => (i ? ctx.lineTo(xx, yv(upper[i])) : ctx.moveTo(xx, yv(upper[i]))));
        for (let i = xs.length - 1; i >= 0; i--) ctx.lineTo(xs[i], yv(lower[i]));
        ctx.closePath();
        ctx.fillStyle = withAlpha(s.rgb, 0.24);
        ctx.fill();
      }
      for (const { s, upper, lower } of bands) {
        // Skip the outline where a band is empty so zero bands do not draw over others.
        ctx.strokeStyle = s.rgb;
        ctx.lineWidth = 2;
        ctx.beginPath();
        let pen = false;
        xs.forEach((xx, i) => {
          if (upper[i] - lower[i] <= 0) {
            pen = false;
            return;
          }
          if (pen) ctx.lineTo(xx, yv(upper[i]));
          else ctx.moveTo(xx, yv(upper[i]));
          pen = true;
        });
        ctx.stroke();
        tops.push({ s, y: (i) => yv(upper[i]), has: (i) => upper[i] - lower[i] > 0 });
      }
    } else {
      for (const s of this.series) {
        const vals = visible.map((p) => this.value(p, s.key));
        if (s.fill) {
          const g = ctx.createLinearGradient(0, T, 0, B);
          g.addColorStop(0, withAlpha(s.rgb, 0.28));
          g.addColorStop(1, withAlpha(s.rgb, 0.02));
          ctx.fillStyle = g;
          ctx.beginPath();
          let startI = -1;
          vals.forEach((v, i) => {
            if (v == null) return;
            if (startI < 0) {
              startI = i;
              ctx.moveTo(xs[i], B);
            }
            ctx.lineTo(xs[i], yv(v));
          });
          if (startI >= 0) {
            ctx.lineTo(xs[xs.length - 1], B);
            ctx.closePath();
            ctx.fill();
          }
        }
        ctx.strokeStyle = s.rgb;
        ctx.lineWidth = 2;
        ctx.beginPath();
        let pen = false;
        vals.forEach((v, i) => {
          if (v == null) {
            pen = false;
            return;
          }
          if (pen) ctx.lineTo(xs[i], yv(v));
          else ctx.moveTo(xs[i], yv(v));
          pen = true;
        });
        ctx.stroke();
        tops.push({ s, y: (i) => yv(vals[i] ?? 0), has: (i) => vals[i] != null });
      }
    }

    // End dots on the newest second, ringed in the surface color.
    const li = visible.length - 1;
    for (const t of tops) if (t.has(li)) dot(ctx, xs[li], t.y(li), t.s.rgb, col.surface);
    ctx.restore();

    this.drawMarkers(ctx, col, x, start, end, T, B, L, R);
    this.drawHover(ctx, col, visible, xs, tops, start, L, R, T, B, pw);
  }

  drawMarkers(ctx, col, x, start, end, T, B, L, R) {
    const rows = [];
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const m of this.markers) {
      if (!(m.ts >= start && m.ts <= end)) continue;
      const xx = Math.round(x(m.ts)) + 0.5;
      const c = resolveColor(m.color || col.text);
      ctx.strokeStyle = withAlpha(c, 0.75);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xx, T);
      ctx.lineTo(xx, B);
      ctx.stroke();
      if (!m.label) continue;
      const w = ctx.measureText(m.label).width + 14;
      let lx = Math.min(Math.max(xx + 3, L), R - w);
      let row = 0;
      while (row < 3 && rows[row] !== undefined && rows[row] > lx - 4) row++;
      if (row >= 3) continue;
      rows[row] = lx + w;
      const ly = T + row * 24;
      ctx.fillStyle = withAlpha(col.surface2, 0.92);
      roundRect(ctx, lx, ly, w, 21, 4);
      ctx.fill();
      ctx.fillStyle = c;
      ctx.fillRect(lx, ly + 3, 3, 15);
      ctx.fillStyle = col.text;
      ctx.fillText(m.label, lx + 8, ly + 11);
    }
  }

  drawHover(ctx, col, visible, xs, tops, start, L, R, T, B, pw) {
    if (this.hover == null || this.hover < L - 8 || this.hover > R + 8) {
      if (!this.tip.hidden) {
        this.tip.hidden = true;
        this.tipTs = null;
        this.renderLegendValues();
      }
      return;
    }
    const want = start + ((this.hover - L) / pw) * WINDOW;
    let bi = 0;
    for (let i = 1; i < visible.length; i++) if (Math.abs(visible[i].ts - want) < Math.abs(visible[bi].ts - want)) bi = i;
    const p = visible[bi];
    const xx = Math.round(xs[bi]) + 0.5;
    if (xx < L || xx > R) return;
    ctx.strokeStyle = withAlpha(col.text, 0.45);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xx, T);
    ctx.lineTo(xx, B);
    ctx.stroke();
    for (const t of tops) if (t.has(bi)) dot(ctx, xs[bi], t.y(bi), t.s.rgb, col.surface);

    if (this.tipTs !== p.ts) {
      this.tipTs = p.ts;
      this.renderTip(p);
      this.renderLegendValues();
    }
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth;
    const left = xx + 14 + tw > this.w ? xx - 14 - tw : xx + 14;
    this.tip.style.left = `${Math.max(0, left)}px`;
    this.tip.style.top = `${T}px`;
  }

  renderTip(p) {
    const { yFormat, stacked } = this.opts;
    const rows = [];
    let total = 0;
    // Stacked series list top band first, matching the visual order.
    const order = stacked ? [...this.series].reverse() : this.series;
    for (const s of order) {
      const v = this.value(p, s.key);
      total += v || 0;
      const key = el('span', { class: 'tc-tip-key' });
      key.style.background = s.rgb;
      rows.push(
        el('div', { class: 'tc-tip-row' }, key, el('strong', { class: 'num', text: v == null ? '-' : yFormat(v) }), el('span', { text: s.label })),
      );
    }
    if (stacked && this.series.length > 1) {
      rows.push(el('div', { class: 'tc-tip-row tc-tip-total' }, el('span', { class: 'tc-tip-key' }), el('strong', { class: 'num', text: yFormat(total) }), el('span', { text: 'Total' })));
    }
    this.tip.replaceChildren(el('div', { class: 'tc-tip-time num', text: fmtClock(p.ts) }), ...rows);
  }
}

function dot(ctx, x, y, color, ring) {
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = ring;
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Sparkline is a compact trend for a KPI tile: a line with a soft fill and an
// end dot, scaled from zero to the series maximum.
export class Sparkline extends CanvasBox {
  constructor(container, { color = 'var(--accent)' } = {}) {
    super(container, 'spark');
    this.color = color;
    this.values = [];
    live.add(this);
  }

  update(values) {
    this.values = values;
    this.dirty = true;
    kick();
  }

  wantsFrame() {
    return this.dirty;
  }

  animating() {
    return false;
  }

  draw() {
    this.dirty = false;
    if (!this.w || !this.h) return;
    const ctx = this.begin();
    const vals = this.values;
    if (vals.length < 2) return;
    const c = resolveColor(this.color);
    const max = Math.max(1, ...vals) * 1.1;
    const pad = 5;
    const x = (i) => pad + (i / (vals.length - 1)) * (this.w - pad * 2);
    const y = (v) => this.h - 2 - (v / max) * (this.h - pad - 2);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const g = ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, withAlpha(c, 0.3));
    g.addColorStop(1, withAlpha(c, 0));
    ctx.beginPath();
    ctx.moveTo(x(0), this.h);
    vals.forEach((v, i) => ctx.lineTo(x(i), y(v)));
    ctx.lineTo(x(vals.length - 1), this.h);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.beginPath();
    vals.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.strokeStyle = c;
    ctx.lineWidth = 2;
    ctx.stroke();
    dot(ctx, x(vals.length - 1), y(vals[vals.length - 1]), c, cssVar('--panel'));
  }
}
