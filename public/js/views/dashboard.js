'use strict';
/* Dashboard: hero stat cards, quick actions, live charts, service health, hosting summary */
window.DashboardView = (() => {
  let socket = null;
  let cpuChart = null;
  let ramChart = null;

  const meterClass = (pct) => (pct > 90 ? 'meter danger' : pct > 75 ? 'meter warn' : 'meter');
  const el = (id) => document.getElementById(id);

  function heroCard(id, label, icon, iconCls) {
    return ui.el('div', { class: 'stat-card' },
      ui.el('div', { class: 'stat-head' },
        ui.el('span', { class: 'stat-icon ' + (iconCls || '') }, icon),
        ui.el('div', { class: 'stat-label' }, label)
      ),
      ui.el('div', { class: 'stat-value', id: `${id}-value` }, '–'),
      ui.el('div', { class: 'stat-sub', id: `${id}-sub` }, ''),
      ui.el('div', { class: 'meter', id: `${id}-meter` }, ui.el('div', { style: 'width:0%' }))
    );
  }

  function setStat(id, value, sub, pct) {
    const v = el(`${id}-value`); if (!v) return;
    v.textContent = value;
    el(`${id}-sub`).textContent = sub;
    const meter = el(`${id}-meter`);
    if (pct == null) { meter.style.display = 'none'; return; }
    meter.style.display = '';
    meter.className = meterClass(pct);
    meter.firstElementChild.style.width = Math.min(100, pct) + '%';
  }

  /* Chart colours come from the CSS custom properties rather than literals. They
   used to be hardcoded to a light grey, which is right on the dark theme and
   close to invisible on the light one. */
  function chartColors() {
    const cs = getComputedStyle(document.documentElement);
    return {
      tick: (cs.getPropertyValue('--text-dim') || '#93a3bd').trim(),
      grid: (cs.getPropertyValue('--border') || 'rgba(148,163,184,.1)').trim()
    };
  }

  function makeChart(ctx, label, color) {
    const c = chartColors();
    return new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [{ label, data: [], borderColor: color, backgroundColor: color + '22', fill: true, tension: 0.35, pointRadius: 0 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        scales: {
          y: { min: 0, max: 100, ticks: { color: c.tick }, grid: { color: c.grid } },
          x: { display: false }
        },
        plugins: { legend: { labels: { color: c.tick } } }
      }
    });
  }

  /* Rebuild the charts when the theme changes, otherwise they keep the colours
   * they were created with and stay unreadable after a switch. */
  window.addEventListener('panel:theme', () => {
    if (!cpuChart || !ramChart) return;
    cpuChart.destroy();
    ramChart.destroy();
    cpuChart = makeChart(el('cpuChart'), 'CPU %', '#34d399');
    ramChart = makeChart(el('ramChart'), 'RAM %', '#22d3ee');
  });

  function pushPoint(chart, label, value) {
    chart.data.labels.push(label);
    chart.data.datasets[0].data.push(value);
    if (chart.data.labels.length > 40) { chart.data.labels.shift(); chart.data.datasets[0].data.shift(); }
    chart.update('none');
  }

  const QA = [
    { label: 'New Website', icon: '🌐', hash: '#/sites' },
    { label: 'Database', icon: '🗄️', hash: '#/databases' },
    { label: 'Files', icon: '📁', hash: '#/files' },
    { label: 'Services', icon: '⚙️', hash: '#/services', admin: true },
    { label: 'PHP', icon: '🐘', hash: '#/php', admin: true },
    { label: 'Cron Jobs', icon: '⏰', hash: '#/cron', admin: true },
    { label: 'Terminal', icon: '💻', hash: '#/terminal', admin: true },
    { label: 'Setup Wizard', icon: '🧩', hash: '#/setup', admin: true }
  ];

  /* The six services that matter most for a running site: the web server, the
   * PHP it executes, the database behind it and the mail path. The full list
   * lives on the Services page - the dashboard stays a glance, not an
   * inventory. */
  const DASHBOARD_SERVICES = [
    'Nginx', 'OpenLiteSpeed', 'MariaDB', 'PHP-FPM', 'Postfix', 'Dovecot'
  ];
  const DASHBOARD_SERVICE_COUNT = 6;

  const fmtSwap = (d) => (!d || !d.swapTotal
    ? 'none'
    : `${ui.fmtBytes(d.swapUsed)} / ${ui.fmtBytes(d.swapTotal)} (${Math.round((d.swapUsed / d.swapTotal) * 100)}%)`);

  /* Key services table: name and state only, capped at six. This is a
   * dashboard glance - stopping a service belongs on the Services page, where
   * there is room for the unit name, autostart state and confirmation. Keeping
   * the buttons here meant a stray click on a live dashboard could take the
   * web server down with no confirmation in between. */
  function renderKey(box, rows, me) {
    if (!box) return;
    box.innerHTML = '';

    const picked = [];
    for (const name of DASHBOARD_SERVICES) {
      const hit = rows.find((r) => r.name === name);
      if (hit) picked.push(hit);
    }
    /* If fewer than the cap are installed, top up from whatever else is
     * running so the card is not half empty on a minimal box. */
    for (const r of rows) {
      if (picked.length >= DASHBOARD_SERVICE_COUNT) break;
      if (r.found && !picked.includes(r)) picked.push(r);
    }
    const shown = picked.slice(0, DASHBOARD_SERVICE_COUNT);

    if (!shown.length) {
      box.appendChild(ui.el('span', { class: 'text-dim' }, 'No services found'));
      return;
    }

    const body = ui.el('tbody', {});
    for (const s of shown) {
      body.appendChild(ui.el('tr', {},
        ui.el('td', { title: s.desc || (s.found ? s.unit : 'not installed') },
          s.found ? s.name : ui.el('span', { class: 'text-dim' }, s.name)),
        ui.el('td', {},
          s.found ? ui.badge(s.active ? 'running' : s.state, s.active ? 'green' : 'red')
            : ui.badge('not installed', 'gray'))));
    }
    box.appendChild(ui.el('div', { class: 'table-wrap' },
      ui.el('table', {},
        ui.el('thead', {}, ui.el('tr', {},
          ui.el('th', {}, 'Service'), ui.el('th', {}, 'State'))),
        body)));
  }

  /* --------------------- cPanel applications grid -------------------- */
  /* cPanel's home screen is a grid of icon tiles, and recolouring the panel
   * without one leaves it looking like cPanel in name only. Built from the same
   * NAV data the sidebar uses, so it can never list a module this account
   * cannot actually open, and it is only added under the cPanel theme - the
   * default dashboard keeps its own layout. */
  function isCpanel() {
    return (window.__panelTheme && window.__panelTheme.current()) === 'cpanel';
  }

  function cpanelApps(me) {
    const nav = (window.__panelNav && window.__panelNav()) || null;
    if (!nav) return null;
    const items = nav.filter((n) => n.id !== 'dashboard' && n.id !== 'mydashboard');

    const grid = ui.el('div', { class: 'cp-apps' });
    for (const n of items) {
      const b = ui.el('button', { class: 'cp-app', type: 'button' },
        ui.el('span', { class: 'cp-app-ico' }, n.icon),
        ui.el('span', { class: 'cp-app-body' },
          ui.el('span', { class: 'cp-app-title' }, n.label),
          ui.el('span', { class: 'cp-app-desc' }, n.sub || '')));
      b.onclick = () => { location.hash = '#/' + n.id; };
      grid.appendChild(b);
    }
    return ui.el('div', {},
      ui.el('div', { class: 'cp-section-title' }, 'Applications'),
      grid);
  }

  /* --------------------- movable layout (per user) ------------------- */
  /* Each block is a wrapper carrying data-block. The saved order is per
   * account, so two people can arrange the dashboard differently and neither
   * inherits the other's layout. Blocks the browser does not know about (an
   * older stored order, or a block added in a later release) are ignored
   * rather than rendered empty. */
  /* The five cards are one grid, so they are one draggable block - you cannot
   drag a card out of a row that has to stay in a line. A saved layout may
   still list the old 'system' block; applyOrder ignores ids it does not
   recognise, so that costs nothing and the band still renders. */
const DEFAULT_ORDER = ['stats', 'quick', 'band'];

  /* Removed from the dashboard at the operator's request.
   *
   * Flipping either flag back on restores the block, and everything that fed it
   * is still here - the builders, the chart setup and the services fetch are all
   * skipped by these same flags rather than deleted, so putting it back is a
   * one-line change rather than a reconstruction.
   *
   * They are flags rather than deletions because half of this file hangs off
   * them: the charts are built from canvases inside the band, and both
   * makeChart() and pushPoint() throw on a null context, so removing the markup
   * without guarding the runtime breaks every dashboard load. */
  const SHOW_QUICK_ACTIONS = false;
  const SHOW_METRICS_BAND = false;

  function block(id, node) {
    const w = ui.el('div', { 'data-block': id, class: 'dash-block' });
    w.appendChild(node);
    return w;
  }

  /* A drag grip in each block's corner. Only the grip starts a drag: the
   * blocks contain charts, buttons and tables, and making the whole block
   * draggable meant a click on a chart or a quick action began a reorder
   * instead of doing its job. */
  function addGrip(w, label) {
    const grip = ui.el('span', {
      class: 'dash-grip',
      draggable: 'true',
      title: `Drag to move "${label}" - the order is saved to your account`,
      'aria-label': `Move ${label}`
    }, '⠿');
    w.appendChild(grip);
    return grip;
  }

  function applyOrder(container, order) {
    const blocks = [...container.querySelectorAll(':scope > [data-block]')];
    if (!blocks.length) return;
    /* Known ids in the saved order first, then anything new appended after,
     * so adding a block in a future release does not hide it. */
    const byId = new Map(blocks.map((b) => [b.dataset.block, b]));
    const seq = [];
    for (const id of (Array.isArray(order) ? order : [])) {
      if (byId.has(id)) { seq.push(byId.get(id)); byId.delete(id); }
    }
    for (const b of blocks) if (byId.has(b.dataset.block)) seq.push(b);
    for (const b of seq) container.appendChild(b);
  }

  function currentOrder(container) {
    return [...container.querySelectorAll(':scope > [data-block]')].map((b) => b.dataset.block);
  }

  function enableDrag(container, onSaved) {
    let dragged = null;

    container.addEventListener('dragstart', (e) => {
      const grip = e.target.closest('.dash-grip');
      if (!grip) return;                       // only a grip drags
      dragged = grip.closest('[data-block]');
      if (!dragged) return;
      dragged.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox refuses to start a drag without payload.
      try { e.dataTransfer.setData('text/plain', dragged.dataset.block); } catch { /* older browsers */ }
    });

    container.addEventListener('dragend', () => {
      if (!dragged) return;
      dragged.classList.remove('dragging');
      container.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
      dragged = null;
      const order = currentOrder(container);
      onSaved(order);
    });

    container.addEventListener('dragover', (e) => {
      if (!dragged) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const over = e.target.closest('[data-block]');
      container.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
      if (!over || over === dragged || !container.contains(over)) return;
      const box = over.getBoundingClientRect();
      // Above or below the midpoint decides which half we drop onto.
      const after = (e.clientY - box.top) > box.height / 2;
      over.classList.add(after ? 'drop-after' : 'drop-before');
    });

    container.addEventListener('drop', (e) => {
      if (!dragged) return;
      e.preventDefault();
      const over = e.target.closest('[data-block]');
      container.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
      if (!over || over === dragged) return;
      const box = over.getBoundingClientRect();
      const after = (e.clientY - box.top) > box.height / 2;
      if (after) over.after(dragged); else over.before(dragged);
    });
  }

  async function render(root, me) {
    const info = await api.get('/stats/overview');

    /* ---------- hero stats ---------- */
    const cards = ui.el('div', { class: 'hero-grid' },
      heroCard('cpu', 'CPU', '🖥️', ''),
      heroCard('ram', 'Memory', '🧠', 'cyan'),
      heroCard('disk', 'Disk /', '💾', 'violet'),
      heroCard('net', 'Network', '🌐', 'amber')
    );

    /* ---------- quick actions ---------- */
    const actions = ui.el('div', { class: 'quick-actions' });
    for (const a of QA) {
      if (a.admin && me.role !== 'admin') continue;
      const b = ui.el('button', { class: 'qa-btn', type: 'button' },
        ui.el('span', { class: 'qa-ico' }, a.icon), a.label);
      b.onclick = () => { location.hash = a.hash; };
      actions.appendChild(b);
    }
    const actionsCard = ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Quick actions'), actions);

    /* ---------- one line of four ----------
     * System status leads, then the two live charts and Key services, sharing a
     * single grid row so they all come out the same size. The old fifth card
     * (Hosting stack) has gone; the "N active" total it carried moved into
     * Key services, which is the same subject, so nothing is lost that had
     * another sensible home. */
    const keyCard = ui.el('div', { class: 'card card-fill' },
      ui.el('h3', {}, 'Key services'),
      ui.el('p', { class: 'card-sub clamp' }, 'Manage all under Services'),
      ui.el('div', { class: 'key-svc-box', id: 'keySvcBox' },
        ui.el('span', { class: 'text-dim' }, 'Checking…')),
      ui.el('div', { class: 'svc-total', id: 'keySvcActive' }, ''));

    const s = info.static;
    const lv = info.live;

    /* Long values (the CPU model especially) are the only thing that cannot
     * fit a quarter of the screen, so they get a tooltip rather than being
     * truncated away. */
    const kv = (k, id, initial, cls) => [
      ui.el('dt', {}, k),
      ui.el('dd', { id, class: 'clamp' + (cls ? ' ' + cls : ''), title: String(initial == null ? '' : initial) },
        initial == null || initial === '' ? '–' : String(initial))
    ];

    const sysCard = ui.el('div', { class: 'card card-fill' },
      ui.el('h3', {}, 'System status'),
      ui.el('dl', { class: 'kv kv-tight' },
        ...kv('Host', null, s.hostname),
        ...kv('OS', null, `${s.distro} (${s.arch})`),
        ...kv('Kernel', null, s.kernel),
        ...kv('Cores', null, s.cores, 'mono'),
        ...kv('CPU', null, s.cpu, 'mono'),
        ...kv('IP', null, s.ip || '–', 'mono'),
        ...kv('Uptime', 'uptimeVal', ui.fmtUptime(lv.uptime)),
        ...kv('Load', 'sysLoad', String(lv.loadavg ?? '–')),
        ...kv('Memory', 'sysMem', lv.memTotal ? `${ui.fmtBytes(lv.memUsed)} / ${ui.fmtBytes(lv.memTotal)}` : '–'),
        ...kv('Swap', 'sysSwap', fmtSwap(lv))
      ));

    const band = ui.el('div', { class: 'grid band' },
      sysCard,
      ui.el('div', { class: 'card card-fill' },
        ui.el('h3', {}, 'CPU % (live)'),
        ui.el('div', { class: 'chart-box grow' }, ui.el('canvas', { id: 'cpuChart' }))),
      ui.el('div', { class: 'card card-fill' },
        ui.el('h3', {}, 'Memory % (live)'),
        ui.el('div', { class: 'chart-box grow' }, ui.el('canvas', { id: 'ramChart' }))),
      keyCard
    );

    const layout = ui.el('div', { id: 'dashLayout' });

    /* Where this panel is actually reachable from, above everything else.
     *
     * Worth having on the dashboard because the one thing you cannot do from
     * inside the panel is guess the address you are currently using: if it is
     * only on an IP and port, that address is the only way back in if something
     * goes wrong, and it is otherwise buried in Settings. Not a movable block -
     * it is context for the page, not one of the widgets - so it sits outside
     * the drag-and-drop area and cannot be dragged out of position. */
    const whereami = ui.el('div', { id: 'dashWhereami', style: 'margin-bottom:14px' });
    root.appendChild(whereami);
    api.get('/settings/panel').then((p) => {
      const scheme = p.ssl ? 'https' : 'http';
      const addr = p.domain
        ? `${scheme}://${p.domain}`
        : `${scheme}://${location.hostname}:${p.port}`;
      const notes = [];
      if (p.domain && p.sslRequested && !p.ssl) notes.push('SSL certificate not issued yet');
      else if (!p.domain) notes.push('no domain set — reachable by IP only');
      if (p.domain && p.dnsHint && /^no\b/.test(p.dnsHint)) notes.push(`DNS does not point here (${p.dnsHint})`);

      whereami.appendChild(ui.el('div', { class: 'card', style: 'padding:10px 14px' },
        ui.el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' },
          ui.el('span', { title: 'How to reach this panel' }, '🌐'),
          ui.el('strong', { class: 'mono', style: 'font-size:13px' }, addr),
          p.ssl ? ui.badge('https', 'green') : ui.badge('no tls', 'yellow'),
          notes.length ? ui.el('span', { class: 'text-dim', style: 'font-size:12px' }, notes.join(' · ')) : null,
          ui.el('a', {
            href: '#/settings', class: 'btn btn-sm',
            style: 'margin-left:auto;text-decoration:none'
          }, 'Settings'))));
    }).catch(() => {
      /* Non-admin, or the panel endpoint is unavailable: say nothing rather
       * than showing an empty strip above the dashboard. */
      whereami.remove();
    });

    const reset = ui.el('button', { class: 'btn btn-sm', title: 'Put the blocks back in their default order' }, '↺ Reset layout');
    reset.onclick = async () => {
      try {
        await api.put('/settings/prefs', { dashboardOrder: [] });
        applyOrder(layout, DEFAULT_ORDER);
        ui.toast('Dashboard layout reset');
      } catch (e) { ui.toast(e.message, true); }
    };

    const layoutBar = ui.el('div', {
      class: 'dash-layout-bar',
      title: 'This layout belongs to your account only'
    },
      ui.el('span', { class: 'text-dim', style: 'flex:1' },
        'Drag the ⠿ handle on any block to rearrange your dashboard'),
      reset);

    layout.append(block('stats', cards));
    if (SHOW_QUICK_ACTIONS) layout.append(block('quick', actionsCard));
    if (SHOW_METRICS_BAND) layout.append(block('band', band));

    /* cPanel's icon grid leads the page, above the metrics, which is where
     * cPanel puts it. Not a movable block: it is the theme's identity rather
     * than one of the dashboard's widgets. */
    if (isCpanel()) {
      const apps = cpanelApps(me);
      if (apps) layout.insertBefore(apps, layout.firstChild);
    }

    root.append(layout, layoutBar);

    /* Give every block a grip, then restore this account's saved order. */
    const LABELS = { stats: 'Server stats', quick: 'Quick actions', band: 'Live metrics, services and system' };
    for (const w of layout.querySelectorAll(':scope > [data-block]')) {
      addGrip(w, LABELS[w.dataset.block] || w.dataset.block);
    }
    enableDrag(layout, async (order) => {
      try {
        await api.put('/settings/prefs', { dashboardOrder: order });
        ui.toast('Dashboard layout saved to your account');
      } catch (e) { ui.toast('Could not save the layout: ' + e.message, true); }
    });
    try {
      const prefs = await api.get('/settings');
      applyOrder(layout, (prefs.prefs && prefs.prefs.dashboardOrder) || DEFAULT_ORDER);
    } catch { applyOrder(layout, DEFAULT_ORDER); }

    /* Update notice, pinned above the rearrangeable area so a pending update
     * cannot be dragged out of sight. */
    if (window.UpdatesView) {
      UpdatesView.banner(me).then((b) => { if (b) root.insertBefore(b, layout); });
    }

    /* Only when the band is actually on the page: the canvases live inside it,
     * and new Chart(null) throws. */
    if (SHOW_METRICS_BAND) {
      cpuChart = makeChart(el('cpuChart'), 'CPU %', '#34d399');
      ramChart = makeChart(el('ramChart'), 'RAM %', '#22d3ee');
    }

    const apply = (d) => {
      setStat('cpu', d.cpu + '%', `load ${d.loadavg}`, d.cpu);
      setStat('ram', d.memPct + '%', `${ui.fmtBytes(d.memUsed)} / ${ui.fmtBytes(d.memTotal)}`, d.memPct);
      setStat('disk', Math.round(d.diskPct) + '%', `${ui.fmtBytes(d.diskUsed)} / ${ui.fmtBytes(d.diskTotal)}`, d.diskPct);
      setStat('net', `↓ ${ui.fmtBytes(d.rxSec)}/s`, `↑ ${ui.fmtBytes(d.txSec)}/s · up ${ui.fmtUptime(d.uptime)}`, null);
      /* These values are clamped to one line, with the full text in the title
       attribute. Updating textContent alone would leave the tooltip showing
       whatever the value was at page load, so both are refreshed together. */
      const put = (id, text) => {
        const n = el(id);
        if (!n) return;
        n.textContent = text;
        n.title = text;
      };
      put('uptimeVal', ui.fmtUptime(d.uptime));
      put('sysLoad', String(d.loadavg ?? '–'));
      put('sysMem', d.memTotal ? `${ui.fmtBytes(d.memUsed)} / ${ui.fmtBytes(d.memTotal)} (${d.memPct}%)` : '–');
      put('sysSwap', fmtSwap(d));
      const t = new Date(d.ts).toLocaleTimeString();
      if (SHOW_METRICS_BAND) {
        pushPoint(cpuChart, t, d.cpu);
        pushPoint(ramChart, t, d.memPct);
      }
    };
    apply(info.live);

    socket = io('/stats');
    socket.on('stats', apply);

    /* ---------- async enrichment (services) ----------
     * Skipped entirely when the band is off the page. Key services only had
     * somewhere to render inside the band, and renderKey() writes into the box
     * unguarded - so asking for the list would fetch six services and six
     * button rows for a container that is not on the page. */
    if (!SHOW_METRICS_BAND) return;

    Promise.allSettled([
      api.get('/services'),
      api.get('/services/key')
    ]).then(([svc, key]) => {
      if (!root.isConnected) return;
      if (key.status === 'fulfilled') renderKey(el('keySvcBox'), key.value.services || [], me);
      /* The Hosting stack card is gone, so the site and database counts it
       * showed have no tile left to live in, and those requests are no longer
       * worth making for a number with nowhere to go. The "N active" total it
       * carried moved into Key services, which is the same subject - the old
       * health pills just repeated the six rows already on screen. */
      if (svc.status === 'fulfilled') {
        const total = el('keySvcActive');
        if (!total) return;
        const all = svc.value.services || [];
        const activeAll = all.filter((u) => u.active === 'active').length;
        total.textContent = `${activeAll} of ${all.length} system services active`;
        total.title = `${activeAll} active out of ${all.length} loaded units`;
      }
    });
  }

  function destroy() {
    if (socket) { socket.disconnect(); socket = null; }
    if (cpuChart) { cpuChart.destroy(); cpuChart = null; }
    if (ramChart) { ramChart.destroy(); ramChart = null; }
  }

  return { render, destroy };
})();
