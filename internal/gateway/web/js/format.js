// Number, time and color formatting shared by every dashboard module.

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function fixed(v, digits) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v);
}

// fmtNum formats counts: full under 10,000 (1,284), compact above (12.9K, 4.2M).
export function fmtNum(v) {
  if (!finite(v)) return '-';
  const a = Math.abs(v);
  if (a >= 1e9) return fixed(v / 1e9, a >= 1e10 ? 0 : 1) + 'B';
  if (a >= 1e6) return fixed(v / 1e6, a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e4) return fixed(v / 1e3, a >= 1e5 ? 0 : 1) + 'K';
  if (Number.isInteger(v)) return intFmt.format(v);
  return a < 10 ? fixed(v, 1) : intFmt.format(v);
}

// fmtRateParts returns {value, unit} for a per-second rate.
export function fmtRateParts(v, unit = 'rps') {
  if (!finite(v)) return { value: '-', unit };
  const a = Math.abs(v);
  let value;
  if (a === 0) value = '0';
  else if (a < 0.1) value = '<0.1';
  else if (a < 10) value = fixed(v, 1);
  else value = fmtNum(Math.round(v));
  return { value, unit };
}

// fmtRate formats a per-second rate with its unit: "0", "3.4 rps", "1,284 rps".
export function fmtRate(v, unit = 'rps') {
  const p = fmtRateParts(v, unit);
  return unit ? `${p.value} ${p.unit}` : p.value;
}

// fmtMsParts returns {value, unit} with adaptive precision for a duration in ms.
export function fmtMsParts(ms) {
  if (!finite(ms)) return { value: '-', unit: 'ms' };
  const a = Math.abs(ms);
  if (a >= 10000) return { value: fixed(ms / 1000, 1), unit: 's' };
  if (a >= 1000) return { value: fixed(ms / 1000, 2), unit: 's' };
  if (a >= 100) return { value: fixed(ms, 0), unit: 'ms' };
  if (a >= 1) return { value: fixed(ms, 1), unit: 'ms' };
  return { value: fixed(ms, 2), unit: 'ms' };
}

// fmtMs formats a latency: "0.42 ms", "12.3 ms", "250 ms", "1.24 s".
export function fmtMs(ms) {
  const p = fmtMsParts(ms);
  return p.value === '-' ? '-' : `${p.value} ${p.unit}`;
}

// fmtPct formats a percentage given on a 0..100 scale. Without digits it keeps
// enough precision to tell 99.95% from 100% (and 0.05% from 0%), without
// trailing zeros: "100%", "99.95%", "97.8%", "2%".
export function fmtPct(v, digits) {
  if (!finite(v)) return '-';
  if (digits !== undefined) return fixed(v, digits) + '%';
  const a = Math.abs(v);
  const d = a < 1 || (a >= 99 && a < 100) ? 2 : 1;
  // Never round a non-perfect rate up to 100% or a non-zero one down to 0%.
  let s = new Intl.NumberFormat('en-US', { maximumFractionDigits: d }).format(v);
  if (s === '100' && a < 100) s = '99.99';
  if (s === '0' && a > 0) s = '<0.01';
  return s + '%';
}

// fmtDuration formats whole seconds as "45s", "12m 04s", "3h 07m", "2d 05h".
export function fmtDuration(seconds) {
  if (!finite(seconds) || seconds < 0) return '-';
  const s = Math.floor(seconds);
  const pad = (n) => String(n).padStart(2, '0');
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m`;
  return `${Math.floor(s / 86400)}d ${pad(Math.floor(s / 3600) % 24)}h`;
}

// fmtAgo formats a past moment (Date, ISO string or epoch ms) relative to now.
export function fmtAgo(when, now = Date.now()) {
  const t = when instanceof Date ? when.getTime() : typeof when === 'string' ? Date.parse(when) : when;
  if (!finite(t)) return '-';
  const d = Math.max(0, Math.round((now - t) / 1000));
  if (d < 5) return 'just now';
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

// fmtClock formats epoch seconds as a local HH:MM:SS clock time.
export function fmtClock(tsSeconds) {
  const d = new Date(tsSeconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Categorical colors: upstream IDs take --c1..--c8 in first-seen order, so an
// upstream keeps its color everywhere (topology, charts, route editor) for the
// life of the page. A ninth ID folds into the neutral "other" color rather than
// reusing a hue.
const PALETTE_SIZE = 8;
const slots = new Map();
const resolved = new Map();

// colorSlot returns the 1-based palette slot for an ID, or 0 for "other".
export function colorSlot(id) {
  const key = String(id);
  if (!slots.has(key)) slots.set(key, slots.size < PALETTE_SIZE ? slots.size + 1 : 0);
  return slots.get(key);
}

// colorVar returns the CSS custom property reference for an ID, for styles.
export function colorVar(id) {
  const n = colorSlot(id);
  return n ? `var(--c${n})` : 'var(--c-other)';
}

// cssVar reads a custom property from :root, cached.
export function cssVar(name) {
  if (!resolved.has(name)) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    resolved.set(name, v || '#8592a8');
  }
  return resolved.get(name);
}

// resolveColor turns "var(--x)" into its computed value; other strings pass through.
export function resolveColor(c) {
  const m = /^var\((--[\w-]+)\)$/.exec(String(c).trim());
  return m ? cssVar(m[1]) : c;
}

// colorFor returns a concrete color string (usable on canvas and in styles)
// assigned stably by first-seen order of the upstream ID.
export function colorFor(id) {
  return resolveColor(colorVar(id));
}
