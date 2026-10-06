'use strict';
/* Websites view: list, create, SSL, toggle, delete */
window.SitesView = (() => {
  /* Backend keys must match BACKENDS in lib/sites.js. 'node' fronts an app the
   * panel only proxies to, so it takes no PHP version. */
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
    /* OpenLiteSpeed runs a global lsapi processor, not PHP-FPM: offering it
     * FPM versions would be a lie the panel cannot keep (the site keeps
     * running whatever lsphp is installed). */
    const phpOptions = (backend) => {
      if (NO_PHP.includes(backend)) return [];
      return (backend === 'openlitespeed' ? olsVersions : fpmVersions)
        .filter((x) => (backend === 'openlitespeed' ? true : x.fpmInstalled !== false));
    };
    root.innerHTML = '';

    const toolbar = ui.el('div', { class: 'toolbar' },
      ui.el('button', { class: 'btn btn-primary', onclick: () => createModal(root, me, backends, ports, users, phpOptions) }, '+ Add Website')
    );
    root.appendChild(toolbar);

    if (!backends.nginx && !backends.apache && !backends.openlitespeed) {
      root.appendChild(ui.el('div', { class: 'banner' },
        'No web server detected. Install nginx, apache2 and/or openlitespeed to host websites.'));
    }

    if (!sites.length) {
      root.appendChild(ui.el('div', { class: 'card empty' }, 'No websites yet. Click "+ Add Website" to create one.'));
      return;
    }

    const wrap = ui.el('div', { class: 'table-wrap' });
    const rows = sites.map((s) => ui.el('tr', {},
      ui.el('td', {}, ui.el('a', { href: `http://${s.domain}`, target: '_blank' }, s.domain)),
      ui.el('td', {}, ui.badge(s.backend, s.backend === 'nginx' ? 'green' : s.backend === 'apache' ? 'yellow' : s.backend === 'node' ? 'gray' : 'blue')),
      ui.el('td', {}, (() => {
        // quick PHP version switcher - saves immediately on change
        const sel = ui.el('select', { style: 'width:auto;min-width:86px;padding:4px 8px' });
        sel.appendChild(ui.el('option', { value: '' }, 'static'));
        const opts = phpOptions(s.backend);
        for (const v of opts) sel.appendChild(ui.el('option', { value: v.version }, v.version));
        // a version the server cannot actually run stays visible, flagged,
        // instead of silently showing "static" (which reads as "no PHP")
        if (s.phpVersion && !opts.some((v) => v.version === s.phpVersion)) {
          sel.appendChild(ui.el('option', { value: s.phpVersion }, `${s.phpVersion} (not installed)`));
        }
        sel.value = s.phpVersion || '';
        sel.onchange = async () => {
          sel.disabled = true;
          try {
            await api.put(`/sites/${s.id}`, { phpVersion: sel.value || null });
            ui.toast(`PHP updated for ${s.domain}`);
            load(root, me);
          } catch (e) { ui.toast(e.message, true); sel.disabled = false; }
        };
        return sel;
      })()),
      ui.el('td', {}, s.ssl ? ui.badge('SSL', 'green') : ui.badge('no SSL', 'gray')),
      ui.el('td', {}, s.enabled === false ? ui.badge('disabled', 'red') : ui.badge('active', 'green')),
      me.role === 'admin' ? ui.el('td', { class: 'text-dim' }, s.owner) : null,
      ui.el('td', {},
        ui.el('button', {
          class: 'btn btn-sm', onclick: () => editModal(root, me, s, backends, ports, phpOptions, users)
        }, '⚙ Edit'), ' ',
        // php.ini has no meaning for a site served by its own app
        NO_PHP.includes(s.backend) ? null : ui.el('button', {
          class: 'btn btn-sm', onclick: () => phpIniModal(root, me, s, iniFields)
        }, '🛠 ini'),
        ' ',
        ui.el('button', {
          class: 'btn btn-sm', onclick: () => {
            // browse this website's files (opens the Files view at its docroot)
            location.hash = '#/files?path=' + encodeURIComponent((s.docroot || '') + '/public');
          }
        }, '📂 Files'), ' ',
        ui.el('button', {
          class: 'btn btn-sm', onclick: async () => {
            let created = false;
            try {
              await api.post('/dns/zones', { domain: s.domain });
              created = true;
            } catch (e) {
              // zone may already exist - still navigate to it
              if (!/already exists/i.test(e.message || '')) { ui.toast(e.message, true); return; }
            }
            if (created) ui.toast(`DNS zone for ${s.domain} created`);
            DnsView.forDomain(s.domain); // open THIS website's zone, not all zones
            location.hash = '#/dns';
          }
        }, '🛰 DNS'), ' ',
        ui.el('button', {
          class: 'btn btn-sm', onclick: () => {
            WordpressView.forSite(s.id);
            location.hash = '#/wordpress';
          }
        }, '🧭 WP'), ' ',
        ui.el('button', {
          class: 'btn btn-sm', onclick: async () => {
            try {
              const r = await api.post(`/sites/${s.id}/ssl`);
              ui.modal({ title: `SSL for ${s.domain}`, body: ui.el('pre', { class: 'pre-log' }, r.output || (r.ok ? 'Certificate issued.' : 'Failed')) });
              load(root, me);
            } catch (e) { ui.toast(e.message, true); }
          }
        }, '🔒 SSL'),
        ' ',
        ui.el('button', {
          class: 'btn btn-sm', onclick: async () => {
            try { await api.post(`/sites/${s.id}/toggle`); load(root, me); }
            catch (e) { ui.toast(e.message, true); }
          }
        }, s.enabled === false ? '▶ Enable' : '⏸ Disable'),
        ' ',
        ui.el('button', {
          class: 'btn btn-sm btn-danger', onclick: async () => {
            if (!(await ui.confirmBox(`Delete ${s.domain}? Vhost config will be removed.`, { okText: 'Delete' }))) return;
            const delFiles = await ui.confirmBox('Also DELETE all website files (docroot)?', { okText: 'Delete files too' });
            try {
              await api.del(`/sites/${s.id}${delFiles ? '?deleteFiles=true' : ''}`);
              ui.toast(`Deleted ${s.domain}`);
              load(root, me);
            } catch (e) { ui.toast(e.message, true); }
          }
        }, '🗑')
      )
    )).filter(Boolean);
    wrap.appendChild(ui.el('table', {},
      ui.el('thead', {}, ui.el('tr', {},
        ui.el('th', {}, 'Domain'), ui.el('th', {}, 'Server'), ui.el('th', {}, 'PHP'),
        ui.el('th', {}, 'SSL'), ui.el('th', {}, 'Status'),
        me.role === 'admin' ? ui.el('th', {}, 'Owner') : null,
        ui.el('th', {}, 'Actions'))),
      ui.el('tbody', {}, ...rows)
    ));
    root.appendChild(wrap);
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
      hint.textContent = b === 'nginx'
        ? 'Nginx serves this site directly on port 80/443.'
        : b === 'node'
          ? `Nginx proxies to the app's own port ${ports[b]}. The panel never starts or configures it - it only fronts it, and PHP options do not apply.`
          : `${b} serves the site on internal port ${ports[b]}; Nginx proxies port 80/443 to it, so all servers run together.`;
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
          ownerId: document.getElementById('site-owner') ? document.getElementById('site-owner').value : undefined
        });
        m.close();
        ui.toast(`Website ${r.site.domain} created`);
        const failed = (r.results || []).filter((x) => !x.ok);
        if (failed.length) {
          ui.modal({ title: 'Reload results', body: ui.el('pre', { class: 'pre-log' },
            r.results.map((x) => `[${x.server}] ${x.ok ? 'OK' : 'FAILED'}\n${x.output}`).join('\n\n')) });
        }
        load(root, me);
      } catch (e) {
        ui.toast(e.message, true);
        create.disabled = false;
      }
    };
  }

  /* Edit settings: change served-by (backend), PHP version, www alias, owner */
  function editModal(root, me, s, backends, ports, phpOptions, users) {
    const body = ui.el('div', {});
    body.appendChild(ui.el('label', {}, 'Domain',
      ui.el('input', { type: 'text', value: s.domain, readonly: '' })));

    const backendSel = ui.el('select', { id: 'site-backend-edit' });
    for (const b of BACKENDS) {
      const isCurrent = b === s.backend;
      const opt = ui.el('option', { value: b }, `${b}${backends[b] || isCurrent ? '' : ' (not installed)'}`);
      if (!backends[b] && !isCurrent) opt.disabled = true;
      backendSel.appendChild(opt);
    }
    backendSel.value = s.backend;
    body.appendChild(ui.el('label', {}, 'Served by', backendSel));

    const hint = ui.el('p', { class: 'text-dim', style: 'margin-top:-8px' });
    const updateHint = () => {
      const b = backendSel.value;
      hint.textContent = b === s.backend
        ? 'Currently serving this site.'
        : b === 'nginx'
          ? 'Nginx will serve this site directly on port 80/443.'
          : b === 'node'
            ? `Nginx will proxy to the app's own port ${ports[b]}. The panel will not start or configure the app.`
            : `${b} will serve it on internal port ${ports[b]}; Nginx keeps proxying 80/443. The old server's config is removed automatically.`;
    };
    backendSel.onchange = updateHint;
    updateHint();
    body.appendChild(hint);

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

    body.appendChild(ui.el('p', { class: 'text-dim' },
      `Docroot: ${s.docroot}${s.owner ? ` · Owner: ${s.owner}` : ''}`));

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const save = ui.el('button', { class: 'btn btn-primary' }, 'Save settings');
    actions.append(cancel, save);
    body.appendChild(actions);
    const m = ui.modal({ title: `Edit ${s.domain}`, body });
    cancel.onclick = m.close;
    save.onclick = async () => {
      save.disabled = true;
      try {
        const r = await api.put(`/sites/${s.id}`, {
          backend: backendSel.value,
          phpVersion: phpSel.value || null,
          www: wwwChk.checked,
          ownerId: document.getElementById('site-owner-edit') ? document.getElementById('site-owner-edit').value : undefined
        });
        m.close();
        ui.toast('Settings saved');
        const failed = (r.results || []).filter((x) => !x.ok);
        if (failed.length) {
          ui.modal({ title: 'Reload results', body: ui.el('pre', { class: 'pre-log' },
            r.results.map((x) => `[${x.server}] ${x.ok ? 'OK' : 'FAILED'}\n${x.output}`).join('\n\n')) });
        }
        load(root, me);
      } catch (e) {
        ui.toast(e.message, true);
        save.disabled = false;
      }
    };
  }

  /* Visual php.ini editor - builds inputs from the server's field list,
   * saves through the whitelist-validated /sites/:id/phpini endpoint */
  function phpIniModal(root, me, site, fields) {
    if (!fields || !fields.length) return ui.toast('php.ini fields unavailable', true);

    const body = ui.el('div', {});
    body.appendChild(ui.el('p', { class: 'text-dim', style: 'margin-top:0' },
      site.backend === 'openlitespeed'
        ? 'Applied via phpIniOverride in the OpenLiteSpeed vhost (restarts OLS).'
        : 'Applied via .user.ini in the document root; PHP-FPM picks it up per request.'));

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

      const cur = (site.phpIni || {})[f.key] || '';
      let input;
      if (f.type === 'bool') {
        input = ui.el('select', {});
        input.appendChild(ui.el('option', { value: '' }, 'default'));
        input.appendChild(ui.el('option', { value: '1' }, 'On'));
        input.appendChild(ui.el('option', { value: '0' }, 'Off'));
        input.value = cur;
      } else if (f.type === 'select') {
        input = ui.el('select', {});
        for (const [v, lbl] of Object.entries(f.options || {})) {
          input.appendChild(ui.el('option', { value: v }, lbl));
        }
        input.value = cur;
      } else {
        input = ui.el('input', { type: f.type === 'number' ? 'number' : 'text', placeholder: f.placeholder || '' });
        input.value = cur;
      }
      inputs[f.key] = input;

      const lbl = ui.el('label', {}, f.label, input);
      if (f.hint) lbl.appendChild(ui.el('span', { class: 'text-dim', style: 'display:block;font-size:12px;margin-top:2px' }, f.hint));
      groupWrap.appendChild(lbl);
    }

    const preview = ui.el('pre', { class: 'pre-log', style: 'margin-top:6px;max-height:150px' });
    const renderPreview = () => {
      const lines = Object.entries(inputs)
        .map(([k, el]) => [k, el.value.trim()])
        .filter(([, v]) => v !== '')
        .map(([k, v]) => `${k}=${v}`);
      preview.textContent = lines.length ? lines.join('\n') : '# no overrides - PHP defaults apply';
    };
    body.addEventListener('input', renderPreview);
    body.addEventListener('change', renderPreview);
    renderPreview();
    body.appendChild(ui.el('div', { style: 'font-weight:600;color:var(--accent);margin-top:14px;font-size:13px' }, 'Preview'));
    body.appendChild(preview);

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const clear = ui.el('button', { class: 'btn' }, 'Clear all');
    const save = ui.el('button', { class: 'btn btn-primary' }, '💾 Save php.ini');
    actions.append(cancel, clear, save);
    body.appendChild(actions);

    const m = ui.modal({ title: `php.ini — ${site.domain}`, body, wide: true });
    cancel.onclick = m.close;
    clear.onclick = () => {
      for (const el of Object.values(inputs)) el.value = '';
      renderPreview();
    };
    save.onclick = async () => {
      const settings = {};
      for (const [k, el] of Object.entries(inputs)) settings[k] = el.value.trim();
      save.disabled = true;
      try {
        const r = await api.post(`/sites/${site.id}/phpini`, { settings });
        m.close();
        ui.toast(`php.ini saved for ${site.domain}`);
        const failed = (r.results || []).filter((x) => !x.ok);
        if (failed.length) {
          ui.modal({ title: 'Apply results', body: ui.el('pre', { class: 'pre-log' },
            r.results.map((x) => `[${x.server}] ${x.ok ? 'OK' : 'FAILED'}\n${x.output}`).join('\n\n')) });
        }
        load(root, me);
      } catch (e) {
        ui.toast(e.message, true);
        save.disabled = false;
      }
    };
  }

  return { render: (root, me) => load(root, me) };
})();
