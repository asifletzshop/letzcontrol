'use strict';
/* Servers view: the installed web servers (Nginx, Apache, OpenLiteSpeed) -
 * status, start/stop, enable/disable, config editor with validation +
 * rollback, and uninstall with a typed confirmation. */
window.ServersView = (() => {
  async function load(root, me) {
    root.innerHTML = '';
    const [{ servers }, { sites }] = await Promise.all([
      api.get('/servers'),
      api.get('/sites')
    ]);

    root.appendChild(ui.el('div', { class: 'toolbar' },
      ui.el('strong', {}, 'Installed web servers'),
      ui.el('span', { class: 'spacer' }),
      ui.el('button', { class: 'btn', onclick: () => load(root, me) }, '↻ Refresh')
    ));
    root.appendChild(ui.el('p', { class: 'text-dim', style: 'margin:0 0 14px' },
      'Start, stop, enable or disable each server, edit its main configuration (validated with automatic rollback) or uninstall it.'));

    const grid = ui.el('div', { class: 'grid cols-2' });
    for (const s of servers) grid.appendChild(card(root, me, s, sites));
    root.appendChild(grid);
  }

  /* how many sites depend on this server being up */
  function sitesUsing(s, sites) {
    if (s.id === 'nginx') return sites.length; // fronts every site on 80/443
    return sites.filter((x) => x.backend === s.id).length;
  }

  async function act(root, me, s, action) {
    try {
      const r = await api.post(`/servers/${s.id}/action`, { action });
      ui.toast(r.ok ? `${s.name}: ${action} ✓` : (r.output || `${s.name}: ${action} failed`), !r.ok);
    } catch (e) {
      ui.toast(e.message, true);
    }
    load(root, me);
  }

  function card(root, me, s, sites) {
    const badge = (text, color) => ui.el('span', { style: 'margin-right:6px' }, ui.badge(text, color));
    const head = ui.el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' },
      ui.el('h3', { style: 'margin:0' }, `${s.id === 'nginx' ? '🌐' : s.id === 'apache' ? '🪶' : '⚡'} ${s.name}`),
      s.installed
        ? badge(s.active ? 'running' : s.activeState, s.active ? 'green' : 'red')
        : badge('not installed', 'gray'),
      s.installed
        ? badge(s.enabled ? 'starts on boot' : `startup: ${s.enabledState}`, s.enabled ? 'green' : 'gray')
        : null,
      s.installed && s.version ? badge(`v${s.version}`, 'cyan') : null
    );

    const c = ui.el('div', { class: 'card' },
      head,
      ui.el('dl', { class: 'kv', style: 'margin-top:8px' },
        ui.el('dt', {}, 'Ports'), ui.el('dd', { class: 'mono', style: 'font-size:12px' }, s.ports),
        ui.el('dt', {}, 'Config'), ui.el('dd', { class: 'mono', style: 'font-size:12px;word-break:break-all' }, s.config)
      ),
      ui.el('p', { class: 'text-dim', style: 'margin:6px 0 0;font-size:13px' }, s.desc)
    );

    if (!s.installed) {
      c.appendChild(ui.el('div', { class: 'toolbar', style: 'margin-top:12px;margin-bottom:0' },
        ui.el('button', { class: 'btn', onclick: () => { location.hash = '#/setup'; } }, '🧩 Install via Setup Wizard')));
      return c;
    }

    const row = ui.el('div', { class: 'toolbar', style: 'margin-top:12px;margin-bottom:0;flex-wrap:wrap' });
    if (!s.active) row.appendChild(ui.el('button', { class: 'btn btn-primary btn-sm', onclick: () => act(root, me, s, 'start') }, '▶ Start'));
    else {
      row.appendChild(ui.el('button', { class: 'btn btn-sm', onclick: () => act(root, me, s, 'stop') }, '⏸ Stop'));
      row.appendChild(ui.el('button', { class: 'btn btn-sm', onclick: () => act(root, me, s, 'restart') }, '↻ Restart'));
      row.appendChild(ui.el('button', { class: 'btn btn-sm', onclick: () => act(root, me, s, 'reload') }, '⟳ Reload'));
    }
    row.appendChild(ui.el('button', {
      class: 'btn btn-sm',
      onclick: () => act(root, me, s, s.enabled ? 'disable' : 'enable')
    }, s.enabled ? '⏻ Disable autostart' : '⏻ Enable autostart'));
    row.appendChild(ui.el('span', { class: 'spacer' }));
    row.appendChild(ui.el('button', { class: 'btn btn-sm', onclick: () => configModal(root, me, s) }, '📝 Configure'));
    row.appendChild(ui.el('button', { class: 'btn btn-sm btn-danger', onclick: () => uninstallModal(root, me, s, sites) }, '🗑 Uninstall'));
    c.appendChild(row);
    return c;
  }

  /* ------------------------------------------------ config editor ----- */
  function configModal(root, me, s) {
    const body = ui.el('div', {});
    body.appendChild(ui.el('p', { class: 'text-dim mono', style: 'font-size:12px;margin-top:0' },
      `${s.config} · a backup is written to ${s.config}.letzcontrol.bak, the config is validated, and the server reloads. If validation fails the previous config is restored automatically.`));
    const ta = ui.el('textarea', { rows: 22, spellcheck: 'false', style: 'width:100%;font-size:12px' });
    const out = ui.el('pre', { style: 'max-height:160px;overflow:auto;display:none;white-space:pre-wrap;font-size:12px' });
    body.append(ta, out);
    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const save = ui.el('button', { class: 'btn btn-primary' }, '💾 Save, validate & reload');
    actions.append(cancel, save);
    body.appendChild(actions);
    const m = ui.modal({ title: `${s.name} configuration`, body, wide: true });
    cancel.onclick = m.close;

    api.get(`/servers/${s.id}/config`)
      .then((r) => { ta.value = r.content; })
      .catch((e) => { ui.toast(e.message, true); m.close(); });

    save.onclick = async () => {
      save.disabled = true;
      out.style.display = 'none';
      try {
        const r = await api.put(`/servers/${s.id}/config`, { content: ta.value });
        ui.toast(`${s.name}: saved${r.tested ? ', validated ✓' : ''}${r.reloaded ? ', reloaded ✓' : ''}`);
        if (r.output) { out.textContent = r.output; out.style.display = ''; }
        m.close();
        load(root, me);
      } catch (e) {
        ui.toast(e.message, true);
        const detail = (e.body && e.body.output) || '';
        if (detail) { out.textContent = detail; out.style.display = ''; }
        save.disabled = false;
      }
    };
  }

  /* ------------------------------------------------- uninstall --------- */
  function uninstallModal(root, me, s, sites) {
    const n = sitesUsing(s, sites);
    const impact = s.id === 'nginx'
      ? `All ${n} site(s), webmail (:2088) and phpMyAdmin (:2089) will stop being served publicly. The panel stays up on :2087.`
      : s.id === 'apache'
        ? `${n} site(s) using the Apache backend will stop responding.`
        : `${n} site(s) using the OpenLiteSpeed backend (LSCache) will stop responding.`;

    const body = ui.el('div', {});
    body.appendChild(ui.el('p', {}, `Uninstalling ${s.name} removes the package and its configuration.`));
    body.appendChild(ui.el('p', { class: 'banner' }, impact));
    const confirmIn = ui.el('input', { type: 'text', placeholder: `type "${s.id}" to confirm` });
    body.appendChild(ui.el('label', {}, `Type ${s.id} to confirm`, confirmIn));
    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const ok = ui.el('button', { class: 'btn btn-danger', disabled: true }, 'Uninstall');
    actions.append(cancel, ok);
    body.appendChild(actions);
    const m = ui.modal({ title: `Uninstall ${s.name}?`, body });
    cancel.onclick = m.close;
    confirmIn.oninput = () => { ok.disabled = confirmIn.value.trim() !== s.id; };
    ok.onclick = async () => {
      ok.disabled = true;
      ok.textContent = 'Uninstalling…';
      try {
        const r = await api.post(`/servers/${s.id}/uninstall`, { confirm: s.id });
        ui.toast(r.ok ? `${s.name} uninstalled` : `${s.name}: uninstall finished with errors`, !r.ok);
        m.close();
        load(root, me);
      } catch (e) {
        ui.toast(e.message, true);
        ok.disabled = false;
        ok.textContent = 'Uninstall';
      }
    };
  }

  return { render: load };
})();
