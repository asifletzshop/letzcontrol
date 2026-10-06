'use strict';
/* PHP view: versions table, install-version dropdown, interactive
 * extension manager (install/uninstall per version), FPM restart */
window.PhpView = (() => {
  let isAdmin = false;

  async function load(root, me) {
    isAdmin = me && me.role === 'admin';
    root.innerHTML = '';
    const { versions } = await api.get('/php');
    const inst = await api.get('/php/installable').catch(() => ({ versions: [], installed: [] }));
    const installed = new Set(versions.map((v) => v.version));

    if (!versions.length) {
      root.appendChild(ui.el('div', { class: 'banner' },
        'No PHP-FPM installations detected. Use the dropdown below to install one, or run "apt install php8.3-fpm".'));
    }

    if (isAdmin) root.appendChild(ui.el('div', { class: 'toolbar' },
      ui.el('button', { class: 'btn', onclick: () => phpIniModal() }, '📝 php.ini Editor'),
      ui.el('span', { class: 'text-dim', style: 'align-self:center;font-size:12px' },
        'Edit any installed PHP\'s php.ini — FPM, CLI, Apache or OpenLiteSpeed lsphp')
    ));

    if (isAdmin) root.appendChild(installCard(root, me, inst, installed));

    if (versions.length) {
      const rows = versions.map((v) => ui.el('tr', {},
        ui.el('td', {}, ui.el('strong', {}, `PHP ${v.version}`), v.default ? ui.el('span', { style: 'margin-left:6px' }, ui.badge('default CLI', 'green')) : ''),
        ui.el('td', {}, v.fpmSocket ? ui.badge('FPM running', 'green') : ui.badge('FPM socket not found', 'yellow')),
        ui.el('td', {}, v.cli ? '✓' : '–'),
        ui.el('td', {},
          ui.el('button', {
            class: 'btn btn-sm', onclick: () => extensionsModal(v.version)
          }, '🧩 Extensions'), ' ',
          ui.el('button', {
            class: 'btn btn-sm', onclick: async () => {
              try {
                const r = await api.post(`/php/${v.version}/restart-fpm`);
                ui.toast(r.ok ? `php${v.version}-fpm restarted` : (r.output || 'Failed'), !r.ok);
                load(root, me);
              } catch (e) { ui.toast(e.message, true); }
            }
          }, '↻ Restart FPM'), ' ',
          v.default ? null : ui.el('button', {
            class: 'btn btn-sm', onclick: async () => {
              try {
                const r = await api.post('/php/default', { version: v.version });
                ui.toast(r.ok ? `PHP ${v.version} is now the default CLI` : (r.output || 'Failed'), !r.ok);
                load(root, me);
              } catch (e) { ui.toast(e.message, true); }
            }
          }, 'Set default')
        )
      )).filter(Boolean);

      root.appendChild(ui.el('div', { class: 'table-wrap' },
        ui.el('table', {},
          ui.el('thead', {}, ui.el('tr', {},
            ui.el('th', {}, 'Version'), ui.el('th', {}, 'FPM status'), ui.el('th', {}, 'CLI'), ui.el('th', {}, 'Actions'))),
          ui.el('tbody', {}, ...rows))));
    }

    root.appendChild(ui.el('div', { class: 'card', style: 'margin-top:16px' },
      ui.el('h3', {}, 'About version & extension installs'),
      ui.el('p', { class: 'text-dim', style: 'margin:6px 0 0' },
        'New PHP versions and extensions are installed with apt from Ubuntu\'s archive plus the ondrej/php PPA ' +
        '(added automatically on first install). Every change restarts the version\'s FPM service. ' +
        'Sites on the nginx/Apache backends can then select the new version in Websites → Edit. ' +
        'OpenLiteSpeed always runs its bundled lsphp.')
    ));
  }

  /* Global visual php.ini editor. Pick any installed php.ini (system SAPIs
   * and OpenLiteSpeed lsphp), edit the whitelisted directives in a form and
   * save - the server patches the file in place (comments/sections kept)
   * and restarts the SAPI that reads it. */
  async function phpIniModal() {
    let targets = [];
    let fields = [];
    try {
      const [t, f] = await Promise.all([
        api.get('/php/phpini/targets'),
        api.get('/php/phpini/fields')
      ]);
      targets = t.targets || [];
      fields = f.fields || [];
    } catch (e) { ui.toast(e.message, true); return; }
    if (!targets.length) return ui.toast('No php.ini files found on this server', true);
    if (!fields.length) return ui.toast('php.ini fields unavailable', true);

    const body = ui.el('div', {});
    const sel = ui.el('select', { style: 'width:100%' });
    for (const t of targets) sel.appendChild(ui.el('option', { value: t.id }, `${t.label} — ${t.path}`));
    body.appendChild(ui.el('label', {}, 'php.ini file', sel));
    const status = ui.el('p', { class: 'text-dim', style: 'margin:6px 0 0;min-height:18px' }, '');
    body.appendChild(status);

    // preferred default: an FPM target (what serves sites), else first target
    const defFpm = targets.find((t) => t.kind === 'fpm');
    sel.value = (defFpm || targets[0]).id;

    const inputs = {};
    let currentGroup = null;
    let groupWrap = null;
    for (const f of fields) {
      if (f.group && f.group !== currentGroup) {
        currentGroup = f.group;
        groupWrap = ui.el('div', { style: 'margin-top:14px' });
        groupWrap.appendChild(ui.el('div', { style: 'font-weight:600;color:var(--accent);margin-bottom:8px;font-size:13px' }, f.group));
        body.appendChild(groupWrap);
      }
      if (!groupWrap) {
        groupWrap = ui.el('div', { style: 'margin-top:14px' });
        body.appendChild(groupWrap);
      }
      let input;
      if (f.type === 'bool') {
        input = ui.el('select', {});
        input.appendChild(ui.el('option', { value: '' }, 'default'));
        input.appendChild(ui.el('option', { value: '1' }, 'On'));
        input.appendChild(ui.el('option', { value: '0' }, 'Off'));
      } else if (f.type === 'select') {
        input = ui.el('select', {});
        for (const [v, lbl] of Object.entries(f.options || {})) {
          input.appendChild(ui.el('option', { value: v }, lbl));
        }
      } else {
        input = ui.el('input', { type: f.type === 'number' ? 'number' : 'text', placeholder: f.placeholder || '' });
      }
      inputs[f.key] = input;
      const lbl = ui.el('label', {}, f.label, input);
      if (f.hint) lbl.appendChild(ui.el('span', { class: 'text-dim', style: 'display:block;font-size:12px;margin-top:2px' }, f.hint));
      groupWrap.appendChild(lbl);
    }

    const preview = ui.el('pre', { class: 'pre-log', style: 'margin-top:6px;max-height:130px' });
    const renderPreview = () => {
      const lines = Object.entries(inputs)
        .map(([k, el]) => [k, el.value.trim()])
        .filter(([, v]) => v !== '')
        .map(([k, v]) => `${k} = ${v}`);
      preview.textContent = lines.length ? lines.join('\n') : '# no overrides - PHP defaults apply';
    };
    body.addEventListener('input', renderPreview);
    body.addEventListener('change', renderPreview);
    body.appendChild(ui.el('div', { style: 'font-weight:600;color:var(--accent);margin-top:14px;font-size:13px' }, 'Preview (writes on save)'));
    body.appendChild(preview);

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const clear = ui.el('button', { class: 'btn' }, 'Clear all');
    const save = ui.el('button', { class: 'btn btn-primary' }, '💾 Save php.ini');
    save.disabled = true;
    actions.append(cancel, clear, save);
    body.appendChild(actions);

    const m = ui.modal({ title: 'php.ini editor', body, wide: true });
    cancel.onclick = m.close;
    clear.onclick = () => {
      for (const el of Object.values(inputs)) el.value = '';
      renderPreview();
    };

    async function loadValues() {
      save.disabled = true;
      status.textContent = '⏳ Reading current values…';
      try {
        const r = await api.get('/php/phpini/values?target=' + encodeURIComponent(sel.value));
        const v = r.values || {};
        for (const [k, el] of Object.entries(inputs)) {
          const val = v[k] || '';
          // keep values the quick-pick options don't list (e.g. an
          // error_reporting expression from the distro php.ini) round-tripable
          if (el.tagName === 'SELECT' && val && ![...el.options].some((o) => o.value === val)) {
            el.appendChild(ui.el('option', { value: val }, `${val} (from php.ini)`));
          }
          el.value = val;
        }
        status.textContent = `Editing ${r.target.path}`;
        save.disabled = false;
        renderPreview();
      } catch (e) {
        status.textContent = '✗ ' + e.message;
      }
    }
    sel.onchange = loadValues;
    await loadValues();

    save.onclick = async () => {
      const settings = {};
      for (const [k, el] of Object.entries(inputs)) settings[k] = el.value.trim();
      save.disabled = true;
      status.textContent = '⏳ Saving php.ini…';
      try {
        const r = await api.post('/php/phpini', { target: sel.value, settings });
        m.close();
        const failed = (r.results || []).filter((x) => !x.ok);
        if (failed.length) {
          ui.toast('php.ini saved, but a service restart failed', true);
          ui.modal({ title: 'Apply results', body: ui.el('pre', { class: 'pre-log' },
            (r.results || []).map((x) => `[${x.server}] ${x.ok ? 'OK' : 'FAILED'}\n${x.output}`).join('\n\n')) });
        } else {
          ui.toast('php.ini saved — ' + ((r.results || []).map((x) => x.server).join(', ') || 'applied'));
        }
      } catch (e) {
        status.textContent = '✗ ' + e.message;
        save.disabled = false;
        ui.toast(e.message, true);
      }
    };
  }

  /* Dropdown of not-yet-installed versions -> confirm -> apt install */
  function installCard(root, me, inst, installed) {
    const status = ui.el('p', { class: 'text-dim', style: 'margin:8px 0 0;min-height:18px' });
    const sel = ui.el('select', { style: 'width:auto;min-width:220px' });
    sel.appendChild(ui.el('option', { value: '' }, 'Choose a PHP version to install…'));
    let any = false;
    for (const v of inst.versions || []) {
      if (installed.has(v)) {
        sel.appendChild(ui.el('option', { value: '', disabled: '' }, `PHP ${v} (installed)`));
        continue;
      }
      sel.appendChild(ui.el('option', { value: v }, `PHP ${v} — install`));
      any = true;
    }

    sel.onchange = async () => {
      const v = sel.value;
      if (!v) return;
      const go = await ui.confirmBox(
        `Install PHP ${v}? Adds the ondrej/php PPA if needed and installs FPM, CLI and the common site extensions (~1-2 minutes).`,
        { danger: false, okText: 'Install' });
      if (!go) { sel.value = ''; return; }
      sel.disabled = true;
      status.textContent = `⏳ Installing PHP ${v} — apt is running, this can take a couple of minutes…`;
      try {
        const r = await api.post('/php/install', { version: v });
        ui.toast(r.already ? `PHP ${v} is already installed` : `PHP ${v} installed`);
        load(root, me);
      } catch (e) {
        status.textContent = '';
        sel.disabled = false;
        sel.value = '';
        ui.modal({
          title: `PHP ${v} install failed`,
          body: ui.el('pre', { class: 'pre-log' }, (e.message || '') + (e.body && e.body.output ? `\n\n${e.body.output}` : ''))
        });
      }
    };

    return ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Install a PHP version'),
      ui.el('p', { class: 'text-dim', style: 'margin:6px 0 10px' },
        any ? 'Pick a version from the dropdown — installation starts after confirmation.'
            : 'All offered versions are already installed.'),
      sel,
      status
    );
  }

  /* Interactive extension list for one version: every extension with its
   * state, click to install / uninstall (admin) */
  async function extensionsModal(version) {
    const status = ui.el('p', { class: 'text-dim', style: 'margin:10px 0 0;min-height:18px' });
    const list = ui.el('div', { style: 'max-height:55vh;overflow:auto;border:1px solid var(--border,#334155);border-radius:8px;padding:6px' });
    const filter = ui.el('input', { type: 'text', placeholder: 'filter extensions…', style: 'width:100%;margin-bottom:8px' });
    const body = ui.el('div', {}, filter, list, status);
    const m = ui.modal({ title: `PHP ${version} extensions`, body, wide: true });

    let data = [];
    try {
      const r = await api.get(`/php/${version}/extensions`);
      data = r.extensions || [];
    } catch (e) {
      list.appendChild(ui.el('div', { class: 'banner' }, e.message));
      return;
    }

    let busy = false;

    async function act(ext, action) {
      if (busy) return;
      busy = true;
      status.textContent = `⏳ ${action === 'install' ? 'Installing' : 'Removing'} php${version}-${ext.name}…`;
      render();
      try {
        const r = await api.post(`/php/${version}/extensions/${ext.name}`, { action });
        if (!r.ok) {
          status.textContent = `✗ ${ext.name}: failed`;
          ui.modal({
            title: `php${version}-${ext.name} ${action} failed`,
            body: ui.el('pre', { class: 'pre-log' }, r.output || 'apt returned an error')
          });
        } else {
          status.textContent = `✓ ${ext.name} ${action === 'install' ? 'installed' : 'removed'} · php${version}-fpm restarted`;
          ui.toast(`php${version}-${ext.name} ${action === 'install' ? 'installed' : 'removed'}`);
          const rr = await api.get(`/php/${version}/extensions`);
          data = rr.extensions || [];
        }
      } catch (e) {
        status.textContent = `✗ ${e.message}`;
        ui.toast(e.message, true);
      } finally {
        busy = false;
        render();
      }
    }

    function render() {
      const q = filter.value.trim().toLowerCase();
      list.innerHTML = '';
      const shown = data.filter((e) => !q || e.name.toLowerCase().includes(q));
      if (!shown.length) {
        list.appendChild(ui.el('p', { class: 'text-dim', style: 'padding:8px' }, 'No matching extensions.'));
        return;
      }
      for (const e of shown) {
        const state = e.builtin ? ui.badge('built-in', 'blue')
          : e.installed ? ui.badge('installed', 'green')
          : ui.badge('not installed', 'gray');
        let actionBtn = null;
        if (isAdmin && !e.builtin) {
          if (e.removable) {
            actionBtn = ui.el('button', { class: 'btn btn-sm btn-danger', onclick: () => act(e, 'remove') }, 'Uninstall');
          } else if (!e.installed) {
            actionBtn = ui.el('button', { class: 'btn btn-sm btn-primary', onclick: () => act(e, 'install') }, 'Install');
          }
          if (actionBtn) actionBtn.disabled = busy;
        }
        const row = ui.el('div', {
          style: 'display:flex;align-items:center;gap:10px;padding:7px 8px;border-bottom:1px solid rgba(148,163,184,.14)'
        },
          ui.el('span', { style: 'font-family:ui-monospace,monospace;font-size:13px;min-width:150px' }, e.name),
          e.hint ? ui.el('span', { class: 'text-dim', style: 'font-size:12px;flex:1' }, e.hint) : ui.el('span', { style: 'flex:1' }),
          state,
          actionBtn
        );
        list.appendChild(row);
      }
    }

    filter.oninput = render;
    render();
    return m;
  }

  return { render: (root, me) => load(root, me) };
})();
