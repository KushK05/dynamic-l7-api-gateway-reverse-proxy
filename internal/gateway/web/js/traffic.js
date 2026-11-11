// Traffic control panel: the built-in load generator. A large logarithmic RPS
// slider with a numeric twin, presets (including timed Spike and Break it
// ramps), concurrency, invalid JWT percentage, the per-route mix and a live
// readout. The gateway is the source of truth: controls follow the frames
// unless the viewer is editing or a write is in flight. Writes are debounced
// (250 ms) and serialized so only one PUT /admin/v1/load is ever in flight.

import { el, toast } from './ui.js';
import { getLoad, putLoad } from './api.js';
import { fmtNum, fmtRateParts } from './format.js';

const DEBOUNCE_MS = 250;
const POS_MAX = 1000; // slider resolution: position 0 is "off", 1..POS_MAX map logarithmically to 1..max_rps
const DEFAULT_MAX = 2000;
const DEFAULT_START_RPS = 150;
const HOLD_AFTER_WRITE_MS = 1500; // a frame built before our PUT can still be in flight
const SPIKE_RAMP_S = 5;
const SPIKE_HOLD_S = 15;
const BREAK_RAMP_S = 60;
const DEFAULT_MIX_WEIGHT = 100;

const PRESETS = [
  { id: 'idle', label: 'Idle', rps: 0, hint: '0 rps' },
  { id: 'steady', label: 'Steady', rps: 150, hint: '150 rps' },
  { id: 'busy', label: 'Busy', rps: 800, hint: '800 rps' },
  { id: 'spike', label: 'Spike', ramp: true, hint: 'ramp to max in 5s, hold 15s, then return' },
  { id: 'break', label: 'Break it', ramp: true, hint: 'ramp to max over 60s and watch it fail' },
];

export function posToRps(pos, max) {
  if (pos <= 0) return 0;
  if (max <= 1) return max;
  return Math.min(max, Math.max(1, Math.round(Math.pow(max, pos / POS_MAX))));
}

