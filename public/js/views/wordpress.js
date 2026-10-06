'use strict';
/* WordPress manager: per-site status, one-click install, core/plugin/theme
 * updates, WP_DEBUG & auto-updates, admin password reset. */
window.WordpressView = (() => {
  let pendingSite = null;
  let state = { mode: 'sites' }; // { mode:'sites' } | { mode:'site', id }

  async function load(root, me, opts = {}) {
    if (state.mode === 'site') return manager(root, me, state.id, opts);
    return sitesList(root, me, opts);
  }

  function genPw() {
    const a = new Uint8Array(15);
    crypto.getRandomValues(a);
    return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function showOutput(title, output) {
    ui.modal({ title, body: ui.el('pre', { class: 'pre-log' }, output || 'No output') });
  }

  /* ------------------------------------------------ sites overview -- */
  async function sitesList(root, me, opts = {}) {
    root.innerHTML = '';
    const { sites } = await api.get('/sites');
    const fresh = opts.fresh ? '?fresh=1' : '';

    root.appendChild(ui.el('div', { class: 'toolbar' },
      ui.el('span', { class: 'text-dim' }, 'WordPress for every website'),
      ui.el('span', { class: 'spacer' }),
      ui.el('button', { class: 'btn', onclick: () => load(root, me, { fresh: true }) }, '↻ Refresh')
    ));

    if (!sites.length) {
      root.appendChild(ui.el('div', { class: 'card empty' },
        'No websites yet. Create one under Websites first, then install WordPress on it here.'));
      return;
    }

    /* Show the table immediately with "checking" placeholders, then fill
     * each row's status as its request lands - the page never blocks on
     * wp-cli round-trips. */
    const open = (s) => {
      state = { mode: 'site', id: s.id };
      load(root, me);
    };
    const slots = sites.map(() => ({
      wp: ui.el('td', {}, ui.badge('checking…', 'gray')),
      upd: ui.el('td', {}, ui.el('span', { class: 'text-dim' }, '…')),
      act: ui.el('td', {})
    }));

    const rows = sites.map((s, i) => ui.el('tr', {},
      ui.el('td', {}, ui.el('a', { href: `http://${s.domain}`, target: '_blank' }, s.domain)),
      slots[i].wp,
      slots[i].upd,
      ui.el('td', {}, s.phpVersion ? `PHP ${s.phpVersion}` : '—'),
      slots[i].act
    ));

    root.appendChild(ui.el('div', { class: 'table-wrap' },
      ui.el('table', {},
        ui.el('thead', {}, ui.el('tr', {},
          ui.el('th', {}, 'Domain'), ui.el('th', {}, 'WordPress'),
          ui.el('th', {}, 'Updates'), ui.el('th', {}, 'PHP'), ui.el('th', {}, 'Actions'))),
        ui.el('tbody', {}, ...rows))));

    const fill = (i, s, st) => {
      const slot = slots[i];
      let wpCell, updCell, action;
      const openBtn = (label, cls) => ui.el('button', {
        class: `btn btn-sm ${cls || ''}`.trim(),
        onclick: () => open(s)
      }, label);

      if (!st || st.error) {
        wpCell = ui.badge(st && st.error ? 'wp-cli error' : 'unreachable', 'red');
        if (st && st.error) wpCell.title = st.error;
        updCell = '—';
        action = openBtn('Open');
      } else if (!st.installed) {
        wpCell = ui.badge('not installed', 'gray');
        updCell = '—';
        action = openBtn('⚡ Install');
      } else {
        wpCell = ui.badge(`WP ${st.wpVersion || '?'}`, 'green');
        const n = (st.coreUpdate ? 1 : 0)
          + st.plugins.filter((p) => p.hasUpdate).length
          + st.themes.filter((t) => t.hasUpdate).length;
        updCell = n
          ? ui.badge(`${n} update${n === 1 ? '' : 's'}`, 'yellow')
          : ui.badge('up to date', 'green');
        action = openBtn('🧭 Manage');
      }

      slot.wp.replaceChildren(wpCell);
      slot.upd.replaceChildren(updCell);
      slot.act.replaceChildren(action);
    };

    const slotAlive = (i) => rows[i].isConnected;
    sites.forEach((s, i) => {
      api.get(`/wordpress/${s.id}/status${fresh}`)
        .then((st) => { if (slotAlive(i)) fill(i, s, st); })
        .catch((e) => { if (slotAlive(i)) fill(i, s, { error: e.message }); });
    });
  }

  /* ---------------------------------------------------- manager ----- */
  async function manager(root, me, id, opts = {}) {
    root.innerHTML = '';
    const fresh = opts.fresh ? '?fresh=1' : '';
    const refresh = () => load(root, me, { fresh: true });

    /* Paint the shell first: /status can take seconds (wp-cli boots) and
     * used to leave this whole page blank until it answered. */
    const domainEl = ui.el('strong', {}, '…');
    const fill = ui.el('div', {},
      ui.el('div', { class: 'banner' }, '⏳ Checking WordPress…'));
    root.appendChild(ui.el('div', { class: 'toolbar' },
      ui.el('button', {
        class: 'btn',
        onclick: () => { state = { mode: 'sites' }; load(root, me); }
      }, '⬅ All sites'),
      domainEl,
      ui.el('span', { class: 'spacer' }),
      ui.el('button', { class: 'btn', onclick: refresh }, '↻ Refresh')
    ));
    root.appendChild(fill);

    const sitesP = api.get('/sites');
    const stP = api.get(`/wordpress/${id}/status${fresh}`).catch((e) => ({ error: e.message }));

    const { sites } = await sitesP;
    const site = sites.find((s) => s.id === id);
    if (site) domainEl.textContent = site.domain;
    fill.textContent = '';
    if (!site) {
      fill.appendChild(ui.el('div', { class: 'banner' }, 'Site not found.'));
      return;
    }

    const st = await stP;
    if (st.error) {
      fill.appendChild(ui.el('div', { class: 'banner' }, `wp-cli error: ${st.error}`));
      return;
    }
    if (!site.phpVersion) {
      fill.appendChild(ui.el('div', { class: 'banner' },
        'No PHP version is set for this site - WordPress needs one. Set it in Websites → PHP column.'));
    }

    if (!st.installed) {
      const card = ui.el('div', { class: 'card' },
        ui.el('h3', {}, '⚡ Install WordPress'),
        ui.el('p', { class: 'text-dim' },
          `Nothing WordPress-related found in ${site.docroot}/public. ` +
          'One click creates a database, downloads the latest WordPress and sets up your admin account.'),
        ui.el('button', { class: 'btn btn-primary' }, 'Install WordPress')
      );
      card.querySelector('button').onclick = () => installModal(root, me, site);
      fill.appendChild(card);
      return;
    }

    const upd = {
      core: st.coreUpdate,
      plugins: st.plugins.filter((p) => p.hasUpdate),
      themes: st.themes.filter((t) => t.hasUpdate)
    };

    /* ---- overview cards ---- */
    const grid = ui.el('div', { style: 'display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px' });
    const infoCard = (title, ...children) => ui.el('div', {
      class: 'card', style: 'margin:0;min-width:180px;flex:0 0 auto'
    }, ui.el('div', { class: 'text-dim', style: 'font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px' }, title), ...children);

    grid.appendChild(infoCard('WordPress',
      ui.el('div', { style: 'font-size:20px;font-weight:600' }, st.wpVersion || '?'),
      upd.core
        ? ui.el('button', {
            class: 'btn btn-sm btn-primary', style: 'margin-top:8px',
            onclick: async (ev) => {
              ev.target.disabled = true;
              const r = await api.post(`/wordpress/${id}/core-update`).catch((e) => ({ ok: false, output: e.message }));
              if (!r.ok) showOutput('WordPress update failed', r.output);
              else ui.toast('WordPress updated');
              refresh();
            }
          }, `⬆ Update to ${st.latest || 'latest'}`)
        : ui.badge('up to date', 'green')));

    grid.appendChild(infoCard('PHP', ui.el('div', { style: 'font-size:20px;font-weight:600' },
      site.phpVersion || 'not set')));
    grid.appendChild(infoCard('Database', ui.el('div', { class: 'mono' }, st.dbName || '?')));
    grid.appendChild(infoCard('Site URL',
      ui.el('a', { href: st.siteurl, target: '_blank' }, st.siteurl || st.domain)));
    grid.appendChild(infoCard('WP_DEBUG',
      ui.badge(st.debug ? 'On' : 'Off', st.debug ? 'yellow' : 'green')));
    fill.appendChild(grid);

    /* ---- bulk updates banner ---- */
    const bulkBtns = [];
    if (upd.plugins.length) {
      bulkBtns.push(ui.el('button', {
        class: 'btn btn-primary',
        onclick: () => bulk(root, me, id, upd.plugins.map((p) => p.slug), 'plugin')
      }, `⬆ Update plugins (${upd.plugins.length})`));
    }
    if (upd.themes.length) {
      bulkBtns.push(ui.el('button', {
        class: 'btn btn-primary',
        onclick: () => bulk(root, me, id, upd.themes.map((t) => t.slug), 'theme')
      }, `⬆ Update themes (${upd.themes.length})`));
    }
    if (bulkBtns.length) {
      fill.appendChild(ui.el('div', { class: 'banner' },
        `Updates available: ${upd.core ? 'core, ' : ''}${upd.plugins.length} plugin(s), ${upd.themes.length} theme(s).`,
        ui.el('span', { style: 'margin-left:10px' }, ...bulkBtns)));
    }

    /* ---- settings ---- */
    const settings = ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Settings'));

    const dbgSel = ui.el('select', { style: 'width:auto' },
      ui.el('option', { value: '0' }, 'Off'),
      ui.el('option', { value: '1' }, 'On'));
    dbgSel.value = st.debug ? '1' : '0';
    dbgSel.onchange = () => save(root, me, id, { debug: dbgSel.value === '1' }, 'WP_DEBUG');
    settings.appendChild(ui.el('label', {}, 'WP_DEBUG (error display)', dbgSel));

    const coreSel = ui.el('select', { style: 'width:auto' },
      ui.el('option', { value: 'all' }, 'All updates (incl. major)'),
      ui.el('option', { value: 'minor' }, 'Minor only (WordPress default)'),
      ui.el('option', { value: 'off' }, 'Off'));
    coreSel.value = st.coreAuto || 'minor';
    coreSel.onchange = () => save(root, me, id, { coreAuto: coreSel.value }, 'Core auto-updates');
    settings.appendChild(ui.el('label', {}, 'Core auto-updates', coreSel));

    settings.appendChild(ui.el('p', { class: 'text-dim', style: 'margin:2px 0 0;font-size:12px' },
      'Plugin auto-updates are toggled per plugin in the table below.'));

    const pwBtn = ui.el('button', { class: 'btn' }, 'Change admin password…');
    pwBtn.onclick = () => adminPwModal(root, me, id, st);
    settings.appendChild(ui.el('label', {}, 'Administrator', pwBtn));
    fill.appendChild(settings);

    /* ---- plugins table ---- */
    fill.appendChild(ui.el('h3', { style: 'margin:18px 0 8px' }, `Plugins (${st.plugins.length})`));
    fill.appendChild(listTable(root, me, id, st.plugins, 'plugin', ['activate', 'deactivate', 'update', 'delete']));

    /* ---- themes table ---- */
    fill.appendChild(ui.el('h3', { style: 'margin:18px 0 8px' }, `Themes (${st.themes.length})`));
    fill.appendChild(listTable(root, me, id, st.themes, 'theme', ['activate', 'update', 'delete']));
  }

  function listTable(root, me, id, items, kind, actions) {
    const act = (slug, action, label, danger) => ui.el('button', {
      class: `btn btn-sm${danger ? ' btn-danger' : ''}`,
      onclick: async () => {
        if (danger && !(await ui.confirmBox(`Delete ${kind} "${slug}"?`, { okText: 'Delete' }))) return;
        try {
          const r = await api.post(`/wordpress/${id}/${kind}/${slug}`, { action });
          if (!r.ok) { showOutput(`${action} ${slug}`, r.output); return; }
          ui.toast(`${slug}: ${label}`);
          load(root, me);
        } catch (e) { ui.toast(e.message, true); }
      }
    }, label);

    const rows = items.map((it) => {
      const active = String(it.status).toLowerCase() === 'active';
      const btns = [];
      if (actions.includes('update') && it.hasUpdate) btns.push(act(it.slug, 'update', '⬆ Update'));
      if (actions.includes('activate') && !active) btns.push(act(it.slug, 'activate', '▶ Activate'));
      if (actions.includes('deactivate') && active) btns.push(act(it.slug, 'deactivate', '⏸ Deactivate'));
      if (kind === 'plugin') {
        // toggle button: text = the action (turn auto-updates off/on)
        const b = act(
          it.slug,
          it.autoUpdate ? 'auto-off' : 'auto-on',
          it.autoUpdate ? '⏲ Auto off' : '⏲ Auto on'
        );
        b.title = it.autoUpdate
          ? 'Auto-updates are ON for this plugin — click to turn off'
          : 'Auto-updates are OFF for this plugin — click to turn on';
        btns.push(b);
      }
      if (actions.includes('delete') && !active) btns.push(act(it.slug, 'delete', '🗑', true));

      return ui.el('tr', {},
        ui.el('td', {}, ui.el('strong', {}, it.name),
          ui.el('div', { class: 'text-dim mono', style: 'font-size:12px' }, it.slug)),
        ui.el('td', {}, it.version || '—',
          it.hasUpdate ? ui.el('span', {}, ' ', ui.badge('update', 'yellow')) : null),
        ui.el('td', {}, ui.badge(it.status || '?', active ? 'green' : 'gray')),
        ui.el('td', {}, ...btns.flatMap((b) => [b, ' ']))
      );
    });

    if (!items.length) {
      return ui.el('div', { class: 'card empty' }, `No ${kind}s found.`);
    }
    return ui.el('div', { class: 'table-wrap' },
      ui.el('table', {},
        ui.el('thead', {}, ui.el('tr', {},
          ui.el('th', {}, kind === 'plugin' ? 'Plugin' : 'Theme'),
          ui.el('th', {}, 'Version'), ui.el('th', {}, 'Status'), ui.el('th', {}, 'Actions'))),
        ui.el('tbody', {}, ...rows)));
  }

  async function bulk(root, me, id, slugs, kind) {
    ui.toast(`Updating ${slugs.length} ${kind}(s)…`);
    const failed = [];
    for (const slug of slugs) {
      try {
        const r = await api.post(`/wordpress/${id}/${kind}/${slug}`, { action: 'update' });
        if (!r.ok) failed.push(`${slug}: ${r.output}`);
      } catch (e) { failed.push(`${slug}: ${e.message}`); }
    }
    if (failed.length) showOutput(`${failed.length} update(s) failed`, failed.join('\n\n'));
    else ui.toast(`${slugs.length} ${kind}(s) updated`);
    load(root, me);
  }

  async function save(root, me, id, payload, what) {
    try {
      await api.post(`/wordpress/${id}/settings`, payload);
      ui.toast(`${what} saved`);
      load(root, me);
    } catch (e) { ui.toast(`${what}: ${e.message}`, true); load(root, me); }
  }

  function adminPwModal(root, me, id, st) {
    const body = ui.el('div', {});
    const userSel = ui.el('select', { id: 'wp-admin-user' });
    for (const u of st.admins.length ? st.admins : ['admin']) {
      userSel.appendChild(ui.el('option', { value: u }, u));
    }
    const pwIn = ui.el('input', { type: 'text', id: 'wp-admin-pw', value: genPw() });
    body.appendChild(ui.el('label', {}, 'Administrator', userSel));
    body.appendChild(ui.el('label', {}, 'New password', pwIn));

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const ok = ui.el('button', { class: 'btn btn-primary' }, 'Set password');
    actions.append(cancel, ok);
    body.appendChild(actions);
    const m = ui.modal({ title: 'Change WordPress admin password', body });
    cancel.onclick = m.close;
    ok.onclick = async () => {
      if (pwIn.value.length < 8) return ui.toast('Password must be at least 8 characters', true);
      ok.disabled = true;
      try {
        const r = await api.post(`/wordpress/${id}/admin-password`, {
          username: userSel.value, password: pwIn.value
        });
        if (!r.ok) { showOutput('Password change failed', r.output); ok.disabled = false; return; }
        m.close();
        ui.toast(`Password changed for ${userSel.value}`);
      } catch (e) { ui.toast(e.message, true); ok.disabled = false; }
    };
  }

  /* ----------------------------------------------------- install ----- */
  function installModal(root, me, site) {
    const body = ui.el('div', {});
    const base = ('wp_' + site.domain.replace(/[^a-z0-9]+/gi, '_').toLowerCase()).replace(/_+$/, '');

    const titleIn = ui.el('input', { type: 'text', id: 'wp-title', value: site.domain });
    const userIn = ui.el('input', { type: 'text', id: 'wp-user', value: 'admin' });
    const emailIn = ui.el('input', { type: 'email', id: 'wp-email', value: `admin@${site.domain}` });
    const pwIn = ui.el('input', { type: 'text', id: 'wp-pw', value: genPw() });

    const dbNameIn = ui.el('input', { type: 'text', id: 'wp-dbname', value: base.slice(0, 48) });
    const dbUserIn = ui.el('input', { type: 'text', id: 'wp-dbuser', value: `${base}_u`.slice(0, 48) });
    const dbPwIn = ui.el('input', { type: 'text', id: 'wp-dbpw', value: genPw() });

    body.appendChild(ui.el('label', {}, 'Site title', titleIn));
    body.appendChild(ui.el('label', {}, 'Admin username', userIn));
    body.appendChild(ui.el('label', {}, 'Admin email', emailIn));
    body.appendChild(ui.el('label', {}, 'Admin password', pwIn));
    body.appendChild(ui.el('div', { class: 'text-dim', style: 'margin:14px 0 6px;font-weight:600' },
      'Database (created automatically)'));
    body.appendChild(ui.el('label', {}, 'Database name', dbNameIn));
    body.appendChild(ui.el('label', {}, 'Database user', dbUserIn));
    body.appendChild(ui.el('label', {}, 'Database password', dbPwIn));
    body.appendChild(ui.el('p', { class: 'text-dim' },
      'Copy these credentials - the database is also added to your Databases list.'));

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const ok = ui.el('button', { class: 'btn btn-primary' }, '⚡ Install WordPress');
    actions.append(cancel, ok);
    body.appendChild(actions);
    const m = ui.modal({ title: `Install WordPress on ${site.domain}`, body, wide: true });
    cancel.onclick = m.close;

    ok.onclick = async () => {
      if (pwIn.value.length < 8) return ui.toast('Admin password must be at least 8 characters', true);
      ok.disabled = true;
      ok.textContent = '⏳ Installing…';
      try {
        const r = await api.post(`/wordpress/${site.id}/install`, {
          title: titleIn.value,
          adminUser: userIn.value,
          adminEmail: emailIn.value,
          adminPassword: pwIn.value,
          dbName: dbNameIn.value,
          dbUser: dbUserIn.value,
          dbPassword: dbPwIn.value
        });
        m.close();
        load(root, me);
        ui.modal({
          title: '✅ WordPress installed',
          body: ui.el('div', {},
            ui.el('p', {}, 'Your site is live. Save these credentials now:'),
            ui.el('pre', { class: 'pre-log' },
              `Site:      ${r.url}\n` +
              `wp-admin:  ${r.url}/wp-admin/\n` +
              `Username:  ${r.adminUser}\n` +
              `Password:  ${r.adminPassword}\n` +
              `Database:  ${r.db.name}\n` +
              `DB user:   ${r.db.user}\n` +
              `DB pass:   ${r.db.password}`)
          )
        });
      } catch (e) {
        ui.toast(e.message, true);
        ok.disabled = false;
        ok.textContent = '⚡ Install WordPress';
      }
    };
  }

  return {
    /* Call before navigating to #/wordpress: open that site's manager */
    forSite: (id) => { pendingSite = id; },
    render: (root, me) => {
      state = pendingSite ? { mode: 'site', id: pendingSite } : { mode: 'sites' };
      pendingSite = null;
      return load(root, me);
    },
    destroy: () => { state = { mode: 'sites' }; pendingSite = null; }
  };
})();
