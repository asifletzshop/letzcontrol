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

  /* ------------------------ panel domain (admin) ---------------------- */
  function domainCard(state) {
    const domain = ui.el('input', { type: 'text', id: 'panel-domain', placeholder: 'panel.example.com' });
    const sslBox = ui.el('input', { type: 'checkbox', id: 'panel-domain-ssl' });
    const status = ui.el('div', { class: 'text-dim', style: 'font-size:12.5px;margin-bottom:8px' });
    const detail = ui.el('div', { style: 'font-size:12.5px' });

    let current = null;

    async function load() {
      try {
        current = await api.get('/settings/panel');
      } catch (e) { status.textContent = e.message; return; }
      domain.value = current.domain || '';
      sslBox.checked = !!current.ssl;

      status.innerHTML = '';
      detail.innerHTML = '';
      if (!current.domain) {
        status.appendChild(ui.el('div', {},
          `The panel is only reachable at `, ui.el('code', {}, `http://SERVER_IP:${current.port}`),
          `. Add a domain to reach it by name.`));
      } else {
        status.appendChild(ui.el('div', {},
          current.ssl ? 'Serving at ' : 'Serving at ',
          ui.el('code', {}, current.ssl ? `https://${current.domain}` : `http://${current.domain}`),
          current.ssl ? ' with a valid SSL certificate.' : ' over plain HTTP.'));
        const rows = [
          ['Domain', current.domain],
          ['SSL', current.ssl ? 'certificate installed and active' : 'not enabled'],
          ['Nginx vhost', current.vhostWritten ? 'written' : 'missing'],
          ['Points at this server', current.dnsHint || 'checked when you save'],
          ['Firewall', current.firewall]
        ];
        for (const [k, v] of rows) {
          detail.appendChild(ui.el('div', { style: 'display:flex;gap:10px;padding:4px 0;border-bottom:1px solid var(--border)' },
            ui.el('span', { class: 'text-dim', style: 'width:170px' }, k),
            ui.el('span', { style: 'flex:1' }, v)));
        }
      }
    }

    const save = ui.el('button', { class: 'btn btn-primary' }, 'Save domain');
    save.onclick = async () => {
      save.disabled = true;
      const value = domain.value.trim();
      try {
        let r;
        try {
          r = await api.post('/settings/panel/domain', { domain: value, ssl: sslBox.checked });
        } catch (e) {
          // DNS does not point here yet: that is a normal state while the
          // record is propagating, so offer the override rather than only
          // refusing.
          if ((e.body && e.body.needsForce) || /points at|no A record/.test(e.message)) {
            if (!(await ui.confirmBox(
              `${e.message}\n\nSave it anyway? The domain will not work until its DNS record points at this server, and no SSL certificate can be issued until then.`,
              { okText: 'Save anyway', danger: false }))) return;
            r = await api.post('/settings/panel/domain', { domain: value, ssl: sslBox.checked, force: true });
          } else throw e;
        }
        ui.toast(`Panel domain saved: ${r.domain}`);
        state.reload();
      } catch (e) { ui.toast(e.message, true); }
      save.disabled = false;
    };

    const cert = ui.el('button', { class: 'btn' }, 'Issue / renew SSL certificate');
    cert.onclick = async () => {
      if (!(await ui.confirmBox(
        'Request a Let\u2019s Encrypt certificate for this panel domain?\n\nThis needs the domain to already point at this server on port 80.',
        { okText: 'Request certificate', danger: false }))) return;
      cert.disabled = true;
      try {
        const r = await api.post('/settings/panel/domain/ssl', {});
        if (r.ok) ui.toast('Certificate installed - the panel now serves HTTPS');
        else ui.toast('Certificate could not be issued. Open the logs for the reason.', true);
        state.reload();
      } catch (e) { ui.toast(e.message, true); }
      cert.disabled = false;
    };

    const remove = ui.el('button', { class: 'btn btn-danger' }, 'Remove domain');
    remove.onclick = async () => {
      if (!(await ui.confirmBox(
        'Stop serving the panel on this domain?\n\nThe panel will still be reachable at its IP and port, so you will not be locked out.',
        { okText: 'Remove', danger: true }))) return;
      try {
        await api.del('/settings/panel/domain');
        ui.toast('Panel domain removed');
        state.reload();
      } catch (e) { ui.toast(e.message, true); }
    };

    load();

    return ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Panel domain'),
      ui.el('p', { class: 'text-dim', style: 'margin-top:-6px' },
        'Serve the panel at a real hostname instead of an IP address. Point the domain\u2019s A record at this server first.'),
      field('Domain name', domain, 'For example panel.example.com'),
      ui.el('label', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:8px' },
        sslBox, ui.el('span', {}, 'Use SSL (issue a certificate after saving)')),
      status,
      ui.el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, save, cert, remove),
      current ? detail : null
    );
  }

  /* ------------------------- panel port (admin) ----------------------- */
  function portCard(state) {
    const port = intInput('panel-port', '', 1024, 65535);
    const current = ui.el('div', { class: 'text-dim', style: 'font-size:12.5px;margin-bottom:8px' });
    const detail = ui.el('div', { style: 'font-size:12.5px' });
    let info = null;
    let reserved = [];
    let inUse = [];

    async function load() {
      try {
        info = await api.get('/settings/panel');
        port.value = info.port;
        current.textContent = `The panel is listening on port ${info.port}.`;
      } catch (e) { current.textContent = e.message; }
      try {
        const p = await api.get('/settings/panel/ports');
        reserved = p.reserved || [];
        inUse = p.used || [];
        detail.innerHTML = '';
        const say = (label, list, why) => detail.appendChild(ui.el('div',
          { style: 'display:flex;gap:10px;padding:4px 0;border-bottom:1px solid var(--border)' },
          ui.el('span', { class: 'text-dim', style: 'width:170px' }, label),
          ui.el('span', { style: 'flex:1' }, list.join(', ') || 'none', why ? ui.el('div', { class: 'text-dim', style: 'font-size:11.5px' }, why) : null)));
        say('In use now', inUse, null);
        say('Reserved for the stack', reserved, 'The panel cannot use these - they belong to the web servers, mail or MySQL.');
      } catch { /* the hint is optional */ }
    }

    const save = ui.el('button', { class: 'btn btn-primary' }, 'Change port');
    save.onclick = async () => {
      const next = Number(port.value);
      if (!Number.isInteger(next)) return ui.toast('Enter a port number', true);
      /* Check the same rules the server does, so an impossible port is refused
       * straight away instead of after a confirmation the user is already
       * imagining. The server still re-checks - this is only to save a pointless
       * restart and a confusing dialog. */
      if (next < 1024 || next > 65535) {
        return ui.toast('Use a port between 1024 and 65535', true);
      }
      if (next === info.port) return ui.toast(`The panel is already on port ${next}`, true);
      if (reserved.includes(next)) {
        return ui.toast(`Port ${next} is reserved for the hosting stack (web servers, mail or MySQL)`, true);
      }
      if (inUse.includes(next)) return ui.toast(`Something is already listening on port ${next}`, true);
      if (!(await ui.confirmBox(
        `Move the panel from port ${info.port} to ${next}?\n\n`
        + 'The panel restarts, so you will be signed out and the new address will be:\n\n'
        + `  http://SERVER_IP:${next}\n\n`
        + 'If anything goes wrong the panel puts the old port back by itself after about 35 seconds.',
        { okText: `Change to ${next}` }))) return;
      save.disabled = true;
      try {
        const r = await api.post('/settings/panel/port', { port: next });
        ui.toast(`Port changed to ${r.port}. Reopen the panel at ${next}.`);
        setTimeout(() => { location.href = `http://${location.hostname}:${next}/login.html`; }, 4000);
      } catch (e) { ui.toast(e.message, true); save.disabled = false; }
    };

    load();

    return ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Panel port'),
      ui.el('p', { class: 'text-dim', style: 'margin-top:-6px' },
        'The port the panel listens on. Changing it restarts the panel and moves the firewall rule with it.'),
      field('Listen port', port, 'Between 1024 and 65535. The old port is restored automatically if the panel does not come back.'),
      current,
      ui.el('div', { style: 'margin-bottom:10px' }, save),
      detail
    );
  }

  /* ------------------------ server time (admin) ----------------------- */
  function timeCard(state) {
    const zone = ui.el('select', { id: 'server-tz', size: '8', style: 'font-family:var(--mono);font-size:12.5px' });
    const search = ui.el('input', { type: 'text', id: 'tz-search', placeholder: 'Filter, e.g. Kolkata' });
    const status = ui.el('div', { class: 'text-dim', style: 'font-size:12.5px;margin-bottom:8px' });
    const warn = ui.el('div', {});
    const all = ui.el('div', {});

    async function load() {
      try {
        const t = await api.get('/settings/time');
        status.innerHTML = '';
        status.appendChild(ui.el('div', {},
          'Time zone now: ', ui.el('code', {}, t.timezone || 'unknown'),
          t.ntpSynced ? ' · clock is synchronised' : ' · clock is NOT synchronised'));
        status.appendChild(ui.el('div', { style: 'margin-top:2px' }, `Server time: ${t.local}`));

        // timedatectl and /etc/timezone disagreeing means the recorded zone
        // name is stale even though the clock itself is right. Say so plainly
        // rather than hiding it.
        if (t.etcTimezone && t.timezone && t.etcTimezone !== t.timezone) {
          warn.innerHTML = '';
          warn.appendChild(ui.el('div', {
            style: 'background:var(--warn-bg,#3a2a12);border:1px solid var(--warn-border,#7a5a20);'
              + 'border-radius:6px;padding:8px 10px;margin-bottom:8px;font-size:12.5px'
          },
            `The clock runs on ${t.timezone}, but /etc/timezone still says ${t.etcTimezone}. `
            + 'Saving the time zone below corrects that file too.'));
        } else warn.innerHTML = '';

        zone.innerHTML = '';
        for (const z of t.zoneList) {
          zone.appendChild(ui.el('option', { value: z }, z));
        }
        zone.value = t.timezone || '';
        search.oninput = () => {
          const q = search.value.trim().toLowerCase();
          const keep = zone.value;
          const matches = q ? t.zoneList.filter((z) => z.toLowerCase().includes(q)) : t.zoneList;
          zone.innerHTML = '';
          /* Cap only a FILTERED list. Capping the unfiltered one meant clearing
           * the box left the picker stuck showing the first 300 zones. */
          for (const z of (q ? matches.slice(0, 300) : matches)) {
            zone.appendChild(ui.el('option', { value: z }, z));
          }
          if (matches.length) {
            zone.value = keep;
          } else {
            zone.appendChild(ui.el('option', { value: '' }, 'no zone matches that'));
          }
        };

        const ntpLabel = ui.el('span', {}, `Keep the clock in sync with an NTP server (currently ${t.ntp ? 'on' : 'off'})`);
        const ntpBtn = ui.el('button', { class: 'btn' }, t.ntp ? 'Turn NTP off' : 'Turn NTP on');
        ntpBtn.onclick = async () => {
          ntpBtn.disabled = true;
          try {
            await api.post('/settings/time/ntp', { enabled: !t.ntp });
            ui.toast(`NTP turned ${t.ntp ? 'off' : 'on'}`);
            state.reload();
          } catch (e) { ui.toast(e.message, true); ntpBtn.disabled = false; }
        };
        all.innerHTML = '';
        all.appendChild(ui.el('div', { style: 'display:flex;gap:10px;align-items:center;margin-top:8px' }, ntpBtn, ntpLabel));

        const syncBtn = ui.el('button', { class: 'btn' }, 'Force a sync now');
        syncBtn.onclick = async () => {
          syncBtn.disabled = true;
          try { await api.post('/settings/time/sync', {}); ui.toast('Sync requested'); state.reload(); }
          catch (e) { ui.toast(e.message, true); syncBtn.disabled = false; }
        };
        all.appendChild(ui.el('div', { style: 'margin-top:8px;display:flex;gap:10px;align-items:center' }, syncBtn,
          ui.el('span', { class: 'text-dim', style: 'font-size:12.5px' }, 'Step the clock to the NTP time immediately')));
      } catch (e) { status.textContent = e.message; }
    }

    const save = ui.el('button', { class: 'btn btn-primary' }, 'Set time zone');
    save.onclick = async () => {
      const tz = zone.value;
      if (!tz) return ui.toast('Pick a time zone', true);
      if (!(await ui.confirmBox(
        `Change the server time zone to ${tz}?\n\nThis shifts cron jobs and log timestamps on the whole server. PHP keeps its own date.timezone setting, which you change under PHP.`,
        { okText: 'Change time zone', danger: false }))) return;
      save.disabled = true;
      try {
        const r = await api.post('/settings/time', { timezone: tz });
        ui.toast(r.note ? `Time zone set. ${r.note}` : `Time zone set to ${r.timezone}`);
        state.reload();
      } catch (e) { ui.toast(e.message, true); }
      save.disabled = false;
    };

    load();

    return ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Server time'),
      ui.el('p', { class: 'text-dim', style: 'margin-top:-6px' },
        'The time zone the whole server runs on. Changing it shifts PHP, cron and every site on the box.'),
      status,
      warn,
      field('Time zone', ui.el('div', {}, search, zone)),
      ui.el('div', { class: 'modal-actions', style: 'justify-content:flex-start' }, save),
      all
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
    if (isAdmin) {
      root.appendChild(domainCard(state));
      root.appendChild(portCard(state));
      root.appendChild(timeCard(state));
      root.appendChild(configCard(data, isAdmin));
    }
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