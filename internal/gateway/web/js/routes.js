// Routes panel: one card per route with live stats, linked weight sliders,
// auto weight, a progressive canary, add/edit/delete, and a raw config JSON
// editor. Every change is a full config PUT with If-Match; auto weight's live
// effective weights are only displayed, never written.

import * as api from './api.js';
import { el, openModal, toast } from './ui.js';
import { colorFor, colorSlot, fmtMs, fmtPct, fmtRate } from './format.js';
import { configError, distribute, evenSplit, openRouteForm, rebalance } from './routeform.js';

export const CANARY_STEPS = [10, 25, 50, 100];
const CANARY_STEP_MS = 8000;
// Same thresholds as the topology cards.
const ERR_WARN = 2;
const ERR_BAD = 10;
const P95_WARN = 250;
const P95_BAD = 1000;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clone = (v) => JSON.parse(JSON.stringify(v));
const canon = (r) => JSON.stringify(r);
const weightsOf = (r) => r.upstreams.map((u) => u.weight);
const sameArr = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const splitText = (r) => r.upstreams.map((u) => `${u.id} ${u.weight}`).join(' / ');

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  plus: 'M12 5v14M5 12h14',
  code: 'M9 7l-5 5 5 5M15 7l5 5-5 5',
};

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `ico ico-${name}`);
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICONS[name]);
  svg.append(p);
  return svg;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function withoutAuto(r) {
  const out = { ...r };
  delete out.auto_weight;
  return out;
}

let controller = null;

// CANARY_CANCELLED is thrown from a canary step's mutate closure when the
// canary was rolled back or replaced; callers treat it as a quiet no-op.
const CANARY_CANCELLED = Object.freeze({ canaryCancelled: true });

// startCanary runs the progressive canary on a route: the target upstream goes
// 10 -> 25 -> 50 -> 100 percent, one config revision every 8 seconds. Resolves
// true when the first step was applied.
export function startCanary(routeId, upstreamId) {
  if (!controller) throw new Error('routes panel is not initialized');
  return controller.startCanary(routeId, upstreamId);
}

export function initRoutes(panel, store) {
  controller = new RoutesPanel(panel, store);
  return controller;
}

class RoutesPanel {
  constructor(panel, store) {
    this.panel = panel;
    this.store = store;
    this.cards = new Map();
    this.drafts = new Map(); // routeId -> {ids, weights, base, baseRev}
    this.canaries = new Map(); // routeId -> canary state
    this.order = '';
    this.tick = 0;
    this.buildChrome();
    store.subscribe(({ type, state }) => {
      if (type === 'config') this.onConfig(state);
      else if (type === 'frame') this.onFrame(state);
    });
    document.addEventListener('route:edit', (e) => {
      const id = e.detail && e.detail.id;
      if (!id) return;
      this.panel.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      const card = this.cards.get(id);
      if (card) card.flash();
      this.openEdit(id);
    });
  }

  buildChrome() {
    const head = this.panel.querySelector('.panel-head');
    this.countSub = head.querySelector('.panel-sub');
    this.jsonBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-pressed': 'false', 'aria-controls': 'routes-json' }, icon('code'), el('span', { text: 'Config JSON' }));
    this.addBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm' }, icon('plus'), el('span', { text: 'Add route' }));
    this.jsonBtn.addEventListener('click', () => this.toggleJson());
    this.addBtn.addEventListener('click', () => this.openAdd());
    head.append(el('div', { class: 'rp-actions' }, this.jsonBtn, this.addBtn));

    const body = this.panel.querySelector('.panel-body');
    body.textContent = '';
    this.json = new JsonEditor(this);
    this.grid = el('div', { class: 'rc-grid' });
    this.empty = el('p', { class: 'placeholder', text: 'Loading routes...' });
    body.append(this.json.node, this.empty, this.grid);
  }

  get state() {
    return this.store.getState();
  }

  route(id) {
    const c = this.state.config;
    return c ? c.routes.find((r) => r.id === id) : undefined;
  }

  onConfig(state) {
    const cfg = state.config;
    if (!cfg) return;
    // Palette slots follow config order, as the charts assign them.
    for (const r of cfg.routes) for (const u of r.upstreams) colorSlot(u.id);
    const sorted = [...cfg.routes].sort((a, b) => b.priority - a.priority);
    const ids = new Set(sorted.map((r) => r.id));
    for (const [id, card] of this.cards) {
      if (ids.has(id)) continue;
      card.node.remove();
      this.cards.delete(id);
      this.drafts.delete(id);
    }
    for (const [id, c] of this.canaries) {
      if (!ids.has(id)) {
        this.stopCanary(c);
        this.canaries.delete(id);
        toast(`Canary on "${id}" stopped: the route was removed.`, 'warn');
      }
    }
    for (const r of sorted) {
      let card = this.cards.get(r.id);
      if (!card) {
        card = new RouteCard(this, r.id);
        this.cards.set(r.id, card);
      }
      card.setRoute(r);
    }
    const order = sorted.map((r) => r.id).join('\u0000');
    if (order !== this.order) {
      this.order = order;
      const focused = document.activeElement;
      for (const r of sorted) this.grid.append(this.cards.get(r.id).node);
      if (focused && focused !== document.activeElement && focused.isConnected) focused.focus();
    }
    this.empty.hidden = true;
    const n = cfg.routes.length;
    setText(this.countSub, `${n} route${n === 1 ? '' : 's'}, config rev ${state.configRevision}`);
    for (const card of this.cards.values()) card.setOnlyRoute(n === 1);
    this.json.onConfig(state);
    if (state.frame) this.onFrame(state);
  }

