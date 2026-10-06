'use strict';
/* Customer dashboard.
 *
 * A deliberately different view from the admin one. Where the admin dashboard
 * is about the machine (CPU, memory, services, load), this one is about what
 * the customer owns: their plan, how much of it they have used, and their
 * websites and databases.
 *
 * Nothing here reads host metrics. Not "not displayed" - not requested. The
 * admin-only endpoints answer 403 for a non-admin, so there is nothing to leak
 * even if this file were changed later.
 */
window.UserDashboardView = (() => {
  /** A quota tile: used against the plan's allowance.
   *
   * Takes the finished strings rather than raw numbers plus a formatter. The
   * first version built the tile from numbers and then reached back into the
   * document to patch the disk tile's text - which threw, because at that
   * point the tiles had not been appended anywhere yet. Everything is computed
   * here, while the values are to hand.
   *
   * A limit of null or -1 means the plan does not cap it, so show the plain
   * figure rather than a meaningless percentage. */
  function quotaTile(label, value, sub, pct) {
    return ui.el('div', { class: 'stat-card' },
      ui.el('div', { class: 'stat-head' },
        ui.el('span', { class: 'stat-icon' }, '◷'),
        ui.el('div', { class: 'stat-label' }, label)),
      ui.el('div', { class: 'stat-value' }, value),
      ui.el('div', { class: 'stat-sub' }, sub),
      ui.el('div', {
        class: 'meter' + (pct > 90 ? ' danger' : pct > 75 ? ' warn' : ''),
        style: pct == null ? 'display:none' : ''
      }, ui.el('div', { style: `width:${pct || 0}%` })));
  }

  /** used/limit, optionally in megabytes for the disk tile. */
  function quota(used, limit, asMb) {
    if (limit == null || limit < 0) {
      return { value: asMb ? `${used} MB` : String(used), sub: 'no limit on this plan', pct: null };
    }
    const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    return {
      value: asMb ? `${used} / ${limit} MB` : `${used} / ${limit}`,
      sub: `${pct}% of your allowance`,
      pct
    };
  }

  function siteRow(s) {
    const link = ui.el('button', { class: 'btn btn-sm' }, 'Open');
    link.onclick = () => { location.hash = '#/sites'; };
    return ui.el('tr', {},
      ui.el('td', {}, ui.el('code', {}, s.domain)),
      ui.el('td', {}, ui.badge(s.backend || 'nginx', 'gray')),
      ui.el('td', {}, s.ssl ? ui.badge('secured', 'green') : ui.badge('no SSL', 'gray')),
      ui.el('td', {}, link));
  }

  function dbRow(d) {
    return ui.el('tr', {},
      ui.el('td', {}, ui.el('code', {}, d.name)),
      ui.el('td', { class: 'text-dim' }, d.host || '–'));
  }

  function emptyRow(colspan, text, action) {
    const cell = ui.el('td', { colspan }, ui.el('span', { class: 'text-dim' }, text));
    if (action) {
      const b = ui.el('button', { class: 'btn btn-sm', style: 'margin-left:10px' }, action.label);
      b.onclick = () => { location.hash = action.hash; };
      cell.appendChild(b);
    }
    return ui.el('tr', {}, cell);
  }

  async function render(root, me) {
    let d;
    try {
      d = await api.get('/users/me/dashboard');
    } catch (e) {
      root.innerHTML = '';
      root.appendChild(ui.el('div', { class: 'card empty' }, 'Could not load your dashboard: ' + e.message));
      return;
    }

    const plan = d.plan;
    const u = d.usage;
    const first = (s) => String(s || '').charAt(0).toUpperCase();

    /* ---------- greeting ---------- */
    const hour = new Date().getHours();
    const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const header = ui.el('div', {
      class: 'user-hero',
      style: 'margin-bottom:16px'
    },
      ui.el('div', { style: 'flex:1;min-width:0' },
        ui.el('div', { class: 'user-hero-hi' }, `${part}, ${d.user.username}`),
        ui.el('div', { class: 'text-dim', style: 'font-size:13px;margin-top:2px' },
          plan
            ? `Plan: ${plan.name}`
            : 'No hosting plan assigned — ask your administrator for one.')),
      ui.el('button', { class: 'btn btn-primary', onclick: () => { location.hash = '#/sites'; } },
        plan && plan.maxSites >= 0 && u.sites >= plan.maxSites ? 'Manage websites' : '＋ New website'));

    /* ---------- what you have used ---------- */
    const siteQ = quota(u.sites, plan ? plan.maxSites : -1);
    const dbQ = quota(u.databases, plan ? plan.maxDatabases : -1);
    const diskQ = quota(u.diskMB, plan ? plan.diskMB : -1, true);
    const tiles = ui.el('div', { class: 'hero-grid' },
      quotaTile('Websites', siteQ.value, siteQ.sub, siteQ.pct),
      quotaTile('Databases', dbQ.value, dbQ.sub, dbQ.pct),
      quotaTile('Disk used', diskQ.value, diskQ.sub, diskQ.pct));

    /* ---------- your websites ---------- */
    const siteBody = ui.el('tbody', {});
    if (!d.sites.length) {
      siteBody.appendChild(emptyRow(4, 'You have no websites yet.', { label: 'Create one', hash: '#/sites' }));
    } else {
      for (const s of d.sites) siteBody.appendChild(siteRow(s));
    }
    const sitesCard = ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Your websites'),
      ui.el('p', { class: 'text-dim', style: 'margin-top:-6px' }, 'Only the sites assigned to your account are listed.'),
      ui.el('div', { class: 'table-wrap' },
        ui.el('table', {},
          ui.el('thead', {}, ui.el('tr', {},
            ui.el('th', {}, 'Domain'), ui.el('th', {}, 'Served by'),
            ui.el('th', {}, 'SSL'), ui.el('th', {}, ''))),
          siteBody)));

    /* ---------- your databases ---------- */
    const dbBody = ui.el('tbody', {});
    if (!d.databases.length) {
      dbBody.appendChild(emptyRow(2, 'No databases assigned to you.', { label: 'Request one', hash: '#/databases' }));
    } else {
      for (const x of d.databases) dbBody.appendChild(dbRow(x));
    }
    const dbsCard = ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Your databases'),
      ui.el('div', { class: 'table-wrap' },
        ui.el('table', {},
          ui.el('thead', {}, ui.el('tr', {},
            ui.el('th', {}, 'Database'), ui.el('th', {}, 'Host'))),
          dbBody)));

    /* ---------- things you can actually do ---------- */
    /* Only the entries this role is allowed to use. A hosting customer has no
     * business being offered a terminal, a PHP manager or a service manager. */
    const ACTIONS = [
      { label: 'My websites', icon: '🌐', hash: '#/sites', admin: false },
      { label: 'My databases', icon: '🗄️', hash: '#/databases', admin: false },
      { label: 'Files', icon: '📁', hash: '#/files', admin: false },
      { label: 'DNS', icon: '🛰️', hash: '#/dns', admin: false },
      { label: 'Mail', icon: '📧', hash: '#/mail', admin: false },
      { label: 'WordPress', icon: '🧭', hash: '#/wordpress', admin: false }
    ];
    const allowed = ACTIONS.filter((a) => !a.admin || me.role === 'admin');
    const quick = ui.el('div', { class: 'quick-actions' });
    for (const a of allowed) {
      const b = ui.el('button', { class: 'qa-btn', type: 'button' },
        ui.el('span', { class: 'qa-ico' }, a.icon), a.label);
      b.onclick = () => { location.hash = a.hash; };
      quick.appendChild(b);
    }
    const quickCard = ui.el('div', { class: 'card', style: 'margin-top:16px' },
      ui.el('h3', {}, 'What you can do'), quick);

    /* ---------- getting help ---------- */
    const help = ui.el('div', { class: 'card', style: 'margin-top:16px' },
      ui.el('h3', {}, 'Need something?'),
      ui.el('p', { class: 'text-dim', style: 'margin-top:-4px' },
        'This dashboard only shows your own account. For anything about the server itself '
        + '(a new plan, more sites, a mail problem) contact your administrator.'));

    root.append(
      header,
      tiles,
      ui.el('div', { class: 'grid cols-2', style: 'margin-top:16px' }, sitesCard, dbsCard),
      quickCard,
      help
    );
  }

  return { render };
})();
