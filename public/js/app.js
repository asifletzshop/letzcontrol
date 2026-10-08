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
    { id: 'dashboard', icon: '📊', label: 'Dashboard', group: 'Overview', view: DashboardView, hideForNonAdmin: true },
    { id: 'mydashboard', icon: '🏠', label: 'My hosting', group: 'Overview', sub: 'Your plan, websites and databases', view: UserDashboardView, hideForAdmin: true },
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
    { id: 'nodeapps', icon: '🟩', label: 'Apps', group: 'Server', sub: 'Apps running behind a proxy — start, stop and read logs', view: NodeAppsView, admin: true },
    { id: 'nodewizard', icon: '🪄', label: 'New Node.js site', group: 'Server', sub: 'Wizard for a Node.js website', view: NodeWizardView, admin: true, hidden: true },
    { id: 'terminal', icon: '💻', label: 'Terminal', group: 'Server', sub: 'Web shell session', view: TerminalView, admin: true },
    { id: 'setup', icon: '🧩', label: 'Setup Wizard', group: 'Advanced', sub: 'Guided installation of the hosting stack', view: SetupView, admin: true },
    { id: 'users', icon: '👥', label: 'Users & Plans', group: 'Advanced', sub: 'Panel accounts, roles and quotas', view: UsersView, admin: true },
    { id: 'settings', icon: '🔧', label: 'Settings', group: 'Advanced', sub: 'Panel preferences and maintenance', view: SettingsView },
    { id: 'updates', icon: '⬆️', label: 'Updates', group: 'Advanced', sub: 'Check for and install panel updates', view: UpdatesView, admin: true }
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

  /* The Setup Wizard installs the whole hosting stack. Once every component it
   * manages is present there is nothing left for it to do, so it is hidden
   * rather than left sitting in the menu as a link that does nothing. The
   * check is the same one the wizard itself runs, and the server caches the
   * detection for a minute, so this costs one request per page load. */
  let setupComplete = false;
  let setupChecked = false;

  const visibleNav = () => NAV.filter((n) => {
    if (n.hidden) return false;
    if (n.admin && me.role !== 'admin') return false;
    /* Exactly one dashboard per audience: the machine one is the admin's, the
     * customer's is built from their own sites and databases. */
    if (n.hideForAdmin && me.role === 'admin') return false;
    if (n.hideForNonAdmin && me.role !== 'admin') return false;
    if (n.id === 'setup' && setupComplete) return false;
    return true;
  });

  /* ----------------------------- theme ------------------------------- */
  const THEMES = ['dark', 'cpanel'];
  const THEME_KEY = 'letzcontrol.theme';

  /** Apply a theme id to <html>, which is what every rule in
   *  css/theme-cpanel.css is scoped to, and mirror it into localStorage for
   *  the inline pre-paint script in index.html. */
  function applyTheme(theme) {
    const t = THEMES.includes(theme) ? theme : 'dark';
    const changed = document.documentElement.getAttribute('data-theme') !== t;
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ }
    window.__letzTheme = t;
    /* Views that draw their own canvas (the dashboard charts) hold colours they
     * read at creation time, so tell them only when something actually changed
     * - this also runs once during boot, before any view exists. */
    if (changed) window.dispatchEvent(new CustomEvent('panel:theme', { detail: t }));
    return t;
  }
  applyTheme((() => {
    try { return localStorage.getItem(THEME_KEY); } catch { return null; }
  })());

  /* Two dashboards, one per audience. An admin opening "/" gets the machine -
   * CPU, memory, services. A customer must not, so they land on a page built
   * only from their own sites, databases and plan. Route "/" and an explicit
   * request for the machine dashboard to the right one rather than rendering
   * the admin view and relying on the fields being hidden in CSS. */
  function dashboardRoute(id) {
    if (id === 'dashboard' || id === 'mydashboard') {
      return me.role === 'admin' ? 'dashboard' : 'mydashboard';
    }
    return id;
  }

  /** Push the current state onto the Settings → System restore button. Kept
   *  separate from the check because that button is rendered by a view that
   *  runs AFTER the check has already finished. */
  function applySetupRestore() {
    const restore = document.querySelector('[data-setup-restore]');
    if (!restore) return;
    restore.style.display = setupComplete ? '' : 'none';
    restore.textContent = setupComplete
      ? 'Setup Wizard — everything is installed. Show it again'
      : '';
  }

  async function refreshSetupVisibility() {
    if (me.role !== 'admin') { setupChecked = true; applySetupRestore(); return; }
    try {
      const res = await api.get('/setup/components');
      const list = res.components || [];
      setupComplete = list.length > 0 && list.every((c) => c.installed);
    } catch {
      /* Detection failed (or the user is mid-install). Leave the entry visible:
       * a wizard you cannot see is far more annoying than one that is already
       * installed, and hiding something on a failed check can strand an admin
       * who cannot find the tool they need. */
      setupComplete = false;
    }
    setupChecked = true;
    applySetupRestore();
  }

  function renderNav() {
    navEl.innerHTML = '';
    let lastGroup = null;
    for (const item of visibleNav()) {
      if (item.group !== lastGroup) {
        lastGroup = item.group;
        navEl.appendChild(ui.el('div', { class: 'nav-group-title' }, item.group));
      }
      const el = ui.el('div', { class: 'nav-item' + (item.id === dashboardRoute(currentRoute()) ? ' active' : '') },
        ui.el('span', { class: 'ico' }, item.icon),
        ui.el('span', { class: 'label' }, item.label)
      );
      el.onclick = () => { location.hash = '#/' + item.id; closeSidebar(); };
      navEl.appendChild(el);
    }
  }

  const currentRoute = () => (location.hash.replace(/^#\//, '').split('?')[0] || 'dashboard');

  async function route() {
    const id = dashboardRoute(currentRoute());
    const item = NAV.find((n) => n.id === id) || NAV[0];
    if (item.admin && me.role !== 'admin') { location.hash = '#/dashboard'; return; }
    if (activeView && activeView.destroy) { try { activeView.destroy(); } catch { /* noop */ } }
    activeView = item.view;
    titleEl.textContent = item.label;
    /* Hide the subtitle element when a page has none. Leaving it visible with
     * empty content keeps a line of font metrics under the title, so removing
     * a description would otherwise open a small gap in the header. */
    subEl.textContent = item.sub || '';
    subEl.hidden = !item.sub;
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

    /* These three pages can change what is installed, so re-check afterwards.
     * A wizard hidden because the stack was complete has to come back the
     * moment something is actually missing again. */
    if (setupChecked && ['setup', 'servers', 'addons'].includes(id)) {
      const was = setupComplete;
      await refreshSetupVisibility();
      if (was !== setupComplete) renderNav();
    }
    /* The restore button lives inside the view that just rendered, so it is
     * synced after every render rather than only inside the check above. */
    applySetupRestore();
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

  window.__panelTheme = { apply: applyTheme, list: THEMES, current: () => window.__letzTheme || 'dark' };

  /* The dashboard's cPanel application grid reads the sidebar's already
   * filtered list from here rather than keeping its own copy, so a module can
   * never appear as a tile for an account that cannot open it - the role and
   * hidden-wizard rules are applied in exactly one place. */
  window.__panelNav = () => visibleNav();

  window.addEventListener('hashchange', route);
  /* Resolve the setup state BEFORE the first paint, otherwise the wizard shows
   * in the sidebar for a frame and then vanishes. */
  (async () => {
    await refreshSetupVisibility();
    /* The saved theme is a per-account preference, so it can only be known
     * after login. Applying it here rather than in Settings keeps every page
     * consistent, and the inline script in index.html already avoided a dark
     * flash while this request was in flight. */
    try {
      const s = await api.get('/settings');
      applyTheme(s.prefs && s.prefs.theme);
    } catch { /* keep the cached theme */ }
    route();
  })();
})();
