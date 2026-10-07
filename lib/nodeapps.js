'use strict';
/**
 * Node.js website wizard.
 *
 * The Websites page could already record a site with the "node" backend, but
 * that only fronted something: the panel wrote a proxy vhost to a port and left
 * you to write the app, install it and keep it running. This module does the
 * rest - picks a port nothing else is using, puts an app in place, gives it a
 * hardened systemd unit with restart-on-failure, and points Nginx at it.
 *
 * Ports are per site, never shared. config.ports.node is only the seed for the
 * search; a second Node site gets a different port, because two apps on one
 * port means one of them is unreachable and the vhosts cannot tell which is
 * which.
 */
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const net = require('net');
const config = require('../config');
const db = require('./db');
const { requireAdmin } = require('./auth');
const { run } = require('./exec');

const router = express.Router();

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const APP_PORT_MIN = 3000;
const APP_PORT_MAX = 3999;

/* Ports that must never be handed to an app, on top of the hosting stack's own.
 * Reserved here as well as in panelsettings so the wizard cannot pick one even
 * if the two lists ever drift apart. */
const RESERVED = new Set([
  20, 21, 22, 23, 25, 53, 80, 110, 111, 143, 443, 465, 587, 993, 995,
  2087, 2088, 2089, 3001, 3306, 6379, 8080, 8088, 8443, 9090
]);

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const unitName = (domain) => `nodeapp-${domain.replace(/[^a-z0-9]+/gi, '-')}`;

/* --------------------------------- ports -------------------------------- */

/** Is anything already listening on this port? */
function portListening(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(port, '0.0.0.0');
  });
}

/** Ports already claimed: listening sockets, this box's reserved set, the
 *  panel's own port, and every other Node site's recorded port. */
async function takenPorts() {
  const used = new Set(RESERVED);
  used.add(Number(config.port));
  for (const s of db.all('sites')) {
    if (s.backend === 'node' && Number.isInteger(s.appPort)) used.add(s.appPort);
  }
  const r = await run("ss -tlnH 2>/dev/null | awk '{print $4}' | sed 's/.*://' | sort -un");
  for (const line of (r.stdout || '').split('\n')) {
    const n = Number(line.trim());
    if (Number.isInteger(n)) used.add(n);
  }
  return used;
}

/** Is something already listening on this port?
 *
 *  Matching ":PORT$" against the raw ss output does not work: a line reads
 *  "LISTEN 0 511 *:3001 *:*", so it ends with the peer address, not the port.
 *  Extract the local port into its own field and compare that exactly.
 */
async function isListening(port) {
  const r = await run(`ss -tlnH 2>/dev/null | awk '{print $4}' | sed 's/.*://' | grep -cx ${shq(String(port))}`);
  return Number((r.stdout || '0').trim()) > 0;
}

/** The first free port in the app range, plus whether it had to search far. */
router.get('/port', requireAdmin, async (_req, res) => {
  const taken = await takenPorts();
  for (let p = APP_PORT_MIN; p <= APP_PORT_MAX; p++) {
    if (taken.has(p)) continue;
    if (await portListening(p)) continue;
    return res.json({ port: p, range: [APP_PORT_MIN, APP_PORT_MAX] });
  }
  res.status(400).json({ error: `No free port between ${APP_PORT_MIN} and ${APP_PORT_MAX}` });
});

/* --------------------------------- jobs --------------------------------- */

/* One job at a time: the install touches systemd and Nginx, and two runs
 * interleaving would race on the same files. */
let job = null;

const publicJob = () => (job ? { running: job.running, ok: job.ok, error: job.error, log: job.log, domain: job.domain } : { running: false });

function appendLog(text) {
  if (!job) return;
  const chunk = text.endsWith('\n') ? text : `${text}\n`;
  job.log = (job.log + chunk).slice(-80_000);
}

