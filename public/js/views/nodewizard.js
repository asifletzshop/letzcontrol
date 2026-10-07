'use strict';
/* Node.js website wizard.
 *
 * Four steps: domain, where the application comes from, how it runs, then the
 * install itself with a live log. The install is a server-side job because
 * `npm install` on a real project takes minutes - the browser watches the log
 * rather than waiting on one request.
 *
 * SSL is deliberately a separate button after the app is up, not part of the
 * wizard: a certificate needs the DNS record in place, which usually is not
 * true at the moment the app is created. */
window.NodeWizardView = (() => {
  const esc = (s) => String(s == null ? '' : s);
  let state = null;
  let poll = null;

  const STEPS = ['Domain', 'Application', 'Runtime', 'Install'];

  /* ------------------------------- helpers ------------------------------ */

  function card(title, hint, body) {
    return ui.el('div', { class: 'card' },
      ui.el('h3', {}, title),
      hint ? ui.el('p', { class: 'text-dim', style: 'margin-top:-6px' }, hint) : null,
      body);
  }

  const label = (t, node, hint) => ui.el('label', { class: 'field' },
    ui.el('span', {}, t), node,
    hint ? ui.el('span', { class: 'text-dim', style: 'display:block;font-size:12px;margin-top:2px' }, hint) : null);

  function input(type, value, placeholder, attrs) {
    const i = ui.el('input', Object.assign({ type, placeholder: placeholder || '' }, attrs || {}));
    i.value = value == null ? '' : String(value);
    return i;
  }

  /** Show an error under a step and stop the wizard moving on. */
  const setError = (box, msg) => {
    box.innerHTML = '';
    box.appendChild(ui.el('div', { class: 'banner danger', style: 'margin-bottom:10px' }, msg));
  };
  const clearError = (box) => { box.innerHTML = ''; };

  /* --------------------------------- steps -------------------------------- */

  /** Step 1 - the domain. */
  function stepDomain(root, go) {
    const box = ui.el('div', {});
    const domain = input('text', state.domain, 'myapp.example.com', { autofocus: true });
    domain.oninput = () => { state.domain = domain.value; };

    const next = ui.el('button', { class: 'btn btn-primary' }, 'Next');
    next.onclick = () => {
      const d = domain.value.trim().toLowerCase();
      if (!d || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) {
        return setError(box, 'Enter a valid domain name, for example myapp.example.com');
      }
      clearError(box);
      state.domain = d;
      go(2);
    };

    const box2 = ui.el('div', {},
      box,
      label('Domain name', domain, 'Point this name at this server before requesting SSL.'),
      ui.el('div', { class: 'modal-actions', style: 'justify-content:flex-start' }, next));
    root.appendChild(card('Step 1 of 4 - Domain', 'The name your app answers on.', box2));
  }

  /** Step 2 - where the code comes from. */
  function stepSource(root, go) {
    const box = ui.el('div', {});
    const opts = [
      ['starter', 'Starter app', 'A tiny dependency-free app that responds immediately. Good for checking the plumbing.'],
      ['git', 'Clone a git repository', 'Clone a public repository over https and install its dependencies.'],
      ['existing', 'I already put files there', 'Use what is already in the app folder - for a project you uploaded yourself.']
    ];

    const repoRow = ui.el('div', { style: 'display:none;margin-bottom:10px' });
    const repo = input('text', state.repoUrl, 'https://github.com/user/repo.git');
    repo.oninput = () => { state.repoUrl = repo.value; };
    repoRow.appendChild(label('Repository URL', repo, 'An https URL ending in .git.'));

    const note = ui.el('div', { class: 'banner info', style: 'display:none' });

    const radio = opts.map(([id, name, desc]) => {
      const wrap = ui.el('label', {
        class: 'radio-card' + (state.source === id ? ' active' : ''),
        onclick: () => {
          state.source = id;
          cards.forEach((c) => c.el.classList.toggle('active', c.id === id));
          repoRow.style.display = id === 'git' ? '' : 'none';
          note.style.display = id === 'existing' ? '' : 'none';
          if (id === 'existing') {
            note.textContent = `Upload your project to ${state.sitesRoot || '/var/www'}/${state.domain}/app with the File Manager first, then come back.`;
          }
        }
      },
        ui.el('span', { class: 'radio-dot' }),
        ui.el('span', {}, ui.el('strong', {}, name), ui.el('span', { class: 'text-dim', style: 'display:block;font-size:12px' }, desc)));
      return { id, el: wrap };
    });
    const cards = radio;

    const next = ui.el('button', { class: 'btn btn-primary' }, 'Next');
    next.onclick = () => {
      if (state.source === 'git' && !/^https:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+\.git$/i.test(repo.value.trim())) {
        return setError(box, 'Enter an https git URL ending in .git');
      }
      clearError(box);
      state.repoUrl = repo.value.trim();
      go(3);
    };

    root.appendChild(card('Step 2 of 4 - Application', 'Where the code for your app comes from.',
      ui.el('div', {}, box, ui.el('div', { class: 'radio-list' }, ...cards.map((c) => c.el)), repoRow, note,
        ui.el('div', { class: 'modal-actions', style: 'justify-content:flex-start' }, next))));
  }

  /** Step 3 - port, start command, run user. */
  function stepRuntime(root, go) {
    const box = ui.el('div', {});
    const port = input('number', state.port, '', { min: 1024, max: 65535 });
    const startCmd = input('text', state.startCmd, 'app.js');
    const runUser = input('text', state.runUser, 'www-data');
    const installDeps = ui.el('input', { type: 'checkbox' });
    installDeps.checked = state.installDeps !== false;

    const portNote = ui.el('span', { class: 'text-dim', style: 'display:block;font-size:12px;margin-top:2px' }, 'Finding a free port…');

    port.oninput = () => { state.port = Number(port.value); };
    startCmd.oninput = () => { state.startCmd = startCmd.value; };
    runUser.oninput = () => { state.runUser = runUser.value; };
    installDeps.onchange = () => { state.installDeps = installDeps.checked; };

    /* Offer a port the server already knows is free, rather than making the
     * operator hunt for one and discover the clash when the service fails. */
    api.get('/node-apps/port').then((r) => {
      state.port = r.port;
      port.value = r.port;
      portNote.textContent = `Port ${r.port} is free right now. Each Node app needs its own port.`;
    }).catch((e) => { portNote.textContent = e.message; });

    const next = ui.el('button', { class: 'btn btn-primary' }, 'Create the website');
    next.onclick = () => {
      const p = Number(port.value);
      if (!Number.isInteger(p) || p < 1024 || p > 65535) return setError(box, 'Enter a port between 1024 and 65535');
      if (!startCmd.value.trim()) return setError(box, 'Enter the file that starts your app, e.g. app.js');
      if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(runUser.value.trim())) return setError(box, 'Enter a valid Linux username');
      clearError(box);
      state.port = p;
      state.startCmd = startCmd.value.trim();
      state.runUser = runUser.value.trim();
      go(4);
    };

    root.appendChild(card('Step 3 of 4 - Runtime', 'How the app runs.',
      ui.el('div', {}, box,
        label('App port', port, null),
        ui.el('div', { style: 'margin:-4px 0 10px' }, portNote),
        label('Start command', startCmd, 'The entry file inside the app folder. package.json "main" is used if you leave it as app.js.'),
        label('Run as user', runUser, 'A non-root user. The app is given no way to gain privileges.'),
        ui.el('label', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:6px' },
          installDeps, ui.el('span', {}, 'Run npm install if the project has a package.json')),
        ui.el('div', { class: 'modal-actions', style: 'justify-content:flex-start' }, next))));
  }

  /** Step 4 - install, with the job log. */
  function stepInstall(root) {
    const box = ui.el('div', {});
    const log = ui.el('pre', { class: 'pre-log', style: 'max-height:420px' }, 'Starting…');
    const status = ui.el('div', { class: 'text-dim', style: 'font-size:12.5px;margin-bottom:8px' }, 'Creating the app…');
    const done = ui.el('div', { style: 'display:none' });

    const follow = async () => {
      let j;
      try { j = await api.get('/node-apps/job'); }
      catch (e) { status.textContent = 'Lost contact with the panel: ' + e.message; return; }
      log.textContent = j.log || '(waiting)';
      log.scrollTop = log.scrollHeight;
      if (j.running) { setTimeout(follow, 1500); return; }
      clearInterval(poll);
      if (j.ok) {
        status.textContent = 'Finished.';
        done.style.display = '';
        done.innerHTML = '';
        const visit = ui.el('button', { class: 'btn btn-primary' }, 'Open ' + state.domain);
        visit.onclick = () => { location.href = (state.port === 443 || state.port === 80 ? 'https://' : 'http://') + state.domain; };
        const cert = ui.el('button', { class: 'btn' }, 'Request an SSL certificate');
        cert.onclick = async () => {
          if (!(await ui.confirmBox(
            `Request a Let's Encrypt certificate for ${state.domain}?\n\n`
            + 'The domain must already point at this server on port 80.',
            { okText: 'Request certificate', danger: false }))) return;
          cert.disabled = true;
          try {
            const r = await api.post(`/sites/${encodeURIComponent(state.domain)}/ssl`, {});
            if (r.ok) ui.toast('Certificate installed');
            else ui.toast('Certificate not issued - check the Websites page for the reason', true);
          } catch (e) { ui.toast(e.message, true); }
          cert.disabled = false;
        };
        const back = ui.el('button', { class: 'btn' }, 'Back to Node.js apps');
        back.onclick = () => { location.hash = '#/nodeapps'; };
        done.append(ui.el('div', { style: 'margin-top:12px' },
          ui.el('p', { class: 'text-dim' }, 'The app is running behind Nginx on a private port. ' +
            'Request SSL once the domain resolves here.'),
          ui.el('div', { class: 'modal-actions', style: 'justify-content:flex-start' }, visit, cert, back)));
      } else {
        status.textContent = 'Failed.';
        done.style.display = '';
        done.innerHTML = '';
        const retry = ui.el('button', { class: 'btn' }, 'Start over');
        retry.onclick = () => { state.step = 1; render(root, state.me); };
        const back = ui.el('button', { class: 'btn' }, 'Back to Node.js apps');
        back.onclick = () => { location.hash = '#/nodeapps'; };
        done.append(ui.el('div', { style: 'margin-top:12px' },
          ui.el('p', { class: 'text-dim' }, 'Nothing was left behind - the site record and service were rolled back.'),
          ui.el('div', { class: 'modal-actions', style: 'justify-content:flex-start' }, retry, back)));
      }
    };

    api.post('/node-apps', {
      domain: state.domain,
      source: state.source,
      repoUrl: state.repoUrl,
      port: state.port,
      startCmd: state.startCmd,
      runUser: state.runUser,
      installDeps: state.installDeps,
      www: true
    }).then(() => follow()).catch((e) => {
      status.textContent = 'Could not start: ' + e.message;
      log.textContent = e.message;
    });

    root.appendChild(card('Step 4 of 4 - Install', 'Watch it build. This can take a few minutes if it installs packages.',
      ui.el('div', {}, box, status, log, done)));
  }

  /* -------------------------------- render ------------------------------- */

  async function render(root, me) {
    const params = (location.hash.split('?')[1] || '').split('&').reduce((o, p) => {
      const [k, v] = p.split('=');
      if (k) o[k] = decodeURIComponent(v || '');
      return o;
    }, {});

    state = {
      step: Number(params.step) || 1,
      domain: params.domain || '',
      source: 'starter',
      repoUrl: '',
      port: 3000,
      startCmd: 'app.js',
      runUser: 'www-data',
      installDeps: true,
      sitesRoot: '/var/www',
      me
    };

    clearInterval(poll);
    root.innerHTML = '';

    root.appendChild(ui.el('div', { class: 'toolbar' },
      ui.el('div', { class: 'steps' }, ...STEPS.map((s, i) =>
        ui.el('span', { class: 'step' + (i + 1 === state.step ? ' active' : '') }, `${i + 1}. ${s}`))),
      ui.el('button', {
        class: 'btn',
        onclick: () => { location.hash = '#/nodeapps'; }
      }, 'Cancel')));

    const go = (n) => {
      state.step = n;
      location.hash = `#/nodewizard?step=${n}&domain=${encodeURIComponent(state.domain)}`;
      // hashchange re-enters render; do not also render here or the log is lost.
    };

    if (state.step === 1) stepDomain(root, go);
    else if (state.step === 2) stepSource(root, go);
    else if (state.step === 3) stepRuntime(root, go);
    else stepInstall(root);
  }

  return { render, destroy() { clearInterval(poll); } };
})();
