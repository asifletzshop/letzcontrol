'use strict';
/* Websites view: card grid with actions, create, edit, SSL, toggle, delete */
window.SitesView = (() => {
  const BACKENDS = ['nginx', 'apache', 'openlitespeed', 'node'];
  const NO_PHP = ['node'];

  async function load(root, me) {
    const [{ sites }, { backends, ports }, php, usersData, fieldsData] = await Promise.all([
      api.get('/sites'),
      api.get('/sites/backends'),
      api.get('/php').catch(() => ({ versions: [], ols: [] })),
      me.role === 'admin' ? api.get('/users') : Promise.resolve({ users: [] }),
      api.get('/sites/phpini/fields').catch(() => ({ fields: [] }))
    ]);
    const users = usersData.users;
    const iniFields = fieldsData.fields;
    const fpmVersions = php.versions || [];
    const olsVersions = php.ols || [];

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
      grid.appendChild(siteCard(root, me, s, backends, ports, phpOptions, users, iniFields));
    }
    root.appendChild(grid);
  }

  function siteCard(root, me, s, backends, ports, phpOptions, users, iniFields) {
    const card = ui.el('div', { class: 'site-card' });

    // Domain bar
    const domainBar = ui.el('div', { class: 'site-domain-bar' },
      ui.el('a', { href: `http://${s.domain}`, target: '_blank', rel: 'noopener', class: 'site-domain' }, s.domain),
      ui.el('a', { href: `http://${s.domain}`, target: '_blank', rel: 'noopener', class: 'site-open', title: 'Open site' }, '↗')
    );

    // Status row
    const statusDot = ui.el('span', { class: 'dot ' + (s.enabled === false ? 'idle' : 'ok') });
    const statusText = s.enabled === false ? 'disabled' : 'active';
    const statusBadges = ui.el('div', { class: 'site-badges' },
      ui.badge(s.backend, s.backend === 'nginx' ? 'green' : s.backend === 'apache' ? 'yellow' : s.backend === 'node' ? 'gray' : 'blue'),
      s.ssl ? ui.badge('SSL', 'green') : null,
      s.enabled === false ? ui.badge('off', 'red') : null,
      s.phpVersion ? ui.badge('PHP ' + s.phpVersion, 'green') : null
    );

    // Disk & Traffic stats
    const diskMb = s.diskMb || 0;
    const trafficMb = s.trafficMb || 0;
    const statsRow = ui.el('div', { class: 'site-stats' },
      ui.el('span', { title: 'Disk space used' }, '💾 ' + (diskMb >= 1024 ? (diskMb / 1024).toFixed(1) + ' GB' : diskMb + ' MB')),
      ui.el('span', { title: 'Traffic this month' }, '📊 ' + (trafficMb >= 1024 ? (trafficMb / 1024).toFixed(1) + ' GB' : trafficMb + ' MB'))
    );

    // PHP switcher (inline)
    const phpSel = ui.el('select', { class: 'site-php-select' });
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
    const actions = ui.el('div', { class: 'site-actions' },
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
      ui.el('button', { class: 'btn btn-sm', onclick: () => phpIniModal(root, me, s, iniFields), title: 'PHP Settings' }, '⚙️PHP'),
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

    card.appendChild(domainBar);
    card.appendChild(ui.el('div', { class: 'site-status' },
      ui.el('div', { class: 'site-status-left' }, statusDot, statusText, statusBadges),
      ui.el('div', { class: 'site-php' }, phpSel)
    ));
    card.appendChild(statsRow);
    card.appendChild(actions);

    // Owner (admin only)
    if (me.role === 'admin' && s.owner) {
      card.appendChild(ui.el('div', { class: 'site-owner' }, '👤 ' + s.owner));
    }

    return card;
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
  async function checkMailRelayStatus(domain) {
    try {
      const r = await api.get('/sites/' + encodeURIComponent(domain));
      const site = r.site;
      // Check if this site is configured to relay through VPS2
      // (simplified check - in production, this would verify the actual relay configuration)
      const isRelaying = site.phpIni && Object.keys(site.phpIni).length > 0; // placeholder
      return { enabled: isRelaying, domain };
    } catch (e) {
      return { enabled: false, domain };
    }
  }

  /* ------------------------------------------------------------------ */
  /* SSL/403 Fix Tool - fix common SSL and 403 issues                         */
  /* ------------------------------------------------------------------ */
  async function checkSslIssues(domain) {
    try {
      // Check if SSL certificate exists
      const certCheck = await api.get('/api/check-ssl/' + encodeURIComponent(domain)).catch(() => ({ ok: false }));
      // Get site configuration
      const siteCheck = await api.get('/sites/' + encodeURIComponent(domain)).catch(() => ({ site: null }));
      
      const issues = [];
      if (!certCheck.ok) issues.push('SSL certificate missing or invalid');
      if (siteCheck.site && !siteCheck.site.ssl) issues.push('SSL not enabled');
      if (siteCheck.site && siteCheck.site.ssl) issues.push('SSL enabled but may have configuration issues');
      
      return {
        hasIssues: issues.length > 0,
        issues: issues,
        domain: domain
      };
    } catch (e) {
      return {
        hasIssues: true,
        issues: ['Unable to check SSL configuration'],
        domain: domain
      };
    }
  }

  async function fixSslIssues(domain) {
    ui.toast('Fixing SSL/403 issues...', false);
    try {
      const r = await api.post('/api/fix-ssl', { domain: domain });
      ui.toast('SSL/403 issues fixed!', true);
      return { ok: true, message: r.message || 'Issues resolved' };
    } catch (e) {
      ui.toast(e.message, true);
      return { ok: false, error: e.message };
    }
  }

  /* ------------------------------------------------------------------ */
  /* SSL/403 Fix Tool - check and fix SSL certificates and 403 issues */
  /* ------------------------------------------------------------------ */
  async function checkSslIssues(domain) {
    try {
      // Check if SSL certificate exists
      const certCheck = await api.get('/api/check-ssl/' + encodeURIComponent(domain)).catch(() => ({ ok: false }));
      // Get site configuration
      const siteCheck = await api.get('/sites/' + encodeURIComponent(domain)).catch(() => ({ site: null }));
      
      const issues = [];
      if (!certCheck.ok) issues.push('SSL certificate missing or invalid');
      if (siteCheck.site && !siteCheck.site.ssl) issues.push('SSL not enabled');
      if (siteCheck.site && siteCheck.site.ssl) issues.push('SSL enabled but may have configuration issues');
      
      return {
        hasIssues: issues.length > 0,
        issues: issues,
        domain: domain
      };
    } catch (e) {
      return {
        hasIssues: true,
        issues: ['Unable to check SSL configuration'],
        domain: domain
      };
    }
  }

  async function fixSslIssues(domain) {
    ui.toast('Fixing SSL/403 issues...', false);
    try {
      const r = await api.post('/api/fix-ssl', { domain: domain });
      ui.toast('SSL/403 issues fixed!', true);
      return { ok: true, message: r.message || 'Issues resolved' };
    } catch (e) {
      ui.toast(e.message, true);
      return { ok: false, error: e.message };
    }
  }

  async function dnsModal(root, me, s) {
    const loading = ui.el('div', { style: 'text-align:center;padding:20px' }, ui.el('span', { class: 'spinner' }), ' Loading DNS...');
    const body = ui.el('div', {}, loading);

    // SSL/403 Fix Tool Section
    const sslStatus = ui.el('div', { style: 'margin-bottom:20px; padding:12px; background: var(--bg-elev); border-radius:6px; border-left:4px solid var(--accent);' },
      ui.el('div', { style: 'font-weight:600; margin-bottom:8px; color: var(--accent)' }, '🔧 SSL/403 Fix Tool'),
      ui.el('div', { style: 'font-size:13px; color: var(--text-dim); margin-bottom:8px' }, 'Check and fix common SSL certificates and 403 access issues'),
      ui.el('div', { id: 'ssl-status', style: 'margin-top:8px; font-size:12px' }, 'Checking...')
    );
    body.appendChild(sslStatus);

    const fixBtn = ui.el('button', { 
      class: 'btn btn-sm', 
      onclick: async () => {
        const statusEl = body.querySelector('#ssl-status');
        if (statusEl) statusEl.textContent = 'Fixing...';
        try {
          const result = await fixSslIssues(s.domain);
          statusEl.textContent = result.ok ? '✅ Fixed - ' + result.message : '❌ Error: ' + result.error;
          statusEl.style.color = result.ok ? 'var(--accent)' : 'var(--danger)';
        } catch (e) {
          statusEl.textContent = '❌ Error: ' + e.message;
          statusEl.style.color = 'var(--danger)';
        }
      }
    }, '🔧 Fix SSL/403');
    const statusContainer = ui.el('div', { style: 'margin-top:8px; display:flex; gap:8px' });
    statusContainer.append(fixBtn);
    body.appendChild(statusContainer);

    const m = ui.modal({ title: `DNS: ${s.domain}`, body, wide: true });
  async function wpModal(root, me, s) {
    const loading = ui.el('div', { style: 'text-align:center;padding:20px' }, ui.el('span', { class: 'spinner' }), ' Checking WordPress...');
    const body = ui.el('div', {}, loading);

    const m = ui.modal({ title: `WordPress: ${s.domain}`, body, wide: true });

    try {
      const wp = await api.get(`/wordpress/${s.id}/status`);

      body.innerHTML = '';
      if (!wp.installed) {
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

      body.appendChild(ui.el('h4', {}, `WordPress ${wp.version}`));
      body.appendChild(ui.el('div', { class: 'site-badges', style: 'margin-bottom:16px' },
        ui.badge(wp.siteTitle || 'Untitled', 'blue'),
        ui.badge(wp.phpVersion || 'PHP ?', 'green'),
        wp.updateAvailable ? ui.badge('Update available', 'yellow') : ui.badge('Up to date', 'green')
      ));

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

      if (wp.health) {
        const healthEl = ui.el('div', { class: 'card' },
          ui.el('h4', {}, 'Site Health'),
          ui.el('div', { class: 'site-badges' },
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

  async function phpIniModal(root, me, s, iniFields) {
    const fields = iniFields || [];
    if (!fields.length) {
      try {
        const f = await api.get('/sites/phpini/fields');
        fields = f.fields || [];
      } catch (e) { ui.toast(e.message, true); return; }
    }
    if (!fields.length) return ui.toast('PHP ini fields unavailable', true);

    const body = ui.el('div', {});
    const inputs = {};
    let currentGroup = null;
    let groupWrap = null;
    for (const f of fields) {
      if (f.group && f.group !== currentGroup) {
        currentGroup = f.group;
        groupWrap = ui.el('div', { style: 'margin-top:14px' });
        groupWrap.appendChild(ui.el('div', { style: 'font-weight:600;color:var(--accent);margin-bottom:8px;font-size:13px' }, f.group));
        body.appendChild(groupWrap);
      }
      if (!groupWrap) {
        groupWrap = ui.el('div', { style: 'margin-top:14px' });
        body.appendChild(groupWrap);
      }
      let input;
      if (f.type === 'bool') {
        input = ui.el('select', {});
        input.appendChild(ui.el('option', { value: '' }, 'default'));
        input.appendChild(ui.el('option', { value: '1' }, 'On'));
        input.appendChild(ui.el('option', { value: '0' }, 'Off'));
      } else if (f.type === 'select') {
        input = ui.el('select', {});
        for (const [v, lbl] of Object.entries(f.options || {})) {
          input.appendChild(ui.el('option', { value: v }, lbl));
        }
      } else {
        input = ui.el('input', { type: f.type === 'number' ? 'number' : 'text', placeholder: f.placeholder || '' });
      }
      inputs[f.key] = input;
      const lbl = ui.el('label', {}, f.label, input);
      if (f.hint) lbl.appendChild(ui.el('span', { class: 'text-dim', style: 'display:block;font-size:12px;margin-top:2px' }, f.hint));
      groupWrap.appendChild(lbl);
    }

    const preview = ui.el('pre', { class: 'pre-log', style: 'margin-top:6px;max-height:130px' });
    const renderPreview = () => {
      const lines = Object.entries(inputs)
        .map(([k, el]) => [k, el.value.trim()])
        .filter(([, v]) => v !== '')
        .map(([k, v]) => `${k} = ${v}`);
      preview.textContent = lines.length ? lines.join('\n') : '# no overrides - PHP defaults apply';
    };
    body.addEventListener('input', renderPreview);
    body.addEventListener('change', renderPreview);
    body.appendChild(ui.el('div', { style: 'font-weight:600;color:var(--accent);margin-top:14px;font-size:13px' }, 'Preview (writes on save)'));
    body.appendChild(preview);

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const clear = ui.el('button', { class: 'btn' }, 'Clear all');
    const save = ui.el('button', { class: 'btn btn-primary' }, 'Save PHP settings');
    save.disabled = true;
    actions.append(cancel, clear, save);
    body.appendChild(actions);

    const m = ui.modal({ title: `PHP Settings: ${s.domain}`, body, wide: true });
    cancel.onclick = m.close;
    clear.onclick = () => {
      for (const el of Object.values(inputs)) el.value = '';
      renderPreview();
    };

    // Load current values from site.phpIni
    const v = s.phpIni || {};
    for (const [k, el] of Object.entries(inputs)) {
      const val = v[k] || '';
      if (el.tagName === 'SELECT' && val && ![...el.options].some((o) => o.value === val)) {
        el.appendChild(ui.el('option', { value: val }, `${val} (current)`));
      }
      el.value = val;
    }
    save.disabled = false;
    renderPreview();

    save.onclick = async () => {
      const settings = {};
      for (const [k, el] of Object.entries(inputs)) settings[k] = el.value.trim();
      save.disabled = true;
      try {
        const r = await api.post(`/sites/${s.id}/phpini`, { settings });
        m.close();
        ui.toast('PHP settings saved');
        load(root, me);
      } catch (e) {
        ui.toast(e.message, true);
        save.disabled = false;
      }
    };
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
