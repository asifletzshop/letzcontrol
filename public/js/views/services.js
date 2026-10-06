'use strict';
/* Services view: systemd units with start/stop/restart/enable
 *
 * A bare Ubuntu box exposes ~140 service units (systemd-journald, udev, apt
 * daemons, getty per tty, cloud-init...), which buries the handful that
 * actually matter for a hosting panel. So the view opens on the KEY services
 * only - nginx, Apache, OpenLiteSpeed, MariaDB, PHP-FPM, mail, Docker, the
 * panel itself - and a button reveals the complete list for anyone who needs
 * to dig into the rest.
 */
window.ServicesView = (() => {
  let allServices = [];
  let showAll = false;      // false = key services only (the default)
  let rootEl = null;
  let searchEl = null;

  const visible = () => {
    const q = (searchEl ? searchEl.value : '').toLowerCase().trim();
    // Browsing "all" shows the RUNNING units only - that is the useful
    // overview on a box with ~170 units. But a search always looks through
    // every unit (running or not) so a stopped service can still be found and
    // started from here; otherwise those units would be unreachable.
    const pool = showAll && !q
      ? allServices.filter((s) => s.active === 'active')
      : showAll
        ? allServices
        : allServices.filter((s) => s.key);
    if (!q) return pool;
    return pool.filter((s) => s.unit.toLowerCase().includes(q) ||
      (s.description || '').toLowerCase().includes(q));
  };

  function renderTable(root) {
    const old = root.querySelector('.table-wrap');
    if (old) old.remove();
    const list = visible();
    if (!list.length) {
      const empty = ui.el('div', { class: 'card empty' },
        searchEl && searchEl.value ? 'No service matches that filter.' : 'No key services found.');
      root.appendChild(empty);
      updateToggle(root);
      return;
    }
    const rows = list.map((s) => {
      const name = s.unit.replace(/\.service$/, '');
      return ui.el('tr', {},
        ui.el('td', { class: 'mono' },
          s.key ? ui.el('span', { class: 'svc-key-dot', title: 'Key service' }) : null,
          name),
        ui.el('td', {}, s.active === 'active' ? ui.badge('active', 'green')
          : s.active === 'failed' ? ui.badge('failed', 'red') : ui.badge(s.active, 'gray')),
        ui.el('td', { class: 'text-dim' }, s.sub),
        ui.el('td', { class: 'text-dim', style: 'white-space:normal;max-width:340px' }, s.description),
        ui.el('td', {},
          s.active !== 'active'
            ? ui.el('button', { class: 'btn btn-sm', onclick: () => act(root, name, 'start') }, '▶ Start')
            : ui.el('button', { class: 'btn btn-sm', onclick: () => act(root, name, 'stop') }, '⏹ Stop'),
          ' ',
          ui.el('button', { class: 'btn btn-sm', onclick: () => act(root, name, 'restart') }, '↻'),
          ' ',
          ui.el('button', { class: 'btn btn-sm', onclick: () => act(root, name, 'enable') }, 'Enable'),
          ' ',
          ui.el('button', { class: 'btn btn-sm', onclick: () => act(root, name, 'disable') }, 'Disable')
        )
      );
    });
    root.appendChild(ui.el('div', { class: 'table-wrap' },
      ui.el('table', {},
        ui.el('thead', {}, ui.el('tr', {},
          ui.el('th', {}, 'Service'), ui.el('th', {}, 'State'), ui.el('th', {}, 'Sub'),
          ui.el('th', {}, 'Description'), ui.el('th', {}, 'Actions'))),
        ui.el('tbody', {}, ...rows))));
    updateToggle(root);
  }

  /* The button that switches between the two modes, plus a live count so it
   * is obvious what clicking it will reveal. The count reflects the filter:
   * with a search active the table shows matches from every unit. */
  function updateToggle(root) {
    const btn = root.querySelector('#svc-toggle');
    if (!btn) return;
    const keyCount = allServices.filter((s) => s.key).length;
    const runningCount = allServices.filter((s) => s.active === 'active').length;
    const searching = (searchEl && searchEl.value.trim()) !== '';
    btn.textContent = showAll
      ? `★ Show key services only (${keyCount})`
      : `Show all running services (${searching ? allServices.length : runningCount})`;
    btn.classList.toggle('btn-primary', showAll);
    btn.setAttribute('aria-pressed', showAll ? 'true' : 'false');
  }

  async function act(root, name, action) {
    if (['stop', 'disable'].includes(action) &&
        !(await ui.confirmBox(`Really ${action} ${name}?`, { okText: action }))) return;
    try {
      const r = await api.post(`/services/${name}/action`, { action });
      ui.toast(r.ok ? `${name}: ${action} OK` : (r.output || 'Failed'), !r.ok);
      await refresh(root);
    } catch (e) { ui.toast(e.message, true); }
  }

  async function refresh(root) {
    const { services } = await api.get('/services');
    allServices = services;
    renderTable(root);
  }

  async function render(root) {
    rootEl = root;
    showAll = false; // always start on the key services
    searchEl = ui.el('input', { type: 'search', id: 'svc-search', placeholder: 'Filter services…' });
    searchEl.oninput = () => renderTable(root);

    const toggle = ui.el('button', { class: 'btn', id: 'svc-toggle' }, 'Show all running services');
    toggle.onclick = () => {
      showAll = !showAll;
      // a filter left over from the long list can hide everything in the
      // short one, which looks like an empty table for no reason
      renderTable(root);
    };

    root.appendChild(ui.el('div', { class: 'toolbar' },
      searchEl,
      toggle,
      ui.el('button', { class: 'btn', onclick: () => refresh(root) }, '↻ Refresh')
    ));
    const { services } = await api.get('/services');
    allServices = services;
    renderTable(root);
  }

  return { render };
})();