  onFrame(state) {
    const f = state.frame;
    if (!f) return;
    for (const card of this.cards.values()) card.live(f);
  }

  // ---- writes -------------------------------------------------------------

  // put sends a full config and re-reads it so every panel sees the result.
  async put(config, revision) {
    const res = await api.putConfig(config, revision);
    await this.store.refreshConfig();
    return res;
  }

  // mutateRoute rewrites one route on top of the latest config. Used for
  // single-purpose actions (auto toggle, canary steps, rollback, delete) that
  // do not depend on a stale view of the route, so a 412 is retried once on
  // the refreshed config.
  async mutateRoute(id, fn, retries = 1) {
    for (let attempt = 0; ; attempt++) {
      const { config, configRevision } = this.state;
      if (!config || !config.routes.some((r) => r.id === id)) throw new Error(`Route "${id}" no longer exists.`);
      const routes = [];
      for (const r of config.routes) {
        if (r.id !== id) routes.push(r);
        else {
          const next = fn(clone(r));
          if (next) routes.push(next);
        }
      }
      try {
        return await this.put({ ...config, routes }, configRevision);
      } catch (e) {
        if (e.conflict && attempt < retries) {
          await this.store.refreshConfig();
          continue;
        }
        throw e;
      }
    }
  }

  async conflict(what) {
    await this.store.refreshConfig();
    toast(`Config changed elsewhere (now rev ${this.state.configRevision}). ${what}`, 'warn');
  }

  // ---- weights --------------------------------------------------------------

  setDraft(id, weights) {
    const r = this.route(id);
    if (!r) return;
    const prev = this.drafts.get(id);
    const base = prev ? prev.baseRoute : r;
    if (sameArr(weights, weightsOf(base)) && (!prev || canon(r) === prev.base)) {
      this.drafts.delete(id);
      return;
    }
    this.drafts.set(id, {
      ids: base.upstreams.map((u) => u.id),
      weights,
      base: prev ? prev.base : canon(r),
      baseRoute: base,
      baseRev: prev ? prev.baseRev : this.state.configRevision,
    });
  }

  discard(id) {
    this.drafts.delete(id);
    const r = this.route(id);
    const card = this.cards.get(id);
    if (r && card) card.setRoute(r);
  }

  async applyWeights(id) {
    const d = this.drafts.get(id);
    const card = this.cards.get(id);
    const { config, configRevision } = this.state;
    const cur = this.route(id);
    if (!d || !cur || !card) return;
    // Unchanged route: merge onto the latest config. Changed since the edit
    // started: send the revision the edit was based on so the server reports
    // the conflict instead of silently overwriting someone else's change.
    const rev = canon(cur) === d.base ? configRevision : d.baseRev;
    const byId = new Map(d.ids.map((uid, i) => [uid, d.weights[i]]));
    const next = { ...cur, upstreams: cur.upstreams.map((u) => ({ ...u, weight: byId.get(u.id) ?? 0 })) };
    card.busy(true);
    try {
      const res = await this.put({ ...config, routes: config.routes.map((r) => (r.id === id ? next : r)) }, rev);
      this.drafts.delete(id);
      card.setRoute(this.route(id) || next);
      toast(`"${id}" weights applied: ${splitText(next)} (rev ${res.new_revision})`, 'success');
    } catch (e) {
      if (e.conflict) {
        await this.conflict(`Your weights for "${id}" are kept: review them and Apply again.`);
        this.rebaseDraft(id);
      } else if (e.status === 400) card.error(e.error);
      else {
        card.error(e.message);
        toast(`Applying "${id}" failed: ${e.message}`, 'error');
      }
    } finally {
      card.busy(false);
    }
  }

  // rebaseDraft keeps the pending weights but bases them on the refreshed
  // route, so the next Apply goes through.
  rebaseDraft(id, render = true) {
    const d = this.drafts.get(id);
    const r = this.route(id);
    const card = this.cards.get(id);
    if (!d) return;
    if (!r) {
      this.drafts.delete(id);
      return;
    }
    const byId = new Map(d.ids.map((uid, i) => [uid, d.weights[i]]));
    let weights = r.upstreams.map((u) => byId.get(u.id) ?? 0);
    if (weights.reduce((a, b) => a + b, 0) !== 100) weights = distribute(100, weights);
    this.drafts.set(id, { ids: r.upstreams.map((u) => u.id), weights, base: canon(r), baseRoute: r, baseRev: this.state.configRevision });
    if (card && render) card.setRoute(r);
  }

  async setAuto(id, on) {
    const card = this.cards.get(id);
    card.busy(true);
    try {
      await this.mutateRoute(id, (r) => (on ? { ...r, auto_weight: true } : withoutAuto(r)));
      toast(on ? `Auto weight on for "${id}": the gateway now shifts traffic by health and latency.` : `Auto weight off for "${id}": configured weights apply.`, 'success');
    } catch (e) {
      card.error(e.status === 400 ? e.error : e.message);
      toast(`Auto weight change failed: ${e.message}`, 'error');
    } finally {
      card.busy(false);
      const r = this.route(id);
      if (r) card.setRoute(r);
    }
  }

