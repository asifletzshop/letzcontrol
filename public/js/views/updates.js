'use strict';
/* Panel updates: notice when the running code is behind the repository, and
 * apply an update in place.
 *
 * This is deliberately a button and not an automatic pull. The panel runs as
 * root with a web terminal, so quietly replacing its own code would mean a bad
 * push takes down every install at once with nobody watching. */
window.UpdatesView = (() => {
  let pollTimer = null;

  /* ------------------------------ banner ------------------------------- */
  /* A quiet strip on the dashboard. Only rendered when there is genuinely
   * something new - a banner that shows up every visit trains people to ignore
   * banners, which is the opposite of what an update notice is for. */
  async function banner(me) {
    if (me.role !== 'admin') return null;
    let u;
    try { u = await api.get('/updates'); } catch { return null; }
    if (!u.reachable || !u.updateAvailable) return null;

    const box = ui.el('div', {
      class: 'card',
      style: 'border-color:var(--warn-border,#7a5a20);background:var(--warn-bg,#2a2013);'
        + 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px'
    });
    const text = ui.el('div', { style: 'flex:1;min-width:220px' },
      ui.el('strong', {}, `letzControl ${u.upstream} is available`),
      ui.el('span', { class: 'text-dim' }, `  (running ${u.installed})`),
      u.commits && u.commits.length
        ? ui.el('div', { class: 'text-dim', style: 'font-size:12px;margin-top:2px' },
            `Latest: ${u.commits[0].subject}`)
        : null);

    const go = ui.el('button', { class: 'btn btn-primary' }, 'Review update');
    go.onclick = () => { location.hash = '#/updates'; };

    box.append(text, go);
    return box;
  }

  /* ------------------------------- card -------------------------------- */
  function statusBox(u) {
    if (!u.reachable) {
      return ui.el('div', {
        style: 'background:var(--warn-bg,#3a2a12);border:1px solid var(--warn-border,#7a5a20);'
          + 'border-radius:6px;padding:10px 12px;font-size:12.5px'
      }, u.note || 'Could not reach the repository.');
    }
    return null;
  }

  function commitList(u) {
    if (!u.commits || !u.commits.length) return null;
    const rows = u.commits.map((c) => ui.el('div', {
      style: 'display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12.5px'
    },
      ui.el('code', { class: 'text-dim', style: 'width:64px;flex:none' }, c.sha),
      ui.el('span', { style: 'flex:1' }, c.subject),
      c.date ? ui.el('span', { class: 'text-dim', style: 'flex:none' }, new Date(c.date).toLocaleDateString()) : null));
    return ui.el('div', { style: 'margin-top:12px' },
      ui.el('h3', { style: 'margin-bottom:2px' }, 'What changed'),
      ui.el('p', { class: 'text-dim', style: 'margin-top:0;font-size:12px' },
        u.updateAvailable ? 'Changes included in the update:' : 'Recent commits on the repository:'),
      ...rows);
  }

  async function render(root, me) {
    root.innerHTML = '';
    root.appendChild(ui.el('div', { class: 'toolbar' },
      (() => {
        const b = ui.el('button', { class: 'btn' }, '↻ Check now');
        b.onclick = async () => {
          b.disabled = true;
          b.textContent = 'Checking…';
          try { await api.post('/updates/check', {}); } catch { /* shown in the card */ }
          render(root, me);
        };
        return b;
      })()));

    const body = ui.el('div', { class: 'card' }, ui.el('p', { class: 'text-dim' }, 'Checking for updates…'));
    root.appendChild(body);

    let u;
    try {
      u = await api.get('/updates', { });
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(ui.el('p', {}, 'Could not check for updates: ' + e.message));
      return;
    }

    const log = ui.el('pre', { class: 'pre-log', style: 'max-height:320px;display:none' });

    const showLog = (txt) => {
      if (!txt) return;
      log.style.display = '';
      log.textContent = txt;
    };

    const applyBtn = ui.el('button', { class: 'btn btn-primary' }, `Update to ${u.upstream || 'latest'}`);
    const refresh = ui.el('button', { class: 'btn' }, '↻ Refresh');
    refresh.onclick = () => render(root, me);

    body.innerHTML = '';
    body.appendChild(ui.el('h3', {}, 'Panel updates'));
    body.appendChild(ui.el('p', { class: 'text-dim', style: 'margin-top:-6px' },
      'Keep the panel itself current. Updates replace the panel code only — your sites, users, mailboxes and databases are never touched.'));

    const warn = statusBox(u);
    if (warn) body.appendChild(warn);

    body.appendChild(ui.el('dl', { class: 'kv' },
      ui.el('dt', {}, 'Installed version'), ui.el('dd', { class: 'mono' }, u.installed),
      ui.el('dt', {}, 'Latest version'), ui.el('dd', { class: 'mono' }, u.upstream || '—'),
      ui.el('dt', {}, 'Repository'), ui.el('dd', { class: 'mono' }, `${u.repo} (${u.branch})`),
      ui.el('dt', {}, 'Status'), ui.el('dd', {},
        !u.reachable ? 'could not be checked'
          : u.updateAvailable ? `update available — ${u.installed} → ${u.upstream}`
            : 'up to date'),
      ui.el('dt', {}, 'Last checked'), ui.el('dd', {},
        u.checkedAt ? new Date(u.checkedAt).toLocaleString() : '—')
    ));

    if (u.updateAvailable) {
      body.appendChild(ui.el('div', { class: 'modal-actions', style: 'justify-content:flex-start' }, applyBtn));
      const clr = ui.el('button', { class: 'btn' }, 'Clear log');
      clr.onclick = async () => {
        try { await api.post('/updates/log/clear', {}); log.style.display = 'none'; } catch { /* fine */ }
      };
      body.appendChild(clr);
    } else {
      body.appendChild(ui.el('div', {}, refresh));
    }

    const list = commitList(u);
    if (list) body.appendChild(list);

    if (u.job && u.job.log) showLog(u.job.log);

    /* While an update runs the panel restarts, so the connection drops. Keep
     * polling so the log fills in until the page dies, then stop. */
    if (u.job && u.job.running) {
      applyBtn.disabled = true;
      applyBtn.textContent = 'Updating…';
      clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        try {
          const s = await api.get('/updates');
          showLog(s.job && s.job.log);
          if (!s.job || !s.job.running) { clearInterval(pollTimer); render(root, me); }
        } catch { clearInterval(pollTimer); }
      }, 1500);
    }

    applyBtn.onclick = async () => {
      if (!(await ui.confirmBox(
        `Update the panel from ${u.installed} to ${u.upstream}?\n\n`
        + 'config.json and your panel data are backed up first, and only the '
        + 'panel code is replaced. The panel restarts when it finishes, so you '
        + 'will be signed out and need to log in again.',
        { okText: `Update to ${u.upstream}`, danger: false }))) return;
      applyBtn.disabled = true;
      applyBtn.textContent = 'Starting…';
      try {
        const r = await api.post('/updates/apply', {});
        ui.toast(`Updating ${r.from} → ${r.to}`);
        showLog(r.job && r.job.log);
        applyBtn.textContent = 'Updating…';
        clearInterval(pollTimer);
        pollTimer = setInterval(async () => {
          try {
            const s = await api.get('/updates');
            showLog(s.job && s.job.log);
            if (!s.job || !s.job.running) { clearInterval(pollTimer); }
          } catch { clearInterval(pollTimer); }
        }, 1500);
      } catch (e) {
        ui.toast(e.message, true);
        applyBtn.disabled = false;
        applyBtn.textContent = `Update to ${u.upstream}`;
      }
    };

    /* Backups taken before each update, so an unwanted one can be undone. */
    api.get('/updates/backups').then(({ files }) => {
      if (!files || !files.length) return;
      const list2 = ui.el('div', { style: 'margin-top:16px' },
        ui.el('h3', { style: 'margin-bottom:2px' }, 'Pre-update backups'),
        ui.el('p', { class: 'text-dim', style: 'margin-top:0;font-size:12px' },
          'config.json and data/ as they were before the most recent update.'));
      for (const f of files) {
        list2.appendChild(ui.el('div', {
          style: 'display:flex;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12.5px'
        },
          ui.el('span', { class: 'mono', style: 'flex:1' }, f.name),
          ui.el('span', { class: 'text-dim' }, `${ui.fmtBytes(f.bytes)} · ${new Date(f.createdAt).toLocaleString()}`)));
      }
      body.appendChild(list2);
    }).catch(() => { /* optional */ });
  }

  return { render, banner };
})();
