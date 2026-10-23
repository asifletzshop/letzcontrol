'use strict';
/* Docker view, laid out the way CasaOS lays out its home screen: a wallpaper,
 * a clock and live system widgets along the top, a grid of app tiles in the
 * middle, and a dock along the bottom. The tiles are containers, the dock
 * switches between the app grid, the store, images, volumes and networks, and
 * every action CasaOS puts behind a right-click is here too - Open, Settings,
 * Logs, Terminal, the state controls, and Uninstall.
 *
 * Admin-only, same as the API behind it. */
window.DockerView = (() => {
  /* ---------------------------------------------------- state ---------- */
  let page = 'apps';        /* apps | store | images | volumes | networks */
  let search = '';
  let runningOnly = false;
  let stats = {};           /* id -> the last one-shot reading */
  let openMenu = null;      /* the menu currently open, if any */
  let liveTimer = null;
  let clockTimer = null;
  let live = null;          /* last /stats/live reading, for the widgets */
  let payload = null;       /* last listing, so a page switch is instant */
  let rootEl = null;        /* the element this view is rendered into */
  let bodyEl = null;        /* only the middle is rebuilt while searching */
  let gridEl = null;        /* the app grid */
  let widgets = null;       /* key -> { value, bar } for the live widgets */

  /* Close the open menu, if any. Shared by every path that should dismiss it:
   * opening another, clicking a menu entry, clicking away, right-clicking
   * somewhere else. */
  function closeMenus() {
    if (!openMenu) return;
    openMenu.classList.remove('open');
    openMenu = null;
  }

  /* The daemon has no artwork for a container, so the common images keep
   * their mark and everything else gets its first letter on a hue picked
   * from the image name - the same image always lands on the same colour.
   * Matched against the repository part only (before any :tag), so
   * nginx:alpine reads as nginx and not as alpine. */
  const IMG_MARKS = [
    ['nginx', '🌐'], ['apache', '🪶'], ['httpd', '🪶'], ['caddy', '🛡'],
    ['postgres', '🐘'], ['mysql', '🐬'], ['mariadb', '🐬'], ['mongo', '🍃'],
    ['redis', '⚡'], ['memcache', '⚡'], ['valkey', '⚡'],
    ['ubuntu', '🐧'], ['debian', '🌀'], ['alpine', '🏔'],
    ['traefik', '🚦'], ['certbot', '📜'], ['acme', '📜'],
    ['grafana', '📈'], ['prometheus', '🔥'], ['portainer', '🚢'],
    ['wordpress', '📝'], ['nextcloud', '☁️'], ['jellyfin', '🎬'], ['plex', '🎬'],
    ['homeassistant', '🏠'], ['pihole', '🕳️'], ['adguard', '🛡'],
    ['vaultwarden', '🔐'], ['bitwarden', '🔐'],
    ['postfix', '📬'], ['dovecot', '📬'], ['mailu', '📬'], ['roundcube', '✉️'],
    ['phpmyadmin', '🗄️'], ['adminer', '🗄️'], ['docker', '🐳'],
    ['uptime', '💓'], ['gitea', '🦊'], ['gitlab', '🦊'],
    ['syncthing', '🔄'], ['filebrowser', '📂'], ['minio', '🪣'],
    ['sonarr', '📺'], ['radarr', '📺'], ['lidarr', '📺'], ['prowlarr', '📺'],
    ['qbittorrent', '⬇️'], ['transmission', '⬇️'], ['deluge', '⬇️'],
    ['n8n', '🧩'], ['ollama', '🦙'], ['immich', '🖼️'],
    ['navidrome', '🎵'], ['audiobookshelf', '🎧'],
    ['wireguard', '🔒'], ['openvpn', '🔒']
  ];

  function iconFor(image) {
    const repo = String(image || '').toLowerCase().split('/').pop().split(':')[0];
    for (const [k, mark] of IMG_MARKS) if (repo.includes(k)) return mark;
    let h = 0;
    for (const ch of String(image || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return (repo.match(/[a-z0-9]/i) || ['?'])[0].toUpperCase() + `|${h}`;
  }

  /* One icon element, in whatever size the caller wants. Letter icons carry
   * the hue picked from the image name, so they read as artwork rather than
   * as a placeholder. */
  function iconEl(image, size) {
    const mark = iconFor(image);
    const letter = mark.includes('|');
    const [glyph, hue] = letter ? mark.split('|') : [mark, null];
    return ui.el('div', {
      class: `casa-ico${letter ? ' letter' : ''}`,
      style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.46)}px;`
        + (letter ? `background:linear-gradient(135deg, hsl(${hue}, 60%, 46%), hsl(${hue}, 60%, 30%))` : '')
    }, letter ? glyph : mark);
  }

  const ago = (ms) => {
    if (!ms) return '–';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  };

  const when = (ms) => (ms ? new Date(ms).toLocaleString() : '–');

  /* One number, the way the dashboard and the mail page show them. */
  function statCard(label, icon, tone, sub, value) {
    return ui.el('div', { class: `stat-card tone-${tone}` },
      ui.el('div', { class: 'stat-head' },
        ui.el('span', { class: 'stat-icon' }, icon),
        ui.el('div', { class: 'stat-label' }, label)),
      ui.el('div', { class: 'stat-value' }, value || '–'),
      ui.el('div', { class: 'stat-sub' }, sub || ''));
  }

  /* A button that shows it is working while it is: the actions here reach a
   * daemon that can take seconds, and a button that does nothing visible for
   * that long gets pressed again. */
  function busy(btn, label) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = label || '…';
    return () => { btn.disabled = false; btn.textContent = old; };
  }

  /* ------------------------------------------------- live widgets ------- */
  /* CasaOS keeps CPU, memory, storage and network in sight the whole time the
   * desktop is open. These are the same four, read from the panel's own host
   * stats and repainted in place, so opening a menu is never interrupted. */
  const WIDGETS = [
    { key: 'cpu', icon: '⚙️', label: 'CPU', pct: (l) => l.cpu || 0, fmt: (l) => `${(l.cpu || 0).toFixed(1)}%` },
    { key: 'mem', icon: '🧠', label: 'Memory', pct: (l) => l.memPct || 0, fmt: (l) => `${(l.memPct || 0).toFixed(1)}%` },
    { key: 'disk', icon: '💾', label: 'Storage', pct: (l) => l.diskPct || 0, fmt: (l) => `${(l.diskPct || 0).toFixed(0)}%` },
    {
      key: 'net', icon: '⇅', label: 'Network', pct: () => 0,
      fmt: (l) => `↓ ${ui.fmtBytes(l.rxSec)}/s · ↑ ${ui.fmtBytes(l.txSec)}/s`
    }
  ];

  function startLive() {
    stopLive();
    const tick = async () => {
      try { live = await api.get('/stats/live'); } catch { return; }
      if (!rootEl || !rootEl.isConnected) { stopLive(); return; }
      paintWidgets();
    };
    tick();
    liveTimer = setInterval(tick, 4000);
  }

  function stopLive() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  }

  function paintWidgets() {
    if (!live || !widgets) return;
    for (const w of WIDGETS) {
      const box = widgets[w.key];
      if (!box) continue;
      box.value.textContent = w.fmt(live);
      const pct = Math.max(0, Math.min(100, w.pct(live)));
      box.bar.style.width = `${pct}%`;
    }
  }

  /* ---------------------------------------------------- the desktop ---- */
  function topBar() {
    const clock = ui.el('div', { class: 'casa-clock' });
    const paintClock = () => {
      const d = new Date();
      clock.innerHTML = '';
      clock.appendChild(ui.el('div', { class: 'casa-time' },
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
      clock.appendChild(ui.el('div', { class: 'casa-date' },
        d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })));
    };
    paintClock();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(paintClock, 20_000);

    const chipBox = ui.el('div', { class: 'casa-chips' });
    widgets = {};
    for (const w of WIDGETS) {
      const value = ui.el('span', { class: 'cw-val' }, '–');
      const bar = ui.el('i', { class: 'cw-bar' });
      widgets[w.key] = { value, bar };
      chipBox.appendChild(ui.el('div', { class: 'casa-chip', title: w.label },
        ui.el('span', { class: 'cw-ico' }, w.icon),
        ui.el('span', { class: 'cw-label' }, w.label),
        value,
        ui.el('div', { class: 'cw-track' }, bar)));
    }

    /* Rebuilding only the middle keeps this input alive while typing. */
    const searchBox = ui.el('input', {
      type: 'search', class: 'casa-search', placeholder: 'Search apps…'
    });
    searchBox.value = search;
    searchBox.oninput = (e) => { search = e.target.value; paintBody(); };

    return ui.el('div', { class: 'casa-top' },
      clock,
      searchBox,
      ui.el('div', { class: 'spacer' }),
      chipBox,
      ui.el('button', {
        class: 'btn btn-sm', title: 'Refresh', 'aria-label': 'Refresh',
        onclick: () => load()
      }, '↻'));
  }

  /* The dock: the five places the desktop can be, and the three things worth
   * doing from anywhere. CasaOS pins its own apps here; these are the ones a
   * Docker operator reaches for without looking. */
  function dock() {
    const item = (id, icon, label) => ui.el('button', {
      class: `dock-item${page === id ? ' on' : ''}`,
      title: label, 'aria-label': label,
      onclick: () => { page = id; closeMenus(); render(); }
    }, ui.el('span', { class: 'dock-ico' }, icon), ui.el('span', { class: 'dock-label' }, label));

    return ui.el('div', { class: 'casa-dock', role: 'navigation', 'aria-label': 'Docker sections' },
      item('apps', '🏠', 'Apps'),
      item('store', '🛍', 'Store'),
      item('images', '🧰', 'Images'),
      item('volumes', '💾', 'Volumes'),
      item('networks', '🕸', 'Networks'),
      ui.el('div', { class: 'dock-sep' }),
      ui.el('button', {
        class: 'dock-item', title: 'Run a container', 'aria-label': 'Run a container',
        onclick: () => runModal()
      }, ui.el('span', { class: 'dock-ico' }, '➕'), ui.el('span', { class: 'dock-label' }, 'Run')),
      ui.el('button', {
        class: 'dock-item', title: 'Pull an image', 'aria-label': 'Pull an image',
        onclick: () => pullModal()
      }, ui.el('span', { class: 'dock-ico' }, '⬇️'), ui.el('span', { class: 'dock-label' }, 'Pull')),
      ui.el('button', {
        class: 'dock-item', title: 'Reclaim disk space', 'aria-label': 'Reclaim disk space',
        onclick: () => prune()
      }, ui.el('span', { class: 'dock-ico' }, '🧹'), ui.el('span', { class: 'dock-label' }, 'Reclaim')));
  }

  /* ---------------------------------------------------- app grid ------- */
  function paintGrid() {
    if (!gridEl || !bodyEl) return;
    const list = (payload && payload.containers.containers) || [];
    const needle = search.trim().toLowerCase();
    const shown = list.filter((c) => {
      if (runningOnly && c.state !== 'running') return false;
      if (!needle) return true;
      return `${c.name} ${c.image} ${c.id} ${c.ports}`.toLowerCase().includes(needle);
    });

    gridEl.innerHTML = '';
    shown.forEach((c) => gridEl.appendChild(containerTile(c)));
    gridEl.appendChild(addTile());

    const empty = bodyEl.querySelector('.casa-empty');
    if (empty) {
      empty.hidden = shown.length > 0;
      empty.textContent = list.length
        ? 'No container matches that.'
        : 'No containers yet. Run one from an image, or install one from the Store.';
    }
  }

  /* One container as a CasaOS app tile: a big icon with the state dot in its
   * corner, the name under it, and the actions behind a right-click or a ⋯ -
   * exactly how a CasaOS home screen treats an installed app. Clicking the
   * tile opens its settings, the way clicking an app opens the app. */
  function containerTile(c) {
    const s = stats[c.id];
    const dotCls = c.state === 'running' ? 'ok' : c.state === 'paused' ? 'warn' : '';

    const icon = iconEl(c.image, 74);
    icon.appendChild(ui.el('span', { class: `casa-dot ${dotCls}` }));

    const stateLine = c.state === 'running'
      ? (c.uptime ? `up ${ago(c.uptime)}` : 'running')
      : (c.health ? `${c.state} · ${c.health}` : (c.status || c.state));

    const menu = buildMenu(c);
    const more = ui.el('button', {
      class: 'casa-more', title: 'Actions', 'aria-label': `Actions for ${c.name}`
    }, '⋯');
    more.onclick = (e) => {
      if (e.stopPropagation) e.stopPropagation();
      toggleMenu(menu);
    };

    const tile = ui.el('div', {
      class: 'casa-app', role: 'button', tabindex: '0',
      title: `${c.name} — ${c.image}${c.ports ? ` — ${c.ports}` : ''}`
    }, more, icon,
      ui.el('div', { class: 'casa-app-name' }, c.name),
      ui.el('div', { class: 'casa-app-sub' }, c.image),
      ui.el('div', { class: 'casa-app-state' }, stateLine),
      s ? ui.el('div', { class: 'casa-app-use' },
        `${(s.cpu || 0).toFixed(1)}% cpu · ${(s.memPct || 0).toFixed(1)}% mem`) : null,
      menu);
    tile.onclick = () => { closeMenus(); appDialog(c); };
    tile.oncontextmenu = (e) => {
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      openAt(menu, e);
    };
    return tile;
  }

  function toggleMenu(menu) {
    const wasOpen = menu.classList.contains('open');
    closeMenus();
    if (!wasOpen) { menu.classList.add('open'); openMenu = menu; }
  }

  /* Open a menu at the pointer, the way a right-click does, clamped so it can
   * not run off the right or bottom edge of the window. Pressing again on a
   * menu that is already up puts it back down - that is what the browser does
   * with its own context menus. */
  function openAt(menu, e) {
    const wasOpen = menu.classList.contains('open');
    closeMenus();
    if (wasOpen) return;
    menu.classList.add('open');
    openMenu = menu;
    const x = e && typeof e.clientX === 'number' ? e.clientX : null;
    const y = e && typeof e.clientY === 'number' ? e.clientY : null;
    if (x == null) { menu.style.left = ''; menu.style.top = ''; return; }
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.right = 'auto';
    const w = menu.offsetWidth || 190;
    const h = menu.offsetHeight || 300;
    if (x + w > window.innerWidth - 8) menu.style.left = `${Math.max(8, window.innerWidth - w - 8)}px`;
    if (y + h > window.innerHeight - 8) menu.style.top = `${Math.max(8, y - h)}px`;
  }

  /* The full action set, the same list CasaOS puts behind a right-click. */
  function buildMenu(c) {
    const act = (action, label) => ui.el('button', {
      onclick: async (e) => {
        if (e.stopPropagation) e.stopPropagation();
        closeMenus();
        try {
          await api.post(`/docker/containers/${c.id}/action`, { action });
          ui.toast(`${action} requested`);
          load();
        } catch (err) { ui.toast(err.message, true); }
      }
    }, label);

    /* Every entry does the same two things before acting: the click stays
     * inside the menu, and the menu goes back down. The class is only set when
     * there is one - ui.el assigns whatever it is handed, so a class key left
     * at undefined would end up as a class literally named "undefined". */
    const item = (label, fn, cls) => {
      const attrs = {
        onclick: (e) => { if (e.stopPropagation) e.stopPropagation(); closeMenus(); fn(); }
      };
      if (cls) attrs.class = cls;
      return ui.el('button', attrs, label);
    };

    const openUrl = publishedUrl(c);
    const raw = portUrl(c);
    /* A second open entry is only worth showing once there is a linked website
     * for it to differ from - otherwise the two say the same thing. */
    const showRaw = Boolean(c.site && raw && raw !== openUrl);

    return ui.el('div', { class: 'casa-menu' },
      item('⚙️ Settings', () => appDialog(c)),
      openUrl ? item('↗ Open', () => window.open(openUrl, '_blank', 'noopener')) : null,
      item(c.site ? '🌐 Website' : '🌐 Link website', () => linkModal(c)),
      showRaw ? item('↗ Open port', () => window.open(raw, '_blank', 'noopener')) : null,
      item('📋 Logs', () => logsModal(c)),
      item('💻 Terminal', () => appDialog(c, 'terminal')),
      ui.el('div', { class: 'msep' }),
      ...(c.state === 'running'
        ? [act('pause', '⏸ Pause'), act('restart', '↻ Restart'), act('stop', '⏹ Stop')]
        : c.state === 'paused'
          ? [act('unpause', '▶ Unpause'), act('stop', '⏹ Stop')]
          : [act('start', '▶ Start')]),
      ui.el('div', { class: 'msep' }),
      item('🗑 Uninstall', async () => {
        if (!(await ui.confirmBox(`Uninstall ${c.name}? It is stopped and deleted.`, { okText: 'Uninstall' }))) return;
        try { await api.del(`/docker/containers/${c.id}`); ui.toast(`${c.name} uninstalled`); load(); }
        catch (err) { ui.toast(err.message, true); }
      }, 'danger')
    );
  }

  /* Some containers only speak TLS on their published port - Portainer on 9443
   * is the common one. Sending http:// to a TLS socket is not a connection that
   * quietly upgrades: the far end answers 400 "The plain HTTP request was sent
   * to HTTPS port" and the browser shows that instead of the app, which reads
   * as the install having failed. So the scheme is asked, not assumed. */
  const TLS_ONLY = [
    { port: 9443, image: /portainer/i }
  ];
  function schemeFor(image, port) {
    return TLS_ONLY.some((t) => t.port === port && t.image.test(image)) ? 'https' : 'http';
  }

  /* The raw address: this container's own published port on this server. That
   * is what an app looks like before it has a name of its own. */
  function portUrl(c) {
    const first = String(c.ports || '').split(',')[0].trim();
    const m = first.match(/^(\d+)->/);
    if (!m) return null;
    const port = Number(m[1]);
    return `${schemeFor(c.image || '', port)}://${location.hostname || 'localhost'}:${port}`;
  }

  /* Where the container is opened from, when it publishes a port.
   *
   *  A linked website wins when there is one. That is the address meant for
   *  other people - a name on the normal ports, with a certificate - and it
   *  does not depend on which port happened to be published or on which
   *  scheme this particular image happens to speak. CasaOS's "Open" does the
   *  same job; the raw port stays in the menu for when the app matters more
   *  than the name. */
  function publishedUrl(c) {
    return (c.site && c.site.url) || portUrl(c);
  }

  /* Ask for the certificate, and say what came back.
   *
   *  certbot's own output is shown rather than a yes/no, because the one case
   *  where this matters is a name whose DNS does not point here yet - and
   *  "failed" tells nobody what to fix. The Sites page shows it the same way. */
  async function issueCert(site) {
    try {
      const r = await api.post(`/sites/${site.id}/ssl`);
      if (r.ok) {
        ui.toast(`Certificate issued for ${site.domain}`);
        load();
        return true;
      }
      ui.modal({
        title: `SSL for ${site.domain}`,
        body: ui.el('div', {},
          ui.el('p', { style: 'margin-top:0' },
            `No certificate yet. ${site.domain} has to resolve to this server `
            + 'before certbot can validate it - add an A record for it, then '
            + 'try again. The website itself already works over http:// in the '
            + 'meantime.'),
          ui.el('pre', { class: 'pre-log' }, r.output || '(no output)'))
      });
    } catch (e) {
      ui.toast(e.message, true);
    }
    load();
    return false;
  }

  /* Giving an app a hostname - and, once it has one, showing what it is now.
   *
   *  A linked site is an ordinary site record, so what is worth putting in
   *  front of the operator is only the three facts that differ: the address,
   *  whether there is a certificate yet, and how to take the link away. */
  function linkModal(c) {
    const ports = String(c.ports || '').split(',')
      .map((p) => p.trim().match(/^(\d+)->/))
      .filter(Boolean)
      .map((m) => Number(m[1]));

    if (c.site) {
      const s = c.site;
      ui.modal({
        title: `Website for ${c.name}`,
        body: ui.el('div', {},
          ui.el('p', { style: 'margin-top:0' }, 'This app is served at:'),
          ui.el('p', {},
            ui.el('a', { href: s.url, target: '_blank', rel: 'noopener' }, `${s.url} ↗`),
            ' ',
            s.ssl ? ui.badge('SSL', 'green') : ui.badge('no SSL yet', 'gray')),
          ui.el('p', { class: 'text-dim' },
            `${s.domain} forwards to port ${s.port} of ${c.name}.`),
          ui.el('div', { class: 'modal-actions' },
            s.ssl ? null : ui.el('button', {
              class: 'btn btn-primary',
              onclick: async (ev) => {
                const btn = ev.target;
                btn.disabled = true;
                /* Re-enabled either way: certbot refusing is the case where the
                 * operator most needs to press it again after adding the DNS
                 * record, so a failed attempt must not leave it stuck. */
                try { await issueCert(s); } finally { btn.disabled = false; }
              }
            }, '🔒 Get certificate'),
            ui.el('button', {
              class: 'btn btn-danger',
              onclick: async () => {
                if (!(await ui.confirmBox(
                  `Unlink ${s.domain} from ${c.name}? The website stops `
                  + 'serving this app, and its document root is removed.',
                  { okText: 'Unlink' }))) return;
                try {
                  await api.del(`/docker/containers/${c.id}/link?deleteFiles=true`);
                  ui.toast(`Unlinked ${s.domain}`);
                  load();
                } catch (e) { ui.toast(e.message, true); }
              }
            }, 'Unlink'))
        )
      });
      return;
    }

    const domain = textInput('app.example.com');
    const portSel = ui.el('select', {},
      ...ports.map((p) => ui.el('option', { value: String(p) }, String(p))));

    if (!ports.length) {
      ui.modal({
        title: `Website for ${c.name}`,
        body: ui.el('div', {},
          ui.el('p', { style: 'margin-top:0' },
            `${c.name} publishes no ports, so there is nothing for a website to `
            + 'forward to yet.'),
          ui.el('p', { class: 'text-dim' },
            'Add a port mapping in Settings first - a website can only reach '
            + 'what the container exposes.'))
      });
      return;
    }

    const go = ui.el('button', { class: 'btn btn-primary' }, 'Link website');
    const m = ui.modal({
      title: `Website for ${c.name}`,
      body: ui.el('div', {},
        ui.el('p', { class: 'text-dim', style: 'margin-top:0' },
          'Give the app a name: nginx serves it on the normal ports, with a '
          + 'certificate, instead of a port number nobody can remember. The '
          + 'app opens from its tile at this address afterwards.'),
        field('Hostname', domain, 'A name that already resolves to this server, e.g. app.example.com.'),
        field('Forward to', portSel, `Published by ${c.name}.`),
        ui.el('div', { class: 'modal-actions' }, go))
    });

    go.onclick = async () => {
      const host = domain.value.trim();
      if (!host) { ui.toast('Enter a hostname', true); return; }
      const done = busy(go, 'Linking…');
      try {
        const r = await api.post(`/docker/containers/${c.id}/link`, {
          domain: host, port: portSel.value
        });
        ui.toast(`Linked ${host} to ${c.name}`);
        m.close();
        /* The address is meant to be used over https, so ask for the
         * certificate as part of the same action rather than leaving a linked
         * app that silently only works over http. A DNS record that is not
         * there yet is reported inside issueCert, not swallowed. */
        await issueCert(r.site);
      } catch (e) {
        ui.toast(e.message, true);
      } finally {
        done();
      }
    };
  }

  /* The "+" CasaOS puts at the end of the grid: it goes to the store, which is
   * where an app comes from. */
  function addTile() {
    const t = ui.el('div', {
      class: 'casa-app casa-add', role: 'button', tabindex: '0',
      title: 'Install an app'
    }, ui.el('div', { class: 'casa-ico dashed' }, '+'),
      ui.el('div', { class: 'casa-app-name' }, 'Add app'));
    t.onclick = () => { page = 'store'; render(); };
    return t;
  }

  /* ------------------------------------------------ app settings -------- */
  /* The CasaOS settings dialog: a list down the side for each thing worth
   * looking at, and the container's own configuration behind each one.
   * Nothing here changes the container - ports, volumes and environment are
   * fixed when it is created - so the tabs offer a copy of what they show and
   * the actions that do apply. */
  function appDialog(c, tabId) {
    const body = ui.el('div', { class: 'casa-dialog' });
    const m = ui.modal({ title: c.name, wide: true, body });
    body.appendChild(ui.el('div', { class: 'text-dim' }, 'Loading…'));

    Promise.all([
      api.get(`/docker/containers/${c.id}/inspect`),
      api.get('/docker/stats'),
      api.get(`/docker/containers/${c.id}/compose`)
    ]).then(([d, s, comp]) => {
      if (!m.el.isConnected) return;
      stats = Object.fromEntries((s.stats || []).map((x) => [x.id, x]));
      body.innerHTML = '';
      body.appendChild(tabbed([
        { id: 'overview', label: 'Overview', node: overviewTab(d) },
        { id: 'ports', label: 'Ports', node: listTab('Published ports', d.ports, 'No ports are published.') },
        { id: 'env', label: 'Environment', node: envTab(d) },
        { id: 'volumes', label: 'Volumes', node: volumesTab(d) },
        { id: 'network', label: 'Network', node: networkTab(d) },
        { id: 'logs', label: 'Logs', node: logsBody(c) },
        { id: 'terminal', label: 'Terminal', node: terminalBody(c) },
        { id: 'installer', label: 'Installer', node: installerTab(comp) }
      ], tabId || 'overview'));
    }).catch((e) => {
      body.innerHTML = '';
      body.appendChild(ui.el('div', { class: 'banner' }, e.message));
    });

    return m;
  }

  /* A list down the left, one panel shown at a time. */
  function tabbed(tabs, activeId) {
    if (!tabs.some((t) => t.id === activeId)) activeId = tabs[0].id;
    const wrap = ui.el('div', { class: 'tabs' });
    const list = ui.el('div', { class: 'tab-list', role: 'tablist' });
    const panel = ui.el('div', { class: 'tab-panel' });
    const buttons = [];

    tabs.forEach((t) => {
      const b = ui.el('button', {
        class: `tab-item${t.id === activeId ? ' on' : ''}`, role: 'tab',
        'aria-selected': t.id === activeId ? 'true' : 'false'
      }, t.label);
      b.onclick = () => {
        activeId = t.id;
        tabs.forEach((o, n) => {
          buttons[n].classList.toggle('on', o.id === activeId);
          buttons[n].setAttribute('aria-selected', o.id === activeId ? 'true' : 'false');
        });
        panel.innerHTML = '';
        panel.appendChild(tabs.find((o) => o.id === activeId).node);
      };
      buttons.push(b);
      list.appendChild(b);
    });

    panel.appendChild(tabs.find((o) => o.id === activeId).node);
    wrap.append(list, panel);
    return wrap;
  }

  const row = (k, v) => ui.el('div', { class: 'kv-row' },
    ui.el('span', { class: 'kv-k' }, k), ui.el('span', { class: 'kv-v mono' }, v));

  function overviewTab(d) {
    const st = stats[d.id];
    const wrap = ui.el('div', {});
    if (st) wrap.appendChild(ui.el('div', { class: 'hero-grid', style: 'margin-bottom:14px' },
      statCard('CPU', '⚙️', 'cyan', `${(st.cpu || 0).toFixed(1)}% of all cores`, `${(st.cpu || 0).toFixed(1)}%`),
      statCard('Memory', '🧠', 'violet',
        `${ui.fmtBytes(st.memUsed)} of ${ui.fmtBytes(st.memLimit)}`, `${(st.memPct || 0).toFixed(1)}%`),
      statCard('Network', '🔀', 'green', `↓ ${ui.fmtBytes(st.netRx)} · ↑ ${ui.fmtBytes(st.netTx)}`, `${st.pids} pid`),
      statCard('Disk I/O', '💾', 'amber', `read ${ui.fmtBytes(st.blkRead)} · wrote ${ui.fmtBytes(st.blkWrite)}`, 'since start')
    ));
    wrap.appendChild(ui.el('div', { class: 'kv-list' },
      row('Image', d.image),
      d.command ? row('Command', d.command) : null,
      row('State', d.health ? `${d.state} (${d.health})` : d.state),
      row('Restart policy', d.restartPolicy),
      row('Network', d.networkMode || '–'),
      d.privileged ? row('Privileged', 'yes — this container is effectively root on the host') : null,
      row('Created', when(d.created)),
      d.started ? row('Started', `${when(d.started)} · ${ago(d.started)} ago`) : null
    ));
    return wrap;
  }

  function listTab(title, items, empty) {
    const wrap = ui.el('div', {});
    wrap.appendChild(ui.el('div', { class: 'tab-head' }, ui.el('span', {}, title)));
    if (!items || !items.length) {
      wrap.appendChild(ui.el('div', { class: 'text-dim' }, empty));
      return wrap;
    }
    wrap.appendChild(ui.el('div', { class: 'kv-list' },
      ...items.map((v) => ui.el('div', { class: 'kv-row' },
        ui.el('span', { class: 'kv-v mono', style: 'flex:1' }, String(v))))));
    return wrap;
  }

  function envTab(d) {
    const wrap = ui.el('div', {});
    const copy = ui.el('button', { class: 'btn btn-sm' }, '⧉ Copy');
    copy.onclick = () => copyText((d.env || []).map((e) => `${e.key}=${e.value}`).join('\n'), 'Environment copied');
    wrap.appendChild(ui.el('div', { class: 'tab-head' },
      ui.el('span', {}, `Environment (${(d.env || []).length})`),
      ui.el('span', { class: 'spacer' }), copy));
    if (!(d.env || []).length) {
      wrap.appendChild(ui.el('div', { class: 'text-dim' }, 'None set.'));
      return wrap;
    }
    wrap.appendChild(ui.el('div', { class: 'kv-list' },
      ...d.env.map((e) => row(e.key, e.value || ' '))));
    return wrap;
  }

  function volumesTab(d) {
    const mounts = d.mounts || [];
    const wrap = ui.el('div', {});
    wrap.appendChild(ui.el('div', { class: 'tab-head' },
      ui.el('span', {}, `Volumes (${mounts.length})`)));
    if (!mounts.length) {
      wrap.appendChild(ui.el('div', { class: 'text-dim' }, 'None mounted.'));
      return wrap;
    }
    wrap.appendChild(ui.el('div', { class: 'kv-list' },
      ...mounts.map((mnt) => ui.el('div', { class: 'kv-row' },
        ui.el('span', { class: 'kv-v mono', style: 'flex:1' }, `${mnt.source} → ${mnt.destination}`),
        ui.badge(mnt.rw ? 'rw' : 'ro', mnt.rw ? 'yellow' : 'gray')))));
    return wrap;
  }

  function networkTab(d) {
    const wrap = ui.el('div', {});
    wrap.appendChild(ui.el('div', { class: 'kv-list' },
      row('Mode', d.networkMode || '–'),
      row('Published', (d.ports || []).length ? d.ports.join(', ') : 'none')));
    wrap.appendChild(ui.el('p', { class: 'text-dim', style: 'font-size:12px' },
      'Networks the daemon knows about, with how many containers sit on each:'));
    const box = ui.el('div', { class: 'kv-list' }, ui.el('div', { class: 'text-dim' }, 'Loading…'));
    wrap.appendChild(box);
    api.get('/docker/networks').then((r) => {
      box.innerHTML = '';
      (r.networks || []).forEach((n) => box.appendChild(ui.el('div', { class: 'kv-row' },
        ui.el('span', { class: 'kv-v mono', style: 'flex:1' }, n.name),
        ui.el('span', { class: 'text-dim', style: 'font-size:11.5px' },
          `${n.driver}${n.gateway ? ` · ${n.gateway}` : ''} · ${n.containers} container(s)`))));
      if (!(r.networks || []).length) box.appendChild(ui.el('div', { class: 'text-dim' }, 'None.'));
    }).catch(() => { /* the list is a nicety, not the page */ });
    return wrap;
  }

  /* ---------------------------------------------------- logs ----------- */
  function logsBody(c) {
    const pre = ui.el('pre', { class: 'pre-log' }, 'Loading…');
    const fetchLogs = () => {
      api.get(`/docker/containers/${c.id}/logs?tail=500`).then((r) => {
        pre.textContent = r.logs || '(no output)';
        pre.scrollTop = pre.scrollHeight;
      }).catch((e) => { pre.textContent = e.message; });
    };
    const refresh = ui.el('button', { class: 'btn btn-sm', title: 'Reload' }, '↻');
    refresh.onclick = () => { pre.textContent = 'Loading…'; fetchLogs(); };
    fetchLogs();
    return ui.el('div', {},
      ui.el('div', { class: 'tab-head' },
        ui.el('span', {}, 'Last 500 lines'), ui.el('span', { class: 'spacer' }), refresh),
      pre);
  }

  function logsModal(c) {
    return ui.modal({ title: `Logs · ${c.name}`, wide: true, body: logsBody(c) });
  }

  /* ---------------------------------------------------- terminal -------- */
  /* One command and its output, rather than a PTY: this panel already has a
   * real web shell for the host, and a second interactive stream here would be
   * one nobody ever collects. */
  function terminalBody(c) {
    const input = ui.el('input', { type: 'text', class: 'term-in', placeholder: 'ls -la /var/www' });
    input.value = '';
    const out = ui.el('pre', { class: 'pre-log' }, 'Run a command to see its output.');
    const go = ui.el('button', { class: 'btn btn-primary btn-sm' }, 'Run');
    const runIt = async () => {
      const command = input.value.trim();
      if (!command) return;
      const done = busy(go, '…');
      out.textContent = 'Running…';
      try {
        const r = await api.post(`/docker/containers/${c.id}/exec`, { command });
        out.textContent = r.output || '(no output)';
        if (!r.ok) ui.toast('The command exited non-zero', true);
      } catch (e) {
        out.textContent = e.message;
        ui.toast(e.message, true);
      } finally { done(); }
    };
    go.onclick = runIt;
    input.onkeydown = (e) => { if (e.key === 'Enter') runIt(); };

    return ui.el('div', {},
      ui.el('div', { class: 'tab-head' },
        ui.el('span', {}, `Shell in ${c.name}`), ui.el('span', { class: 'spacer' }), go),
      ui.el('p', { class: 'text-dim', style: 'font-size:12px;margin-top:0' },
        'Runs through the container\'s own sh, with a 30 second limit.'),
      input, out);
  }

  function installerTab(comp) {
    const text = (comp && comp.compose) || '(nothing to show)';
    const pre = ui.el('pre', { class: 'pre-log' }, text);
    const copy = ui.el('button', { class: 'btn btn-sm' }, '⧉ Copy');
    copy.onclick = () => copyText((comp && comp.compose) || '', 'Compose file copied');
    return ui.el('div', {},
      ui.el('div', { class: 'tab-head' },
        ui.el('span', {}, 'docker-compose.yml'), ui.el('span', { class: 'spacer' }), copy),
      ui.el('p', { class: 'text-dim', style: 'font-size:12px;margin-top:0' },
        'Generated from the running container. Secret-looking values are masked.'),
      pre);
  }

  async function copyText(text, say) {
    try {
      await navigator.clipboard.writeText(text);
      ui.toast(say);
    } catch { ui.toast('The browser would not allow copying', true); }
  }

  /* ---------------------------------------------------- store ---------- */
  /* The part of CasaOS people install it for: a shelf of apps with an icon, a
   * line about what it is, and an Install that fills the run form in with the
   * ports, volumes and environment that app normally wants. */
  const STORE = [
    { name: 'Nginx', icon: 'nginx', cat: 'Web', image: 'nginx:alpine', desc: 'Web server and reverse proxy', ports: '8090:80', vol: '/var/www/site:/usr/share/nginx/html:ro' },
    { name: 'Caddy', icon: 'caddy', cat: 'Web', image: 'caddy:alpine', desc: 'Reverse proxy with automatic HTTPS', ports: '8091:80,8443:443' },
    { name: 'WordPress', icon: 'wordpress', cat: 'Web', image: 'wordpress:latest', desc: 'Publish a site in one click', ports: '8092:80', vol: '/var/www/wordpress:/var/www/html' },
    { name: 'MariaDB', icon: 'mariadb', cat: 'Database', image: 'mariadb:11', desc: 'SQL database for WordPress and friends', ports: '13306:3306', vol: '/var/lib/mysql:/var/lib/mysql', env: 'MYSQL_ROOT_PASSWORD=change-me\nMYSQL_DATABASE=app' },
    { name: 'PostgreSQL', icon: 'postgres', cat: 'Database', image: 'postgres:16', desc: 'Advanced SQL database', ports: '5432:5432', vol: '/var/lib/postgresql/data:/var/lib/postgresql/data', env: 'POSTGRES_PASSWORD=change-me' },
    { name: 'Redis', icon: 'redis', cat: 'Database', image: 'redis:7-alpine', desc: 'Cache and message broker', ports: '16379:6379' },
    { name: 'Portainer', icon: 'portainer', cat: 'Tools', image: 'portainer/portainer-ce:latest', desc: 'Manage Docker from a browser', ports: '9443:9443', vol: '/var/run/docker.sock:/var/run/docker.sock', vol2: '/data:/data' },
    { name: 'phpMyAdmin', icon: 'phpmyadmin', cat: 'Tools', image: 'phpmyadmin:latest', desc: 'MySQL over the web', ports: '8081:80' },
    { name: 'Uptime Kuma', icon: 'uptime', cat: 'Monitoring', image: 'louislam/uptime-kuma:1', desc: 'Get told when a service breaks', ports: '13001:3001', vol: '/var/lib/uptime-kuma:/app/data' },
    { name: 'Grafana', icon: 'grafana', cat: 'Monitoring', image: 'grafana/grafana:latest', desc: 'Dashboards from metrics', ports: '3000:3000', vol: '/var/lib/grafana:/var/lib/grafana' },
    { name: 'Prometheus', icon: 'prometheus', cat: 'Monitoring', image: 'prom/prometheus:latest', desc: 'Time-series metrics', ports: '9090:9090', vol: '/var/lib/prometheus:/prometheus' },
    { name: 'Pi-hole', icon: 'pihole', cat: 'Network', image: 'pihole/pihole:latest', desc: 'Network-wide ad blocking', ports: '1053:53/tcp,1053:53/udp,8082:80', vol: '/etc/pihole:/etc/pihole' },
    { name: 'WireGuard', icon: 'wireguard', cat: 'Network', image: 'linuxserver/wireguard:latest', desc: 'VPN into this server', ports: '51820:51820/udp', vol: '/etc/wireguard:/etc/wireguard' },
    { name: 'Jellyfin', icon: 'jellyfin', cat: 'Media', image: 'jellyfin/jellyfin:latest', desc: 'Stream your own media', ports: '8096:8096', vol: '/var/media:/media', vol2: '/var/lib/jellyfin:/config' },
    { name: 'Immich', icon: 'immich', cat: 'Media', image: 'ghcr.io/immich-app/immich-server:latest', desc: 'A photo library like the big ones', ports: '2283:2283', vol: '/var/lib/immich:/usr/src/app/upload' },
    { name: 'Nextcloud', icon: 'nextcloud', cat: 'Storage', image: 'nextcloud:latest', desc: 'Files, calendar and contacts', ports: '8093:80', vol: '/var/www/nextcloud:/var/www/html' },
    { name: 'MinIO', icon: 'minio', cat: 'Storage', image: 'minio/minio:latest', desc: 'S3-compatible object storage', ports: '9001:9001,9000:9000', vol: '/var/lib/minio:/data', env: 'MINIO_ROOT_USER=admin\nMINIO_ROOT_PASSWORD=change-me' },
    { name: 'Filebrowser', icon: 'filebrowser', cat: 'Storage', image: 'filebrowser/filebrowser:latest', desc: 'Browse files in a browser', ports: '8083:80', vol: '/srv:/srv' },
    { name: 'Syncthing', icon: 'syncthing', cat: 'Storage', image: 'syncthing/syncthing:latest', desc: 'Peer-to-peer file sync', ports: '8384:8384,22000:22000/tcp,22000:22000/udp', vol: '/var/syncthing:/var/syncthing' },
    { name: 'qBittorrent', icon: 'qbittorrent', cat: 'Download', image: 'lscr.io/linuxserver/qbittorrent:latest', desc: 'BitTorrent client', ports: '8084:8080,6881:6881', vol: '/var/lib/qbittorrent:/config', vol2: '/var/downloads:/downloads' },
    { name: 'Vaultwarden', icon: 'vaultwarden', cat: 'Tools', image: 'vaultwarden/server:latest', desc: 'A password vault you host yourself', ports: '8085:80', vol: '/var/lib/vaultwarden:/data' },
    { name: 'Gitea', icon: 'gitea', cat: 'Tools', image: 'gitea/gitea:latest', desc: 'Git hosting', ports: '3002:3000', vol: '/var/lib/gitea:/data' },
    { name: 'n8n', icon: 'n8n', cat: 'Tools', image: 'n8nio/n8n:latest', desc: 'Automate work between services', ports: '5678:5678', vol: '/var/lib/n8n:/home/node/.n8n' },
    { name: 'Ollama', icon: 'ollama', cat: 'AI', image: 'ollama/ollama:latest', desc: 'Run language models locally', ports: '11434:11434', vol: '/var/lib/ollama:/root/.ollama' }
  ];
  const STORE_CATS = ['All', ...Array.from(new Set(STORE.map((a) => a.cat)))];
  let storeCat = 'All';

  function storePage() {
    const wrap = ui.el('div', {});
    const needle = search.trim().toLowerCase();
    const apps = STORE.filter((a) => (storeCat === 'All' || a.cat === storeCat)
      && (!needle || `${a.name} ${a.desc} ${a.image}`.toLowerCase().includes(needle)));

    wrap.appendChild(ui.el('div', { class: 'casa-store-head' },
      ui.el('h3', {}, 'App Store'),
      ui.el('p', { class: 'text-dim' },
        'One click pulls the image and starts it with the ports and volumes that app '
        + 'normally wants. Everything is editable before it starts.')));

    wrap.appendChild(ui.el('div', { class: 'casa-cats' },
      ...STORE_CATS.map((cat) => {
        const b = ui.el('button', { class: `cat-chip${storeCat === cat ? ' on' : ''}` }, cat);
        b.onclick = () => { storeCat = cat; paintBody(); };
        return b;
      })));

    const grid = ui.el('div', { class: 'casa-store' });
    apps.forEach((a) => grid.appendChild(storeCard(a)));
    if (!apps.length) grid.appendChild(ui.el('div', { class: 'empty' }, 'No app matches that.'));

    wrap.appendChild(grid);
    return wrap;
  }

  function storeCard(a) {
    const icon = iconEl(a.icon, 62);
    const go = ui.el('button', { class: 'btn btn-sm btn-primary' }, 'Install');
    go.onclick = () => runModal(a);
    return ui.el('div', { class: 'casa-store-card' },
      icon,
      ui.el('div', { class: 'cs-name' }, a.name),
      ui.el('div', { class: 'cs-desc' }, a.desc),
      ui.el('div', { class: 'cs-foot' }, ui.badge(a.cat, 'gray'), go));
  }

  /* ---------------------------------------------------- run / pull ------ */
  /* A label wrapping its input is how every other form in the panel is built
   * (see the mailbox modal), and the stylesheet styles it that way. */
  const field = (label, input, hint) => ui.el('label', {}, label, input,
    hint ? ui.el('div', { class: 'text-dim', style: 'font-size:11.5px;margin-top:4px' }, hint) : null);

  function textInput(ph, value) {
    const i = ui.el('input', { type: 'text', placeholder: ph });
    i.value = value == null ? '' : String(value);
    return i;
  }

  function runModal(preset) {
    const p = preset || {};
    const image = textInput('nginx:alpine', p.image || '');
    const name = textInput('my-website', p.name || '');
    const command = textInput('sleep 3600', '');
    const ports = textInput('8080:80', p.ports || '');
    const volumes = textInput('/var/www/site:/usr/share/nginx/html:ro',
      [p.vol, p.vol2].filter(Boolean).join(', '));
    const env = ui.el('textarea', { rows: 4 });
    env.value = p.env || '';
    const restart = ui.el('select', {},
      ...['unless-stopped', 'always', 'on-failure', 'no'].map((v) =>
        ui.el('option', { value: v }, v)));
    restart.value = p.restart || 'unless-stopped';

    const start = ui.el('button', { class: 'btn btn-primary' }, 'Start container');
    const m = ui.modal({
      title: p.name ? `Install ${p.name}` : 'Run a container', wide: true,
      body: ui.el('div', {},
        p.desc ? ui.el('p', { class: 'text-dim', style: 'margin-top:0' }, p.desc) : null,
        ui.el('p', { class: 'text-dim', style: 'margin-top:0' },
          'The image is pulled if it is not already here. Ports and volumes are '
          + 'host-side: 8080:80 publishes container port 80 as 8080 on this server, '
          + 'and a volume is /host/path:/container/path, with :ro to keep it read-only.'),
        field('Image', image),
        field('Name', name, 'Letters, digits, dot, dash and underscore.'),
        field('Command', command, 'Optional: what to run instead of the image\'s own default — e.g. sleep 3600 to keep a shell image alive.'),
        field('Published ports', ports, 'Comma-separated host:container[/tcp|udp]. Leave empty to publish none.'),
        field('Volumes', volumes, 'Comma-separated /host:/container[:ro]. Absolute paths only.'),
        field('Environment', env, 'One KEY=value per line.'),
        field('Restart policy', restart),
        ui.el('div', { class: 'modal-actions' }, start)
      )
    });

    start.onclick = async () => {
      /* An image that is not here yet has to be downloaded first, and that is
       * minutes rather than milliseconds - so say which of the two is
       * happening. A button that only reads "Starting…" throughout a whole
       * image download looks stuck, which invites clicking it again. docker
       * writes an implicit :latest out in full, so a bare name is written out
       * the same way before the two are compared. */
      const typed = image.value.trim();
      const hasTag = typed.includes(':') || typed.includes('@');
      const local = await api.get('/docker/images')
        .then((d) => (d.images || []).some(
          (i) => (i.tags || []).includes(hasTag ? typed : `${typed}:latest`)))
        .catch(() => true);
      const done = busy(start, local ? 'Starting…' : 'Pulling image…');
      try {
        const r = await api.post('/docker/containers', {
          image: image.value.trim(), name: name.value.trim(), command: command.value,
          ports: ports.value, volumes: volumes.value, env: env.value, restart: restart.value
        });
        ui.toast(`Started ${r.name || name.value}`);
        m.close();
        page = 'apps';
        load();
      } catch (e) {
        ui.toast(e.message, true);
      } finally { done(); }
    };
  }

  function pullModal() {
    const image = textInput('nginx:alpine');
    const out = ui.el('pre', { class: 'pre-log', style: 'max-height:220px' }, '');
    const go = ui.el('button', { class: 'btn btn-primary' }, 'Pull');
    ui.modal({
      title: 'Pull an image', wide: true,
      body: ui.el('div', {},
        field('Image', image, 'Anything the Docker Hub, or this server\'s own registry, will serve.'),
        ui.el('div', { class: 'modal-actions' }, go),
        out)
    });
    go.onclick = async () => {
      const nm = image.value.trim();
      if (!nm) return;
      const done = busy(go, 'Pulling…');
      out.textContent = 'Contacting the registry…';
      try {
        const r = await api.post('/docker/pull', { image: nm });
        out.textContent = r.output || '(no output)';
        if (r.ok) { ui.toast(`Pulled ${nm}`); load(); }
        else ui.toast('The pull failed', true);
      } catch (e) {
        out.textContent = e.message;
        ui.toast(e.message, true);
      } finally { done(); }
    };
  }

  async function prune() {
    if (!(await ui.confirmBox(
      'Remove every stopped container, dangling image and unused network?\n'
      + 'Running containers and tagged images are untouched.', { okText: 'Reclaim space' }))) return;
    try {
      const r = await api.post('/docker/system/prune', {});
      ui.toast(`Reclaimed ${ui.fmtBytes(r.reclaimed)} — ${r.containers} container(s), ${r.images} image(s), ${r.networks} network(s)`);
      load();
    } catch (e) { ui.toast(e.message, true); }
  }

  /* ---------------------------------------------------- the pages ------ */
  function appsPage() {
    const list = (payload && payload.containers.containers) || [];
    const running = list.filter((c) => c.state === 'running').length;

    const head = ui.el('div', { class: 'casa-head' },
      ui.el('h3', {}, 'Apps'),
      ui.el('span', { class: 'text-dim' },
        `${running} of ${list.length} running`
        + (payload ? ` · ${ui.fmtBytes((payload.df.images || {}).size)} in images` : '')),
      ui.el('span', { class: 'spacer' }));
    const box = ui.el('label', { class: 'checkbox-label' },
      ui.el('input', { type: 'checkbox' }), ' running only');
    const cb = box.querySelector('input');
    cb.checked = runningOnly;
    cb.onchange = (e) => { runningOnly = e.target.checked; paintGrid(); };
    head.appendChild(box);

    gridEl = ui.el('div', { class: 'casa-grid' });
    return [head, gridEl, ui.el('div', { class: 'empty casa-empty' })];
  }

  function imagesPage() {
    const imgs = (payload && payload.images.images) || [];
    const wrap = ui.el('div', {});
    const pull = ui.el('button', { class: 'btn btn-sm' }, '⬇ Pull image');
    pull.onclick = () => pullModal();
    wrap.appendChild(ui.el('div', { class: 'casa-head' },
      ui.el('h3', {}, `Images (${imgs.length})`),
      ui.el('span', { class: 'spacer' }), pull));
    if (!imgs.length) {
      wrap.appendChild(ui.el('div', { class: 'empty' }, 'No images. Pull one to get started.'));
      return [wrap];
    }
    wrap.appendChild(ui.el('div', { class: 'card' },
      ui.el('div', { class: 'table-wrap' },
        ui.el('table', {},
          ui.el('thead', {}, ui.el('tr', {},
            ui.el('th', {}, 'Tags'), ui.el('th', {}, 'Size'),
            ui.el('th', {}, 'In use'), ui.el('th', {}, 'Created'), ui.el('th', {}, ''))),
          ui.el('tbody', {}, ...imgs.map(imageRow))))));
    return [wrap];
  }

  /* Volumes and Networks are not in the container listing, so they ask the
   * daemon when the dock opens them. */
  function listPage(title, endpoint, build) {
    const wrap = ui.el('div', {});
    wrap.appendChild(ui.el('div', { class: 'casa-head' }, ui.el('h3', {}, title),
      ui.el('span', { class: 'spacer' })));
    const box = ui.el('div', { class: 'card' }, ui.el('div', { class: 'text-dim' }, 'Loading…'));
    wrap.appendChild(box);
    api.get(endpoint).then((r) => {
      if (!wrap.isConnected) return;
      box.innerHTML = '';
      const rows = build.rows(r);
      if (!rows.length) {
        box.appendChild(ui.el('div', { class: 'empty' }, build.empty));
        return;
      }
      box.appendChild(ui.el('div', { class: 'table-wrap' },
        ui.el('table', {},
          ui.el('thead', {}, ui.el('tr', {}, ...build.head.map((h) => ui.el('th', {}, h)))),
          ui.el('tbody', {}, ...rows.map(build.row)))));
    }).catch((e) => {
      box.innerHTML = '';
      box.appendChild(ui.el('div', { class: 'banner' }, e.message));
    });
    return [wrap];
  }

  const volumesPage = () => listPage('Volumes', '/docker/volumes', {
    empty: 'No volumes. Containers that keep their data create them.',
    head: ['Name', 'Driver', 'Size', 'Used by', 'Mountpoint'],
    rows: (r) => r.volumes || [],
    row: (v) => ui.el('tr', {},
      ui.el('td', { class: 'mono', style: 'font-size:12px' }, v.name),
      ui.el('td', {}, v.driver),
      ui.el('td', {}, ui.fmtBytes(v.size)),
      ui.el('td', {}, v.refCount ? ui.badge(`${v.refCount} container(s)`, 'green') : ui.badge('unused', 'gray')),
      ui.el('td', { class: 'mono text-dim', style: 'font-size:11.5px' }, v.mountpoint))
  });

  const networksPage = () => listPage('Networks', '/docker/networks', {
    empty: 'No networks.',
    head: ['Name', 'Driver', 'Scope', 'Subnet', 'Containers'],
    rows: (r) => r.networks || [],
    row: (n) => ui.el('tr', {},
      ui.el('td', { class: 'mono', style: 'font-size:12px' }, n.name),
      ui.el('td', {}, n.driver),
      ui.el('td', {}, n.scope),
      ui.el('td', { class: 'mono text-dim', style: 'font-size:11.5px' }, n.gateway || '–'),
      ui.el('td', {}, n.containers ? ui.badge(String(n.containers), 'green') : ui.badge('0', 'gray')))
  });

  function imageRow(img) {
    const tag = (img.tags && img.tags.length && img.tags[0] !== '<none>') ? img.tags[0] : img.id;
    const run = ui.el('button', { class: 'btn btn-sm', title: 'Run this image' }, '▶');
    run.onclick = () => runModal({ image: tag, name: tag.split('/').pop().split(':')[0] });
    const del = ui.el('button', { class: 'btn btn-sm btn-danger' }, '🗑');
    del.onclick = async () => {
      if (!(await ui.confirmBox(`Delete image ${tag}? Containers using it are unaffected.`,
        { okText: 'Delete' }))) return;
      try { await api.del(`/docker/images/${img.id}`); ui.toast('Image deleted'); load(); }
      catch (e) { ui.toast(e.message, true); }
    };
    return ui.el('tr', {},
      ui.el('td', { class: 'mono', style: 'font-size:12px' },
        ui.el('div', {}, tag),
        img.tags && img.tags.length > 1
          ? ui.el('div', { class: 'text-dim', style: 'font-size:11px' },
            `+${img.tags.length - 1} more tag(s)`) : null),
      ui.el('td', {}, ui.fmtBytes(img.size)),
      ui.el('td', {}, img.containers === null
        ? ui.el('span', { class: 'text-dim' }, '–')
        : ui.badge(img.containers > 0 ? `${img.containers} running` : 'unused',
          img.containers > 0 ? 'green' : 'gray')),
      ui.el('td', { class: 'text-dim', style: 'font-size:12px' }, when(img.created * 1000)),
      ui.el('td', { style: 'text-align:right' }, run, ' ', del));
  }

  /* Rebuild only the middle, so the search box keeps its focus and its caret
   * while a keystroke is changing what is on screen. */
  function paintBody() {
    if (!bodyEl) return;
    bodyEl.innerHTML = '';
    gridEl = null;
    const parts = page === 'apps' ? appsPage()
      : page === 'store' ? [storePage()]
        : page === 'images' ? imagesPage()
          : page === 'volumes' ? volumesPage()
            : networksPage();
    parts.forEach((p) => bodyEl.appendChild(p));
    if (page === 'apps') paintGrid();
  }

  function render() {
    if (!rootEl) return;
    stopLive();
    rootEl.innerHTML = '';
    const desk = ui.el('div', { class: 'casa' });
    rootEl.appendChild(desk);

    desk.appendChild(topBar());
    bodyEl = ui.el('div', { class: 'casa-body' });
    desk.appendChild(bodyEl);
    desk.appendChild(dock());

    paintBody();
    paintWidgets();
    startLive();
  }

  /* ---------------------------------------------------- load ----------- */
  async function load() {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    bodyEl = null;
    gridEl = null;
    let containers, images, info, df;
    try {
      [containers, images, info, df] = await Promise.all([
        api.get('/docker/containers'),
        api.get('/docker/images'),
        api.get('/docker/info'),
        api.get('/docker/df')
      ]);
    } catch (e) {
      stopLive();
      rootEl.appendChild(ui.el('div', { class: 'card empty' },
        ui.el('h3', {}, 'Docker is not available'),
        ui.el('p', {}, e.message),
        ui.el('a', { class: 'btn btn-primary', href: '#/setup' }, '🧩 Open Setup Wizard')));
      return;
    }

    payload = { containers, images, df };

    /* One reading for every running container, so the tiles can show what each
     * one is using without a request per tile. */
    api.get('/docker/stats').then((s) => {
      if (!rootEl || !rootEl.isConnected) return;
      stats = Object.fromEntries((s.stats || []).map((x) => [x.id, x]));
      render();
    }).catch(() => { render(); });
  }

  /* Clicking anywhere outside a menu closes it. The ⋯ button and the menu
   * entries stopPropagation, so they do not trip this. */
  document.addEventListener('click', () => closeMenus());
  document.addEventListener('contextmenu', (e) => {
    if (openMenu && !(openMenu.contains && openMenu.contains(e.target))) closeMenus();
  });

  return {
    render: (root) => { rootEl = root; return load(); },
    destroy: () => { stopLive(); closeMenus(); rootEl = null; bodyEl = null; gridEl = null; }
  };
})();
