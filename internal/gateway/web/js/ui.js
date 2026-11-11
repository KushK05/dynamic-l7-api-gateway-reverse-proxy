// Shared UI primitives: toasts, modal dialogs and popovers.

const TOAST_MS = 4000;
const LEVEL_ICON = { info: 'i', success: '✓', warn: '!', error: '✕' };

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

let toastStack = null;

// toast shows a message bottom-right for four seconds. level: info|success|warn|error.
export function toast(message, level = 'info') {
  if (!toastStack) {
    toastStack = el('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastStack);
  }
  const lvl = LEVEL_ICON[level] ? level : 'info';
  const t = el(
    'div',
    { class: `toast toast-${lvl}` },
    el('span', { class: 'toast-icon', 'aria-hidden': 'true', text: LEVEL_ICON[lvl] }),
    el('span', { class: 'toast-msg', text: message }),
  );
  const close = () => {
    if (!t.isConnected) return;
    t.classList.add('toast-out');
    setTimeout(() => t.remove(), 200);
  };
  t.addEventListener('click', close);
  toastStack.append(t);
  // Keep the stack short on a projector.
  while (toastStack.children.length > 5) toastStack.firstChild.remove();
  setTimeout(close, TOAST_MS);
  return close;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
}

// openModal shows a dialog with a title, a body node and action buttons
// [{label, kind: 'primary'|'danger'|'ghost', onClick(close)}]. Focus is trapped
// inside; Esc or a backdrop click closes it. Returns the close function.
export function openModal({ title, body, actions = [], onClose } = {}) {
  const prevFocus = document.activeElement;
  const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
    if (onClose) onClose();
  };
  const buttons = actions.map((a) =>
    el('button', {
      type: 'button',
      class: `btn btn-${a.kind || 'ghost'}`,
      text: a.label,
      onclick: () => (a.onClick ? a.onClick(close) : close()),
    }),
  );
  const dialog = el(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    el(
      'header',
      { class: 'modal-head' },
      el('h2', { id: titleId, text: title || '' }),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', text: '✕', onclick: close }),
    ),
    el('div', { class: 'modal-body' }, body || null),
    buttons.length ? el('footer', { class: 'modal-actions' }, buttons) : null,
  );
  const backdrop = el('div', { class: 'modal-backdrop' }, dialog);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const f = focusables(dialog);
    if (!f.length) {
      e.preventDefault();
      dialog.focus();
      return;
    }
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      e.preventDefault();
      first.focus();
    }
  }
  document.addEventListener('keydown', onKey, true);
  dialog.tabIndex = -1;
  document.body.append(backdrop);
  const f = focusables(dialog.querySelector('.modal-body'));
  (f[0] || buttons.find((b) => b.classList.contains('btn-primary')) || dialog).focus();
  return close;
}

let activePopover = null;

// openPopover shows node next to anchorRect (a DOMRect or {left, top, right,
// bottom}), kept inside the viewport. An outside click or Esc closes it; opening
// another popover closes the previous one. Returns the close function.
export function openPopover(anchorRect, node, { onClose } = {}) {
  if (activePopover) activePopover();
  const pop = el('div', { class: 'popover', role: 'dialog' }, node);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    pop.remove();
    if (activePopover === close) activePopover = null;
    if (onClose) onClose();
  };
  function onDown(e) {
    if (!pop.contains(e.target)) close();
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }
  document.body.append(pop);
  place(pop, anchorRect);
  // Defer so the click that opened the popover does not immediately close it.
  setTimeout(() => {
    if (closed) return;
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
  }, 0);
  activePopover = close;
  return close;
}

function place(pop, a) {
  const m = 8;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const r = pop.getBoundingClientRect();
  let left = a.left + ((a.right ?? a.left) - a.left) / 2 - r.width / 2;
  left = Math.max(m, Math.min(left, vw - r.width - m));
  let top = (a.bottom ?? a.top) + m;
  if (top + r.height > vh - m) {
    const above = a.top - r.height - m;
    top = above >= m ? above : Math.max(m, vh - r.height - m);
  }
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}
