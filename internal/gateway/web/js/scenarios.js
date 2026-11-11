// One-click demo scenarios, shown inside the traffic panel: a canary rollout
// and fault injection on a chosen upstream. Each action goes through the
// admin API, which logs the matching event (and the feed marks the charts).

import { el, toast } from './ui.js';
import { getUpstreams, injectFault, resetFault } from './api.js';
import { startCanary } from './routes.js';

const SLOW_MS = 800;
const FLAKY_PERCENT = 30;
const KILL_STATUS = 503;

// canaryPlan picks the first route with two or more upstreams and, as the
// canary target, the upstream with the lowest current weight.
export function canaryPlan(config) {
  const routes = (config && config.routes) || [];
  const route = routes.find((r) => (r.upstreams || []).length >= 2);
  if (!route) return null;
  let target = route.upstreams[0];
  for (const u of route.upstreams) if (u.weight < target.weight) target = u;
  return { route: route.id, target: target.id };
}

export function initScenarios(root, store) {
  new Scenarios(root, store);
}

class Scenarios {
  constructor(root, store) {
    this.root = root;
    this.store = store;
    this.ids = [];
    this.busy = false;
    this.build();
    store.subscribe(({ type, state }) => {
      if (type === 'config') {
        this.paintCanary(state);
        this.refresh();
      }
    });
    this.paintCanary(store.getState());
    this.refresh();
  }

  build() {
    this.select = el('select', { class: 'sc-select', id: 'sc-upstream', name: 'scenario-upstream', 'aria-label': 'Target upstream for fault scenarios' });
    this.select.addEventListener('pointerdown', () => this.refresh());
    this.select.addEventListener('focus', () => this.refresh());
    const head = el('div', { class: 'sc-head' }, el('span', { class: 'sc-title', text: 'Scenarios' }), el('label', { class: 'sc-target', for: 'sc-upstream' }, el('span', { text: 'Upstream' }), this.select));

    this.canaryDesc = el('span', { class: 'sc-desc', text: '10, 25, 50, 100%' });
    this.buttons = {
      canary: this.button('canary', 'Canary rollout', this.canaryDesc, () => this.canary()),
      slow: this.button('slow', 'Slow upstream', `+${SLOW_MS} ms`, () => this.fault({ delay_ms: SLOW_MS, status: 0, unhealthy: false, error_rate_percent: 0 }, (id) => `Slow upstream: ${SLOW_MS} ms added to ${id}`)),
      flaky: this.button('flaky', 'Flaky upstream', `${FLAKY_PERCENT}% errors`, () => this.fault({ delay_ms: 0, status: 0, unhealthy: false, error_rate_percent: FLAKY_PERCENT }, (id) => `Flaky upstream: ${FLAKY_PERCENT}% errors on ${id}`)),
      kill: this.button('kill', 'Kill upstream', `unhealthy, ${KILL_STATUS}`, () => this.fault({ delay_ms: 0, status: KILL_STATUS, unhealthy: true, error_rate_percent: 0 }, (id) => `Killed upstream ${id}`)),
      reset: this.button('reset', 'Reset all faults', 'clear every upstream', () => this.resetAll()),
    };
    this.root.replaceChildren(head, el('div', { class: 'sc-grid' }, ...Object.values(this.buttons)));
  }

  button(kind, name, desc, onClick) {
    const d = desc instanceof Node ? desc : el('span', { class: 'sc-desc', text: desc });
    const b = el('button', { type: 'button', class: `sc-btn sc-${kind}` }, el('span', { class: 'sc-name', text: name }), d);
    b.addEventListener('click', onClick);
    return b;
  }

  async run(fn) {
    if (this.busy) return;
    this.busy = true;
    this.root.classList.add('sc-busy');
    try {
      await fn();
    } catch (e) {
      toast(e.error || e.message || 'Scenario failed', 'error');
    } finally {
      this.busy = false;
      this.root.classList.remove('sc-busy');
      this.refresh();
    }
  }

  paintCanary(state) {
    const plan = canaryPlan(state.config);
    const b = this.buttons.canary;
    b.disabled = !plan;
    b.title = plan ? `Shift traffic on "${plan.route}" to ${plan.target} in steps` : 'Needs a route with two or more upstreams';
    this.canaryDesc.textContent = plan ? `${plan.target} on ${plan.route}` : 'needs 2+ upstreams';
  }

  async canary() {
    const plan = canaryPlan(this.store.getState().config);
    if (!plan) {
      toast('Canary needs a route with two or more upstreams.', 'warn');
      return;
    }
    await this.run(() => startCanary(plan.route, plan.target));
  }

  selected() {
    const id = this.select.value;
    if (!id) toast('No upstream to target yet.', 'warn');
    return id;
  }

  async fault(body, message) {
    const id = this.selected();
    if (!id) return;
    await this.run(async () => {
      await injectFault(id, body);
      toast(message(id), body.unhealthy ? 'error' : 'warn');
    });
  }

  async resetAll() {
    await this.run(async () => {
      const list = await getUpstreams();
      const results = await Promise.allSettled(list.map((u) => resetFault(u.id)));
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed) toast(`Reset ${list.length - failed} of ${list.length} upstreams; ${failed} failed.`, 'error');
      else toast(`Faults cleared on ${list.length} upstream${list.length === 1 ? '' : 's'}.`, 'success');
    });
  }

  async refresh() {
    if (this.loading) return;
    this.loading = true;
    try {
      const list = await getUpstreams();
      const ids = list.map((u) => u.id);
      if (ids.join('\u0000') === this.ids.join('\u0000')) return;
      this.ids = ids;
      const keep = this.select.value;
      this.select.replaceChildren(...ids.map((id) => el('option', { value: id, text: id })));
      if (ids.includes(keep)) this.select.value = keep;
      for (const k of ['slow', 'flaky', 'kill', 'reset']) this.buttons[k].disabled = ids.length === 0;
    } catch {
      // keep the previous list; the next refresh retries
    } finally {
      this.loading = false;
    }
  }
}
