// Route add/edit form, client-side validation that mirrors the server's
// Validate (internal/gateway/types.go), and the integer weight math shared with
// the route cards.

import { el, openModal } from './ui.js';
import { colorFor } from './format.js';

export const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
// Retries are only accepted for these methods (see hasNonIdempotent).
export const IDEMPOTENT = ['GET', 'HEAD', 'OPTIONS', 'TRACE'];
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

// ---------------------------------------------------------------------------
// Weight math. Weights are integers 0..100 that always total 100.

// distribute splits total into integers proportional to shares (largest
// remainder), or evenly when every share is 0. Earlier entries win ties.
export function distribute(total, shares) {
  const n = shares.length;
  if (!n) return [];
  const sum = shares.reduce((a, b) => a + Math.max(0, b), 0);
  const raw = shares.map((s) => (sum > 0 ? (total * Math.max(0, s)) / sum : total / n));
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0 && n; k = (k + 1) % n, left--) out[order[k][1]]++;
  return out;
}

// rebalance sets weights[idx] to value and spreads the rest of 100 over the
// other entries in proportion to their weights in base (evenly when they are
// all 0). Returns a new array.
export function rebalance(base, idx, value) {
  const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  if (base.length <= 1) return base.map(() => 100);
  const others = base.map((w, i) => (i === idx ? null : w)).filter((w) => w !== null);
  const spread = distribute(100 - v, others);
  let k = 0;
  return base.map((_, i) => (i === idx ? v : spread[k++]));
}

export function evenSplit(n) {
  return distribute(100, new Array(n).fill(0));
}

// nextPriority is the next free multiple of 10 below the lowest priority.
export function nextPriority(config) {
  const ps = ((config && config.routes) || []).map((r) => r.priority);
  if (!ps.length) return 100;
  return Math.floor((Math.min(...ps) - 1) / 10) * 10;
}

// ---------------------------------------------------------------------------
// Validation. Messages follow the server's wording where it has one.

export function validUpstreamURL(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.host !== '' && !u.username && !u.password && !u.search && !u.hash;
}

// routeErrors returns [{field, msg}] for one route. field names match the
// form's data-field keys; upstream errors use "up:<index>:<part>".
export function routeErrors(r) {
  const errs = [];
  const add = (field, msg) => errs.push({ field, msg });
  if (!SAFE_ID.test(r.id || '')) add('id', 'Use 1-64 letters, digits, ".", "_" or "-".');
  if (!Number.isInteger(r.priority)) add('priority', 'Priority must be a whole number.');
  const m = r.match || {};
  if (!m.path_prefix || !m.path_prefix.startsWith('/')) add('path_prefix', 'Path prefix must start with "/".');
  if (!Number.isInteger(r.timeout_ms) || r.timeout_ms < 1 || r.timeout_ms > 120000) add('timeout_ms', 'Timeout must be 1..120000 ms.');
  for (const meth of m.methods || []) {
    if (!meth || meth !== meth.toUpperCase()) add('methods', 'Methods must be uppercase.');
  }
  if (r.rewrite_prefix && (!r.rewrite_prefix.startsWith('/') || r.rewrite_prefix.includes('..'))) {
    add('rewrite_prefix', 'Rewrite must start with "/" and must not contain "..".');
  }
  if (r.retry_attempts < 0 || r.retry_attempts > 1) add('retry', 'Retry attempts must be 0 or 1.');
  if (r.retry_attempts > 0 && (!(m.methods || []).length || m.methods.some((x) => !IDEMPOTENT.includes(x)))) {
    add('retry', 'Retries need explicitly idempotent methods (GET, HEAD, OPTIONS, TRACE).');
  }
  for (const k of Object.keys(m.headers || {})) {
    if (!HEADER_NAME.test(k)) add('headers', `"${k}" is not a valid header name.`);
  }
  const ups = Array.isArray(r.upstreams) ? r.upstreams : [];
  if (!ups.length) add('upstreams', 'Add at least one upstream.');
  const seen = new Set();
  let sum = 0;
  ups.forEach((u, i) => {
    if (!SAFE_ID.test(u.id || '') || seen.has(u.id)) add(`up:${i}:id`, seen.has(u.id) ? 'Duplicate upstream.' : 'Invalid upstream ID.');
    seen.add(u.id);
    if (!validUpstreamURL(u.url || '')) add(`up:${i}:url`, 'Use an http(s) URL with a host, no credentials, query or fragment.');
    if (!Number.isInteger(u.weight) || u.weight < 0 || u.weight > 100) add(`up:${i}:weight`, 'Weight must be 0..100.');
    sum += Number.isInteger(u.weight) ? u.weight : 0;
  });
  if (ups.length && sum !== 100) add('weights', `Weights total ${sum}, they must total 100.`);
  return errs;
}