  // ---- add / edit / delete ----------------------------------------------------

  async knownUpstreams() {
    try {
      return await api.getUpstreams();
    } catch (e) {
      toast(`Could not list upstreams: ${e.message}`, 'warn');
      return [];
    }
  }

  async openAdd() {
    const known = await this.knownUpstreams();
    openRouteForm({
      mode: 'add',
      config: this.state.config,
      known,
      onSubmit: async (route) => {
        const { config, configRevision } = this.state;
        try {
          const res = await this.put({ ...config, routes: [...config.routes, route] }, configRevision);
          toast(`Route "${route.id}" added (rev ${res.new_revision})`, 'success');
          requestAnimationFrame(() => {
            const card = this.cards.get(route.id);
            if (card) card.flash(true);
          });
        } catch (e) {
          if (e.conflict) await this.conflict('Your new route is kept in the form: save it again.');
          throw e;
        }
      },
    });
  }

  async openEdit(id) {
    const r = this.route(id);
    if (!r) return;
    const known = await this.knownUpstreams();
    const ctx = { base: canon(r), baseRev: this.state.configRevision };
    openRouteForm({
      mode: 'edit',
      route: clone(r),
      config: this.state.config,
      known,
      onSubmit: async (route) => {
        const { config, configRevision } = this.state;
        const cur = this.route(id);
        if (!cur) throw new Error(`Route "${id}" was deleted elsewhere.`);
        const rev = canon(cur) === ctx.base ? configRevision : ctx.baseRev;
        try {
          const res = await this.put({ ...config, routes: config.routes.map((x) => (x.id === id ? route : x)) }, rev);
          this.drafts.delete(id);
          const card = this.cards.get(id);
          const now = this.route(id);
          if (card && now) card.setRoute(now);
          toast(`Route "${id}" saved (rev ${res.new_revision})`, 'success');
        } catch (e) {
          if (e.conflict) {
            await this.conflict(`Your edits to "${id}" are kept in the form: review and save again.`);
            const fresh = this.route(id);
            if (fresh) {
              ctx.base = canon(fresh);
              ctx.baseRev = this.state.configRevision;
            }
          }
          throw e;
        }
      },
    });
  }

