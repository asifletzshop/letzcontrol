'use strict';
/* Settings view: account, panel preferences, admin configuration,
 * maintenance (backup/restore), active sessions and system information.
 *
 * Every control is driven by the schema the API returns, so the form can never
 * drift from what the backend actually accepts. */
window.SettingsView = (() => {
  const field = (label, input, hint) =>
    ui.el('label', {}, label, input, hint ? ui.el('span', { class: 'text-dim', style: 'display:block;font-size:12px;margin-top:2px' }, hint) : null);

  const boolToggle = (id, value) => {
    const sel = ui.el('select', { id }, ui.el('option', { value: '' }, 'default'), ui.el('option', { value: '1' }, 'On'), ui.el('option', { value: '0' }, 'Off'));
    sel.value = value ? '1' : (value === false ? '0' : '');
    return sel;
  };

  const textInput = (id, value, placeholder) => {
    const i = ui.el('input', { type: 'text', id, placeholder: placeholder || '' });
    i.value = value == null ? '' : String(value);
    return i;
  };

  const intInput = (id, value, min, max) => {
    const i = ui.el('input', { type: 'number', id, min: min ?? '', max: max ?? '' });
    i.value = value == null ? '' : String(value);
    return i;
  };

  /* ------------------------------ account ------------------------------ */
  function accountCard(me, state) {
    const cur = ui.el('input', { type: 'password', id: 'pw-current', autocomplete: 'current-password' });
    const next = ui.el('input', { type: 'password', id: 'pw-next', autocomplete: 'new-password' });
    const confirm = ui.el('input', { type: 'password', id: 'pw-confirm', autocomplete: 'new-password' });
    const msg = ui.el('p', { class: 'text-dim', style: 'font-size:12px' });

    const save = ui.el('button', { class: 'btn btn-primary' }, 'Change password');
    save.onclick = async () => {
      if (next.value.length < 8) return ui.toast('New password must be at least 8 characters', true);
      if (next.value !== confirm.value) return ui.toast('The two new passwords do not match', true);
      save.disabled = true;
      try {
        await api.post('/auth/password', { current: cur.value, next: next.value });
        ui.toast('Password changed');
        [cur, next, confirm].forEach((i) => { i.value = ''; });
        msg.textContent = 'Changed just now.';
      } catch (e) { ui.toast(e.message, true); }
      save.disabled = false;
    };

    return ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Account'),
      ui.el('p', { class: 'text-dim', style: 'margin-top:-6px' },
        `Signed in as `, ui.el('code', {}, me.username), ` · ${me.role}`),
      field('Current password', cur),
      field('New password (min 8 chars)', next),
      field('Repeat new password', confirm),
      ui.el('div', { class: 'modal-actions', style: 'justify-content:flex-start' }, save),
      msg
    );
  }

  /* --------------------------- preferences ---------------------------- */
  function prefsCard(data) {
    const inputs = {};
    const p = data.prefs || {};
    const row = (key, label, input, hint) => { inputs[key] = input; return field(label, input, hint); };

    const size = intInput('pref-pageSize', p.pageSize ?? 25, 5, 200);
    const live = boolToggle('pref-liveStats', p.liveStats !== false);
    const confirm = boolToggle('pref-confirmDangerous', p.confirmDangerous !== false);

    const save = ui.el('button', { class: 'btn btn-primary' }, 'Save preferences');
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api.put('/settings/prefs', {
          pageSize: size.value,
          liveStats: live.value === '' ? true : live.value === '1',
          confirmDangerous: confirm.value === '' ? true : confirm.value === '1'
        });
        ui.toast('Preferences saved');
        state.reload();
      } catch (e) { ui.toast(e.message, true); save.disabled = false; }
    };

    return ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Preferences'),
      ui.el('p', { class: 'text-dim', style: 'margin-top:-6px' }, 'Personal to your account — no effect on other users.'),
      row('pageSize', 'Rows per page in lists', size, 'How many entries tables show by default'),
      row('liveStats', 'Live dashboard updates', live, 'Refresh CPU/memory on the dashboard every 2 seconds'),
      row('confirmDangerous', 'Confirm dangerous actions', confirm, 'Ask before deleting or stopping something'),
      ui.el('div', { class: 'modal-actions', style: 'justify-content:flex-start' }, save)
    );
  }

  /* ------------------------- panel config (admin) --------------------- */
  function configCard(data, isAdmin) {
    const c = data.config || {};
    const inputs = {};
    const rows = [];
    const restartNote = ui.el('p', { class: 'text-dim', style: 'font-size:12px;display:none' });

    for (const s of data.schema || []) {
      if (s.adminOnly && !isAdmin) continue;
      let input;
      if (s.type === 'bool') input = boolToggle('cfg-' + s.key, c[s.key]);
      else if (s.type === 'int') input = intInput('cfg-' + s.key, c[s.key]);
      else if (s.type === 'list') input = textInput('cfg-' + s.key, (c[s.key] || []).join(', '), '/var/www, /home');
      else input = textInput('cfg-' + s.key, c[s.key]);
      inputs[s.key] = { input, schema: s };
      rows.push(field(s.hint ? `${s.key}` : s.key, input, s.hint || ''));
    }

    if (!rows.length) {
      return ui.el('div', { class: 'card' },
        ui.el('h3', {}, 'Panel configuration'),
        ui.el('p', { class: 'text-dim' }, 'Only an administrator can change panel configuration.'));
    }

    const save = ui.el('button', { class: 'btn btn-primary' }, 'Save configuration');
    save.onclick = async () => {
      const payload = {};
      for (const [key, { input, schema }] of Object.entries(inputs)) {
        payload[key] = schema.type === 'bool'
          ? (input.value === '' ? null : input.value === '1')
          : (schema.type === 'int' ? Number(input.value) : input.value);
      }
      save.disabled = true;
      try {
        const r = await api.put('/settings', payload);
        ui.toast(`Saved ${r.changed.length} setting${r.changed.length === 1 ? '' : 's'}`);
        if (r.restartRequired) {
          restartNote.style.display = '';
          restartNote.textContent = 'Some changes (session timeout) only take effect after the panel restarts.';
        }
      } catch (e) {
        ui.toast(e.message, true);
      }
      save.disabled = false;
    };

    return ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Panel configuration'),
      ui.el('p', { class: 'text-dim', style: 'margin-top:-6px' }, 'Stored in config.json. Secrets are never shown or editable here.'),
      ...rows,
      ui.el('div', { class: 'modal-actions', style: 'justify-content:flex-start' }, save),
      restartNote
    );
  }

  /* ---------------------------- maintenance --------------------------- */
  function maintenanceCard(state, isAdmin) {
    const status = ui.el('p', { class: 'text-dim', style: 'font-size:12px' });
    const list = ui.el('div', { style: 'font-size:12.5px;font-family:var(--mono)' });

    const refresh = async () => {
      try {
        const { files } = await api.get('/settings/exports');
        list.innerHTML = '';
        if (!files.length) { list.appendChild(ui.el('div', { class: 'text-dim' }, 'No backups yet.')); return; }
        for (const f of files) {
          const row = ui.el('div', { style: 'display:flex;gap:10px;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)' },
            ui.el('span', { style: 'flex:1' }, f.name),
            ui.el('span', { class: 'text-dim' }, ui.fmtBytes(f.bytes) + ' · ' + new Date(f.createdAt).toLocaleString()));
          if (isAdmin) {
            const imp = ui.el('button', { class: 'btn btn-sm' }, 'Restore');
            imp.onclick = async () => {
              if (!(await ui.confirmBox(`Replace ALL panel data with ${f.name}?\n\nSites, users, mailboxes and databases will be overwritten. A copy of the current data is kept as db.json.before-import.`, { okText: 'Restore' }))) return;
              imp.disabled = true;
              try {
                const r = await api.post('/settings/import', { name: f.name });
                ui.toast(`Restored: ${r.sites} sites, ${r.users} users`);
                state.reload();
              } catch (e) { ui.toast(e.message, true); imp.disabled = false; }
            };
            row.appendChild(imp);
          }
          list.appendChild(row);
        }
      } catch (e) { status.textContent = e.message; }
    };

    const mk = ui.el('button', { class: 'btn btn-primary' }, 'Back up panel data');
    mk.onclick = async () => {
      mk.disabled = true;
      try {
        const r = await api.post('/settings/export');
        status.textContent = `Saved ${ui.fmtBytes(r.bytes)} to ${r.file}`;
        refresh();
      } catch (e) { ui.toast(e.message, true); }
      mk.disabled = false;
    };

    const clear = ui.el('button', { class: 'btn' }, 'Clear abandoned uploads');
    clear.onclick = async () => {
      if (!(await ui.confirmBox('Delete leftover upload temp files? Safe — finished uploads are already moved into place.', { okText: 'Clear' }))) return;
      try {
        const r = await api.post('/settings/clear-uploads');
        ui.toast(`Removed ${r.removed} file(s), ${ui.fmtBytes(r.bytes)} freed`);
      } catch (e) { ui.toast(e.message, true); }
    };

    const restart = ui.el('button', { class: 'btn btn-danger' }, 'Restart panel');
    restart.onclick = async () => {
      if (!(await ui.confirmBox('Restart the panel now? You will be signed out.', { okText: 'Restart' }))) return;
      try { await api.post('/settings/restart-panel'); } catch { /* connection drops on restart */ }
    };

    refresh();

    return ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Maintenance'),
      ui.el('p', { class: 'text-dim', style: 'margin-top:-6px' }, 'Backups hold your sites, mailboxes, databases and users.'),
      ui.el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px' }, mk, clear, isAdmin ? restart : null),
      status,
      list
    );
  }

  /* ----------------------------- sessions ----------------------------- */
  function sessionsCard(me) {
    const list = ui.el('div', { style: 'font-size:12.5px;font-family:var(--mono)' });
    const kill = ui.el('button', { class: 'btn' }, 'Sign out other sessions');
    kill.onclick = async () => {
      if (!(await ui.confirmBox('Sign out every other browser logged into your account?', { okText: 'Sign out others', danger: false }))) return;
      try {
        const r = await api.post('/settings/sessions/kill-others');
        ui.toast(r.killed ? `Signed out ${r.killed} session(s)` : 'No other sessions');
        load();
      } catch (e) { ui.toast(e.message, true); }
    };

    async function load() {
      try {
        const { sessions } = await api.get('/settings/sessions');
        list.innerHTML = '';
        if (!sessions.length) { list.appendChild(ui.el('div', { class: 'text-dim' }, 'No active sessions.')); return; }
        for (const s of sessions) {
          list.appendChild(ui.el('div', { style: 'display:flex;gap:10px;padding:5px 0;border-bottom:1px solid var(--border)' },
            ui.el('span', { style: 'flex:1' }, s.sid + ' · ' + s.user),
            ui.el('span', { class: s.current ? '' : 'text-dim' }, s.current ? 'this device' : new Date(s.createdAt || Date.now()).toLocaleString())));
        }
      } catch (e) { list.textContent = e.message; }
    }
    load();

    return ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Active sessions'),
      ui.el('p', { class: 'text-dim', style: 'margin-top:-6px' }, 'Browsers currently signed in to the panel.'),
      ui.el('div', { style: 'margin-bottom:10px' }, kill),
      list
    );
  }

  /* ------------------------------ system ------------------------------ */
  function systemCard() {
    const box = ui.el('pre', { class: 'pre-log', style: 'max-height:260px' }, 'Loading…');
    api.get('/settings/system').then((s) => {
      box.textContent = [
        `hostname : ${s.hostname}`,
        `kernel   : ${s.kernel}`,
        `node     : ${s.node}`,
        `uptime   : ${Math.floor(s.panelUptime / 60)} min (panel)`,
        `load     : ${s.load}`,
        '',
        s.disk.trim(),
        '',
        `config   : ${s.configFile}`,
        `data dir : ${s.dataDir}`,
        '',
        'installed: ' + Object.entries(s.installedServers).map(([k, v]) => `${k}=${v ? 'yes' : 'no'}`).join('  ')
      ].join('\n');
    }).catch((e) => { box.textContent = 'Could not load: ' + e.message; });

    return ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'System'),
      box
    );
  }

  /* ------------------------------ render ------------------------------ */
  async function render(root, me) {
    let data;
    try {
      data = await api.get('/settings');
    } catch (e) {
      root.innerHTML = '';
      root.appendChild(ui.el('div', { class: 'card empty' }, 'Could not load settings: ' + e.message));
      return;
    }
    const isAdmin = me.role === 'admin' || data.role === 'admin';
    const state = { reload: () => render(root, me) };

    root.innerHTML = '';
    root.appendChild(ui.el('div', { class: 'toolbar' },
      ui.el('button', { class: 'btn', onclick: () => render(root, me) }, '↻ Refresh')));
    root.appendChild(ui.el('p', { class: 'text-dim', style: 'margin-top:0' },
      'Panel settings, backups and account controls. '
      + (isAdmin ? 'You are an administrator — all sections are available.' : 'Administrator-only sections are hidden.')));

    root.appendChild(accountCard(me, state));
    root.appendChild(prefsCard(data));
    if (isAdmin) root.appendChild(configCard(data, isAdmin));
    root.appendChild(maintenanceCard(state, isAdmin));
    root.appendChild(sessionsCard(me));
    if (isAdmin) root.appendChild(systemCard());

    root.appendChild(ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'About'),
      ui.el('p', { class: 'text-dim' },
        'letzControl — lightweight VPS & hosting control panel. '
        + (data.hasDbPassword ? 'Database credentials are configured.' : 'Database access uses local root socket auth.'))));
  }

  return { render };
})();