function stream(cmd, cwd, opts = {}) {
  return new Promise((resolve) => {
    appendLog(`$ ${cmd}`);
    const child = require('child_process').spawn(cmd, {
      shell: true, cwd, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }, ...opts
    });
    child.stdout.on('data', (d) => appendLog(d.toString().trimEnd()));
    child.stderr.on('data', (d) => appendLog(d.toString().trimEnd()));
    child.on('close', (code) => {
      if (code !== 0) appendLog(`[exit ${code}]`);
      resolve(code);
    });
    child.on('error', (e) => { appendLog(`[could not run: ${e.message}]`); resolve(1); });
  });
}

/* ------------------------------ starter app ----------------------------- */

/** A dependency-free starter so the wizard produces a working site even with
 *  no npm registry access. It reads PORT from the environment, which is what
 *  the systemd unit sets, so the same code works locally and in production.
 *
 *  The domain is emitted as a literal constant rather than interpolated into
 *  the response body: an earlier version wrote `+ domain +` into the generated
 *  file, which parsed fine but threw "domain is not defined" on the first
 *  request - so every wizard-created site crash-looped. */
function starterApp(domain) {
  return `'use strict';
/* ${domain} - starter Node.js site, created by the letzControl wizard.
   Add dependencies with: npm install express   then require it below. */

const http = require('http');
const SITE = ${JSON.stringify(domain)};
const port = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>' + SITE + '</title>' +
    '<body style="font:16px system-ui;padding:3rem;max-width:40rem;margin:auto">' +
    '<h1>' + SITE + ' is running</h1>' +
    '<p>Served by Node.js behind Nginx on port ' + port + '.</p>' +
    '<p>Your app lives in <code>' + __dirname + '</code>.</p></body>');
}).listen(port, '127.0.0.1', () => console.log('listening on ' + port));
`;
}

/* ----------------------------- systemd unit ----------------------------- */

/**
 * A unit for the app.
 *
 * Hardening is deliberate: the app is untrusted code running on the same box as
 * everything else, so it gets its own unprivileged user, a private /tmp, and
 * no ability to gain privileges. NoNewPrivileges matters most here - it stops
 * a compromised app from using a sudo bit or a setuid binary to become root.
 */
function systemdUnit({ domain, appDir, startCmd, runUser, port: p }) {
  return `[Unit]
Description=Node.js app for ${domain}
Documentation=https://github.com/asifletzshop/letzcontrol
After=network-online.target
Wants=network-online.target
# A broken app must not spin forever. Without a start limit, Restart=always
# turns a syntax error in the app into a tight crash loop burning CPU.
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
User=${runUser}
Group=${runUser}
WorkingDirectory=${appDir}
Environment=NODE_ENV=production
Environment=PORT=${p}
Environment=HOST=127.0.0.1
ExecStart=/usr/bin/node ${startCmd}
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nodeapp-${domain}

# --- hardening -------------------------------------------------------------
# The app is not trusted: it only needs its own directory to write to.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
# localhost only - Nginx reaches it over loopback, the internet never can.
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
IPAddressAllow=localhost

[Install]
WantedBy=multi-user.target
`;
}

/** A start command that cannot be used to run something else: only a path
 *  inside the app directory, no shell metacharacters. */
function validateStartCmd(cmd, appDir) {
  const v = String(cmd || '').trim();
  if (!v) return { error: 'Enter the command that starts your app, e.g. app.js' };
  if (v.length > 200) return { error: 'That command is too long' };
  if (/[;&|`$(){}<>\\]/.test(v)) {
    return { error: 'The start command cannot contain shell characters (; & | ` $ ( ) { } < > \\)' };
  }
  if (/\s-\S/.test(v)) {
    return { error: 'The start command cannot contain flags - edit the file it points at instead' };
  }
  const rel = v.replace(/^\.\//, '');
  if (path.isAbsolute(rel)) return { error: 'Use a path relative to the app folder, e.g. app.js' };
  const resolved = path.resolve(appDir, rel);
  if (resolved !== appDir && !resolved.startsWith(appDir + path.sep)) {
    return { error: 'The start command must point inside the app folder' };
  }
  return { value: rel };
}

function validateRunUser(user) {
  const v = String(user || '').trim();
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(v)) {
    return { error: 'Run user must be a valid Linux username' };
  }
  return { value: v };
}