  confirmDelete(id) {
    const r = this.route(id);
    if (!r) return;
    const m = r.match || {};
    const body = el(
      'div',
      { class: 'rc-confirm' },
      el('p', {}, 'Delete route ', el('code', { text: id }), '? Requests to ', el('code', { text: `${(m.methods || ['*']).join(',')} ${m.path_prefix}` }), ' will fall through to lower priority routes or get a 404.'),
      el('p', { class: 'rc-confirm-note', text: 'This writes a new config revision.' }),
    );
    openModal({
      title: 'Delete route',
      body,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Delete route',
          kind: 'danger',
          onClick: async (close) => {
            close();
            try {
              const res = await this.mutateRoute(id, () => null);
              toast(`Route "${id}" deleted (rev ${res.new_revision})`, 'success');
            } catch (e) {
              toast(`Delete failed: ${e.status === 400 ? e.error : e.message}`, 'error');
            }
          },
        },
      ],
    });
  }

  // ---- canary -----------------------------------------------------------------

  async startCanary(routeId, upstreamId) {
    const r = this.route(routeId);
    if (!r) {
      toast(`Canary: route "${routeId}" not found.`, 'error');
      return false;
    }
    if (r.upstreams.length < 2) {
      toast(`Canary needs a route with two or more upstreams; "${routeId}" has one.`, 'warn');
      return false;
    }
    if (!r.upstreams.some((u) => u.id === upstreamId)) {
      toast(`Canary: "${upstreamId}" is not an upstream of "${routeId}".`, 'error');
      return false;
    }
    const running = this.canaries.get(routeId);
    if (running && running.status === 'running') {
      toast(`A canary is already running on "${routeId}".`, 'warn');
      return false;
    }
    this.drafts.delete(routeId);
    const c = { routeId, target: upstreamId, before: clone(r), step: -1, status: 'running', timer: 0, nextAt: 0 };
    this.canaries.set(routeId, c);
    if (r.auto_weight) toast(`Auto weight paused on "${routeId}" for the canary.`, 'info');
    toast(`Canary started on "${routeId}": ${upstreamId} to ${CANARY_STEPS.join(', ')}%`, 'info');
    return this.canaryStep(c);
  }

  async canaryStep(c) {
    if (this.canaries.get(c.routeId) !== c || c.status !== 'running') return false;
    const step = c.step + 1;
    const pct = CANARY_STEPS[step];
    const beforeW = new Map(c.before.upstreams.map((u) => [u.id, u.weight]));
    this.renderCanary(c);
    // live is re-checked every time fn runs, including the 412 retry, so a
    // rollback that lands while this step is in flight is never undone.
    const live = () => this.canaries.get(c.routeId) === c && c.status === 'running';
    try {
      await this.mutateRoute(c.routeId, (r) => {
        if (!live()) throw CANARY_CANCELLED;
        const idx = r.upstreams.findIndex((u) => u.id === c.target);
        if (idx < 0) throw new Error(`upstream "${c.target}" was removed from the route`);
        const w = rebalance(
          r.upstreams.map((u) => beforeW.get(u.id) ?? 0),
          idx,
          pct,
        );
        return { ...withoutAuto(r), upstreams: r.upstreams.map((u, i) => ({ ...u, weight: w[i] })) };
      });
    } catch (e) {
      if (e === CANARY_CANCELLED || !live()) return false;
      c.status = 'failed';
      c.error = e.status === 400 ? e.error : e.message;
      this.renderCanary(c);
      toast(`Canary on "${c.routeId}" stopped at step ${step + 1}: ${c.error}`, 'error');
      return false;
    }
    if (!live()) return true;
    c.step = step;
    if (step >= CANARY_STEPS.length - 1) {
      c.status = 'done';
      toast(`Canary complete: "${c.routeId}" sends 100% to ${c.target}.`, 'success');
    } else {
      c.nextAt = Date.now() + CANARY_STEP_MS;
      c.timer = setTimeout(() => this.canaryStep(c), CANARY_STEP_MS);
      this.ensureTicker();
    }
    this.renderCanary(c);
    return true;
  }

  stopCanary(c) {
    clearTimeout(c.timer);
    c.timer = 0;
  }

  async rollback(routeId) {
    const c = this.canaries.get(routeId);
    if (!c || c.status === 'rolling-back') return;
    this.stopCanary(c);
    const prevStatus = c.status;
    c.status = 'rolling-back';
    this.renderCanary(c);
    const before = new Map(c.before.upstreams.map((u) => [u.id, u.weight]));
    try {
      await this.mutateRoute(routeId, (r) => {
        let w = r.upstreams.map((u) => before.get(u.id) ?? 0);
        if (w.reduce((a, b) => a + b, 0) !== 100) w = distribute(100, w);
        const out = { ...withoutAuto(r), upstreams: r.upstreams.map((u, i) => ({ ...u, weight: w[i] })) };
        if (c.before.auto_weight) out.auto_weight = true;
        return out;
      });
      this.canaries.delete(routeId);
      this.renderCanary({ routeId, status: 'idle' });
      toast(`Rolled back "${routeId}" to ${splitText(c.before)}${c.before.auto_weight ? ' with auto weight' : ''}.`, 'success');
    } catch (e) {
      c.status = prevStatus === 'running' ? 'failed' : prevStatus;
      c.error = `Rollback failed: ${e.status === 400 ? e.error : e.message}`;
      this.renderCanary(c);
      toast(c.error, 'error');
    }
  }

  dismissCanary(routeId) {
    const c = this.canaries.get(routeId);
    if (!c || c.status === 'running' || c.status === 'rolling-back') return;
    this.canaries.delete(routeId);
    this.renderCanary({ routeId, status: 'idle' });
  }

  renderCanary(c) {
    const card = this.cards.get(c.routeId);
    if (card) card.renderCanary(c.status === 'idle' ? null : c);
  }

  // One 250ms ticker drives every running canary's countdown.
  ensureTicker() {
    if (this.tick) return;
    this.tick = setInterval(() => {
      let any = false;
      for (const c of this.canaries.values()) {
        if (c.status !== 'running') continue;
        any = true;
        const card = this.cards.get(c.routeId);
        if (card) card.canaryCountdown(c);
      }
      if (!any) {
        clearInterval(this.tick);
        this.tick = 0;
      }
    }, 250);
  }

  // ---- JSON ---------------------------------------------------------------------

  toggleJson() {
    const open = this.json.node.hidden;
    this.json.setOpen(open);
    this.jsonBtn.setAttribute('aria-pressed', String(open));
  }
}

// ---------------------------------------------------------------------------

