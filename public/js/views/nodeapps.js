'use strict';
/* Node.js apps: the wizard's home, and start/stop/logs for apps it made. */
window.NodeAppsView = (() => {
  let timer = null;

  function appCard(app, me) {
    const state = app.active
      ? (app.listening ? ['running', 'green'] : ['starting, no port yet', 'yellow'])
      : (app.hasUnit ? [app.activeState || 'stopped', 'red'] : ['no service', 'gray']);

    const box = ui.el('div', { class: 'table-wrap' },
      ui.el('table', {},
        ui.el('thead', {}, ui.el('tr', {},
          ui.el('th', {}, 'Domain'), ui.el('th', {}, 'App port'),
          ui.el('th', {}, 'Service'), ui.el('th', {}, ''))),
        ui.el('tbody', {},
          ui.el('tr', {},
            ui.el('td', {}, ui.el('code', {}, app.domain), app.ssl ? ' ' : null,
              app.ssl ? ui.badge('ssl', 'green') : null),
            ui.el('td', { class: 'mono' }, String(app.appPort)),
            ui.el('td', {}, ui.badge(state[0], state[1])),
            ui.el('td', {}, controls(app))))));

    return box;
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

    if (app.hasUnit) {
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
    } else {
      wrap.append(ui.el('span', { class: 'text-dim', style: 'font-size:12px' },
        'fronted by Nginx only'));
    }
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
