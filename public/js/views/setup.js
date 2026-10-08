'use strict';
/* Setup Wizard: one-click component installation with live output */
window.SetupView = (() => {
  let pollTimer = null;

  async function load(root, fresh) {
    root.innerHTML = '';

    /* Shell renders immediately - detection happens server-side and used to
     * leave this page blank for ~3s while the endpoint probed every component. */
    const tbody = ui.el('tbody', {},
      ui.el('tr', {}, ui.el('td', { colspan: '4', class: 'text-dim' }, '⏳ Detecting installed components…')));
    root.appendChild(ui.el('div', { class: 'card', style: 'margin-bottom:16px' },
      ui.el('h3', {}, '🧩 Setup Wizard'),
      ui.el('p', { class: 'text-dim', style: 'margin-bottom:0' },
        'Install everything letzControl needs: Nginx (ports 80/443) as the front server, ',
        'Apache (8080) and OpenLiteSpeed (8088) as selectable site backends, PHP-FPM, MariaDB and Certbot for SSL. ',
        'Already-installed components are detected and skipped.')
    ));
    root.appendChild(ui.el('div', { class: 'table-wrap' },
      ui.el('table', {},
        ui.el('thead', {}, ui.el('tr', {}, ui.el('th', {}, ''), ui.el('th', {}, 'Component'), ui.el('th', {}, 'Description'), ui.el('th', {}, 'Status'))),
        tbody)));

    const installBtn = ui.el('button', { class: 'btn btn-primary', disabled: true }, '⬇ Install selected');
    root.appendChild(ui.el('div', { class: 'toolbar', style: 'margin-top:16px' },
      installBtn,
      ui.el('button', { class: 'btn', onclick: () => load(root, true) }, '↻ Refresh status')
    ));
    root.appendChild(ui.el('div', { id: 'setup-log', style: 'margin-top:16px' }));

    let components;
    let job;
    try {
      ({ components, job } = await api.get('/setup/components' + (fresh ? '?fresh=1' : '')));
    } catch (e) {
      tbody.textContent = '';
      tbody.appendChild(ui.el('tr', {},
        ui.el('td', { colspan: '4', style: 'color:var(--danger,#e5484d)' }, `Detection failed: ${e.message}`)));
      return;
    }

    tbody.textContent = '';
    for (const c of components) {
      const chk = ui.el('input', { type: 'checkbox', 'data-id': c.id, id: `cmp-${c.id}` });
      chk.checked = !c.installed;
      if (c.installed) chk.disabled = true;
      tbody.appendChild(ui.el('tr', {},
        ui.el('td', {}, chk),
        ui.el('td', {},
          ui.el('label', { class: 'checkbox-label', for: `cmp-${c.id}`, style: 'margin:0' },
            ui.el('strong', {}, c.name),
            c.version ? ui.el('span', { class: 'text-dim' }, ` ${c.version}`) : null)),
        ui.el('td', { class: 'text-dim', style: 'white-space:normal;min-width:280px' }, c.description),
        ui.el('td', {}, c.installed ? ui.badge('installed', 'green') : ui.badge('not installed', 'yellow'))
      ));
    }

    installBtn.disabled = false;
    installBtn.onclick = async () => {
      const ids = [...root.querySelectorAll('input[data-id]:checked')].map((c) => c.dataset.id);
      if (!ids.length) return ui.toast('Nothing selected', true);
      if (!(await ui.confirmBox(`Install ${ids.length} component(s) now? This runs apt on the server.`, { danger: false, okText: 'Install' }))) return;
      installBtn.disabled = true;
      try {
        await api.post('/setup/install', { components: ids });
        watch(root);
      } catch (e) {
        ui.toast(e.message, true);
        installBtn.disabled = false;
      }
    };

    if (job && job.running) {
      installBtn.disabled = true;
      watch(root);
    }
  }

  function watch(root) {
    clearInterval(pollTimer);
    if (!progress) progress = openProgress();

    pollTimer = setInterval(async () => {
      try {
        const { job } = await api.get('/setup/job');
        progress.update(job);
        renderLog(root, job);
        if (!job.running && job.log) {
          clearInterval(pollTimer);
          pollTimer = null;
          progress.finish(job);
          setTimeout(() => {
            progress = null;
            if (document.contains(root)) load(root);
          }, 2500);
        }
      } catch { /* transient */ }
    }, 1500);
  }

  /* The inline log stays. It is what you read afterwards, and it survives the
   * popup being dismissed - the job itself keeps running either way, so closing
   * the dialog is never "stop the installation". */
  function renderLog(root, job) {
    const box = document.getElementById('setup-log');
    if (!box) return;
    box.innerHTML = '';
    const pre = ui.el('pre', { class: 'pre-log', style: 'max-height:480px' }, job.log || '(starting…)');
    box.appendChild(ui.el('div', { class: 'card' },
      ui.el('h3', {}, job.running
        ? '⏳ Installing… you can navigate away — the job keeps running'
        : job.ok ? '✅ Installation finished' : '⚠️ Finished with errors — review the log'),
      progressLine(job),
      pre));
    pre.scrollTop = pre.scrollHeight;
  }

  function progressLine(job) {
    if (job.running && job.total) {
      const pct = Math.min(100, Math.round((job.done / job.total) * 100));
      return ui.el('p', { class: 'text-dim', style: 'margin:0 0 10px' },
        `Step ${job.done} of ${job.total} (${pct}%) — ${job.current || ''}`);
    }
    return null;
  }

  /* The popup. Dismissible on purpose: an apt run can take many minutes, and a
   * modal you cannot close is a modal you are forced to stare at. Closing it
   * only hides the dialog - polling stops, the server-side job continues, and
   * coming back to the Wizard reopens it. */
  function openProgress() {
    let onClose = null;
    const bar = ui.el('div', {
      style: 'height:8px;border-radius:4px;background:var(--border);overflow:hidden;margin:12px 0 8px'
    }, ui.el('div', {
      style: 'height:100%;width:0;background:var(--accent,#34d399);transition:width .35s ease'
    }));
    const fill = bar.firstChild;
    const status = ui.el('p', { class: 'text-dim', style: 'margin:0 0 10px' }, 'Starting…');
    const pre = ui.el('pre', { class: 'pre-log', style: 'max-height:300px;margin:0' }, '(starting…)');
    const dismiss = ui.el('button', { class: 'btn' }, 'Run in background');

    const body = ui.el('div', {},
      ui.el('p', { style: 'margin:0' },
        'Installing components. This runs apt on the server and can take several minutes.'),
      bar, status,
      pre,
      ui.el('div', { class: 'modal-actions', style: 'margin-top:14px' }, dismiss)
    );

    const m = ui.modal({ title: '⏳ Installing components', body });

    const api = {
      update(job) {
        const pct = job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;
        /* No known step count (an addon run, say): show an indeterminate bar
         * rather than a fake percentage that sits at 0% and never moves. */
        fill.style.width = pct === null ? '100%' : pct + '%';
        fill.style.opacity = pct === null ? '.45' : '1';
        status.textContent = job.running
          ? (job.total
            ? `Step ${job.done} of ${job.total} (${pct}%) — ${job.current || 'working'}`
            : `Working — ${job.current || 'installing'}`)
          : (job.ok ? 'Finished.' : 'Finished with errors — review the log on the page.');
        pre.textContent = job.log || '(starting…)';
        pre.scrollTop = pre.scrollHeight;
      },
      finish(job) {
        fill.style.width = '100%';
        fill.style.background = job.ok ? 'var(--accent,#34d399)' : 'var(--danger,#e5484d)';
        status.textContent = job.ok
          ? 'Installation finished.'
          : 'Finished with errors — review the log on the page.';
        dismiss.textContent = 'Close';
      },
      close() { m.close(); }
    };

    dismiss.onclick = () => {
      clearInterval(pollTimer);
      pollTimer = null;
      progress = null;
      m.close();
    };

    return api;
  }

  let progress = null;

  function destroy() {
    clearInterval(pollTimer);
    pollTimer = null;
    /* Close the dialog too. It lives on document.body, not inside the view
     * root, so swapping views leaves it stranded on screen with nothing
     * updating it. The server-side job carries on regardless. */
    if (progress) { progress.close(); progress = null; }
  }

  return { render: (root) => load(root), destroy };
})();