class RouteCard {
  constructor(panel, id) {
    this.p = panel;
    this.id = id;
    this.route = null;
    this.rows = [];
    this.rowsKey = '';
    this.gesture = null;

    this.idEl = el('span', { class: 'rc-id', text: id });
    this.prio = el('span', { class: 'rc-prio num' });
    this.jwt = el('span', { class: 'rc-badge rc-badge-jwt', title: 'JWT required' }, icon('lock'), el('span', { text: 'JWT' }));
    this.auto = el('span', { class: 'rc-badge rc-badge-auto', text: 'AUTO', title: 'Auto weight on' });
    this.canaryBadge = el('span', { class: 'rc-badge rc-badge-canary', text: 'CANARY', hidden: true });
    this.editBtn = el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Edit route ${id}`, title: 'Edit route' }, icon('edit'));
    this.delBtn = el('button', { type: 'button', class: 'icon-btn icon-btn-danger', 'aria-label': `Delete route ${id}`, title: 'Delete route' }, icon('trash'));
    this.editBtn.addEventListener('click', () => this.p.openEdit(id));
    this.delBtn.addEventListener('click', () => this.p.confirmDelete(id));

    this.methods = el('span', { class: 'rc-methods' });
    this.path = el('span', { class: 'rc-path' });
    this.extra = el('div', { class: 'rc-extra' });
    this.meta = el('dl', { class: 'rc-meta' });

    this.stat = {};
    const stat = (k, label) => {
      const v = el('span', { class: 'rc-sv num', text: '-' });
      const u = el('span', { class: 'rc-su' });
      this.stat[k] = { v, u, box: el('div', { class: 'rc-stat' }, el('span', { class: 'rc-sval' }, v, u), el('span', { class: 'rc-sk', text: label })) };
      return this.stat[k].box;
    };
    this.liveBox = el('div', { class: 'rc-live' }, stat('rps', 'requests'), stat('err', '5xx'), stat('p95', 'p95'));

    this.split = el('div', { class: 'rc-split', 'aria-hidden': 'true' });
    this.wHead = el('span', { class: 'rc-wmode' });
    this.weights = el('div', { class: 'rc-weights' });

    this.evenBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Even split' });
    this.autoChk = el('input', { type: 'checkbox', name: `auto-${id}`, class: 'rf-check', 'aria-label': `Auto weight for ${id}` });
    this.autoToggle = el('label', { class: 'rc-autotoggle rf-toggle' }, this.autoChk, el('span', { class: 'rf-switch', 'aria-hidden': 'true' }), el('span', { text: 'Auto weight' }));
    this.discardBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Discard' });
    this.applyBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Apply' });
    this.evenBtn.addEventListener('click', () => this.setWeights(evenSplit(this.rows.length)));
    this.autoChk.addEventListener('change', () => this.p.setAuto(id, this.autoChk.checked));
    this.discardBtn.addEventListener('click', () => this.p.discard(id));
    this.applyBtn.addEventListener('click', () => this.p.applyWeights(id));

    this.canaryBox = el('div', { class: 'rc-canary' });
    this.msg = el('div', { class: 'rc-msg', role: 'alert', hidden: true });

    this.node = el(
      'article',
      { class: 'rc', 'data-route': id },
      el('header', { class: 'rc-head' }, el('div', { class: 'rc-title' }, this.idEl, this.prio), el('div', { class: 'rc-badges' }, this.jwt, this.auto, this.canaryBadge), el('div', { class: 'rc-actions' }, this.editBtn, this.delBtn)),
      el('div', { class: 'rc-match' }, this.methods, this.path),
      this.extra,
      this.meta,
      this.liveBox,
      el('section', { class: 'rc-wsec', 'aria-label': `Weights for ${id}` }, el('div', { class: 'rc-whead' }, el('span', { class: 'rc-wtitle', text: 'Weights' }), this.wHead), this.split, this.weights),
      el('div', { class: 'rc-tools' }, this.evenBtn, this.autoToggle, el('span', { class: 'rc-spacer' }), this.discardBtn, this.applyBtn),
      this.msg,
      this.canaryBox,
    );
  }

  get draft() {
    return this.p.drafts.get(this.id);
  }

  get canary() {
    return this.p.canaries.get(this.id);
  }

  setOnlyRoute(only) {
    this.delBtn.disabled = only;
    this.delBtn.title = only ? 'The last route cannot be deleted' : 'Delete route';
  }

  setRoute(r) {
    this.route = r;
    const m = r.match || {};
    setText(this.prio, `P${r.priority}`);
    this.jwt.hidden = !(r.jwt && r.jwt.required);
    this.auto.hidden = !r.auto_weight;
    this.methods.textContent = '';
    for (const x of m.methods && m.methods.length ? m.methods : ['ANY']) this.methods.append(el('span', { class: 'rc-method', 'data-m': x, text: x }));
    setText(this.path, m.path_prefix || '/');

    this.extra.textContent = '';
    if (m.hosts && m.hosts.length) this.extra.append(el('span', { class: 'rc-tag' }, el('b', { text: 'host ' }), m.hosts.join(', ')));
    for (const [k, v] of Object.entries(m.headers || {})) this.extra.append(el('span', { class: 'rc-tag' }, el('b', { text: 'header ' }), `${k}=${v}`));
    this.extra.hidden = !this.extra.childElementCount;

    this.meta.textContent = '';
    const meta = (k, v, cls) => this.meta.append(el('div', { class: `rc-mi ${cls || ''}` }, el('dt', { text: k }), el('dd', { class: 'num', text: v })));
    meta('Rewrite', r.rewrite_prefix ? `-> ${r.rewrite_prefix}` : 'none', r.rewrite_prefix ? '' : 'is-off');
    meta('Timeout', r.timeout_ms < 1000 ? `${r.timeout_ms} ms` : `${+(r.timeout_ms / 1000).toFixed(2)} s`);
    meta('Retry', r.retry_attempts > 0 ? `${r.retry_attempts}x` : 'off', r.retry_attempts > 0 ? '' : 'is-off');

    // Rebuild the upstream rows only when the set of upstreams changes, so a
    // slider being dragged keeps its element.
    const key = r.upstreams.map((u) => u.id).join('\u0000');
    if (key !== this.rowsKey) {
      this.rowsKey = key;
      if (this.draft) this.p.rebaseDraft(this.id, false);
      this.buildRows(r);
    }
    this.node.dataset.auto = String(!!r.auto_weight);
    this.autoChk.checked = !!r.auto_weight;
    this.msg.hidden = true;
    this.renderWeights();
    this.renderCanary(this.canary || null);
  }

  buildRows(r) {
    this.weights.textContent = '';
    this.split.textContent = '';
    this.rows = r.upstreams.map((u, i) => {
      const color = colorFor(u.id);
      const range = el('input', { type: 'range', name: `weight-${this.id}-${u.id}`, min: '0', max: '100', step: '1', class: 'rc-range', 'aria-label': `${u.id} weight` });
      const num = el('input', { type: 'number', name: `weight-num-${this.id}-${u.id}`, min: '0', max: '100', step: '1', class: 'rc-num num', 'aria-label': `${u.id} weight percent` });
      const effFill = el('div', { class: 'rc-eff-fill' });
      const eff = el('div', { class: 'rc-eff', role: 'meter', 'aria-label': `${u.id} effective weight`, 'aria-valuemin': '0', 'aria-valuemax': '100' }, effFill);
      const was = el('span', { class: 'rc-was num' });
      const row = el(
        'div',
        { class: 'rc-row' },
        el('span', { class: 'rc-up' }, el('span', { class: 'rc-dot', 'aria-hidden': 'true' }), el('span', { class: 'rc-uid', text: u.id, title: u.url })),
        el('div', { class: 'rc-ctl' }, range, eff),
        el('span', { class: 'rc-val' }, num, el('span', { class: 'rc-pct', text: '%' })),
        was,
      );
      row.style.setProperty('--uc', color);
      const seg = el('span', { class: 'rc-seg' });
      seg.style.setProperty('--uc', color);
      this.split.append(seg);
      range.addEventListener('pointerdown', () => (this.gesture = this.current()));
      range.addEventListener('input', () => {
        if (!this.gesture) this.gesture = this.current();
        this.setWeights(rebalance(this.gesture, i, range.value));
      });
      range.addEventListener('change', () => (this.gesture = null));
      num.addEventListener('change', () => this.setWeights(rebalance(this.current(), i, num.value)));
      num.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') num.blur();
      });
      this.weights.append(row);
      return { id: u.id, row, range, num, eff, effFill, was, seg };
    });
  }

  current() {
    const d = this.draft;
    return d ? d.weights.slice() : weightsOf(this.route);
  }

  setWeights(ws) {
    this.p.setDraft(this.id, ws);
    this.msg.hidden = true;
    this.renderWeights();
    if (!this.canary) this.renderCanary(null);
  }

  renderWeights() {
    const r = this.route;
    if (!r) return;
    const d = this.draft;
    const ws = this.current();
    const base = d ? weightsOf(d.baseRoute) : weightsOf(r);
    const single = this.rows.length < 2;
    const auto = !!r.auto_weight;
    const canary = this.canary;
    const locked = auto || single || !!(canary && (canary.status === 'running' || canary.status === 'rolling-back'));
    this.rows.forEach((x, i) => {
      const w = ws[i] ?? 0;
      if (String(w) !== x.range.value) x.range.value = String(w);
      if (x.num.value !== String(w)) x.num.value = String(w);
      x.range.style.setProperty('--p', `${w}%`);
      x.range.disabled = locked;
      x.num.disabled = locked;
      const changed = !!d && base[i] !== w;
      x.row.dataset.changed = String(changed);
      setText(x.was, changed ? `was ${base[i]}` : '');
      if (!auto) x.seg.style.flexGrow = String(w);
    });
    const dirty = !!d;
    this.node.dataset.dirty = String(dirty);
    this.applyBtn.disabled = !dirty;
    this.discardBtn.disabled = !dirty;
    this.evenBtn.disabled = locked;
    this.autoChk.disabled = dirty || single || !!canary;
    this.autoToggle.title = single ? 'Needs two or more upstreams' : dirty ? 'Apply or discard the weight edit first' : canary ? 'Finish or roll back the canary first' : '';
    const stale = d && this.route && canon(this.route) !== d.base;
    if (auto) setText(this.wHead, 'live effective, set by the gateway');
    else if (stale) setText(this.wHead, 'changed elsewhere since you started; Apply will conflict');
    else if (dirty) setText(this.wHead, 'unsaved edit');
    else if (single) setText(this.wHead, 'single upstream');
    else setText(this.wHead, 'configured');
    this.wHead.dataset.tone = stale ? 'warn' : dirty ? 'edit' : auto ? 'auto' : '';
    if (auto && this.p.state.frame) this.live(this.p.state.frame);
  }

  live(f) {
    const w = (f.window && f.window.routes && f.window.routes[this.id]) || null;
    const rps = w ? w.rps || 0 : 0;
    const has = rps > 0;
    const set = (k, v, u, tone) => {
      setText(this.stat[k].v, v);
      setText(this.stat[k].u, u);
      this.stat[k].box.dataset.tone = tone || '';
    };
    const rp = fmtRate(rps, '').split(' ');
    set('rps', rp[0], '/s', has ? '' : 'idle');
    const errPct = has ? ((w.error_rps || 0) / rps) * 100 : null;
    set('err', has ? fmtPct(errPct) : '-', '', !has ? 'idle' : errPct > ERR_BAD ? 'err' : errPct > ERR_WARN ? 'warn' : 'ok');
    const p95 = has ? fmtMs(w.p95_ms).split(' ') : ['-', ''];
    set('p95', p95[0], p95[1] || '', !has ? 'idle' : w.p95_ms > P95_BAD ? 'err' : w.p95_ms > P95_WARN ? 'warn' : '');
    this.node.dataset.state = !has ? 'idle' : errPct > ERR_BAD || w.p95_ms > P95_BAD ? 'err' : errPct > ERR_WARN || w.p95_ms > P95_WARN ? 'warn' : 'ok';

    if (!this.route || !this.route.auto_weight) return;
    const eff = (f.weights && f.weights[this.id]) || {};
    const vals = this.rows.map((x) => eff[x.id] ?? 0);
    const total = vals.reduce((a, b) => a + b, 0);
    this.rows.forEach((x, i) => {
      const pct = total > 0 ? Math.round((vals[i] / total) * 100) : 0;
      x.effFill.style.width = `${pct}%`;
      x.eff.setAttribute('aria-valuenow', String(pct));
      x.seg.style.flexGrow = String(pct);
      if (document.activeElement !== x.num) x.num.value = String(pct);
      const baseW = this.route.upstreams[i] ? this.route.upstreams[i].weight : 0;
      setText(x.was, `base ${baseW}`);
      x.row.dataset.changed = 'false';
    });
  }

  busy(on) {
    this.node.toggleAttribute('data-busy', on);
    for (const b of [this.applyBtn, this.discardBtn, this.evenBtn]) if (on) b.disabled = true;
    this.autoChk.disabled = on || this.autoChk.disabled;
    if (!on) this.renderWeights();
  }

  error(text) {
    this.msg.textContent = '';
    this.msg.append(el('b', { text: 'Rejected: ' }), text || 'unknown error');
    this.msg.hidden = false;
  }

  flash(scroll) {
    this.node.classList.remove('rc-flash');
    void this.node.offsetWidth;
    this.node.classList.add('rc-flash');
    if (scroll) this.node.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
  }

  // ---- canary UI ----------------------------------------------------------------

  renderCanary(c) {
    const r = this.route;
    // The idle picker is rebuilt only when its inputs change, so an open
    // select keeps focus across config updates.
    const sig = !c && r ? `idle|${this.rowsKey}|${!!this.draft}` : '';
    if (sig && sig === this.canarySig) return;
    this.canarySig = sig;
    this.canaryBox.textContent = '';
    this.canaryBadge.hidden = !c || c.status === 'idle';
    this.node.dataset.canary = c ? c.status : 'none';
    this.canaryRefs = null;
    if (!r) return;
    if (!c) {
      if (r.upstreams.length < 2) {
        this.canaryBox.hidden = true;
        return;
      }
      this.canaryBox.hidden = false;
      // Default target: the upstream with the lowest weight.
      let target = r.upstreams[0].id;
      let low = Infinity;
      for (const u of r.upstreams) if (u.weight < low) [low, target] = [u.weight, u.id];
      const prev = this.canarySel && this.canarySel.value;
      const sel = el(
        'select',
        { class: 'rf-input rc-csel', name: `canary-${this.id}`, 'aria-label': `Canary target for ${this.id}` },
        r.upstreams.map((u) => el('option', { value: u.id, text: u.id })),
      );
      sel.value = prev && r.upstreams.some((u) => u.id === prev) ? prev : target;
      this.canarySel = sel;
      const go = el('button', { type: 'button', class: 'btn btn-sm btn-canary', text: 'Start canary' });
      go.disabled = !!this.draft;
      go.title = this.draft ? 'Apply or discard the weight edit first' : `Shift ${CANARY_STEPS.join(', ')}% to the target, one step every ${CANARY_STEP_MS / 1000}s`;
      go.addEventListener('click', () => this.p.startCanary(this.id, sel.value));
      this.canaryBox.append(el('span', { class: 'rc-clabel', text: 'Canary' }), el('span', { class: 'rc-chint', text: 'shift traffic to' }), sel, go);
      return;
    }
    this.canaryBox.hidden = false;
    const steps = el('ol', { class: 'rc-steps', 'aria-label': 'Canary steps' });
    CANARY_STEPS.forEach((pct, i) => {
      const state = i <= c.step ? 'done' : i === c.step + 1 && c.status === 'running' ? 'next' : 'todo';
      steps.append(el('li', { class: 'rc-step', 'data-s': state, 'aria-current': i === c.step ? 'step' : null }, el('span', { class: 'rc-step-dot', 'aria-hidden': 'true' }), el('span', { class: 'rc-step-v num', text: `${pct}%` })));
    });
    const fill = el('div', { class: 'rc-cbar-fill' });
    const bar = el('div', { class: 'rc-cbar' }, fill);
    const status = el('span', { class: 'rc-cstatus' });
    const dot = el('span', { class: 'rc-dot', 'aria-hidden': 'true' });
    dot.style.setProperty('--uc', colorFor(c.target));
    const head = el('div', { class: 'rc-chead' }, el('span', { class: 'rc-clabel', text: 'Canary' }), dot, el('b', { class: 'rc-ctarget', text: c.target }), status);
    const actions = el('div', { class: 'rc-cactions' });
    const rollback = el('button', { type: 'button', class: 'btn btn-danger btn-sm', text: c.status === 'rolling-back' ? 'Rolling back...' : 'Rollback' });
    rollback.disabled = c.status === 'rolling-back';
    rollback.addEventListener('click', () => this.p.rollback(this.id));
    actions.append(rollback);
    if (c.status === 'done' || c.status === 'failed') {
      actions.append(el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: c.status === 'done' ? 'Keep' : 'Dismiss', onclick: () => this.p.dismissCanary(this.id) }));
    }
    const cur = c.step >= 0 ? CANARY_STEPS[c.step] : 0;
    if (c.status === 'running') status.textContent = c.step < 0 ? `applying ${CANARY_STEPS[0]}%...` : `step ${c.step + 1} of ${CANARY_STEPS.length}, at ${cur}%`;
    else if (c.status === 'done') status.textContent = `complete, at 100%`;
    else if (c.status === 'rolling-back') status.textContent = 'restoring previous weights...';
    else status.textContent = c.error || 'stopped';
    status.dataset.tone = c.status === 'failed' ? 'err' : c.status === 'done' ? 'ok' : '';
    const prog = c.step < 0 ? 0 : (c.step / (CANARY_STEPS.length - 1)) * 100;
    fill.style.width = `${prog}%`;
    const next = el('span', { class: 'rc-cnext num' });
    this.canaryBox.append(head, steps, el('div', { class: 'rc-cfoot' }, bar, next, actions));
    this.canaryRefs = { next, fill, c };
    this.canaryCountdown(c);
    if (r) this.renderWeights();
  }

  canaryCountdown(c) {
    if (!this.canaryRefs || this.canaryRefs.c !== c) return;
    const { next, fill } = this.canaryRefs;
    if (c.status !== 'running' || c.step < 0 || c.step >= CANARY_STEPS.length - 1) {
      setText(next, '');
      return;
    }
    const left = Math.max(0, c.nextAt - Date.now());
    setText(next, `${CANARY_STEPS[c.step + 1]}% in ${Math.ceil(left / 1000)}s`);
    // Overall progress, advancing through the wait for the next step.
    const frac = 1 - left / CANARY_STEP_MS;
    fill.style.width = `${((c.step + frac) / (CANARY_STEPS.length - 1)) * 100}%`;
  }
}

// ---------------------------------------------------------------------------

class JsonEditor {
  constructor(p) {
    this.p = p;
    this.baseText = '';
    this.baseRev = null;
    this.area = el('textarea', { class: 'rj-text', name: 'config-json', id: 'routes-json-text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Active config JSON' });
    this.rev = el('span', { class: 'rj-rev num' });
    this.note = el('span', { class: 'rj-note' });
    this.err = el('div', { class: 'rj-err', role: 'alert', hidden: true });
    this.applyBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Apply JSON' });
    this.formatBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Format' });
    this.reloadBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Reload' });
    this.node = el(
      'section',
      { class: 'rj', id: 'routes-json', hidden: true, 'aria-label': 'Config JSON editor' },
      el('div', { class: 'rj-head' }, el('span', { class: 'rj-title', text: 'Active config' }), this.rev, this.note),
      this.area,
      this.err,
      el('div', { class: 'rj-foot' }, el('span', { class: 'rj-hint', text: 'Edits are validated here and on the server, then applied as one new revision.' }), el('span', { class: 'rc-spacer' }), this.reloadBtn, this.formatBtn, this.applyBtn),
    );
    this.area.addEventListener('input', () => {
      this.err.hidden = true;
      this.sync();
    });
    this.reloadBtn.addEventListener('click', () => this.load(true));
    this.formatBtn.addEventListener('click', () => {
      try {
        this.area.value = JSON.stringify(JSON.parse(this.area.value), null, 2);
        this.err.hidden = true;
      } catch (e) {
        this.showErr(`Invalid JSON: ${e.message}`);
      }
      this.sync();
    });
    this.applyBtn.addEventListener('click', () => this.apply());
  }

  get dirty() {
    return this.area.value !== this.baseText;
  }

  setOpen(open) {
    this.node.hidden = !open;
    if (open) {
      this.load(!this.dirty);
      this.area.focus({ preventScroll: true });
      this.node.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
    }
  }

  load(replaceText) {
    const { config, configRevision } = this.p.state;
    if (!config) return;
    this.baseText = JSON.stringify(config, null, 2);
    this.baseRev = configRevision;
    if (replaceText) {
      this.area.value = this.baseText;
      this.err.hidden = true;
    }
    this.sync();
  }

  onConfig(state) {
    if (this.node.hidden) return;
    if (!this.dirty) this.load(true);
    else this.sync(state.configRevision);
  }

  sync(liveRev = this.p.state.configRevision) {
    setText(this.rev, `rev ${this.baseRev ?? '-'}`);
    const stale = this.dirty && liveRev != null && liveRev !== this.baseRev;
    if (stale) setText(this.note, `Config is now rev ${liveRev}. Applying will conflict; Reload discards your edits.`);
    else setText(this.note, this.dirty ? 'unsaved edits' : 'in sync');
    this.note.dataset.tone = stale ? 'warn' : this.dirty ? 'edit' : 'ok';
    this.applyBtn.disabled = !this.dirty;
  }

  showErr(text) {
    this.err.textContent = text;
    this.err.hidden = false;
  }

  async apply() {
    this.err.hidden = true;
    let cfg;
    try {
      cfg = JSON.parse(this.area.value);
    } catch (e) {
      this.showErr(`Invalid JSON: ${e.message}`);
      return;
    }
    const problem = configError(cfg);
    if (problem) {
      this.showErr(problem);
      return;
    }
    this.applyBtn.disabled = true;
    try {
      const res = await this.p.put(cfg, this.baseRev);
      this.load(true);
      toast(`Config JSON applied (rev ${res.new_revision})`, 'success');
    } catch (e) {
      if (e.conflict) {
        await this.p.conflict('Your JSON edits are kept: Apply again to replace the new config with them.');
        // Rebase so a deliberate second Apply goes through.
        const keep = this.area.value;
        this.load(false);
        this.area.value = keep;
        this.showErr(`Rebased on rev ${this.baseRev}. Check the routes panel for what changed, then Apply again or Reload.`);
      } else if (e.status === 400) this.showErr(`Server rejected the config: ${e.error}`);
      else this.showErr(e.message);
    } finally {
      this.sync();
    }
  }
}
