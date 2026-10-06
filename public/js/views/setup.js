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
    const renderLog = (job) => {
      const box = document.getElementById('setup-log');
      if (!box) return;
      box.innerHTML = '';
      const pre = ui.el('pre', { class: 'pre-log', style: 'max-height:480px' }, job.log || '(starting…)');
      box.appendChild(ui.el('div', { class: 'card' },
        ui.el('h3', {}, job.running
          ? '⏳ Installing… you can navigate away — the job keeps running'
          : job.ok ? '✅ Installation finished' : '⚠️ Finished with errors — review the log'),
        pre));
      pre.scrollTop = pre.scrollHeight;
    };
    pollTimer = setInterval(async () => {
      try {
        const { job } = await api.get('/setup/job');
        renderLog(job);
        if (!job.running && job.log) {
          clearInterval(pollTimer);
          pollTimer = null;
          setTimeout(() => { if (document.contains(root)) load(root); }, 1500);
        }
      } catch { /* transient */ }
    }, 1500);
  }

  function destroy() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  return { render: (root) => load(root), destroy };
})();