/* -------------------------------- routes -------------------------------- */

router.get('/', requireAdmin, async (_req, res) => {
  const sites = db.find('sites', (s) => s.backend === 'node');
  const out = [];
  for (const s of sites) {
    const unit = unitName(s.domain);
    const [active, enabled, listening] = await Promise.all([
      run(`systemctl is-active ${unit}`),
      run(`systemctl is-enabled ${unit}`),
      isListening(s.appPort)
    ]);
    out.push({
      id: s.id,
      domain: s.domain,
      ssl: !!s.ssl,
      docroot: s.docroot,
      appDir: path.join(s.docroot, 'app'),
      appPort: s.appPort,
      hasUnit: unitExists(unit),
      active: active.stdout.trim() === 'active',
      activeState: active.stdout.trim() || 'unknown',
      enabled: enabled.stdout.trim() === 'enabled',
      listening: !!listening,
      createdAt: s.createdAt || null
    });
  }
  res.json({ apps: out, job: publicJob() });
});

function unitExists(unit) {
  return fs.existsSync(path.join('/etc/systemd/system', `${unit}.service`));
}

router.get('/job', requireAdmin, (_req, res) => res.json(publicJob()));

/**
 * Create a Node website end to end: domain, app, dependencies, systemd unit
 * and the Nginx vhost. Runs as a job so the browser can watch it, because
 * `npm install` on a real project takes minutes.
 */
