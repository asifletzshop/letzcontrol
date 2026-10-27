'use strict';
/* Websites view: card grid with real previews, create, edit, SSL, toggle, delete */
window.SitesView = (() => {
  const BACKENDS = ['nginx', 'apache', 'openlitespeed', 'node'];
  const NO_PHP = ['node'];

  async function load(root, me) {
    const [{ sites }, { backends, ports }, php, usersData, fieldsData, pstatus] = await Promise.all([
      api.get('/sites'),
      api.get('/sites/backends'),
      api.get('/php').catch(() => ({ versions: [], ols: [] })),
      me.role === 'admin' ? api.get('/users') : Promise.resolve({ users: [] }),
      api.get('/sites/phpini/fields').catch(() => ({ fields: [] })),
      api.get('/sites/previews/status').catch(() => ({ available: false }))
    ]);
    const users = usersData.users;
    const iniFields = fieldsData.fields;
    const fpmVersions = php.versions || [];
    const olsVersions = php.ols || [];
    const chrome = pstatus.available;

    const phpOptions = (backend) => {
      if (NO_PHP.includes(backend)) return [];
      return (backend === 'openlitespeed' ? olsVersions : fpmVersions)
        .filter((x) => (backend === 'openlitespeed' ? true : x.fpmInstalled !== false));
    };

    root.innerHTML = '';

    // Header bar with actions
    const header = ui.el('div', { class: 'sites-header' },
      ui.el('div', { class: 'sites-title' },
        ui.el('h2', {}, 'Websites'),
        ui.el('span', { class: 'sites-count' }, `${sites.length} site${sites.length !== 1 ? 's' : ''}`)
      ),
      ui.el('div', { class: 'toolbar' },
        chrome ? ui.el('button', { class: 'btn btn-sm', onclick: () => refreshAllPreviews(root, me) }, '🔄 Refresh previews') : null,
        ui.el('button', { class: 'btn btn-primary', onclick: () => createModal(root, me, backends, ports, users, phpOptions) }, '+ Add Website')
      )
    );
    root.appendChild(header);

    if (!backends.nginx && !backends.apache && !backends.openlitespeed) {
      root.appendChild(ui.el('div', { class: 'banner' },
        'No web server detected. Install nginx, apache2 and/or openlitespeed to host websites.'));
      return;
    }

    if (!sites.length) {
      root.appendChild(ui.el('div', { class: 'card empty' },
        ui.el('div', { class: 'empty-icon' }, '🌐'),
        ui.el('p', {}, 'No websites yet'),
        ui.el('p', { class: 'text-dim' }, 'Click "+ Add Website" to create your first site.')
      ));
      return;
    }

    // Card grid
    const grid = ui.el('div', { class: 'sites-grid' });
    for (const s of sites) {
      grid.appendChild(siteCard(root, me, s, backends, ports, phpOptions, users, iniFields, chrome));
    }
    root.appendChild(grid);
  }

  function siteCard(root, me, s, backends, ports, phpOptions, users, iniFields, chrome) {
    const card = ui.el('div', { class: 'site-preview-card' });

    // Preview image area
    const previewBox = ui.el('div', { class: 'preview-box' },
      ui.el('div', { class: 'preview-loading', style: chrome ? 'display:flex' : 'display:none' },
        ui.el('span', { class: 'spinner' })
      ),
      ui.el('img', {
        class: 'preview-img',
        loading: 'lazy',
        alt: s.domain,
        style: 'display:none',
        onload: function() { this.style.display = 'block'; this.previousElementSibling.style.display = 'none'; },
        onerror: function() { this.style.display = 'none'; this.previousElementSibling.style.display = 'flex'; this.previousElementSibling.innerHTML = '⚠️'; }
      })
    );
    // Set the preview URL (will 404 if none exists, image handles it)
    if (chrome) {
      previewBox.querySelector('img').src = `/api/sites/previews/${s.domain}`;
    } else {
      previewBox.querySelector('.preview-loading').innerHTML = '🖼️';
      previewBox.querySelector('.preview-loading').style.display = 'flex';
    }

    // Domain bar
    const domainBar = ui.el('div', { class: 'preview-domain-bar' },
      ui.el('a', { href: `http://${s.domain}`, target: '_blank', rel: 'noopener', class: 'preview-domain' }, s.domain),
      ui.el('a', { href: `http://${s.domain}`, target: '_blank', rel: 'noopener', class: 'preview-open', title: 'Open site' }, '↗')
    );

    // Status row
    const statusDot = ui.el('span', { class: 'dot ' + (s.enabled === false ? 'idle' : 'ok') });
    const statusText = s.enabled === false ? 'disabled' : 'active';
    const statusBadges = ui.el('div', { class: 'preview-badges' },
      ui.badge(s.backend, s.backend === 'nginx' ? 'green' : s.backend === 'apache' ? 'yellow' : s.backend === 'node' ? 'gray' : 'blue'),
      s.ssl ? ui.badge('SSL', 'green') : null,
      s.enabled === false ? ui.badge('off', 'red') : null,
      s.phpVersion ? ui.badge('PHP ' + s.phpVersion, 'green') : null
    );

    // Disk & Traffic stats
    const diskMb = s.diskMb || 0;
    const trafficMb = s.trafficMb || 0;
    const statsRow = ui.el('div', { class: 'preview-stats' },
      ui.el('span', { title: 'Disk space used' }, '💾 ' + (diskMb >= 1024 ? (diskMb / 1024).toFixed(1) + ' GB' : diskMb + ' MB')),
      ui.el('span', { title: 'Traffic this month' }, '📊 ' + (trafficMb >= 1024 ? (trafficMb / 1024).toFixed(1) + ' GB' : trafficMb + ' MB'))
    );

    // PHP switcher (inline)
    const phpSel = ui.el('select', { class: 'preview-php-select' });
    phpSel.appendChild(ui.el('option', { value: '' }, 'static'));
    const opts = phpOptions(s.backend);
    for (const v of opts) phpSel.appendChild(ui.el('option', { value: v.version }, v.version));
    if (s.phpVersion && !opts.some((v) => v.version === s.phpVersion)) {
      phpSel.appendChild(ui.el('option', { value: s.phpVersion }, `${s.phpVersion} (not installed)`));
    }
    phpSel.value = s.phpVersion || '';
    phpSel.onchange = async () => {
      try {
        await api.put(`/sites/${s.id}`, { phpVersion: phpSel.value || null });
        ui.toast(`PHP updated for ${s.domain}`);
        load(root, me);
      } catch (e) { ui.toast(e.message, true); }
    };

    // Action buttons
    const actions = ui.el('div', { class: 'preview-actions' },
      ui.el('button', { class: 'btn btn-sm', onclick: () => editModal(root, me, s, backends, ports, phpOptions, users) }, '⚙️'),
      ui.el('button', { class: 'btn btn-sm', onclick: () => {
        location.hash = '#/files?path=' + encodeURIComponent((s.docroot || '') + '/public');
      }, title: 'Files' }, '📂'),
      ui.el('button', { class: 'btn btn-sm', onclick: () => folderModal(root, me, s), title: 'Folder' }, '🗂'),
      ui.el('button', { class: 'btn btn-sm', onclick: () => dnsModal(root, me, s), title: 'DNS' }, '🧭'),
      ui.el('button', { class: 'btn btn-sm', onclick: () => wpModal(root, me, s), title: 'WordPress' }, '🛰'),
      ui.el('button', { class: 'btn btn-sm', onclick: async () => {
        try {
          const r = await api.post(`/sites/${s.id}/ssl`);
          ui.modal({ title: `SSL for ${s.domain}`, body: ui.el('pre', { class: 'pre-log' }, r.output || (r.ok ? 'Certificate issued.' : 'Failed')) });
          load(root, me);
        } catch (e) { ui.toast(e.message, true); }
      }, title: 'SSL' }, '🔒'),
      ui.el('button', { class: 'btn btn-sm', onclick: async () => {
        try { await api.post(`/sites/${s.id}/toggle`); load(root, me); }
        catch (e) { ui.toast(e.message, true); }
      }, title: s.enabled === false ? 'Enable' : 'Disable' }, s.enabled === false ? '▶' : '⏸'),
      ui.el('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
        if (!(await ui.confirmBox(`Delete ${s.domain}?`, { okText: 'Delete' }))) return;
        try { await api.del(`/sites/${s.id}`); ui.toast(`Deleted ${s.domain}`); load(root, me); }
        catch (e) { ui.toast(e.message, true); }
      }, title: 'Delete' }, '🗑️')
    );

    card.appendChild(previewBox);
    card.appendChild(domainBar);
    card.appendChild(ui.el('div', { class: 'preview-status' },
      ui.el('div', { class: 'preview-status-left' }, statusDot, statusText, statusBadges),
      ui.el('div', { class: 'preview-php' }, phpSel)
    ));
    card.appendChild(statsRow);
    card.appendChild(actions);

    // Owner (admin only)
    if (me.role === 'admin' && s.owner) {
      card.appendChild(ui.el('div', { class: 'preview-owner' }, '👤 ' + s.owner));
    }

    return card;
  }

  async function refreshAllPreviews(root, me) {
    ui.toast('Refreshing previews...', false);
    try {
      const r = await api.post('/sites/previews/refresh', {});
      ui.toast(`Previews updated (${r.taken} taken, ${r.failed} failed)`);
      load(root, me);
    } catch (e) { ui.toast(e.message, true); }
  }

  /* ------------------------------------------------------------------ */
  /* Folder modal - change document root                                */
  /* ------------------------------------------------------------------ */
  function folderModal(root, me, s) {
    const body = ui.el('div', {});
    const docrootIn = ui.el('input', { type: 'text', value: s.docroot || '', placeholder: '/var/www/' + s.domain });
    body.appendChild(ui.el('label', {}, 'Document Root', docrootIn));
    body.appendChild(ui.el('p', { class: 'text-dim' }, 'Full path to the website files. Changes take effect immediately.'));

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const save = ui.el('button', { class: 'btn btn-primary' }, 'Save');
    actions.append(cancel, save);
    body.appendChild(actions);

    const m = ui.modal({ title: `Folder: ${s.domain}`, body });
    cancel.onclick = m.close;
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api.put(`/sites/${s.id}/docroot`, { docroot: docrootIn.value.trim() });
        m.close();
        ui.toast('Document root updated');
        load(root, me);
      } catch (e) { ui.toast(e.message, true); save.disabled = false; }
    };
  }

  /* ------------------------------------------------------------------ */
  /* DNS modal - show DNS records / manage zone                        */
  /* ------------------------------------------------------------------ */
  async function dnsModal(root, me, s) {
    const loading = ui.el('div', { style: 'text-align:center;padding:20px' }, ui.el('span', { class: 'spinner' }), ' Loading DNS...');
    const body = ui.el('div', {}, loading);

    const m = ui.modal({ title: `DNS: ${s.domain}`, body, wide: true });

    try {
      // Get all DNS zones and find one matching this domain
      const zones = await api.get('/dns/zones');
      const zone = zones.find(z => z.domain === s.domain || s.domain.endsWith('.' + z.domain));

      if (!zone) {
        body.innerHTML = '';
        body.appendChild(ui.el('p', {}, 'No DNS zone found for this domain.'));
        body.appendChild(ui.el('p', { class: 'text-dim' }, 'Add a DNS zone in the DNS section to manage records.'));
        return;
      }

      // Show zone info and records
      body.innerHTML = '';
      body.appendChild(ui.el('h4', {}, `Zone: ${zone.domain}`));
      body.appendChild(ui.el('p', { class: 'text-dim' }, `NS records: ${zone.ns.join(', ')}`));

      const recs = ui.el('table', { class: 'table' },
        ui.el('thead', {}, ui.el('tr', {},
          ui.el('th', {}, 'Type'), ui.el('th', {}, 'Name'), ui.el('th', {}, 'Value'), ui.el('th', {}, 'TTL')
        )),
        ui.el('tbody', {})
      );
      const tbody = recs.querySelector('tbody');

      // Add common records for this site
      const records = [
        { type: 'A', name: '@', value: config.serverIp || 'YOUR_SERVER_IP', ttl: 3600 },
        { type: 'A', name: 'www', value: config.serverIp || 'YOUR_SERVER_IP', ttl: 3600 },
        { type: 'CNAME', name: 'mail', value: 'mail.' + zone.domain, ttl: 3600 },
        { type: 'CNAME', name: 'smtp', value: 'mail.' + zone.domain, ttl: 3600 },
        { type: 'CNAME', name: 'pop', value: 'mail.' + zone.domain, ttl: 3600 },
        { type: 'CNAME', name: 'imap', value: 'mail.' + zone.domain, ttl: 3600 },
        { type: 'TXT', name: '@', value: 'v=spf1 a mx ~all', ttl: 3600 },
      ];

      for (const r of records) {
        tbody.appendChild(ui.el('tr', {},
          ui.el('td', { class: 'badge' }, r.type),
          ui.el('td', {}, r.name),
          ui.el('td', { style: 'word-break:break-all' }, r.value),
          ui.el('td', {}, r.ttl.toString())
        ));
      }
      body.appendChild(recs);

    } catch (e) {
      body.innerHTML = '';
      body.appendChild(ui.el('p', { style: 'color:var(--danger)' }, e.message));
    }
  }

  /* ------------------------------------------------------------------ */
  /* WordPress modal - status, install, manage                          */
  /* ------------------------------------------------------------------ */
  async function wpModal(root, me, s) {
    const loading = ui.el('div', { style: 'text-align:center;padding:20px' }, ui.el('span', { class: 'spinner' }), ' Checking WordPress...');
    const body = ui.el('div', {}, loading);

    const m = ui.modal({ title: `WordPress: ${s.domain}`, body, wide: true });

    try {
      const wp = await api.get(`/wordpress/${s.id}/status`);

      body.innerHTML = '';
      if (!wp.installed) {
        // Not installed - show install button
        body.appendChild(ui.el('p', {}, 'WordPress is not installed on this site.'));
        const installBtn = ui.el('button', { class: 'btn btn-primary' }, 'Install WordPress');
        installBtn.onclick = async () => {
          installBtn.disabled = true;
          installBtn.textContent = 'Installing...';
          try {
            const r = await api.post(`/wordpress/${s.id}/install`, {});
            ui.toast(r.ok ? 'WordPress installed!' : 'Install failed: ' + r.error);
            load(root, me);
            m.close();
          } catch (e) { ui.toast(e.message, true); installBtn.disabled = false; }
        };
        body.appendChild(installBtn);
        return;
      }

      // Show WordPress status
      body.appendChild(ui.el('h4', {}, `WordPress ${wp.version}`));
      body.appendChild(ui.el('div', { class: 'preview-badges', style: 'margin-bottom:16px' },
        ui.badge(wp.siteTitle || 'Untitled', 'blue'),
        ui.badge(wp.phpVersion || 'PHP ?', 'green'),
        wp.updateAvailable ? ui.badge('Update available', 'yellow') : ui.badge('Up to date', 'green')
      ));

      // Quick actions
      const actionsRow = ui.el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px' });

      actionsRow.appendChild(ui.el('button', { class: 'btn btn-sm', onclick: async () => {
        try {
          await api.post(`/wordpress/${s.id}/cache`, { action: 'clear' });
          ui.toast('Cache cleared');
        } catch (e) { ui.toast(e.message, true); }
      }}, '🧹 Clear cache'));

      if (wp.updateAvailable) {
        const updateBtn = ui.el('button', { class: 'btn btn-sm btn-primary' }, 'Update core');
        updateBtn.onclick = async () => {
          updateBtn.disabled = true; updateBtn.textContent = 'Updating...';
          try {
            await api.post(`/wordpress/${s.id}/core-update`, {});
            ui.toast('WordPress updated');
            load(root, me);
            m.close();
          } catch (e) { ui.toast(e.message, true); updateBtn.disabled = false; }
        };
        actionsRow.appendChild(updateBtn);
      }

      body.appendChild(actionsRow);

      // Site health
      if (wp.health) {
        const healthEl = ui.el('div', { class: 'card' },
          ui.el('h4', {}, 'Site Health'),
          ui.el('div', { class: 'preview-badges' },
            ui.badge(`Health score: ${wp.health.score}/100`, wp.health.score >= 80 ? 'green' : wp.health.score >= 50 ? 'yellow' : 'red')
          )
        );
        body.appendChild(healthEl);
      }

    } catch (e) {
      body.innerHTML = '';
      body.appendChild(ui.el('p', { style: 'color:var(--danger)' }, e.message));
    }
  }

  function createModal(root, me, backends, ports, users, phpOptions) {
    const body = ui.el('div', {});
    body.appendChild(ui.el('label', {}, 'Domain name',
      ui.el('input', { type: 'text', id: 'site-domain', placeholder: 'example.com' })));

    const backendSel = ui.el('select', { id: 'site-backend' });
    for (const b of BACKENDS) {
      const opt = ui.el('option', { value: b }, `${b}${backends[b] ? '' : ' (not installed)'}`);
      if (!backends[b]) opt.disabled = true;
      backendSel.appendChild(opt);
    }
    body.appendChild(ui.el('label', {}, 'Served by', backendSel));

    const hint = ui.el('p', { class: 'text-dim', style: 'margin-top:-8px' });
    const updateHint = () => {
      const b = backendSel.value;
      hint.textContent = b === 'nginx' ? 'Nginx serves this site directly on port 80/443.'
        : b === 'node' ? `Nginx proxies to the app's own port ${ports[b]}.`
        : `${b} serves the site on internal port ${ports[b]}; Nginx proxies port 80/443 to it.`;
    };
    backendSel.onchange = updateHint;
    updateHint();
    body.appendChild(hint);

    const phpSel = ui.el('select', { id: 'site-php' }, ui.el('option', { value: '' }, 'None (static site)'));
    const fillPhp = () => {
      phpSel.replaceChildren(ui.el('option', { value: '' }, 'None (static site)'));
      for (const v of phpOptions(backendSel.value)) phpSel.appendChild(ui.el('option', { value: v.version }, `PHP ${v.version}`));
    };
    fillPhp();
    backendSel.addEventListener('change', fillPhp);
    body.appendChild(ui.el('label', {}, 'PHP version', phpSel));

    const wwwChk = ui.el('input', { type: 'checkbox', id: 'site-www', checked: '' });
    body.appendChild(ui.el('label', { class: 'checkbox-label' }, wwwChk, 'Also create www.<domain> alias'));

    const docrootIn = ui.el('input', { type: 'text', id: 'site-docroot', placeholder: 'leave blank for default folder' });
    body.appendChild(ui.el('label', {}, 'Document root folder (optional)', docrootIn));

    if (me.role === 'admin' && users && users.length) {
      const ownerSel = ui.el('select', { id: 'site-owner' });
      for (const u of users) ownerSel.appendChild(ui.el('option', { value: u.id }, `${u.username} (${u.role})`));
      ownerSel.value = me.id;
      body.appendChild(ui.el('label', {}, 'Owner', ownerSel));
    }

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const create = ui.el('button', { class: 'btn btn-primary' }, 'Create website');
    actions.append(cancel, create);
    body.appendChild(actions);

    const m = ui.modal({ title: 'Add Website', body });
    cancel.onclick = m.close;
    create.onclick = async () => {
      create.disabled = true;
      try {
        const r = await api.post('/sites', {
          domain: document.getElementById('site-domain').value,
          backend: backendSel.value,
          phpVersion: phpSel.value || null,
          www: wwwChk.checked,
          docroot: docrootIn.value.trim() || undefined,
          ownerId: document.getElementById('site-owner') ? document.getElementById('site-owner').value : undefined
        });
        m.close();
        ui.toast(`Website ${r.site.domain} created`);
        load(root, me);
      } catch (e) { ui.toast(e.message, true); create.disabled = false; }
    };
  }

  function editModal(root, me, s, backends, ports, phpOptions, users) {
    const body = ui.el('div', {});
    body.appendChild(ui.el('label', {}, 'Domain', ui.el('input', { type: 'text', value: s.domain, readonly: '' })));

    const backendSel = ui.el('select', { id: 'site-backend-edit' });
    for (const b of BACKENDS) {
      const isCurrent = b === s.backend;
      const opt = ui.el('option', { value: b }, `${b}${backends[b] || isCurrent ? '' : ' (not installed)'}`);
      if (!backends[b] && !isCurrent) opt.disabled = true;
      backendSel.appendChild(opt);
    }
    backendSel.value = s.backend;
    body.appendChild(ui.el('label', {}, 'Served by', backendSel));

    const phpSel = ui.el('select', { id: 'site-php-edit' }, ui.el('option', { value: '' }, 'None (static site)'));
    const fillPhp = () => {
      phpSel.replaceChildren(ui.el('option', { value: '' }, 'None (static site)'));
      const opts = phpOptions(backendSel.value);
      for (const v of opts) phpSel.appendChild(ui.el('option', { value: v.version }, `PHP ${v.version}`));
      if (s.phpVersion && !opts.some((v) => v.version === s.phpVersion)) {
        phpSel.appendChild(ui.el('option', { value: s.phpVersion }, `PHP ${s.phpVersion} (not installed)`));
      }
      phpSel.value = s.phpVersion || '';
    };
    fillPhp();
    backendSel.addEventListener('change', fillPhp);
    body.appendChild(ui.el('label', {}, 'PHP version', phpSel));

    const wwwChk = ui.el('input', { type: 'checkbox', id: 'site-www-edit' });
    wwwChk.checked = !!s.www;
    body.appendChild(ui.el('label', { class: 'checkbox-label' }, wwwChk, 'Also serve www.<domain>'));

    if (me.role === 'admin' && users && users.length) {
      const ownerSel = ui.el('select', { id: 'site-owner-edit' });
      for (const u of users) ownerSel.appendChild(ui.el('option', { value: u.id }, `${u.username} (${u.role})`));
      ownerSel.value = s.ownerId || me.id;
      body.appendChild(ui.el('label', {}, 'Owner', ownerSel));
    }

    body.appendChild(ui.el('p', { class: 'text-dim' }, `Docroot: ${s.docroot}${s.owner ? ` · Owner: ${s.owner}` : ''}`));

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const save = ui.el('button', { class: 'btn btn-primary' }, 'Save');
    actions.append(cancel, save);
    body.appendChild(actions);

    const m = ui.modal({ title: `Edit ${s.domain}`, body });
    cancel.onclick = m.close;
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api.put(`/sites/${s.id}`, {
          backend: backendSel.value,
          phpVersion: phpSel.value || null,
          www: wwwChk.checked,
          ownerId: document.getElementById('site-owner-edit') ? document.getElementById('site-owner-edit').value : undefined
        });
        m.close();
        ui.toast('Saved');
        load(root, me);
      } catch (e) { ui.toast(e.message, true); save.disabled = false; }
    };
  }

  return { render: (root, me) => load(root, me) };
})();