export function rpsToPos(rps, max) {
  if (rps <= 0) return 0;
  if (max <= 1) return POS_MAX;
  return Math.min(POS_MAX, Math.max(1, Math.round((POS_MAX * Math.log(rps)) / Math.log(max))));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const intOr = (v, d) => (Number.isFinite(+v) ? Math.round(+v) : d);

// initTraffic builds the panel and returns {scenarios}: the element where the
// scenario buttons mount.
export function initTraffic(panel, store) {
  const c = new TrafficPanel(panel, store);
  return { scenarios: c.scn };
}

class TrafficPanel {
  constructor(panel, store) {
    this.panel = panel;
    this.store = store;
    this.max = DEFAULT_MAX;
    this.hasToken = true;
    this.available = true;
    this.vals = { rps: 0, concurrency: 256, invalid: 0, mix: {} };
    this.lastRps = DEFAULT_START_RPS;
    this.routeKey = '';
    this.routeIds = [];
    this.deb = 0;
    this.inflight = false;
    this.again = false;
    this.holdUntil = 0;
    this.dragging = false;
    this.ramp = null;
    this.rows = new Map();
    const release = () => {
      this.dragging = false;
    };
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    this.build();
    store.subscribe(({ type, state }) => {
      if (type === 'config') this.onConfig(state);
      else if (type === 'frame') this.onFrame(state);
    });
    this.onConfig(store.getState());
    if (store.getState().frame) this.onFrame(store.getState());
    getLoad()
      .then((s) => this.applyStatus(s, true))
      .catch(() => {});
  }

  // ---- DOM --------------------------------------------------------------------

  build() {
    const body = this.panel.querySelector('.panel-body');
    body.textContent = '';
    body.classList.add('tp');

    this.rpsInput = el('input', { type: 'number', class: 'tp-rps-input num', id: 'tp-rps', name: 'target-rps', min: '0', max: String(this.max), step: '1', inputmode: 'numeric', 'aria-label': 'Target requests per second' });
    this.runBtn = el('button', { type: 'button', class: 'btn btn-primary tp-run' });
    this.runBtn.addEventListener('click', () => this.toggleRun());
    const hero = el(
      'div',
      { class: 'tp-hero' },
      el('label', { class: 'tp-big', for: 'tp-rps' }, this.rpsInput, el('span', { class: 'tp-unit', text: 'rps target' })),
      this.runBtn,
    );

    this.rpsRange = this.range({ min: 0, max: POS_MAX, step: 1, name: 'rps-slider', label: 'Target requests per second, logarithmic' });
    this.rpsRange.classList.add('tp-range-big');
    this.scale = el('div', { class: 'tp-scale', 'aria-hidden': 'true' });
    this.sliderWrap = el('div', { class: 'tp-slider', 'data-state': 'ok' }, this.rpsRange, this.scale);

    this.presetBtns = new Map();
    const presets = el('div', { class: 'tp-presets', role: 'group', 'aria-label': 'Traffic presets' });
    for (const p of PRESETS) {
      const b = el('button', { type: 'button', class: 'tp-preset', 'aria-pressed': 'false', title: p.hint, text: p.label });
      b.addEventListener('click', () => this.preset(p));
      this.presetBtns.set(p.id, b);
      presets.append(b);
    }

    this.rampText = el('span', { class: 'tp-ramp-text' });
    this.rampFill = el('div', { class: 'tp-ramp-fill' });
    this.rampCancel = el('button', { type: 'button', class: 'btn btn-sm btn-ghost tp-ramp-cancel', text: 'Cancel' });
    this.rampCancel.addEventListener('click', () => this.cancelRamp(true));
    this.rampBox = el('div', { class: 'tp-ramp', hidden: true }, el('div', { class: 'tp-ramp-top' }, this.rampText, this.rampCancel), el('div', { class: 'tp-ramp-bar' }, this.rampFill));

    this.stat = {};
    const live = el('div', { class: 'tp-live', role: 'group', 'aria-label': 'Live generator readout' });
    for (const [key, label, title] of [
      ['sent', 'Sent', 'requests sent per second'],
      ['shed', 'Shed', 'requests the generator dropped per second because concurrency was full'],
      ['inflight', 'In-flight', 'requests in progress now'],
    ]) {
      const v = el('span', { class: 'tp-stat-v num', text: '-' });
      const u = el('span', { class: 'tp-stat-u', text: key === 'inflight' ? '' : '/s' });
      this.stat[key] = { box: el('div', { class: 'tp-stat', 'data-k': key, title }, el('span', { class: 'tp-stat-k', text: label }), el('span', { class: 'tp-stat-line' }, v, u)), v, u };
      live.append(this.stat[key].box);
    }

    this.concRange = this.range({ min: 1, max: 1024, step: 1, name: 'concurrency', label: 'Concurrency' });
    this.concVal = el('span', { class: 'tp-val num', text: '256' });
    this.invRange = this.range({ min: 0, max: 100, step: 1, name: 'invalid-jwt-percent', label: 'Invalid JWT percent' });
    this.invVal = el('span', { class: 'tp-val num', text: '0%' });
    this.hint = el('p', { class: 'tp-hint', role: 'note', hidden: true, text: 'No load-generator token configured; JWT routes will return 401.' });
    const settings = el(
      'div',
      { class: 'tp-settings' },
      el('div', { class: 'tp-row', title: 'Maximum requests the generator keeps in flight' }, el('span', { class: 'tp-row-k', text: 'Concurrency' }), this.concRange, this.concVal),
      el('div', { class: 'tp-row', title: 'Share of requests sent with a bad token' }, el('span', { class: 'tp-row-k', text: 'Invalid JWT' }), this.invRange, this.invVal),
      this.hint,
    );

    this.mixList = el('div', { class: 'tp-mix-list' });
    this.mixEmpty = el('p', { class: 'tp-note', text: 'Waiting for routes...' });
    const mix = el('details', { class: 'tp-mix' }, el('summary', { class: 'tp-mix-sum' }, el('span', { text: 'Route mix' }), el('span', { class: 'tp-mix-sub', text: 'share of generated requests' })), this.mixList, this.mixEmpty);

    this.scn = el('div', { class: 'tp-scn' });
    body.append(hero, this.sliderWrap, presets, this.rampBox, live, settings, mix, this.scn);

    this.bindRange(this.rpsRange, () => {
      this.cancelRamp(false);
      this.setRps(posToRps(+this.rpsRange.value, this.max), { paintRange: false });
      this.schedule();
    });
    this.rpsInput.addEventListener('input', () => {
      if (this.rpsInput.value === '') return;
      this.cancelRamp(false);
      this.setRps(clamp(intOr(this.rpsInput.value, 0), 0, this.max), { paintInput: false });
      this.schedule();
    });
    this.rpsInput.addEventListener('change', () => this.paintRps());
    this.rpsInput.addEventListener('blur', () => this.paintRps());
    this.bindRange(this.concRange, () => {
      this.vals.concurrency = clamp(intOr(this.concRange.value, 256), 1, 1024);
      this.paintSettings();
      this.schedule();
    });
    this.bindRange(this.invRange, () => {
      this.vals.invalid = clamp(intOr(this.invRange.value, 0), 0, 100);
      this.paintSettings();
      this.schedule();
    });
    this.paintScale();
    this.paintAll();
  }

  range({ min, max, step, name, label }) {
    return el('input', { type: 'range', class: 'rc-range tp-range', min: String(min), max: String(max), step: String(step), name, 'aria-label': label, value: String(min) });
  }

  // bindRange marks the slider as held while the pointer is down so frames do
  // not move the thumb under the user's finger.
  bindRange(input, onInput) {
    input.addEventListener('input', onInput);
    input.addEventListener('pointerdown', () => {
      this.dragging = true;
    });
  }

  paintScale() {
    // Keep ticks clear of the 0 and max labels at the ends.
    const ticks = [10, 100, 1000, 10000].filter((v) => rpsToPos(v, this.max) / POS_MAX < 0.8);
    const items = [{ v: 0, label: '0', at: 0 }, ...ticks.map((v) => ({ v, label: fmtNum(v), at: rpsToPos(v, this.max) / POS_MAX })), { v: this.max, label: `${fmtNum(this.max)} max`, at: 1 }];
    const key = items.map((i) => i.label).join('|');
    if (key === this.scaleKey) return;
    this.scaleKey = key;
    this.scale.replaceChildren(
      ...items.map((i, idx) => {
        const s = el('span', { class: 'tp-tick num', text: i.label });
        s.style.left = `${i.at * 100}%`;
        if (idx === 0) s.classList.add('tp-tick-first');
        if (idx === items.length - 1) s.classList.add('tp-tick-last');
        return s;
      }),
    );
  }

  // ---- state -> controls --------------------------------------------------------

  setRps(rps, { paintRange = true, paintInput = true } = {}) {
    this.vals.rps = clamp(Math.round(rps), 0, this.max);
    if (this.vals.rps > 0) this.lastRps = this.vals.rps;
    this.paintRps({ paintRange, paintInput });
  }

  paintRps({ paintRange = true, paintInput = true } = {}) {
    const v = this.vals.rps;
    if (paintInput && document.activeElement !== this.rpsInput && this.rpsInput.value !== String(v)) this.rpsInput.value = String(v);
    if (paintInput && document.activeElement === this.rpsInput && this.rpsInput.value === '') this.rpsInput.value = String(v);
    this.rpsInput.max = String(this.max);
    if (paintRange) this.rpsRange.value = String(rpsToPos(v, this.max));
    this.fill(this.rpsRange);
    const running = v > 0 || !!this.ramp;
    this.runBtn.textContent = running ? 'Stop' : 'Start';
    this.runBtn.classList.toggle('btn-primary', !running);
    this.runBtn.classList.toggle('btn-danger', running);
    this.runBtn.setAttribute('aria-label', running ? 'Stop the load generator' : 'Start the load generator');
    this.paintPresets();
  }

  paintSettings() {
    this.concRange.value = String(this.vals.concurrency);
    this.invRange.value = String(this.vals.invalid);
    this.fill(this.concRange);
    this.fill(this.invRange);
    this.concVal.textContent = String(this.vals.concurrency);
    this.invVal.textContent = `${this.vals.invalid}%`;
    this.hint.hidden = this.hasToken || !this.available;
    this.paintMix();
  }

  paintMix() {
    const total = this.routeIds.reduce((s, id) => s + (this.vals.mix[id] || 0), 0);
    for (const [id, row] of this.rows) {
      const w = this.vals.mix[id] || 0;
      if (!this.dragging) row.range.value = String(w);
      this.fill(row.range);
      row.val.textContent = total > 0 ? `${Math.round((w / total) * 100)}%` : this.routeIds.length ? `${Math.round(100 / this.routeIds.length)}%` : '-';
    }
  }

  paintAll() {
    this.paintRps();
    this.paintSettings();
    this.paintLocks();
  }

  paintLocks() {
    const off = !this.available;
    for (const n of [this.rpsInput, this.rpsRange, this.runBtn, this.concRange, this.invRange, ...this.presetBtns.values()]) n.disabled = off;
    for (const row of this.rows.values()) row.range.disabled = off;
    this.panel.classList.toggle('tp-off', off);
  }

  fill(range) {
    const min = +range.min;
    const max = +range.max;
    const p = max > min ? ((+range.value - min) / (max - min)) * 100 : 0;
    range.style.setProperty('--p', `${p}%`);
  }

  paintPresets() {
    let active = '';
    if (this.ramp) active = this.ramp.kind;
    else {
      const hit = PRESETS.find((p) => !p.ramp && p.rps === this.vals.rps && this.vals.rps <= this.max);
      if (hit) active = hit.id;
    }
    for (const [id, b] of this.presetBtns) {
      const on = id === active;
      if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', String(on));
    }
  }

  // ---- store --------------------------------------------------------------------

  onConfig(state) {
    const routes = (state.config && state.config.routes) || [];
    const ids = routes.map((r) => r.id);
    const key = ids.join('\u0000');
    if (key === this.routeKey) return;
    this.routeKey = key;
    this.routeIds = ids;
    for (const id of ids) if (!(id in this.vals.mix)) this.vals.mix[id] = DEFAULT_MIX_WEIGHT;
    this.buildMix();
    this.paintMix();
  }

  buildMix() {
    this.rows.clear();
    this.mixEmpty.hidden = this.routeIds.length > 0;
    this.mixList.replaceChildren(
      ...this.routeIds.map((id, i) => {
        const range = this.range({ min: 0, max: 100, step: 1, name: `mix-${id}`, label: `Share of traffic for route ${id}` });
        range.style.setProperty('--uc', `var(--c${(i % 8) + 1})`);
        const val = el('span', { class: 'tp-val num', text: '-' });
        this.bindRange(range, () => {
          this.vals.mix[id] = clamp(intOr(range.value, 0), 0, 100);
          this.paintMix();
          this.schedule();
        });
        this.rows.set(id, { range, val });
        return el('div', { class: 'tp-row tp-row-mix' }, el('span', { class: 'tp-row-k', title: id, text: id }), range, val);
      }),
    );
    this.paintLocks();
  }

  onFrame(state) {
    const load = state.frame && state.frame.load;
    if (!load) {
      if (this.available) {
        this.available = false;
        this.paintLocks();
        this.paintSettings();
      }
      this.paintLive(null);
      return;
    }
    this.applyStatus(load, false);
  }

  get busy() {
    return !!(this.deb || this.inflight || this.again || this.ramp || this.dragging || Date.now() < this.holdUntil);
  }

  applyStatus(load, force) {
    if (!load) return;
    if (!this.available) {
      this.available = true;
      this.paintLocks();
    }
    if (Number.isFinite(load.max_rps) && load.max_rps > 0 && load.max_rps !== this.max) {
      this.max = load.max_rps;
      this.paintScale();
      this.vals.rps = Math.min(this.vals.rps, this.max);
      this.paintRps();
    }
    this.hasToken = load.has_token !== false;
    this.paintLive(load);
    const s = load.settings;
    if (s && (force || !this.busy)) {
      this.vals.rps = clamp(intOr(s.rps, 0), 0, this.max);
      if (this.vals.rps > 0) this.lastRps = this.vals.rps;
      this.vals.concurrency = clamp(intOr(s.concurrency, 256), 1, 1024);
      this.vals.invalid = clamp(intOr(s.invalid_token_percent, 0), 0, 100);
      const mix = Array.isArray(s.mix) ? s.mix : [];
      for (const id of this.routeIds) {
        const m = mix.find((x) => x.route === id);
        this.vals.mix[id] = m ? clamp(intOr(m.weight, 0), 0, 100) : mix.length ? 0 : DEFAULT_MIX_WEIGHT;
      }
      this.paintRps();
      this.paintSettings();
    } else {
      this.paintSettings();
    }
  }

  paintLive(load) {
    const set = (k, parts) => {
      const s = this.stat[k];
      if (s.v.textContent !== parts.value) s.v.textContent = parts.value;
    };
    if (!load) {
      set('sent', { value: '-' });
      set('shed', { value: '-' });
      set('inflight', { value: '-' });
      return;
    }
    set('sent', { value: fmtRateParts(load.sent_per_sec || 0, '').value });
    set('shed', { value: fmtRateParts(load.shed_per_sec || 0, '').value });
    set('inflight', { value: fmtNum(load.in_flight || 0) });
    const shed = load.shed_per_sec || 0;
    const attempted = (load.sent_per_sec || 0) + shed;
    const state = shed <= 0 ? 'ok' : attempted > 0 && shed / attempted > 0.25 ? 'err' : 'warn';
    this.stat.shed.box.dataset.state = state;
    this.sliderWrap.dataset.state = state;
  }

  // ---- writes -------------------------------------------------------------------

  schedule(delay = DEBOUNCE_MS) {
    clearTimeout(this.deb);
    this.deb = setTimeout(() => this.flush(), delay);
  }

  settingsBody() {
    return {
      rps: this.vals.rps,
      concurrency: this.vals.concurrency,
      invalid_token_percent: this.vals.invalid,
      mix: this.routeIds.map((route) => ({ route, weight: this.vals.mix[route] ?? DEFAULT_MIX_WEIGHT })),
    };
  }

  async flush() {
    clearTimeout(this.deb);
    this.deb = 0;
    if (this.inflight) {
      this.again = true;
      return;
    }
    this.inflight = true;
    try {
      await putLoad(this.settingsBody());
    } catch (e) {
      toast(`Traffic settings were not applied: ${e.error || e.message}`, 'error');
      this.holdUntil = 0;
      this.again = false;
      this.cancelRamp(false);
      getLoad()
        .then((s) => this.applyStatus(s, true))
        .catch(() => {});
    } finally {
      this.inflight = false;
      this.holdUntil = Date.now() + HOLD_AFTER_WRITE_MS;
      if (this.again) {
        this.again = false;
        this.flush();
      }
    }
  }

  // ---- run, presets and ramps -----------------------------------------------------

  toggleRun() {
    if (this.vals.rps > 0 || this.ramp) {
      this.cancelRamp(false);
      this.setRps(0);
    } else {
      this.setRps(clamp(this.lastRps || DEFAULT_START_RPS, 1, this.max));
    }
    this.schedule(0);
  }

  preset(p) {
    if (p.ramp) {
      if (this.ramp && this.ramp.kind === p.id) this.cancelRamp(true);
      else this.startRamp(p.id);
      return;
    }
    this.cancelRamp(false);
    this.setRps(Math.min(p.rps, this.max));
    this.schedule(0);
  }

  startRamp(kind) {
    const wasRamp = this.ramp;
    // Chain from the rate before any ramp that is being replaced, so "return" goes home.
    const prev = wasRamp ? wasRamp.prev : this.vals.rps;
    this.cancelRamp(false);
    const total = kind === 'spike' ? SPIKE_RAMP_S + SPIKE_HOLD_S : BREAK_RAMP_S;
    this.ramp = { kind, prev, n: 0, total, t0: Date.now(), timer: 0 };
    this.ramp.timer = setInterval(() => this.rampTick(), 1000);
    toast(kind === 'spike' ? `Spike: ramping to ${fmtNum(this.max)} rps, holding ${SPIKE_HOLD_S}s.` : `Break it: ramping to ${fmtNum(this.max)} rps over ${BREAK_RAMP_S}s. Watch latency and shed.`, 'info');
    this.rampTick();
  }

  rampTick() {
    const r = this.ramp;
    if (!r) return;
    // Wall-clock seconds, so a throttled or delayed timer cannot stretch the ramp.
    r.n = Math.floor((Date.now() - r.t0) / 1000) + 1;
    const n = r.n;
    const span = r.kind === 'spike' ? SPIKE_RAMP_S : BREAK_RAMP_S;
    const frac = Math.min(1, n / span);
    const rps = Math.round(r.prev + (this.max - r.prev) * frac);
    if (r.kind === 'spike' && n > r.total) {
      this.endRamp();
      this.setRps(r.prev);
      this.schedule(0);
      toast(`Spike over: back to ${fmtNum(r.prev)} rps.`, 'success');
      return;
    }
    this.setRps(rps);
    this.schedule(0);
    if (r.kind === 'break' && n >= r.total) {
      this.endRamp();
      toast(`Break it reached ${fmtNum(this.max)} rps. Drag the slider down to recover.`, 'warn');
      return;
    }
    this.paintRamp();
  }

  paintRamp() {
    const r = this.ramp;
    if (!r) {
      this.rampBox.hidden = true;
      return;
    }
    this.rampBox.hidden = false;
    let text;
    if (r.kind === 'spike') {
      text = r.n <= SPIKE_RAMP_S ? `Spike: ramping up, ${fmtNum(this.vals.rps)} of ${fmtNum(this.max)} rps` : `Spike: holding ${fmtNum(this.max)} rps, ${r.total - r.n + 1}s left`;
    } else {
      text = `Break it: ${fmtNum(this.vals.rps)} of ${fmtNum(this.max)} rps, ${r.total - r.n}s left`;
    }
    if (this.rampText.textContent !== text) this.rampText.textContent = text;
    this.rampFill.style.width = `${Math.min(100, (r.n / r.total) * 100)}%`;
  }

  endRamp() {
    if (!this.ramp) return;
    clearInterval(this.ramp.timer);
    this.ramp = null;
    this.rampBox.hidden = true;
    this.paintRps();
  }

  // cancelRamp stops a running ramp. With revert it also returns to the rate
  // from before the ramp; without it the generator stays where it is.
  cancelRamp(revert) {
    const r = this.ramp;
    if (!r) return;
    this.endRamp();
    if (revert) {
      this.setRps(r.prev);
      this.schedule(0);
      toast(`${r.kind === 'spike' ? 'Spike' : 'Break it'} cancelled: back to ${fmtNum(r.prev)} rps.`, 'info');
    }
  }
}
