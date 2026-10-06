'use strict';
/* App shell: grouped navigation, hash routing, command palette, auth bootstrap */
(async () => {
  let me;
  try {
    me = (await api.get('/auth/me')).user;
  } catch {
    location.href = '/login.html';
    return;
  }

  const NAV = [
    { id: 'dashboard', icon: '📊', label: 'Dashboard', group: 'Overview', sub: 'Live server metrics, services and quick actions', view: DashboardView },
    { id: 'sites', icon: '🌐', label: 'Websites', group: 'Hosting', sub: 'Create and manage sites, backends and SSL', view: SitesView },
    { id: 'dns', icon: '🛰️', label: 'DNS', group: 'Hosting', sub: 'Zone records per website', view: DnsView },
    { id: 'wordpress', icon: '🧭', label: 'WordPress', group: 'Hosting', sub: 'Installations, updates and core integrity', view: WordpressView },
    { id: 'mail', icon: '📧', label: 'Mail', group: 'Hosting', sub: 'Mailboxes, domains and delivery status', view: MailView },
    { id: 'databases', icon: '🗄️', label: 'Databases', group: 'Hosting', sub: 'MySQL databases, users and phpMyAdmin', view: DatabasesView },
    { id: 'php', icon: '🐘', label: 'PHP', group: 'Server', sub: 'Versions, extensions and php.ini editor', view: PhpView, admin: true },
    { id: 'services', icon: '⚙️', label: 'Services', group: 'Server', sub: 'systemd service manager', view: ServicesView, admin: true },
    { id: 'servers', icon: '🖥️', label: 'Servers', group: 'Server', sub: 'Web servers: configure, enable, disable, uninstall', view: ServersView, admin: true },
    { id: 'files', icon: '📁', label: 'File Manager', group: 'Server', sub: 'Browse, edit, upload and archive files', view: FilesView },
    { id: 'docker', icon: '🐳', label: 'Docker', group: 'Server', sub: 'Containers, images and compose stacks', view: DockerView, admin: true },
    { id: 'cron', icon: '⏰', label: 'Cron Jobs', group: 'Server', sub: 'Scheduled tasks on the server', view: CronView, admin: true },
    { id: 'addons', icon: '🧱', label: 'Addons', group: 'Server', sub: 'Install and manage Redis, Varnish, FTP, antivirus, and more', view: AddonsView, admin: true },
    { id: 'terminal', icon: '💻', label: 'Terminal', group: 'Server', sub: 'Web shell session', view: TerminalView, admin: true },
    { id: 'setup', icon: '🧩', label: 'Setup Wizard', group: 'Advanced', sub: 'Guided installation of the hosting stack', view: SetupView, admin: true },
    { id: 'users', icon: '👥', label: 'Users & Plans', group: 'Advanced', sub: 'Panel accounts, roles and quotas', view: UsersView, admin: true },
    { id: 'settings', icon: '🔧', label: 'Settings', group: 'Advanced', sub: 'Panel preferences and maintenance', view: SettingsView }
  ];

  const navEl = document.getElementById('nav');
  const contentEl = document.getElementById('content');
  const titleEl = document.getElementById('pageTitle');
  const subEl = document.getElementById('pageSub');

  document.getElementById('currentUser').textContent = me.username;
  document.getElementById('userRole').textContent = me.role;
  document.getElementById('userAvatar').textContent = (me.username[0] || '?').toUpperCase();
  document.getElementById('logoutBtn').onclick = async () => {
    await api.post('/auth/logout');
    location.href = '/login.html';
  };

  /* ---- mobile sidebar ---- */
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const closeSidebar = () => { sidebar.classList.remove('open'); overlay.classList.remove('show'); };
  document.getElementById('menuBtn').onclick = () => {
    sidebar.classList.toggle('open'); overlay.classList.toggle('show');
  };
  overlay.onclick = closeSidebar;

  let activeView = null;
  const visibleNav = () => NAV.filter((n) => !(n.admin && me.role !== 'admin'));

  function renderNav() {
    navEl.innerHTML = '';
    let lastGroup = null;
    for (const item of visibleNav()) {
      if (item.group !== lastGroup) {
        lastGroup = item.group;
        navEl.appendChild(ui.el('div', { class: 'nav-group-title' }, item.group));
      }
      const el = ui.el('div', { class: 'nav-item' + (item.id === currentRoute() ? ' active' : '') },
        ui.el('span', { class: 'ico' }, item.icon),
        ui.el('span', { class: 'label' }, item.label)
      );
      el.onclick = () => { location.hash = '#/' + item.id; closeSidebar(); };
      navEl.appendChild(el);
    }
  }

  const currentRoute = () => (location.hash.replace(/^#\//, '').split('?')[0] || 'dashboard');

  async function route() {
    const id = currentRoute();
    const item = NAV.find((n) => n.id === id) || NAV[0];
    if (item.admin && me.role !== 'admin') { location.hash = '#/dashboard'; return; }
    if (activeView && activeView.destroy) { try { activeView.destroy(); } catch { /* noop */ } }
    activeView = item.view;
    titleEl.textContent = item.label;
    subEl.textContent = item.sub || '';
    contentEl.innerHTML = '';
    contentEl.classList.remove('page-enter');
    void contentEl.offsetWidth; /* restart animation */
    contentEl.classList.add('page-enter');
    renderNav();
    closeSidebar();
    try {
      await item.view.render(contentEl, me);
    } catch (e) {
      contentEl.innerHTML = '';
      contentEl.appendChild(ui.el('div', { class: 'banner' }, `Failed to load: ${e.message}`));
    }
  }

  /* ================= command palette (Ctrl+K) ================= */
  let paletteOpen = false;
  let items = [];      /* flat list of {group, icon, label, hint, run} */
  let filtered = [];
  let activeIdx = 0;

  async function collectItems() {
    const list = [];
    for (const n of visibleNav()) {
      list.push({ group: 'Pages', icon: n.icon, label: n.label, hint: n.sub || '', run: () => { location.hash = '#/' + n.id; } });
    }
    /* lazy-load sites + databases for deep navigation */
    try {
      const { sites } = await api.get('/sites');
      for (const s of sites) {
        list.push({ group: 'Websites', icon: '🌐', label: s.domain, hint: s.backend || '', run: () => { location.hash = '#/sites'; } });
      }
    } catch { /* noop */ }
    try {
      const res = await api.get('/databases');
      for (const d of (res.databases || res)) {
        list.push({ group: 'Databases', icon: '🗄️', label: d.name, hint: 'database', run: () => { location.hash = '#/databases'; } });
      }
    } catch { /* noop */ }
    return list;
  }

  function score(q, text) {
    const t = text.toLowerCase();
    if (t.startsWith(q)) return 0;
    if (t.includes(q)) return 1;
    return -1;
  }

  function applyFilter(q) {
    const scored = [];
    for (const it of items) {
      const s = score(q, it.label);
      if (s >= 0) scored.push({ it, s });
    }
    if (q) scored.sort((a, b) => a.s - b.s);
    filtered = scored.map((x) => x.it);
    activeIdx = 0;
    renderList();
  }

  function renderList() {
    const listEl = document.getElementById('cmdkList');
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!filtered.length) {
      listEl.appendChild(ui.el('div', { class: 'cmdk-empty' }, 'No matches'));
      return;
    }
    let lastGroup = null;
    filtered.forEach((it, i) => {
      if (it.group !== lastGroup) {
        lastGroup = it.group;
        listEl.appendChild(ui.el('div', { class: 'cmdk-group' }, it.group));
      }
      const row = ui.el('div', { class: 'cmdk-item' + (i === activeIdx ? ' active' : '') },
        ui.el('span', { class: 'ci-ico' }, it.icon),
        ui.el('span', {}, it.label),
        it.hint ? ui.el('span', { class: 'ci-hint' }, it.hint) : ui.el('span')
      );
      row.onclick = () => runItem(i);
      listEl.appendChild(row);
    });
    const act = listEl.querySelector('.cmdk-item.active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  }

  function runItem(i) {
    const it = filtered[i];
    closePalette();
    if (it) it.run();
  }

  async function openPalette() {
    if (paletteOpen) return;
    paletteOpen = true;
    const back = ui.el('div', { class: 'cmdk-backdrop' });
    const box = ui.el('div', { class: 'cmdk' });
    const inputWrap = ui.el('div', { class: 'cmdk-input' },
      ui.el('span', { class: 'ci-ico' }, '⌕'),
      (() => { const inp = ui.el('input', { type: 'text', placeholder: 'Search pages, websites, databases…', id: 'cmdkInput' }); return inp; })()
    );
    const listEl = ui.el('div', { class: 'cmdk-list', id: 'cmdkList' });
    const foot = ui.el('div', { class: 'cmdk-footer' },
      ui.el('span', {}, '↑↓ navigate'), ui.el('span', {}, '⏎ open'), ui.el('span', {}, 'esc close')
    );
    box.append(inputWrap, listEl, foot);
    back.appendChild(box);
    back.onclick = (e) => { if (e.target === back) closePalette(); };
    document.body.appendChild(back);

    const input = document.getElementById('cmdkInput');
    input.oninput = () => applyFilter(input.value.trim().toLowerCase());
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, filtered.length - 1); renderList(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); renderList(); }
      else if (e.key === 'Enter') { e.preventDefault(); runItem(activeIdx); }
      else if (e.key === 'Escape') { closePalette(); }
    };
    input.focus();

    filtered = items = await collectItems();
    /* keep whatever the user typed while items were loading */
    const pending = document.getElementById('cmdkInput');
    applyFilter(pending && pending.value ? pending.value.trim().toLowerCase() : '');
    const inp = document.getElementById('cmdkInput');
    if (inp) inp.focus();
  }

  function closePalette() {
    const b = document.querySelector('.cmdk-backdrop');
    if (b) b.remove();
    paletteOpen = false;
  }

  document.getElementById('searchBtn').onclick = openPalette;
  window.addEventListener('keydown', (e) => {
    const inField = /INPUT|TEXTAREA|SELECT/.test((e.target.tagName || '')) || e.target.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); paletteOpen ? closePalette() : openPalette(); }
    else if (e.key === '/' && !inField && !paletteOpen) { e.preventDefault(); openPalette(); }
    else if (e.key === 'Escape' && paletteOpen) closePalette();
  });

  window.addEventListener('hashchange', route);
  route();
})();
