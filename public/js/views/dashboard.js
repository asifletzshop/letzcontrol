'use strict';
/* Dashboard: hero stats with sparklines, a live performance panel, website
 * health, service health and system information.
 *
 * Everything here reads its colours from the CSS custom properties rather
 * than from literals, so the cPanel theme gets its own palette for free -
 * the same reason the charts here had to be rebuilt on a theme change. */
window.DashboardView = (() => {
  let socket = null;
  const charts = {};      // id -> Chart.js instance
  const sparks = {};      // id -> number[] of recent samples
  const HISTORY = 40;

  const el = (id) => document.getElementById(id);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /* The load average arrives as an array [1m, 5m, 15m]; a number is accepted
   * too, so the panel keeps working if the shape ever changes. */
  function load1(d) {
    const l = d.loadavg;
    if (Array.isArray(l)) return Number(l[0]) || 0;
    return Number(l) || 0;
  }

  /* Colours from the stylesheet, so a theme switch is all it takes. */
  function palette() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (cs.getPropertyValue(name) || fallback).trim();
    return {
      text: v('--text', '#e9eef8'),
      dim: v('--text-dim', '#93a3bd'),
      grid: v('--border', 'rgba(148,163,184,.14)'),
      accent: v('--accent', '#34d399'),
      cyan: v('--accent-2', '#22d3ee'),
      violet: v('--violet', '#a78bfa'),
      amber: v('--amber', '#fbbf24'),
      danger: v('--danger', '#f87171')
    };
  }

  /* ------------------------------------------------------------------ */
  /* Sparklines                                                          */
  /* ------------------------------------------------------------------ */

  /* A sparkline is drawn by hand rather than with Chart.js: a Chart instance
   * per stat card is a canvas, a controller and an animation loop each, and
   * four of them update every two seconds for a shape that is two pixels
   * wide. Canvas is enough. */
  function drawSpark(canvas, values, color) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 220;
    const h = canvas.clientHeight || 38;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!values || values.length < 2) return;

    let min = Infinity;
    let max = -Infinity;
    for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
    /* A flat line would divide by zero; give it a hair of range so it draws
     * across the middle instead of collapsing onto an edge. */
    const span = (max - min) || 1;
    const pad = 3;
    const x = (i) => pad + (i * (w - pad * 2)) / (values.length - 1);
    const y = (val) => h - pad - ((val - min) / span) * (h - pad * 2);

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color + '3d');
    grad.addColorStop(1, color + '00');
    ctx.beginPath();
    ctx.moveTo(x(0), y(values[0]));
    values.forEach((v, i) => ctx.lineTo(x(i), y(v)));
    ctx.lineTo(x(values.length - 1), h);
    ctx.lineTo(x(0), h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x(0), y(values[0]));
    values.forEach((v, i) => ctx.lineTo(x(i), y(v)));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.7;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    /* The last point gets a dot, so the eye can find "now". */
    const lx = x(values.length - 1);
    const ly = y(values[values.length - 1]);
    ctx.beginPath();
    ctx.arc(lx, ly, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  /* A gauge for the server's overall health. */
  function drawRing(canvas, score, colour) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const size = canvas.clientWidth || 116;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 9;
    const lw = 8;
    const start = Math.PI * 0.75;
    const sweep = Math.PI * 1.5;

    ctx.lineCap = 'round';
    ctx.lineWidth = lw;
    ctx.strokeStyle = 'rgba(148,163,184,.16)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + sweep);
    ctx.stroke();

    ctx.strokeStyle = colour;
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + sweep * clamp(score, 0, 100) / 100);
    ctx.stroke();
  }

  /* ------------------------------------------------------------------ */
  /* Stat cards                                                          */
  /* ------------------------------------------------------------------ */

  function heroCard(id, label, icon, tone) {
    return ui.el('div', { class: 'stat-card tone-' + tone },
      ui.el('div', { class: 'stat-head' },
        ui.el('span', { class: 'stat-icon' }, icon),
        ui.el('div', { class: 'stat-label' }, label)),
      ui.el('div', { class: 'stat-value', id: `${id}-value` }, '–'),
      ui.el('div', { class: 'stat-sub', id: `${id}-sub` }, ''),
      ui.el('div', { class: 'stat-spark' }, ui.el('canvas', { id: `${id}-spark` })),
      ui.el('div', { class: 'meter', id: `${id}-meter` }, ui.el('div', { style: 'width:0%' }))
    );
  }

  const meterClass = (pct) => (pct > 90 ? 'meter danger' : pct > 75 ? 'meter warn' : 'meter');

  function setStat(id, value, sub, pct) {
    const v = el(`${id}-value`);
    if (!v) return;
    v.textContent = value;
    const s = el(`${id}-sub`);
    if (s) s.textContent = sub || '';
    const meter = el(`${id}-meter`);
    if (!meter) return;
    if (pct == null) { meter.style.display = 'none'; return; }
    meter.style.display = '';
    meter.className = meterClass(pct);
    meter.firstElementChild.style.width = clamp(pct, 0, 100) + '%';
  }

  /* ------------------------------------------------------------------ */
  /* Charts                                                              */
  /* ------------------------------------------------------------------ */

  function makeChart(id, label, colour, opts = {}) {
    const p = palette();
    const canvas = el(id);
    if (!canvas) return null;
    const c = new Chart(canvas, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label,
          data: [],
          borderColor: colour,
          backgroundColor: colour + '22',
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          borderWidth: 2,
          ...opts.dataset
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { intersect: false, mode: 'index' },
        scales: {
          y: {
            min: opts.min, max: opts.max,
            ticks: { color: p.dim, maxTicksLimit: 4, font: { size: 10 } },
            grid: { color: p.grid, drawTicks: false }
          },
          x: { display: false }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(8,12,22,.94)',
            borderColor: 'rgba(148,163,184,.25)',
            borderWidth: 1,
            titleColor: p.text,
            bodyColor: p.dim,
            padding: 8,
            displayColors: false
          }
        }
      }
    });
    charts[id] = c;
    return c;
  }

  /* Rebuild the charts when the theme changes, otherwise they keep the
   * colours they were created with and stay unreadable after a switch. */
  window.addEventListener('panel:theme', () => {
    for (const id of Object.keys(charts)) {
      const c = charts[id];
      if (!c) continue;
      c.destroy();
      delete charts[id];
    }
    buildCharts();
    for (const id of Object.keys(sparks)) drawSpark(el(`${id}-spark`), sparks[id], sparkColour(id));
    const score = el('healthScore');
    if (score) drawRing(el('healthRing'), Number(score.dataset.score || 0), healthColour(Number(score.dataset.score || 0)));
  });

  function pushPoint(id, label, value) {
    const c = charts[id];
    if (!c) return;
    c.data.labels.push(label);
    c.data.datasets[0].data.push(value);
    if (c.data.labels.length > HISTORY) {
      c.data.labels.shift();
      c.data.datasets[0].data.shift();
    }
    c.update('none');
  }

  function buildCharts() {
    const p = palette();
    makeChart('cpuChart', 'CPU %', p.accent, { min: 0, max: 100 });
    makeChart('ramChart', 'Memory %', p.cyan, { min: 0, max: 100 });
    makeChart('netChart', 'Network', p.violet, { min: 0 });
  }

  const SPARK_COLOURS = {
    cpu: () => palette().accent,
    ram: () => palette().cyan,
    disk: () => palette().violet,
    net: () => palette().amber
  };
  const sparkColour = (id) => (SPARK_COLOURS[id] || (() => palette().accent))();

  /* ------------------------------------------------------------------ */
  /* Health score                                                        */
  /* ------------------------------------------------------------------ */

  /* A single number for "is this machine happy".
   *
   * Only the part above a comfortable baseline counts: a server sitting at
   * 30% CPU and 40% memory is not "30% unhealthy", it is a server with room
   * to spare. Counting everything from zero made an idle machine look
   * mediocre and a busy one look perfect, which is the opposite of useful.
   *
   * The weights are how much trouble each resource causes when it runs out -
   * CPU and memory first, disk and load behind them - and they add up to
   * one, so a machine at the top of every scale scores zero. */
  function healthScore(d) {
    const cores = d.cores || 1;
    const loadPct = clamp((load1(d) / cores) * 100, 0, 100);
    const COMFORT = 50;
    const over = (v, w) => Math.max(0, clamp(v, 0, 100) - COMFORT) * w;
    const score = 100 - (
      over(d.cpu, 0.40) +
      over(d.memPct, 0.35) +
      over(d.diskPct, 0.15) +
      over(loadPct, 0.10)
    );
    return Math.round(clamp(score, 0, 100));
  }

  function healthColour(score) {
    const p = palette();
    if (score >= 85) return p.accent;
    if (score >= 60) return p.amber;
    return p.danger;
  }

  /* ------------------------------------------------------------------ */
  /* Quick actions were removed at the operator's request.               */
  /* ------------------------------------------------------------------ */
  /* They were a row of buttons that did nothing but change the page -
   * every one of them opened a screen the sidebar already lists. The
   * dashboard is a glance at the state of the server, and a strip of
   * navigation dressed up as a feature was noise in the middle of it. The
   * tiles, and the CSS that went with them, have been left in place rather
   * than deleted, so putting them back is a one-line change. */

  /* ------------------------------------------------------------------ */
  /* Website cards                                                       */
  /* ------------------------------------------------------------------ */

  const HEALTH_DOT = { up: 'ok', error: 'warn', down: 'bad', disabled: 'idle', unknown: 'idle' };
  const HEALTH_TEXT = {
    up: 'responding', error: 'not responding', down: 'not responding',
    disabled: 'disabled', unknown: 'checking…'
  };

  function siteCard(s, health) {
    const dot = ui.el('span', { class: 'dot ' + (HEALTH_DOT[health.status] || 'idle') });
    dot.title = HEALTH_TEXT[health.status] || health.status;
    if (health.ms) dot.title += ` · ${health.ms} ms`;

    const badges = ui.el('div', { class: 'site-badges' },
      ui.badge(s.backend, s.backend === 'nginx' ? 'green' : s.backend === 'node' ? 'gray' : 'blue'),
      s.phpVersion ? ui.badge('PHP ' + s.phpVersion, 'green') : null,
      s.ssl ? ui.badge('SSL', 'green') : ui.badge('no SSL', 'gray'),
      s.enabled === false ? ui.badge('disabled', 'red') : null);

    const open = ui.el('a', { class: 'site-open', href: `http://${s.domain}`, target: '_blank', rel: 'noopener' }, '↗');

    const manage = ui.el('a', { class: 'site-manage', href: '#/sites' }, 'Manage');

    return ui.el('div', { class: 'site-card' },
      ui.el('div', { class: 'site-top' },
        dot,
        ui.el('a', { class: 'site-domain', href: `http://${s.domain}`, target: '_blank', rel: 'noopener' }, s.domain),
        open),
      badges,
      ui.el('div', { class: 'site-foot' },
        ui.el('span', { class: 'text-dim' }, HEALTH_TEXT[health.status] || ''),
        manage));
  }

  function sitesCard(root, me) {
    const box = ui.el('div', { class: 'site-grid' });
    box.appendChild(ui.el('div', { class: 'text-dim' }, 'Checking your websites…'));
    const card = ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Your websites',
        ui.el('span', { class: 'spacer' }),
        ui.el('a', { class: 'btn btn-sm', href: '#/sites', style: 'text-decoration:none' }, 'Manage all')),
      box);

    Promise.allSettled([api.get('/sites'), api.get('/sites/health')]).then(([s, h]) => {
      if (!root.isConnected) return;
      box.innerHTML = '';
      if (s.status !== 'fulfilled') {
        box.appendChild(ui.el('div', { class: 'text-dim' }, 'Could not load the website list.'));
        return;
      }
      const sites = s.value.sites || [];
      if (!sites.length) {
        box.appendChild(ui.el('div', { class: 'text-dim' },
          'No websites yet. Use “New Website” above to add one.'));
        return;
      }
      const health = {};
      if (h.status === 'fulfilled') {
        for (const x of (h.value.sites || [])) health[x.id] = x;
      }
      for (const site of sites) {
        box.appendChild(siteCard(site, health[site.id] || { status: 'unknown' }));
      }
    });
    return card;
  }

  /* ------------------------------------------------------------------ */
  /* Services and system information                                    */
  /* ------------------------------------------------------------------ */

  const DASHBOARD_SERVICES = [
    'Nginx', 'OpenLiteSpeed', 'MariaDB', 'PHP-FPM', 'Postfix', 'Dovecot'
  ];

  function servicesCard(root) {
    const box = ui.el('div', { class: 'svc-list' }, ui.el('span', { class: 'text-dim' }, 'Checking…'));
    const card = ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Service health',
        ui.el('span', { class: 'spacer' }),
        ui.el('a', { class: 'btn btn-sm', href: '#/services', style: 'text-decoration:none' }, 'All services')),
      box);

    api.get('/services/key').then((r) => {
      if (!root.isConnected) return;
      box.innerHTML = '';
      const all = r.services || [];
      const picked = [];
      for (const name of DASHBOARD_SERVICES) {
        const hit = all.find((x) => x.name === name);
        if (hit) picked.push(hit);
      }
      for (const x of all) {
        if (picked.length >= DASHBOARD_SERVICES.length) break;
        if (x.found && !picked.includes(x)) picked.push(x);
      }
      if (!picked.length) {
        box.appendChild(ui.el('span', { class: 'text-dim' }, 'No services found'));
        return;
      }
      for (const s of picked) {
        const ok = s.found && s.active === 'active';
        box.appendChild(ui.el('div', { class: 'svc-row' },
          ui.el('span', { class: 'dot ' + (ok ? 'ok' : 'bad') }),
          ui.el('span', { class: 'svc-name' }, s.name),
          ui.el('span', { class: 'svc-state ' + (ok ? 'ok' : 'bad') },
            s.found ? (s.active === 'active' ? 'running' : (s.state || 'stopped')) : 'not installed')));
      }
    }).catch(() => {
      box.innerHTML = '';
      box.appendChild(ui.el('span', { class: 'text-dim' }, 'Service information is not available.'));
    });
    return card;
  }

  function systemCard(s, lv) {
    const rows = [
      ['🖥️', 'Host', s.hostname],
      ['💿', 'OS', `${s.distro} (${s.arch})`],
      ['🧩', 'Kernel', s.kernel],
      ['🧠', 'CPU', `${s.cores} cores · ${s.cpu}`],
      ['🌐', 'Public IP', s.ip || '–'],
      ['⏱️', 'Uptime', ui.fmtUptime(lv.uptime)],
      ['📈', 'Load average', Array.isArray(lv.loadavg) ? lv.loadavg.map((n) => Number(n).toFixed(2)).join('  ') : String(lv.loadavg ?? '–')],
      ['🧠', 'Memory', lv.memTotal ? `${ui.fmtBytes(lv.memUsed)} / ${ui.fmtBytes(lv.memTotal)}` : '–'],
      ['🔄', 'Swap', lv.swapTotal ? `${ui.fmtBytes(lv.swapUsed)} / ${ui.fmtBytes(lv.swapTotal)}` : 'not in use']
    ];
    const grid = ui.el('div', { class: 'sys-grid' });
    for (const [icon, label, value] of rows) {
      grid.appendChild(ui.el('div', { class: 'sys-item' },
        ui.el('span', { class: 'sys-ico' }, icon),
        ui.el('div', { class: 'sys-body' },
          ui.el('div', { class: 'sys-label' }, label),
          ui.el('div', { class: 'sys-value clamp', title: String(value == null ? '' : value) },
            value == null || value === '' ? '–' : String(value)))));
    }
    return ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'System'),
      grid);
  }

  /* ------------------------------------------------------------------ */
  /* Movable layout (per user)                                           */
  /* ------------------------------------------------------------------ */

  /* Each block is a wrapper carrying data-block. The saved order is per
   * account, so two people can arrange the dashboard differently and neither
   * inherits the other's layout. Blocks the browser does not know about (an
   * older stored order, or a block added in a later release) are ignored
   * rather than rendered empty. */
  const DEFAULT_ORDER = ['stats', 'perf', 'sites', 'ops'];

  function block(id, node) {
    const w = ui.el('div', { 'data-block': id, class: 'dash-block' });
    w.appendChild(node);
    return w;
  }

  /* A drag grip in each block's corner. Only the grip starts a drag: the
   * blocks contain charts, buttons and tables, and making the whole block
   * draggable meant a click on a chart or a button began a reorder
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

  /* ------------------------------------------------------------------ */
  /* cPanel application grid                                             */
  /* ------------------------------------------------------------------ */

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

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  async function render(root, me) {
    const info = await api.get('/stats/overview');
    const s = info.static;
    const lv = info.live;

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

      whereami.appendChild(ui.el('div', { class: 'card whereami' },
        ui.el('div', { class: 'whereami-in' },
          ui.el('span', { class: 'whereami-ico' }, '🌐'),
          ui.el('strong', { class: 'mono' }, addr),
          p.ssl ? ui.badge('https', 'green') : ui.badge('no tls', 'yellow'),
          notes.length ? ui.el('span', { class: 'text-dim whereami-note' }, notes.join(' · ')) : null,
          ui.el('a', {
            href: '#/settings', class: 'btn btn-sm',
            style: 'margin-left:auto;text-decoration:none'
          }, 'Settings'))));
    }).catch(() => {
      /* Non-admin, or the panel endpoint is unavailable: say nothing rather
       * than showing an empty strip above the dashboard. */
      whereami.remove();
    });

    /* ---------- hero stats ---------- */
    const cards = ui.el('div', { class: 'hero-grid' },
      heroCard('cpu', 'CPU', '🖥️', 'green'),
      heroCard('ram', 'Memory', '🧠', 'cyan'),
      heroCard('disk', 'Disk', '💾', 'violet'),
      heroCard('net', 'Network', '🌐', 'amber')
    );

    /* ---------- live performance ---------- */
    const perfCard = ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Live performance',
        ui.el('span', { class: 'spacer' }),
        ui.el('span', { class: 'text-dim card-sub', style: 'margin:0' }, 'updated every two seconds')),
      ui.el('div', { class: 'perf-grid' },
        ui.el('div', { class: 'perf-cell' },
          ui.el('div', { class: 'perf-title' }, 'CPU'),
          ui.el('div', { class: 'chart-box' }, ui.el('canvas', { id: 'cpuChart' }))),
        ui.el('div', { class: 'perf-cell' },
          ui.el('div', { class: 'perf-title' }, 'Memory'),
          ui.el('div', { class: 'chart-box' }, ui.el('canvas', { id: 'ramChart' }))),
        ui.el('div', { class: 'perf-cell' },
          ui.el('div', { class: 'perf-title' }, 'Network'),
          ui.el('div', { class: 'chart-box' }, ui.el('canvas', { id: 'netChart' })))),
      ui.el('div', { class: 'health-row' },
        ui.el('div', { class: 'health-ring' }, ui.el('canvas', { id: 'healthRing' })),
        ui.el('div', { class: 'health-body' },
          ui.el('div', { class: 'health-score', id: 'healthScore' }, '–'),
          ui.el('div', { class: 'health-label' }, 'Server health'),
          ui.el('div', { class: 'text-dim', id: 'healthNote' },
            'CPU, memory, disk and load, weighted by how much trouble each causes.'))));

    const layout = ui.el('div', { id: 'dashLayout' });

    const opsCard = ui.el('div', { class: 'ops-grid' },
      servicesCard(root),
      systemCard(s, lv));

    layout.append(block('stats', cards));
    layout.append(block('perf', perfCard));
    layout.append(block('sites', sitesCard(root, me)));
    layout.append(block('ops', opsCard));

    /* cPanel's icon grid leads the page, above the metrics, which is where
     * cPanel puts it. Not a movable block: it is the theme's identity rather
     * than one of the dashboard's widgets. */
    if (isCpanel()) {
      const apps = cpanelApps(me);
      if (apps) layout.insertBefore(apps, layout.firstChild);
    }

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

    root.append(layout, layoutBar);

    /* Give every block a grip, then restore this account's saved order. */
    const LABELS = {
      stats: 'Server stats', perf: 'Live performance',
      sites: 'Your websites', ops: 'Services and system'
    };
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

    buildCharts();

    /* ---------- the live values ---------- */
    const apply = (d) => {
      setStat('cpu', d.cpu + '%', `load ${load1(d).toFixed(2)}`, d.cpu);
      setStat('ram', d.memPct + '%', `${ui.fmtBytes(d.memUsed)} / ${ui.fmtBytes(d.memTotal)}`, d.memPct);
      setStat('disk', Math.round(d.diskPct) + '%', `${ui.fmtBytes(d.diskUsed)} / ${ui.fmtBytes(d.diskTotal)}`, d.diskPct);
      setStat('net', `↓ ${ui.fmtBytes(d.rxSec)}/s`, `↑ ${ui.fmtBytes(d.txSec)}/s · up ${ui.fmtUptime(d.uptime)}`, null);

      /* Sparklines: the last few samples of each series, so the card shows
       * the shape of the last minute rather than a single number. */
      for (const [id, value] of [['cpu', d.cpu], ['ram', d.memPct], ['disk', d.diskPct], ['net', d.rxSec + d.txSec]]) {
        const arr = sparks[id] || (sparks[id] = []);
        arr.push(Number(value) || 0);
        if (arr.length > HISTORY) arr.shift();
        drawSpark(el(`${id}-spark`), arr, sparkColour(id));
      }

      const score = healthScore({ ...d, cores: s.cores });
      const scoreEl = el('healthScore');
      if (scoreEl) {
        scoreEl.textContent = score + '%';
        scoreEl.dataset.score = score;
        scoreEl.style.color = healthColour(score);
      }
      const note = el('healthNote');
      if (note) {
        const worst = [
          ['CPU', d.cpu], ['memory', d.memPct], ['disk', d.diskPct]
        ].sort((a, b) => b[1] - a[1])[0];
        note.textContent = score >= 85
          ? 'Everything is comfortable. CPU, memory, disk and load all have room.'
          : `The tightest resource is ${worst[0]} at ${Math.round(worst[1])}%.`;
      }
      drawRing(el('healthRing'), score, healthColour(score));

      const t = new Date(d.ts).toLocaleTimeString();
      pushPoint('cpuChart', t, d.cpu);
      pushPoint('ramChart', t, d.memPct);
      pushPoint('netChart', t, (d.rxSec + d.txSec) / 1024);
    };
    apply(info.live);

    socket = io('/stats');
    socket.on('stats', apply);
  }

  function destroy() {
    if (socket) { socket.disconnect(); socket = null; }
    for (const id of Object.keys(charts)) {
      if (charts[id]) charts[id].destroy();
      delete charts[id];
    }
    for (const id of Object.keys(sparks)) delete sparks[id];
  }

  return { render, destroy };
})();
