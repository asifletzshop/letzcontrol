'use strict';
/* Shared UI helpers: toasts, modals, formatting */
window.ui = (() => {
  function toast(msg, isError = false) {
    const root = document.getElementById('toastRoot');
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  /** modal({ title, body, wide }) -> { el, close }. body is an HTMLElement. */
  function modal({ title, body, wide = false }) {
    const root = document.getElementById('modalRoot');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'modal' + (wide ? ' wide' : '');
    const h = document.createElement('h2');
    h.textContent = title;
    box.appendChild(h);
    box.appendChild(body);
    backdrop.appendChild(box);
    root.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
    return { el: box, close };
  }

  function confirmBox(message, { danger = true, okText = 'Confirm' } = {}) {
    return new Promise((resolve) => {
      const body = document.createElement('div');
      const p = document.createElement('p');
      p.textContent = message;
      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.textContent = 'Cancel';
      const ok = document.createElement('button');
      ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
      ok.textContent = okText;
      actions.append(cancel, ok);
      body.append(p, actions);
      const m = modal({ title: 'Please confirm', body });
      cancel.onclick = () => { m.close(); resolve(false); };
      ok.onclick = () => { m.close(); resolve(true); };
    });
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtBytes = (n) => {
    if (!n && n !== 0) return '-';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
  };

  const fmtUptime = (sec) => {
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
  };

  /** Returns a real badge element (safe to pass into ui.el as a child) */
  const badge = (text, color) => el('span', { class: `badge ${color || 'gray'}` }, String(text ?? ''));

  return { toast, modal, confirmBox, el, esc, fmtBytes, fmtUptime, badge };
})();
