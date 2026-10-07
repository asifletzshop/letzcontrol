'use strict';
/* Node.js apps: the wizard's home, and start/stop/logs for apps it made. */
window.NodeAppsView = (() => {
  let timer = null;

  function appCard(app, me) {
    const state = app.active
      ? (app.listening ? ['running', 'green'] : ['starting, no port yet', 'yellow'])
      : (app.hasUnit ? [app.activeState || 'stopped', 'red'] : ['not running', 'gray']);

    /* How the panel relates to this app. "panel" = the wizard built and owns the
       unit; "adopted" = the app already had its own unit, and the panel records
       it and drives it through that one; "none" = nothing manages it yet. */
    const managed = ({
      panel: ['panel managed', 'blue'],
      adopted: ['adopted', 'gray'],
      'existing-unit': ['existing unit', 'gray'],
      none: ['unmanaged', 'yellow']
    })[app.managed] || ['unmanaged', 'yellow'];

    const meta = ui.el('div', { class: 'app-meta' },
      ui.badge(managed[0], managed[1]),
      ui.el('span', { class: 'mono' }, `:${app.appPort}`),
      app.runUser ? ui.el('span', {}, ` · ${app.runUser}`) : null);

    const detail = [];
    if (app.unit) detail.push(['Unit', app.unit]);
    if (app.execStart) detail.push(['Start command', app.execStart]);
    if (app.workingDir) detail.push(['Working folder', app.workingDir]);

    const box = ui.el('div', { class: 'table-wrap' },
      ui.el('table', {},
        ui.el('thead', {}, ui.el('tr', {},
          ui.el('th', {}, 'Domain'), ui.el('th', {}, 'App port'),
          ui.el('th', {}, 'Service'), ui.el('th', {}, ''))),
        ui.el('tbody', {},
          ui.el('tr', {},
            ui.el('td', {},
              ui.el('code', {}, app.domain),
              app.ssl ? ' ' : null,
              app.ssl ? ui.badge('ssl', 'green') : null,
              ui.el('div', { style: 'margin-top:5px' }, meta)),
            ui.el('td', { class: 'mono' }, String(app.appPort)),
            ui.el('td', {}, ui.badge(state[0], state[1])),
            ui.el('td', {}, controls(app))))));

    if (detail.length) {
      const dl = ui.el('dl', { class: 'kv kv-tight', style: 'margin-top:10px' });
      for (const [k, v] of detail) {
        dl.appendChild(ui.el('dt', {}, k));
        dl.appendChild(ui.el('dd', { class: 'clamp mono', title: v }, v));
      }
      box.appendChild(dl);
    }
    return box;
  }

  /** Show what the panel found, then record it. Nothing is restarted. */
  async function adopt(domain) {
    let found;
    try { found = await api.get(`/node-apps/${encodeURIComponent(domain)}/inspect`); }
    catch (e) { return ui.toast(e.message, true); }

    const lines = [];
    if (found.unit) {
      lines.push(`Service   ${found.unit.name}  (${found.unit.enabled ? 'enabled at boot' : 'not enabled'})`);
      lines.push(`Start     ${found.unit.execStart}`);
      lines.push(`User      ${found.unit.user}`);
      if (found.unit.workingDir) lines.push(`Folder    ${found.unit.workingDir}`);
    } else if (found.process) {
      lines.push(`Command   ${found.process.cmdline}`);
      lines.push(`User      ${found.process.user}`);
      lines.push(`Folder    ${found.process.cwd}`);
    }
    for (const n of (found.notes || [])) lines.push(`· ${n}`);

    if (!(await ui.confirmBox(
      `This is how ${domain} is running right now:\n\n${lines.join('\n')}\n\n`
      + 'Record it in the panel? Nothing is changed and nothing is restarted - the '
      + 'panel will simply be able to show it and drive its existing service.',
      { okText: 'Record it', danger: false }))) return;

    try {
      await api.post(`/node-apps/${encodeURIComponent(domain)}/adopt`, {});
      ui.toast(`${domain} recorded`);
      refresh();
    } catch (e) { ui.toast(e.message, true); }
  }

  function controls(app) {
    const wrap = ui.el('div', { style: 'display:flex;gap:6px;justify-content:flex-end' });

    const act = async (action) => {
      try {
        const r = await api.post(`/node-apps/${encodeURIComponent(app.domain)}/${action}`, {});
        ui.toast(`${app.domain}: ${action} ✓${r.active === false ? ' (now stopped)' : ''}`);
      } catch (e) { ui.toast(e.message, true); }
      refresh();
    };

    if (app.managed === 'none' || !app.hasUnit) {
      const b = mk('◎ Adopt', 'Let the panel take this existing app over — records how it runs, changes nothing', () => adopt(app.domain));
      wrap.appendChild(b);
      return wrap;
    }
    if (app.active) {
      wrap.append(mk('⏸', 'Stop', () => act('stop')));
      wrap.append(mk('↻', 'Restart', () => act('restart')));
    } else {
      wrap.append(mk('▶', 'Start', () => act('start')));
    }
    wrap.append(mk(app.enabled ? '⏻ Disable' : '⏻ Enable',
      app.enabled ? 'Do not start at boot' : 'Start at boot',
      () => act(app.enabled ? 'disable' : 'enable')));
    wrap.append(mk('▤', 'Logs', async () => {
      try {
        const r = await api.get(`/node-apps/${encodeURIComponent(app.domain)}/logs`);
        ui.modal({
          title: `${app.domain} — last 100 log lines`,
          body: ui.el('pre', { class: 'pre-log', style: 'max-height:460px' }, r.log)
        });
      } catch (e) { ui.toast(e.message, true); }
    }));
    return wrap;
  }

  const mk = (text, title, onclick) => {
    const b = ui.el('button', { class: 'btn btn-sm', title }, text);
    b.onclick = onclick;
    return b;
  };

  let refresh = () => {};

  async function render(root, me) {
    root.innerHTML = '';

    const header = ui.el('div', { class: 'toolbar' },
      ui.el('p', { class: 'text-dim', style: 'margin:0;flex:1' },
        'Node apps run as their own systemd service on a private port, behind Nginx.'),
      ui.el('button', {
        class: 'btn btn-primary',
        onclick: () => { location.hash = '#/nodewizard?step=1'; }
      }, '＋ New Node.js website'),
      ui.el('button', { class: 'btn', onclick: () => { location.hash = '#/nodewizard'; } }, '↻ Refresh'));

    const body = ui.el('div', { class: 'card' }, ui.el('p', { class: 'text-dim' }, 'Loading…'));
    root.append(header, body);

    refresh = async () => {
      if (!root.isConnected) { clearInterval(timer); return; }
      let data;
      try { data = await api.get('/node-apps'); }
      catch (e) { body.innerHTML = ''; body.appendChild(ui.el('p', {}, e.message)); return; }

      body.innerHTML = '';
      body.appendChild(ui.el('h3', {}, 'Your Node.js apps'));
      if (!data.apps.length) {
        body.appendChild(ui.el('p', { class: 'text-dim' },
          'No Node.js apps yet. The wizard sets up the app folder, a hardened systemd service, ' +
          'and the Nginx vhost in one go.'));
      } else {
        for (const a of data.apps) {
          body.appendChild(appCard(a, me));
          body.appendChild(ui.el('div', { style: 'height:10px' }));
        }
      }

      const job = data.job;
      if (job && job.running) {
        const log = ui.el('pre', { class: 'pre-log', style: 'max-height:260px' }, job.log || '');
        body.appendChild(ui.el('div', { style: 'margin-top:8px' },
          ui.el('strong', {}, `Installing ${job.domain || ''}…`), log));
      }
    };
    await refresh();

    /* Poll while an install is in flight, otherwise stop. */
    clearInterval(timer);
    timer = setInterval(() => { refresh(); }, job0Running() ? 1500 : 6000);
    function job0Running() {
      const b = document.querySelector('.pre-log');
      return !!(b && b.textContent && b.textContent !== 'Loading…');
    }
  }

  return {
    render,
    destroy() { clearInterval(timer); }
  };
})();
