'use strict';
/* Addons view: optional stack components (Redis, Varnish, webmail, antivirus,
 * Docker, cron, Node.js, Perl, FTP, phpMyAdmin, mail, DNS, SSL) with install
 * / uninstall jobs, service + vhost toggles and config editing. */
window.AddonsView = (() => {
  let poll = null;

  async function load(root, me) {
    root.innerHTML = '';
    if (poll) { clearInterval(poll); poll = null; }
    const [{ addons, job }] = await Promise.all([api.get('/addons'), api.get('/addons/job')]);

    root.appendChild(ui.el('div', { class: 'toolbar' },
      ui.el('strong', {}, 'Addons'),
      ui.el('span', { class: 'spacer' }),
      ui.el('button', { class: 'btn', onclick: () => { location.hash = '#/setup'; } }, '🧩 Setup Wizard'),
      ui.el('button', { class: 'btn', onclick: () => load(root, me) }, '↻ Refresh')
    ));
    root.appendChild(ui.el('p', { class: 'text-dim', style: 'margin:0 0 14px' },
      'Install, uninstall, enable/disable and manage the optional parts of the stack. Installs and removals stream their progress below.'));

    root.appendChild(renderJob(job, root, me));

    const grid = ui.el('div', { class: 'grid cols-2' });
    for (const a of addons) grid.appendChild(card(root, me, a));
    root.appendChild(grid);
  }

  /* --------------------------------------------------- job log --------- */
  function renderJob(job, root, me) {
    const wrap = ui.el('div', {});
    if (!job || !job.log) return wrap;
    const d = ui.el('details', { style: 'margin-bottom:14px' });
    if (job.running) d.setAttribute('open', '');
    const dismiss = ui.el('button', { class: 'btn btn-sm', style: 'margin-left:8px' }, '✕ Dismiss');
    const summary = ui.el('summary', {},
      job.running ? '⏳ Working… (live log)' : `Last job ${job.ok ? '✓ finished' : '✗ finished with errors'} — log`,
      dismiss);
    const pre = ui.el('pre', {
      style: 'max-height:280px;overflow:auto;white-space:pre-wrap;margin-top:8px;font-size:12px'
    }, job.log || '');
    d.append(summary, pre);
    wrap.appendChild(d);
    dismiss.onclick = (e) => { e.preventDefault(); wrap.remove(); };
    if (job.running) startPoll(pre, root, me);
    return wrap;
  }

  function startPoll(pre, root, me) {
    if (poll) clearInterval(poll);
    poll = setInterval(async () => {
      if (!pre.isConnected) { clearInterval(poll); poll = null; return; }
      try {
        const { job } = await api.get('/addons/job');
        pre.textContent = job.log || '';
        pre.scrollTop = pre.scrollHeight;
        if (!job.running) {
          clearInterval(poll); poll = null;
          ui.toast(job.ok ? 'Finished ✓' : 'Finished with errors - check the log', !job.ok);
          setTimeout(() => { if (root.isConnected) load(root, me); }, 500);
        }
      } catch { /* transient */ }
    }, 1200);
  }

  /* --------------------------------------------------- cards ----------- */
  function card(root, me, a) {
    const head = ui.el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' },
      ui.el('h3', { style: 'margin:0' }, `${a.icon} ${a.name}`),
      a.installed ? ui.badge('installed', 'green') : ui.badge('available', 'gray'),
      a.installed && a.version ? ui.badge(`v${a.version}`, 'cyan') : null,
      ui.el('span', { class: 'text-dim', style: 'margin-left:auto;font-size:12px' }, a.cat)
    );
    const c = ui.el('div', { class: 'card' },
      head,
      ui.el('p', { class: 'text-dim', style: 'margin:6px 0 8px;font-size:13px' }, a.desc)
    );

    const status = ui.el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center' });
    for (const s of a.services) status.appendChild(ui.badge(`${s.unit.replace(/\.service$/, '')}: ${s.active ? 'running' : s.state}`, s.active ? 'green' : 'red'));
    if (a.vhostOn !== null && a.vhostOn !== undefined) status.appendChild(ui.badge(a.vhostOn ? 'enabled' : 'disabled', a.vhostOn ? 'green' : 'gray'));
    if (a.port) status.appendChild(ui.el('span', { class: 'text-dim', style: 'font-size:12px' }, `port ${a.port}`));
    if (a.note && !a.installed) status.appendChild(ui.el('span', { class: 'text-dim', style: 'font-size:12px' }, a.note));
    if (status.children.length) c.appendChild(status);

    const row = ui.el('div', { class: 'toolbar', style: 'margin-top:12px;margin-bottom:0;flex-wrap:wrap' });

    if (!a.installed) {
      const btn = ui.el('button', { class: 'btn btn-primary btn-sm' }, '⬇ Install');
      btn.onclick = async () => {
        if (!(await ui.confirmBox(`Install ${a.name}? ${a.desc}`, { danger: false, okText: 'Install' }))) return;
        try {
          await api.post('/addons/install', { ids: [a.id] });
          ui.toast(`${a.name} install started`);
          load(root, me);
        } catch (e) { ui.toast(e.message, true); }
      };
      row.appendChild(btn);
      c.appendChild(row);
      return c;
    }

    /* --- installed: controls --- */
    const primary = a.services && a.services[0];
    const act = async (action, unit) => {
      try {
        const r = await api.post(`/addons/${a.id}/action`, { action, ...(unit ? { unit } : {}) });
        ui.toast(r.ok ? `${a.name}: ${action} ✓` : (r.output || `${action} failed`), !r.ok);
      } catch (e) { ui.toast(e.message, true); }
      load(root, me);
    };

    if (primary) {
      if (primary.active) {
        row.appendChild(ui.el('button', { class: 'btn btn-sm', onclick: () => act('stop') }, '⏸ Stop'));
        row.appendChild(ui.el('button', { class: 'btn btn-sm', onclick: () => act('restart') }, '↻ Restart'));
      } else {
        row.appendChild(ui.el('button', { class: 'btn btn-primary btn-sm', onclick: () => act('start') }, '▶ Start'));
      }
      row.appendChild(ui.el('button', {
        class: 'btn btn-sm',
        onclick: () => act(primary.enabled ? 'disable' : 'enable')
      }, primary.enabled ? '⏻ Disable autostart' : '⏻ Enable autostart'));
    }
    if (a.vhostOn !== null && a.vhostOn !== undefined) {
      row.appendChild(ui.el('button', {
        class: 'btn btn-sm',
        onclick: () => act(a.vhostOn ? 'disable' : 'enable')
      }, a.vhostOn ? '⏻ Disable' : '⏻ Enable'));
    }
    if (a.hasConfig) {
      row.appendChild(ui.el('button', { class: 'btn btn-sm', onclick: () => configModal(root, me, a) }, '📝 Config'));
    }
    if (a.link) {
      row.appendChild(ui.el('a', { class: 'btn btn-sm', href: a.link, target: '_blank', rel: 'opener' }, '🔗 Open ↗'));
    } else if (a.manage) {
      row.appendChild(ui.el('button', { class: 'btn btn-sm', onclick: () => { location.hash = a.manage; } }, '⚙ Manage'));
    }
    if (a.uninstallable) {
      row.appendChild(ui.el('span', { class: 'spacer' }));
      row.appendChild(ui.el('button', { class: 'btn btn-sm btn-danger', onclick: () => uninstallModal(root, me, a) }, '🗑 Uninstall'));
    }
    c.appendChild(row);
    return c;
  }

  /* ------------------------------------------------ config editor ------ */
  function configModal(root, me, a) {
    const body = ui.el('div', {});
    body.appendChild(ui.el('p', { class: 'text-dim mono', style: 'font-size:12px;margin-top:0' },
      `${a.id}-config · a backup is kept as .letzcontrol.bak; the config is validated where possible and the service restarts on save.`));
    const ta = ui.el('textarea', { rows: 20, spellcheck: 'false', style: 'width:100%;font-size:12px' });
    const out = ui.el('pre', { style: 'max-height:160px;overflow:auto;display:none;white-space:pre-wrap;font-size:12px' });
    body.append(ta, out);
    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const save = ui.el('button', { class: 'btn btn-primary' }, '💾 Save & apply');
    actions.append(cancel, save);
    body.appendChild(actions);
    const m = ui.modal({ title: `${a.name} configuration`, body, wide: true });
    cancel.onclick = m.close;

    api.get(`/addons/${a.id}/config`)
      .then((r) => { ta.value = r.content; })
      .catch((e) => { ui.toast(e.message, true); m.close(); });

    save.onclick = async () => {
      save.disabled = true;
      out.style.display = 'none';
      try {
        const r = await api.put(`/addons/${a.id}/config`, { content: ta.value });
        ui.toast(`${a.name}: saved${r.tested ? ', validated ✓' : ''}${r.restarted ? ', restarted ✓' : ''}`);
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
  function uninstallModal(root, me, a) {
    const body = ui.el('div', {});
    body.appendChild(ui.el('p', {}, `Uninstalling ${a.name} removes the package from the server.`));
    if (a.warn) body.appendChild(ui.el('div', { class: 'banner' }, a.warn));
    const confirmIn = ui.el('input', { type: 'text', placeholder: `type "${a.id}" to confirm` });
    body.appendChild(ui.el('label', {}, `Type ${a.id} to confirm`, confirmIn));
    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const ok = ui.el('button', { class: 'btn btn-danger', disabled: true }, 'Uninstall');
    actions.append(cancel, ok);
    body.appendChild(actions);
    const m = ui.modal({ title: `Uninstall ${a.name}?`, body });
    cancel.onclick = m.close;
    confirmIn.oninput = () => { ok.disabled = confirmIn.value.trim() !== a.id; };
    ok.onclick = async () => {
      try {
        await api.post(`/addons/${a.id}/uninstall`, { confirm: a.id });
        ui.toast(`${a.name} uninstall started`);
        m.close();
        load(root, me);
      } catch (e) {
        ui.toast(e.message, true);
      }
    };
  }

  function destroy() {
    if (poll) { clearInterval(poll); poll = null; }
  }

  return { render: load, destroy };
})();