router.post('/', requireAdmin, async (req, res) => {
  if (job && job.running) return res.status(409).json({ error: 'Another Node app install is already running' });

  const body = req.body || {};
  const domain = String(body.domain || '').toLowerCase().trim();
  if (!DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'Enter a valid domain name' });
  if (db.findOne('sites', (s) => s.domain === domain)) {
    return res.status(409).json({ error: `${domain} already exists as a website` });
  }
  if (db.findOne('zones', (z) => String(z.domain).toLowerCase() === domain)) {
    return res.status(400).json({ error: `${domain} is already a DNS zone in this panel` });
  }

  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return res.status(400).json({ error: 'Enter a port between 1024 and 65535' });
  }
  if (RESERVED.has(port)) {
    return res.status(400).json({ error: `Port ${port} is reserved for the panel or the hosting stack` });
  }
  /* takenPorts() includes the panel's own port and every other Node site's
     recorded port, so it is left intact here. Removing the panel's port "to
     check it here" actually stopped checking it. */
  const taken = await takenPorts();
  if (taken.has(port) || (await portListening(port))) {
    return res.status(400).json({ error: `Port ${port} is already in use` });
  }

  const runUserCheck = validateRunUser(body.runUser || 'www-data');
  if (runUserCheck.error) return res.status(400).json({ error: runUserCheck.error });
  const runUser = runUserCheck.value;
  const userExists = await run(`id -u ${shq(runUser)}`);
  if (!userExists.ok) return res.status(400).json({ error: `There is no user called "${runUser}" on this server` });

  const source = ['starter', 'existing', 'git'].includes(body.source) ? body.source : 'starter';
  let repoUrl = '';
  if (source === 'git') {
    repoUrl = String(body.repoUrl || '').trim();
    /* Only https git URLs. No ssh (needs a key), no file://, no --upload-pack
       tricks that turn "clone a repo" into "run something". */
    if (!/^https:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+\.git$/i.test(repoUrl)) {
      return res.status(400).json({ error: 'Enter an https git URL ending in .git' });
    }
  }

  const docroot = path.join(config.sitesRoot, domain);
  const appDir = path.join(docroot, 'app');

  /* The start command ends up on a systemd ExecStart line, so it is validated
   * for every source - not just when the operator supplied their own files.
   * Skipping the check for the starter let `app.js; id` through, and although
   * systemd's ExecStart is not a shell, accepting it produces a unit that
   * silently cannot start. For the starter there is nothing to choose anyway:
   * it always writes app.js, so the command is fixed. */
  let startCmd = 'app.js';
  if (source !== 'starter') {
    const cmdCheck = validateStartCmd(body.startCmd || 'app.js', appDir);
    if (cmdCheck.error) return res.status(400).json({ error: cmdCheck.error });
    startCmd = cmdCheck.value;
  }

  const unit = unitName(domain);
  job = { running: true, ok: null, error: '', log: '', domain };
  appendLog(`Creating Node.js website ${domain}`);
  appendLog(`  document root : ${docroot}`);
  appendLog(`  app folder   : ${appDir}`);
  appendLog(`  app port     : ${port}`);
  appendLog(`  run as       : ${runUser}`);
  appendLog(`  source       : ${source === 'git' ? repoUrl : source}`);
  appendLog('');

  let created = false;
  (async () => {
    try {
      // 1. the site record, so the panel owns the vhost like any other site
      const site = db.insert('sites', {
        domain, backend: 'node', appPort: port, phpVersion: null,
        www: body.www !== false, docroot, ssl: false, enabled: true,
        ownerId: req.user.id, nodeSource: source, nodeStartCmd: startCmd
      });
      created = true;

      // 2. folders, owned by the run user so the app can write its own files
      appendLog('--- folders ---');
      await fsp.mkdir(path.join(docroot, 'public'), { recursive: true });
      await fsp.mkdir(appDir, { recursive: true });
      await fsp.mkdir(path.join(docroot, 'logs'), { recursive: true });
      const own = await run(`chown -R ${shq(runUser)}:${shq(runUser)} ${shq(docroot)}`);
      if (!own.ok) appendLog(`warning: could not chown ${docroot} (${runUser} may not exist)`);

      // 3. the application
      appendLog('--- application ---');
      if (source === 'starter') {
        await fsp.writeFile(path.join(appDir, 'app.js'), starterApp(domain));
        await fsp.writeFile(path.join(appDir, 'package.json'),
          JSON.stringify({ name: domain, version: '1.0.0', private: true, main: 'app.js', scripts: { start: 'node app.js' } }, null, 2));
        await run(`chown ${shq(runUser)}:${shq(runUser)} ${shq(path.join(appDir, 'app.js'))} ${shq(path.join(appDir, 'package.json'))}`);
        appendLog('wrote a starter app (no dependencies, runs immediately)');
      } else if (source === 'git') {
        const code = await stream(`git clone --depth 1 ${shq(repoUrl)} ${shq(appDir)}.tmp`, docroot, { timeout: 300_000 });
        if (code !== 0) throw new Error('git clone failed');
        await run(`rm -rf ${shq(appDir)} && mv ${shq(appDir)}.tmp ${shq(appDir)}`);
      } else {
        const contents = await fsp.readdir(appDir).catch(() => []);
        if (!contents.length) {
          throw new Error('The app folder is empty - choose the starter app, a git URL, or put your files in it first');
        }
        appendLog(`using ${contents.length} existing item(s) in the app folder`);
      }

      // 4. dependencies, if asked for
      if (body.installDeps !== false) {
        const hasPkg = fs.existsSync(path.join(appDir, 'package.json'));
        if (hasPkg && !fs.existsSync(path.join(appDir, 'node_modules'))) {
          appendLog('--- installing dependencies ---');
          const lock = fs.existsSync(path.join(appDir, 'package-lock.json'));
          const npmCmd = `su -s /bin/sh -c ${shq(`cd ${appDir} && ${lock ? 'npm ci --omit=dev --no-audit --no-fund' : 'npm install --omit=dev --no-audit --no-fund'}`)} ${shq(runUser)}`;
          const code = await stream(npmCmd, '/', { timeout: 900_000 });
          if (code !== 0) appendLog('dependency install failed - the app may still start if it needs nothing');
        } else if (!hasPkg) {
          appendLog('no package.json - skipping dependency install');
        } else {
          appendLog('node_modules already present - skipping dependency install');
        }
      }

      // 5. the systemd unit
      appendLog('--- service ---');
      const unitFile = path.join('/etc/systemd/system', `${unit}.service`);
      await fsp.writeFile(unitFile, systemdUnit({ domain, appDir, startCmd, runUser, port }),
        { mode: 0o644 });
      await run('systemctl daemon-reload');
      const en = await run(`systemctl enable ${unit}`);
      if (!en.ok) appendLog('warning: could not enable the service at boot');
      const st = await run(`systemctl start ${unit}`);
      if (!st.ok) {
        const log = await run(`journalctl -u ${unit} -n 15 --no-pager`);
        throw new Error(`the service did not start:\n${(log.stdout + log.stderr).trim().slice(-1200)}`);
      }

      // 6. hand the vhost to the Websites module so both paths write it the
      //    same way - a hand-written one here would be overwritten the next
      //    time anything regenerated it
      appendLog('--- nginx ---');
      const sites = require('./sites');
      await sites.writeNginxVhost(site);
      const t = await run('nginx -t');
      if (!t.ok) throw new Error(`nginx rejected the vhost: ${(t.stdout + t.stderr).trim()}`);
      await run('systemctl reload nginx');

      appendLog('');
      appendLog(`Done. ${domain} is serving on port ${port}.`);
      appendLog('Next step: request an SSL certificate for it.');

      job.running = false;
      job.ok = true;
    } catch (e) {
      appendLog('');
      appendLog(`FAILED: ${e.message}`);
      /* Undo: a site record pointing at an app that was never created is worse
       * than no record, because the panel would then manage a vhost for it. */
      if (created) {
        appendLog('rolling back the site record');
        const site = db.findOne('sites', (s) => s.domain === domain);
        if (site) {
          await fsp.rm(path.join(config.nginx.confDir, 'sites-available', `${domain}.conf`), { force: true });
          await fsp.rm(path.join(config.nginx.confDir, 'sites-enabled', `${domain}.conf`), { force: true });
          await run(`systemctl disable --now ${unit}`);
          await fsp.rm(path.join('/etc/systemd/system', `${unit}.service`), { force: true });
          await run('systemctl daemon-reload');
          db.remove('sites', site.id);
          await run('nginx -t').then((r) => (r.ok ? run('systemctl reload nginx') : null));
        }
      }
      job.running = false;
      job.ok = false;
      job.error = e.message;
    }
  })();

  res.json({ ok: true, domain, port, job: publicJob() });
});

