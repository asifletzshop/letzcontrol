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

  function makeChart(ctx, label, color) {
    return new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [{ label, data: [], borderColor: color, backgroundColor: color + '22', fill: true, tension: 0.35, pointRadius: 0 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        scales: {
          y: { min: 0, max: 100, ticks: { color: '#93a3bd' }, grid: { color: 'rgba(148,163,184,.1)' } },
          x: { display: false }
        },
        plugins: { legend: { labels: { color: '#93a3bd' } } }
      }
    });
  }

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

  /* key services we want health pills for, mapped to friendly names */
  const KEY_SERVICES = [
    ['nginx', 'Nginx'], ['openlitespeed', 'OpenLiteSpeed'], ['lsws', 'OpenLiteSpeed'], ['lshttpd', 'OpenLiteSpeed'],
    ['mariadb', 'MariaDB'], ['mysql', 'MySQL'], ['postfix', 'Postfix'], ['dovecot', 'Dovecot'],
    ['redis', 'Redis'], ['docker', 'Docker'], ['cron', 'Cron'], ['letzcontrol', 'letzControl'],
    ['php', 'PHP-FPM'], ['phpmyadmin', 'phpMyAdmin']
  ];

  const fmtSwap = (d) => (!d || !d.swapTotal
    ? 'none'
    : `${ui.fmtBytes(d.swapUsed)} / ${ui.fmtBytes(d.swapTotal)} (${Math.round((d.swapUsed / d.swapTotal) * 100)}%)`);

  /* Key services table: status + start/stop/restart/autostart for admins,
   * read-only for everyone else; missing servers link to their installer. */
  function renderKey(box, rows, me) {
    if (!box) return;
    const admin = me.role === 'admin';
    box.innerHTML = '';
    const body = ui.el('tbody', {});
    for (const s of rows) {
      const actions = ui.el('td', {});
      if (!s.found) {
        if (admin) {
          const target = ['Nginx', 'Apache', 'OpenLiteSpeed'].includes(s.name) ? '#/servers'
            : (s.name === 'MariaDB' || s.name === 'PHP-FPM') ? '#/setup' : '#/addons';
          const b = ui.el('button', { class: 'btn btn-sm' }, '⬇ Install');
          b.onclick = () => { location.hash = target; };
          actions.appendChild(b);
        } else actions.textContent = '—';
      } else if (admin) {
        const doAct = async (action) => {
          try {
            const r = await api.post(`/services/${encodeURIComponent(s.unit)}/action`, { action });
            ui.toast(r.ok ? `${s.name}: ${action} ✓` : (r.output || 'failed'), !r.ok);
          } catch (e) { ui.toast(e.message, true); }
          try {
            const fresh = await api.get('/services/key');
            renderKey(box, fresh.services || [], me);
          } catch { /* keep current rows */ }
        };
        const mk = (label, title, action) => {
          const b = ui.el('button', { class: 'btn btn-sm', title }, label);
          b.onclick = () => doAct(action);
          actions.append(b, ' ');
        };
        if (s.active) { mk('⏸', 'Stop', 'stop'); mk('↻', 'Restart', 'restart'); }
        else mk('▶', 'Start', 'start');
        mk(s.enabled ? '⏻ Disable' : '⏻ Enable', s.enabled ? 'Disable autostart' : 'Enable autostart', s.enabled ? 'disable' : 'enable');
      } else actions.textContent = '—';

      body.appendChild(ui.el('tr', {},
        ui.el('td', { title: s.desc || '' }, s.found ? s.name : ui.el('span', { class: 'text-dim' }, s.name)),
        ui.el('td', {}, s.found ? ui.badge(s.active ? 'running' : s.state, s.active ? 'green' : 'red') : ui.badge('not installed', 'gray')),
        ui.el('td', {}, s.found ? ui.badge(s.enabled ? 'enabled' : s.enabledState, s.enabled ? 'green' : 'gray') : ''),
        actions));
    }
    box.appendChild(ui.el('div', { class: 'table-wrap' },
      ui.el('table', {},
        ui.el('thead', {}, ui.el('tr', {},
          ui.el('th', {}, 'Service'), ui.el('th', {}, 'State'),
          ui.el('th', {}, 'Startup'), ui.el('th', {}, 'Actions'))),
        body)));
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
    const actionsCard = ui.el('div', { class: 'card', style: 'margin-top:16px' },
      ui.el('h3', {}, 'Quick actions'), actions);

    /* ---------- charts ---------- */
    const charts = ui.el('div', { class: 'grid cols-2', style: 'margin-top:16px' },
      ui.el('div', { class: 'card' }, ui.el('h3', {}, 'CPU % (live)'), ui.el('div', { class: 'chart-box' }, ui.el('canvas', { id: 'cpuChart' }))),
      ui.el('div', { class: 'card' }, ui.el('h3', {}, 'Memory % (live)'), ui.el('div', { class: 'chart-box' }, ui.el('canvas', { id: 'ramChart' })))
    );

    /* ---------- system + hosting + services ---------- */
    const s = info.static;
    const lv = info.live;
    const sysCard = ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'System status'),
      ui.el('dl', { class: 'kv' },
        ui.el('dt', {}, 'Hostname'), ui.el('dd', {}, s.hostname),
        ui.el('dt', {}, 'OS'), ui.el('dd', {}, `${s.distro} (${s.arch})`),
        ui.el('dt', {}, 'Kernel'), ui.el('dd', {}, s.kernel),
        ui.el('dt', {}, 'CPU'), ui.el('dd', {}, `${s.cpu} — ${s.cores} cores`),
        ui.el('dt', {}, 'IP address'), ui.el('dd', { class: 'mono' }, s.ip || '–'),
        ui.el('dt', {}, 'Uptime'), ui.el('dd', { id: 'uptimeVal' }, ui.fmtUptime(lv.uptime)),
        ui.el('dt', {}, 'Load average'), ui.el('dd', { id: 'sysLoad' }, String(lv.loadavg ?? '–')),
        ui.el('dt', {}, 'Memory'), ui.el('dd', { id: 'sysMem' }, `${ui.fmtBytes(lv.memUsed)} / ${ui.fmtBytes(lv.memTotal)} (${lv.memPct}%)`),
        ui.el('dt', {}, 'Swap'), ui.el('dd', { id: 'sysSwap' }, fmtSwap(lv))
      )
    );

    const stackCard = ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Hosting stack'),
      ui.el('div', { class: 'quick-actions' },
        (() => { const b = ui.el('button', { class: 'qa-btn', type: 'button' }, ui.el('span', { class: 'qa-ico' }, '🌐'), ui.el('span', { id: 'siteCount' }, '–'), ' ', ui.el('span', { id: 'siteCountLabel' }, 'sites')); b.onclick = () => { location.hash = '#/sites'; }; return b; })(),
        (() => { const b = ui.el('button', { class: 'qa-btn', type: 'button' }, ui.el('span', { class: 'qa-ico' }, '🗄️'), ui.el('span', { id: 'dbCount' }, '–'), ' ', ui.el('span', { id: 'dbCountLabel' }, 'databases')); b.onclick = () => { location.hash = '#/databases'; }; return b; })()
      ),
      ui.el('div', { class: 'divider' }),
      ui.el('h3', {}, 'Services health'),
      ui.el('div', { class: 'health-strip', id: 'healthStrip' }, ui.el('span', { class: 'health-pill' }, 'Checking…'))
    );

    const keyCard = ui.el('div', { class: 'card', style: 'margin-top:16px' },
      ui.el('h3', {}, 'Key services'),
      ui.el('div', { id: 'keySvcBox' }, ui.el('span', { class: 'text-dim' }, 'Checking…')));

    root.append(
      cards, actionsCard, charts, keyCard,
      ui.el('div', { class: 'grid cols-2', style: 'margin-top:16px' }, sysCard, stackCard)
    );

    cpuChart = makeChart(el('cpuChart'), 'CPU %', '#34d399');
    ramChart = makeChart(el('ramChart'), 'RAM %', '#22d3ee');

    const apply = (d) => {
      setStat('cpu', d.cpu + '%', `load ${d.loadavg}`, d.cpu);
      setStat('ram', d.memPct + '%', `${ui.fmtBytes(d.memUsed)} / ${ui.fmtBytes(d.memTotal)}`, d.memPct);
      setStat('disk', Math.round(d.diskPct) + '%', `${ui.fmtBytes(d.diskUsed)} / ${ui.fmtBytes(d.diskTotal)}`, d.diskPct);
      setStat('net', `↓ ${ui.fmtBytes(d.rxSec)}/s`, `↑ ${ui.fmtBytes(d.txSec)}/s · up ${ui.fmtUptime(d.uptime)}`, null);
      const up = el('uptimeVal'); if (up) up.textContent = ui.fmtUptime(d.uptime);
      const ld = el('sysLoad'); if (ld) ld.textContent = String(d.loadavg ?? '–');
      const mm = el('sysMem');
      if (mm) mm.textContent = d.memTotal ? `${ui.fmtBytes(d.memUsed)} / ${ui.fmtBytes(d.memTotal)} (${d.memPct}%)` : '–';
      const sw = el('sysSwap'); if (sw) sw.textContent = fmtSwap(d);
      const t = new Date(d.ts).toLocaleTimeString();
      pushPoint(cpuChart, t, d.cpu);
      pushPoint(ramChart, t, d.memPct);
    };
    apply(info.live);

    socket = io('/stats');
    socket.on('stats', apply);

    /* ---------- async enrichment (services, sites, dbs) ---------- */
    Promise.allSettled([
      api.get('/services'),
      api.get('/services/key'),
      api.get('/sites'),
      api.get('/databases')
    ]).then(([svc, key, sites, dbs]) => {
      if (!root.isConnected) return;
      if (key.status === 'fulfilled') renderKey(el('keySvcBox'), key.value.services || [], me);
      if (sites.status === 'fulfilled' && el('siteCount')) {
        const list = sites.value.sites || [];
        el('siteCount').textContent = list.length;
        if (el('siteCountLabel')) el('siteCountLabel').textContent = list.length === 1 ? 'site' : 'sites';
        const ssl = list.filter((x) => x.ssl).length;
        const sub = ui.el('div', { class: 'stat-sub', style: 'margin-top:8px' },
          list.length ? `${ssl}/${list.length} ${list.length === 1 ? 'site' : 'sites'} secured with SSL` : 'No websites yet');
        const grid = el('siteCount').closest('.quick-actions').parentElement;
        grid.appendChild(sub);
      }
      if (dbs.status === 'fulfilled' && el('dbCount')) {
        const n = (dbs.value.databases || []).length;
        el('dbCount').textContent = n;
        if (el('dbCountLabel')) el('dbCountLabel').textContent = n === 1 ? 'database' : 'databases';
      }
      if (svc.status === 'fulfilled') {
        const strip = el('healthStrip');
        if (!strip) return;
        strip.innerHTML = '';
        const all = svc.value.services || [];
        const seen = new Set();
        let shown = 0;
        for (const [key, name] of KEY_SERVICES) {
          const unit = all.find((u) => u.unit.replace(/\.service$/, '') === key || (key === 'php' && /^php[\d.]*-fpm$/.test(u.unit.replace(/\.service$/, ''))));
          if (!unit) continue;
          if (seen.has(name)) continue;
          seen.add(name);
          shown++;
          const running = unit.active === 'active';
          strip.appendChild(ui.el('span', { class: 'health-pill ' + (running ? 'ok' : 'bad'), title: unit.unit },
            ui.el('span', { class: 'dot' }), name));
        }
        const activeAll = all.filter((u) => u.active === 'active').length;
        strip.appendChild(ui.el('span', { class: 'health-pill', title: `${activeAll} units active out of ${all.length} loaded` },
          ui.el('span', { class: 'dot' }), `${activeAll} active`));
        if (!shown) strip.appendChild(ui.el('span', { class: 'health-pill' }, 'No services matched'));
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