// configErrors checks the cross-route rules for a whole config, as the server
// does: version, at least one route, unique IDs and priorities, one URL per
// upstream ID. Returns the first error message, or ''.
export function configError(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'Config must be a JSON object.';
  if (c.version !== 1) return `unsupported config version ${c.version}`;
  if (!Array.isArray(c.routes) || !c.routes.length) return 'at least one route is required';
  const ids = new Set();
  const prios = new Set();
  const urls = new Map();
  for (const r of c.routes) {
    if (!r || typeof r !== 'object') return 'every route must be an object';
    if (!SAFE_ID.test(r.id || '') || ids.has(r.id)) return `route IDs must be safe, non-empty, and unique: "${r.id ?? ''}"`;
    ids.add(r.id);
    if (prios.has(r.priority)) return `route priority ${r.priority} is ambiguous`;
    prios.add(r.priority);
    const errs = routeErrors({ retry_attempts: 0, ...r });
    if (errs.length) return `route ${r.id}: ${errs[0].msg}`;
    for (const u of r.upstreams) {
      if (urls.has(u.id) && urls.get(u.id) !== u.url) return `upstream ID ${u.id} refers to more than one URL`;
      urls.set(u.id, u.url);
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Form

function field(label, input, { key, hint, wide } = {}) {
  return el(
    'label',
    { class: `rf-field${wide ? ' rf-wide' : ''}`, 'data-field': key },
    el('span', { class: 'rf-label', text: label }),
    input,
    hint ? el('span', { class: 'rf-hint', text: hint }) : null,
    el('span', { class: 'rf-err', role: 'alert' }),
  );
}

function toggle(label, sub, input) {
  return el(
    'label',
    { class: 'rf-toggle' },
    input,
    el('span', { class: 'rf-switch', 'aria-hidden': 'true' }),
    el('span', { class: 'rf-tl' }, el('span', { text: label }), sub ? el('small', { text: sub }) : null),
  );
}

const CUSTOM = '__custom__';

// openRouteForm shows the add or edit dialog. known is the getUpstreams()
// list, config the active config (for defaults and cross-route checks).
// onSubmit(route) resolves on success or throws an ApiError; a 400 is shown in
// the form, any other error is reported by the caller and keeps the form open.
export function openRouteForm({ mode, route, config, known = [], onSubmit }) {
  const editing = mode === 'edit';
  const r = route || {
    id: '',
    priority: nextPriority(config),
    match: { methods: ['GET'], path_prefix: '/api/' },
    timeout_ms: 4000,
    retry_attempts: 0,
    upstreams: [],
  };
  const m = r.match || {};
  const knownMap = new Map();
  for (const u of known) if (u.id && u.url) knownMap.set(u.id, u.url);
  for (const cr of (config && config.routes) || []) for (const u of cr.upstreams || []) if (!knownMap.has(u.id)) knownMap.set(u.id, u.url);

  const inp = (attrs) => el('input', { class: 'rf-input', ...attrs });
  const fId = inp({ type: 'text', name: 'id', value: r.id, maxlength: '64', spellcheck: 'false', autocomplete: 'off', readonly: editing, placeholder: 'orders' });
  const fPrio = inp({ type: 'number', name: 'priority', value: String(r.priority), step: '1', class: 'rf-input num' });
  const fPath = inp({ type: 'text', name: 'path_prefix', value: m.path_prefix || '', spellcheck: 'false', placeholder: '/api/orders' });
  const fRewrite = inp({ type: 'text', name: 'rewrite_prefix', value: r.rewrite_prefix || '', spellcheck: 'false', placeholder: 'optional, e.g. /v2' });
  const fHosts = inp({ type: 'text', name: 'hosts', value: (m.hosts || []).join(', '), spellcheck: 'false', placeholder: 'any host' });
  const fTimeout = inp({ type: 'number', name: 'timeout_ms', value: String(r.timeout_ms ?? 4000), min: '1', max: '120000', step: '1', class: 'rf-input num' });
  const fHeaders = el('textarea', { class: 'rf-input rf-textarea', name: 'headers', rows: '2', spellcheck: 'false', placeholder: 'X-Canary=true' });
  fHeaders.value = Object.entries(m.headers || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const fRetry = el('input', { type: 'checkbox', name: 'retry', class: 'rf-check' });
  fRetry.checked = (r.retry_attempts || 0) > 0;
  const fJwt = el('input', { type: 'checkbox', name: 'jwt', class: 'rf-check' });
  fJwt.checked = !!(r.jwt && r.jwt.required);
  const fAuto = el('input', { type: 'checkbox', name: 'auto_weight', class: 'rf-check' });
  fAuto.checked = !!r.auto_weight;

  const methodBoxes = METHODS.map((name) => {
    const cb = el('input', { type: 'checkbox', class: 'rf-mcheck', name: 'methods', value: name });
    cb.checked = (m.methods || []).includes(name);
    return { name, cb, node: el('label', { class: 'rf-method' }, cb, el('span', { text: name })) };
  });
  // Methods outside the checkbox set (TRACE, CONNECT) are kept as they are.
  const extraMethods = (m.methods || []).filter((x) => !METHODS.includes(x));
  const methods = () => [...methodBoxes.filter((b) => b.cb.checked).map((b) => b.name), ...extraMethods];
  const retryNote = el('small', {});
  const syncRetry = () => {
    const ms = methods();
    const ok = ms.length > 0 && ms.every((x) => IDEMPOTENT.includes(x));
    fRetry.disabled = !ok;
    if (!ok) fRetry.checked = false;
    retryNote.textContent = ok ? 'Retry once on another upstream' : 'Needs only GET, HEAD, OPTIONS or TRACE';
  };
  for (const b of methodBoxes) b.cb.addEventListener('change', syncRetry);

  // Upstream rows
  const rowsBox = el('div', { class: 'rf-ups' });
  const totalOut = el('span', { class: 'rf-total num' });
  const rows = [];
  const optionsFor = () => [
    ...[...knownMap.entries()].map(([id, url]) => {
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        /* keep raw */
      }
      return el('option', { value: id, text: `${id}  (${host})` });
    }),
    el('option', { value: CUSTOM, text: 'Custom upstream...' }),
  ];
  const syncTotal = () => {
    const sum = rows.reduce((a, row) => a + (parseInt(row.weight.value, 10) || 0), 0);
    totalOut.textContent = `Total ${sum}`;
    totalOut.dataset.ok = String(sum === 100);
  };
  const addRow = (u) => {
    const sel = el('select', { class: 'rf-input rf-select', name: 'upstream' }, optionsFor());
    const id = inp({ type: 'text', name: 'upstream_id', placeholder: 'id', spellcheck: 'false', class: 'rf-input rf-up-id' });
    const url = inp({ type: 'url', name: 'upstream_url', placeholder: 'http://host:port', spellcheck: 'false', class: 'rf-input rf-up-url' });
    const weight = inp({ type: 'number', name: 'upstream_weight', min: '0', max: '100', step: '1', class: 'rf-input rf-up-w num', 'aria-label': 'Weight' });
    const dot = el('span', { class: 'rf-dot', 'aria-hidden': 'true' });
    const urlText = el('span', { class: 'rf-up-urltext' });
    const err = el('span', { class: 'rf-err rf-up-err', role: 'alert' });
    const remove = el('button', { type: 'button', class: 'icon-btn rf-up-del', 'aria-label': 'Remove upstream', text: '✕' });
    const node = el('div', { class: 'rf-up' }, dot, sel, id, url, urlText, weight, remove, err);
    const row = { node, sel, id, url, weight, err };
    const sync = () => {
      const custom = sel.value === CUSTOM;
      node.dataset.custom = String(custom);
      id.hidden = url.hidden = !custom;
      urlText.hidden = custom;
      if (!custom) urlText.textContent = knownMap.get(sel.value) || '';
      dot.style.setProperty('--uc', custom ? 'var(--c-other)' : colorFor(sel.value));
    };
    if (u && knownMap.has(u.id) && knownMap.get(u.id) === u.url) sel.value = u.id;
    else if (u) {
      sel.value = CUSTOM;
      id.value = u.id;
      url.value = u.url;
    } else {
      const used = new Set(rows.map((x) => x.sel.value));
      const free = [...knownMap.keys()].find((k) => !used.has(k));
      sel.value = free || CUSTOM;
    }
    weight.value = String(u ? u.weight : 0);
    sel.addEventListener('change', sync);
    weight.addEventListener('input', syncTotal);
    remove.addEventListener('click', () => {
      rows.splice(rows.indexOf(row), 1);
      node.remove();
      syncTotal();
    });
    sync();
    rows.push(row);
    rowsBox.append(node);
    syncTotal();
    return row;
  };
  for (const u of r.upstreams || []) addRow(u);
  if (!rows.length) {
    addRow(null).weight.value = '100';
    syncTotal();
  }
  const btnAddUp = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '+ Add upstream', onclick: () => addRow(null).sel.focus() });
  const btnEven = el('button', {
    type: 'button',
    class: 'btn btn-ghost btn-sm',
    text: 'Even split',
    onclick: () => {
      evenSplit(rows.length).forEach((w, i) => (rows[i].weight.value = String(w)));
      syncTotal();
    },
  });

  const summary = el('div', { class: 'rf-summary', role: 'alert', hidden: true });
  const form = el(
    'form',
    { class: 'rf', novalidate: true },
    summary,
    el(
      'fieldset',
      { class: 'rf-sec' },
      el('legend', { text: 'Match' }),
      el(
        'div',
        { class: 'rf-grid' },
        field('Route ID', fId, { key: 'id', hint: editing ? 'IDs cannot be renamed' : null }),
        field('Priority', fPrio, { key: 'priority', hint: 'Higher matches first' }),
        el(
          'div',
          { class: 'rf-field rf-wide', 'data-field': 'methods' },
          el('span', { class: 'rf-label', text: 'Methods' }),
          el('div', { class: 'rf-methods', role: 'group', 'aria-label': 'Methods' }, methodBoxes.map((b) => b.node)),
          el('span', { class: 'rf-hint', text: 'None checked matches any method' }),
          el('span', { class: 'rf-err', role: 'alert' }),
        ),
        field('Path prefix', fPath, { key: 'path_prefix' }),
        field('Rewrite prefix', fRewrite, { key: 'rewrite_prefix' }),
        field('Hosts', fHosts, { key: 'hosts', hint: 'Comma separated' }),
        field('Timeout (ms)', fTimeout, { key: 'timeout_ms' }),
        field('Headers', fHeaders, { key: 'headers', hint: 'One key=value per line, all must match', wide: true }),
      ),
    ),
    el(
      'fieldset',
      { class: 'rf-sec' },
      el('legend', { text: 'Behavior' }),
      el(
        'div',
        { class: 'rf-toggles', 'data-field': 'retry' },
        toggle('Retry', null, fRetry),
        toggle('JWT required', 'Reject requests without a valid token', fJwt),
        toggle('Auto weight', 'Shift traffic away from slow or failing upstreams', fAuto),
        el('span', { class: 'rf-err', role: 'alert' }),
      ),
    ),
    el(
      'fieldset',
      { class: 'rf-sec', 'data-field': 'upstreams' },
      el('legend', { text: 'Upstreams' }),
      rowsBox,
      el('div', { class: 'rf-up-foot', 'data-field': 'weights' }, btnAddUp, btnEven, el('span', { class: 'rf-spacer' }), totalOut),
      el('span', { class: 'rf-err rf-err-block', role: 'alert' }),
    ),
  );
  // The retry toggle's subtitle reflects whether retries are allowed.
  fRetry.closest('.rf-toggle').querySelector('.rf-tl').append(retryNote);
  syncRetry();

  const build = () => {
    const hosts = fHosts.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const headers = {};
    const badLines = [];
    for (const line of fHeaders.value.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const i = t.indexOf('=');
      if (i <= 0) {
        badLines.push(t);
        continue;
      }
      headers[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    const match = { path_prefix: fPath.value.trim() };
    if (hosts.length) match.hosts = hosts;
    const ms = methods();
    if (ms.length) match.methods = ms;
    if (Object.keys(headers).length) match.headers = headers;
    const out = { id: fId.value.trim(), priority: Number(fPrio.value), match, timeout_ms: Number(fTimeout.value), retry_attempts: fRetry.checked ? 1 : 0 };
    const rw = fRewrite.value.trim();
    if (rw) out.rewrite_prefix = rw;
    if (fJwt.checked) out.jwt = { required: true };
    out.upstreams = rows.map((row) => {
      const custom = row.sel.value === CUSTOM;
      const id = custom ? row.id.value.trim() : row.sel.value;
      return { id, url: custom ? row.url.value.trim() : knownMap.get(id), weight: Number(row.weight.value) };
    });
    if (fAuto.checked) out.auto_weight = true;
    return { route: out, badLines };
  };

  const clearErrors = () => {
    summary.hidden = true;
    summary.textContent = '';
    for (const n of form.querySelectorAll('.rf-err')) n.textContent = '';
    for (const n of form.querySelectorAll('[data-invalid]')) n.removeAttribute('data-invalid');
  };
  const showSummary = (msg) => {
    summary.textContent = msg;
    summary.hidden = false;
    summary.scrollIntoView({ block: 'nearest' });
  };
  const showErrors = (errs) => {
    for (const { field: key, msg } of errs) {
      let box;
      if (key.startsWith('up:')) {
        const [, i, part] = key.split(':');
        const row = rows[Number(i)];
        if (!row) continue;
        box = row.err;
        (part === 'url' ? (row.sel.value === CUSTOM ? row.url : row.sel) : part === 'id' ? (row.sel.value === CUSTOM ? row.id : row.sel) : row.weight).setAttribute('data-invalid', '');
      } else {
        const host = form.querySelector(`[data-field="${key}"]`);
        if (!host) continue;
        box = host.querySelector(':scope > .rf-err') || host.parentElement.querySelector(':scope > .rf-err');
        const input = host.querySelector('.rf-input');
        if (input) input.setAttribute('data-invalid', '');
      }
      if (box && !box.textContent) box.textContent = msg;
    }
    showSummary(errs.length === 1 ? errs[0].msg : `Fix ${errs.length} problems before saving.`);
  };

  const validate = () => {
    const { route: out, badLines } = build();
    const errs = routeErrors(out);
    if (badLines.length) errs.push({ field: 'headers', msg: `Use key=value: "${badLines[0]}".` });
    const others = ((config && config.routes) || []).filter((x) => !(editing && x.id === r.id));
    if (others.some((x) => x.id === out.id)) errs.push({ field: 'id', msg: `Route "${out.id}" already exists.` });
    const clash = others.find((x) => x.priority === out.priority);
    if (clash) errs.push({ field: 'priority', msg: `Priority ${out.priority} is used by "${clash.id}".` });
    out.upstreams.forEach((u, i) => {
      for (const x of others) {
        const o = (x.upstreams || []).find((y) => y.id === u.id);
        if (o && o.url !== u.url) {
          errs.push({ field: `up:${i}:url`, msg: `"${u.id}" is ${o.url} in route "${x.id}".` });
          break;
        }
      }
    });
    return { out, errs };
  };

  let busy = false;
  const save = async (close) => {
    if (busy) return;
    clearErrors();
    const { out, errs } = validate();
    if (errs.length) {
      showErrors(errs);
      return;
    }
    busy = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      await onSubmit(out);
      close();
    } catch (e) {
      if (e && e.status === 400) showSummary(`Server rejected the route: ${e.error || e.message}`);
      else if (e && e.conflict) showSummary('The config changed while you were editing. Your changes are kept: review them and save again.');
      else showSummary(e && e.message ? e.message : 'Save failed.');
    } finally {
      busy = false;
      saveBtn.disabled = false;
      saveBtn.textContent = editing ? 'Save route' : 'Add route';
    }
  };

  const close = openModal({
    title: editing ? `Edit route ${r.id}` : 'Add route',
    body: form,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: editing ? 'Save route' : 'Add route', kind: 'primary', onClick: (c) => save(c) },
    ],
  });
  const modal = form.closest('.modal');
  modal.classList.add('modal-wide');
  const saveBtn = modal.querySelector('.modal-actions .btn-primary');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save(close);
  });
  // Enter in a text input submits, like a normal form.
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') {
      e.preventDefault();
      save(close);
    }
  });
  if (editing) fPath.focus();
  return close;
}