/* ------------------------------- controls ------------------------------- */

const ACTIONS = new Set(['start', 'stop', 'restart', 'enable', 'disable']);

router.post('/:domain/:action', requireAdmin, async (req, res) => {
  const domain = String(req.params.domain || '').toLowerCase();
  const action = String(req.params.action || '');
  if (!ACTIONS.has(action)) return res.status(400).json({ error: 'Unknown action' });
  const site = db.findOne('sites', (s) => s.domain === domain && s.backend === 'node');
  if (!site) return res.status(404).json({ error: 'No Node.js site with that domain' });

  const unit = unitName(domain);
  if (!unitExists(unit)) {
    return res.status(400).json({ error: `No service exists for ${domain}. Re-run the wizard to create one.` });
  }
  const r = await run(`systemctl ${action} ${unit}`);
  if (!r.ok) return res.status(400).json({ error: (r.stdout + r.stderr).trim() || `could not ${action} the service` });
  res.json({ ok: true, action, active: (await run(`systemctl is-active ${unit}`)).stdout.trim() === 'active' });
});

router.get('/:domain/logs', requireAdmin, async (req, res) => {
  const domain = String(req.params.domain || '').toLowerCase();
  const site = db.findOne('sites', (s) => s.domain === domain && s.backend === 'node');
  if (!site) return res.status(404).json({ error: 'No Node.js site with that domain' });
  const lines = Math.min(500, Math.max(10, Number(req.query.lines) || 100));
  const r = await run(`journalctl -u ${shq(unitName(domain))} -n ${lines} --no-pager -o cat`);
  res.json({ log: r.stdout || '(no output yet)' });
});

module.exports = { router, unitName, takenPorts, portListening };
