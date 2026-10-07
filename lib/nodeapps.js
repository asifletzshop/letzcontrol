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
 * Hardening is applied to apps the wizard BUILT, because they were created for
 * it. It is off for adopted apps: the app already works, and wrapping a working
 * production app in ProtectSystem/PrivateTmp can break it in ways nobody can
 * predict from the outside - and a panel that quietly changes how a live site
 * behaves is worse than one that leaves it alone. What is kept either way is
 * the start limit, because Restart=always without one turns a syntax error
 * into a CPU-burning crash loop.
 */
function unitBody({ domain, execStart, runUser, workingDir, port: p, hardened }) {
  const harden = hardened ? `
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
` : `
# Hardening intentionally left off: this app was adopted, not built here, and
# sandboxing something already running in production is a risk, not a courtesy.
`;

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
WorkingDirectory=${workingDir}
Environment=NODE_ENV=production
Environment=PORT=${p}
Environment=HOST=127.0.0.1
ExecStart=${execStart}
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nodeapp-${domain}
${harden}
[Install]
WantedBy=multi-user.target
`;
}

/** The wizard's own apps: a node entry file, with hardening on. */
function systemdUnit({ domain, appDir, startCmd, runUser, port }) {
  return unitBody({
    domain,
    execStart: `/usr/bin/node ${startCmd}`,
    runUser,
    workingDir: appDir,
    port,
    hardened: true
  });
}

/**
 * Validate the file the app starts from.
 *
 * Only relative paths inside the app folder are accepted, and shell
 * metacharacters and newlines are refused. Flags ARE allowed - systemd's
 * ExecStart is not a shell, so `next start -p 3100` cannot execute anything,
 * and refusing flags made real frameworks (Next.js, Nest, Nuxt) impossible to
 * run. An earlier version rejected them and that was too strict.
 */
function validateStartCmd(cmd, appDir) {
  const v = String(cmd || '').trim();
  if (!v) return { error: 'Enter the command that starts your app, e.g. app.js' };
  if (v.length > 300) return { error: 'That command is too long' };
  if (/[\n\r]/.test(v)) return { error: 'The start command cannot span multiple lines' };
  if (/[;&|`$(){}<>\\]/.test(v)) {
    return { error: 'The start command cannot contain shell characters (; & | ` $ ( ) { } < > \\)' };
  }
  const rel = v.replace(/^\.\//, '');
  if (path.isAbsolute(rel)) return { error: 'Use a path relative to the app folder, e.g. app.js' };
  // Only the FIRST token is a path; anything after it is arguments.
  const first = rel.split(/\s+/)[0];
  const resolved = path.resolve(appDir, first);
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

/* ------------------------------- adoption ------------------------------ */

/**
 * Work out how a Node app is actually running RIGHT NOW, without changing
 * anything. This is deliberately read-only: it walks /proc and reads systemd
 * units, and never stops, starts or rewrites a process.
 *
 * Two shapes are handled:
 *  - a systemd unit already exists (possibly one the operator made by hand),
 *    so its ExecStart / User / WorkingDirectory are the truth;
 *  - nothing manages it, so the process listening on the port is inspected.
 *    In that second case the listening process is usually a forked worker whose
 *    own command line says nothing useful - `next-server (v14.2.15)` - so the
 *    chain is walked up to the highest ancestor below init, whose command line
 *    is the one the operator actually typed.
 */
async function inspect(domain) {
  const site = db.findOne('sites', (s) => s.domain === domain && s.backend === 'node');
  if (!site) return { error: 'No Node.js site with that domain', status: 404 };

  const port = appPortOf(site);
  const appDir = path.join(site.docroot, 'app');
  const out = {
    domain,
    appPort: port,
    docroot: site.docroot,
    appDir,
    managedBy: 'none',
    ownerUnit: null,
    unit: null,
    process: null,
    listening: false,
    notes: []
  };

  // 1. which unit owns the process? Read it from the cgroup rather than
  //    guessing unit names - the operator's unit was called
  //    "dhubripgttcollege.service" for dhubripgttcollege.in, which no amount of
  //    name guessing would have produced.
  const ss = await run(`ss -tlnp 2>/dev/null | grep ':${port} ' || true`);
  out.listening = (ss.stdout || '').includes(`:${port}`);
  const pidMatch = (ss.stdout || '').match(/pid=(\d+)/);
  const leaf = pidMatch ? Number(pidMatch[1]) : null;

  if (leaf) {
    const cg = await run(`cat /proc/${leaf}/cgroup 2>/dev/null || true`);
    const svc = (cg.stdout || '').match(/(?:^|\/)([\w.@-]+\.service)(?:\/|$|\s)/m);
    if (svc && svc[1]) out.ownerUnit = svc[1].replace(/\.service$/, '');
  }

  // 2. an existing unit, by name from cgroup, or by the panel's own convention
  const guesses = [out.ownerUnit, unitName(domain), `node-${domain}`, domain].filter(Boolean);
  for (const u of guesses) {
    if (!fs.existsSync(path.join('/etc/systemd/system', `${u}.service`))) continue;
    const show = await run(`systemctl show ${shq(u)} --property=ExecStart,User,Group,WorkingDirectory,ActiveState,UnitFileState --no-pager`);
    const props = {};
    for (const line of (show.stdout || '').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
    }
    /* ExecStart comes back in systemd's own structured form:
     * { path=/usr/bin/node ; argv[]=/usr/bin/node server/index.js ; ... } */
    let exec = props.ExecStart || '';
    const argv = exec.match(/argv\[\]=(.*?)(?: ; |$)/);
    if (argv) exec = argv[1].trim();
    out.managedBy = props.UnitFileState === 'enabled' ? 'systemd' : 'systemd (not enabled)';
    out.unit = {
      name: u,
      execStart: exec,
      user: props.User || 'root',
      workingDir: props.WorkingDirectory || '',
      active: props.ActiveState || 'unknown',
      enabled: props.UnitFileState === 'enabled',
      panelOwned: u === unitName(domain),
      // The file itself. Taking an existing unit over means preserving it
      // verbatim - see manageAdopted.
      raw: await fsp.readFile(path.join('/etc/systemd/system', `${u}.service`), 'utf8').catch(() => '')
    };
    out.notes.push(out.unit.panelOwned
      ? `Managed by the panel's own unit "${u}".`
      : `An existing systemd unit "${u}" already runs this app; the panel is not using it.`);
    break;
  }

  // 3. the process on the port, either way
  if (!leaf) {
    if (!out.unit) out.notes.push('Nothing is listening on this port and no unit exists - the app is not running.');
    return out;
  }

  // walk to the highest ancestor below init
  let pid = leaf;
  const chain = [];
  for (let i = 0; i < 6; i++) {
    const stat = await run(`ps -o ppid= -p ${pid} 2>/dev/null || true`);
    const ppid = Number((stat.stdout || '').trim());
    if (!Number.isInteger(ppid) || ppid <= 1) break;
    pid = ppid;
    chain.push(pid);
  }
  const top = chain.length ? chain[chain.length - 1] : leaf;

  const info = await run(`readlink -f /proc/${top}/cwd 2>/dev/null; tr '\\0' ' ' < /proc/${top}/cmdline 2>/dev/null; echo; stat -c %U /proc/${top} 2>/dev/null`);
  const lines = (info.stdout || '').split('\n');
  out.process = {
    pid: leaf,
    topPid: top,
    cwd: (lines[0] || '').trim(),
    cmdline: (lines[1] || '').trim(),
    user: (lines[2] || '').trim(),
    depth: chain.length
  };
  if (!out.unit) {
    out.managedBy = 'nothing';
    out.notes.push('No systemd unit manages this app, so nothing will restart it after a reboot.');
  }
  if (out.process.user === 'root') {
    out.notes.push('This app runs as root. Adopting it can move it to an unprivileged user, but only if you ask for that.');
  }
  return out;
}

function appPortOf(site) {
  const p = Number(site.appPort);
  return Number.isInteger(p) && p > 0 ? p : Number(config.ports.node);
}

router.get('/:domain/inspect', requireAdmin, async (req, res) => {
  const r = await inspect(String(req.params.domain || '').toLowerCase());
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  res.json(r);
});

/**
 * Record how an existing app runs, so the panel shows and can manage it.
 *
 * Read-only apart from the site record: it deliberately does NOT create a unit
 * and does NOT restart anything. Adopting a production app should never be the
 * moment it goes down.
 */
router.post('/:domain/adopt', requireAdmin, async (req, res) => {
  const domain = String(req.params.domain || '').toLowerCase();
  const r = await inspect(domain);
  if (r.error) return res.status(r.status || 400).json({ error: r.error });

  const patch = { nodeManaged: 'adopted' };
  if (r.unit) {
    patch.nodeUnit = r.unit.name;
    patch.nodeExecStart = r.unit.execStart;
    patch.nodeRunUser = r.unit.user;
    if (r.unit.workingDir) patch.nodeWorkingDir = r.unit.workingDir;
  } else if (r.process) {
    patch.nodeUnit = '';
    patch.nodeExecStart = r.process.cmdline;
    patch.nodeRunUser = r.process.user;
    patch.nodeWorkingDir = r.process.cwd;
  }

  // Explicit overrides win, so the operator can correct anything we guessed.
  for (const [key, allowed] of [['nodeRunUser', /^[a-z_][a-z0-9_-]{0,31}$/], ['nodeWorkingDir', /^\/[^;&|`$<>]*$/]]) {
    const v = String((req.body || {})[key] || '').trim();
    if (v && allowed.test(v)) patch[key] = v;
  }

  const site = db.findOne('sites', (s) => s.domain === domain && s.backend === 'node');
  db.update('sites', site.id, patch);
  db.save();
  res.json({ ok: true, applied: patch, detected: r });
});

/**
 * Take an existing unit over WITHOUT rewriting it.
 *
 * The temptation is to regenerate the unit from this module's template, and
 * that is exactly what would break these apps. Their units carry settings that
 * only someone who debugged that app would know to put there: an
 * EnvironmentFile holding real credentials, a MemoryMax, and
 * ProtectSystem=full paired with a ReadWritePaths escape hatch for .next -
 * without that last one the service starts and then dies on its first write
 * with EROFS, which is a genuinely baffling failure to chase.
 *
 * So the original text is kept byte for byte and only two things change: the
 * unit is renamed so the panel owns it, and a start limit is added if it has
 * none (Restart=always without one turns a syntax error into a crash loop).
 * Every other directive - Environment, ExecStart, User, WorkingDirectory,
 * MemoryMax, ReadWritePaths, all of it - survives untouched.
 */
function adoptUnitText(raw, { domain, from }) {
  let text = String(raw || '');
  if (!text.trim()) return null;

  // A start limit, if the operator has not set one.
  if (!/^\s*StartLimitBurst=/m.test(text)) {
    text = text.replace(/^\[Unit\]\s*$/m,
      '[Unit]\n# Added by letzControl: without this, Restart=always turns a broken app\n# into a crash loop burning CPU.\nStartLimitIntervalSec=120\nStartLimitBurst=5');
  }

  // Mark it as ours so nobody hand-edits a file the panel will rewrite. Every
  // other directive below is left exactly as the operator wrote it.
  const marker = `# Managed by letzControl for ${domain}.\n`
    + `# Taken over from the "${from}" unit with all of its settings preserved.\n`
    + '# Change it through the panel, not this file.\n';
  text = text.replace(/^\[Unit\][ \t]*$/m, `[Unit]\n${marker}`);
  return text;
}

/**
 * Convert an adopted app to a panel-owned service, preserving its unit.
 *
 * This is the only operation here that interrupts a live app, so it backs the
 * original file up, verifies the app comes back on the same port afterwards,
 * and puts everything back if it does not.
 */
router.post('/:domain/manage', requireAdmin, async (req, res) => {
  const domain = String(req.params.domain || '').toLowerCase();
  const site = db.findOne('sites', (s) => s.domain === domain && s.backend === 'node');
  if (!site) return res.status(404).json({ error: 'No Node.js site with that domain' });

  const port = appPortOf(site);
  const unit = unitName(domain);
  const unitPath = path.join('/etc/systemd/system', `${unit}.service`);
  const found = await inspect(domain);
  if (found.error) return res.status(found.status || 400).json({ error: found.error });

  const oldName = found.unit && !found.unit.panelOwned ? found.unit.name : (site.nodeUnit || '');
  const oldPath = oldName ? path.join('/etc/systemd/system', `${oldName}.service`) : '';

  // From here on everything is undoable.
  const backup = oldPath && fs.existsSync(oldPath) ? await fsp.readFile(oldPath, 'utf8') : null;
  if (backup) {
    await fsp.writeFile(path.join(config.dataDir, `unit-backup-${domain}.service`), backup);
  }

  const restore = async () => {
    // Stop ours, put theirs back, bring the app up again.
    await run(`systemctl disable --now ${unit}`);
    await fsp.rm(unitPath, { force: true });
    if (backup) await fsp.writeFile(oldPath, backup, { mode: 0o644 });
    await run('systemctl daemon-reload');
    if (backup) {
      await run(`systemctl enable ${oldName}`);
      await run(`systemctl restart ${oldName}`);
    }
  };

  try {
    if (found.unit && found.unit.raw) {
      const text = adoptUnitText(found.unit.raw, { domain, from: found.unit.name });
      if (!text) throw new Error('The existing unit is empty');
      await fsp.writeFile(unitPath, text, { mode: 0o644 });
    } else {
      // No unit to inherit: fall back to a generated one.
      const execStart = String((req.body || {}).execStart || site.nodeExecStart || '').trim();
      if (!execStart) throw new Error('Nothing to take over and no start command recorded - adopt first');
      if (/[\n\r;&|`$<>]/.test(execStart)) throw new Error('The start command contains shell characters');
      const runUser = String((req.body || {}).runUser || site.nodeRunUser || 'www-data').trim();
      if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(runUser)) throw new Error('Invalid run user');
      const workingDir = String((req.body || {}).workingDir || site.nodeWorkingDir || path.join(site.docroot, 'app')).trim();
      await fsp.writeFile(unitPath, unitBody({
        domain, execStart, runUser, workingDir, port, hardened: (req.body || {}).hardened === true
      }), { mode: 0o644 });
    }

    await run('systemctl daemon-reload');

    /* Stop the old service BEFORE starting ours. Deleting its unit file does
     * not stop it - systemd happily keeps a running unit in memory - so
     * without this the old process still holds the port and the new service
     * dies with EADDRINUSE. Verified on this box: taking over vyaparone
     * without stopping it left both units fighting over :3100. */
    if (oldName && oldName !== unit) {
      await run(`systemctl disable ${oldName}`);
      await run(`systemctl stop ${oldName}`);
      // Wait for the socket to actually be released before claiming the port.
      for (let i = 0; i < 15; i++) {
        if (!(await isListening(port))) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (await isListening(port)) {
        throw new Error(`the old ${oldName} service is still holding port ${port}`);
      }
    }

    const en = await run(`systemctl enable ${unit}`);
    if (!en.ok) throw new Error('could not enable the new service at boot');

    // Only now retire the old unit file, so nothing is ever left unmanaged.
    if (oldName && oldName !== unit && fs.existsSync(oldPath)) {
      await fsp.writeFile(`${oldPath}.taken-over`, backup, { mode: 0o644 });
      await fsp.rm(oldPath, { force: true });
      await run('systemctl daemon-reload');
    }

    const st = await run(`systemctl restart ${unit}`);
    if (!st.ok) throw new Error('the new service did not start');

    // Did the app actually come back? A unit can be "active" while the app
    // inside it has died, so check the port rather than trusting systemctl.
    for (let i = 0; i < 12; i++) {
      if (await isListening(port)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!(await isListening(port))) {
      const log = await run(`journalctl -u ${unit} -n 25 --no-pager -o cat`);
      throw new Error(`the app started but nothing is listening on port ${port} any more:\n${(log.stdout || '').trim().slice(-1200)}`);
    }

    db.update('sites', site.id, {
      nodeManaged: 'panel', nodeUnit: unit,
      nodeExecStart: (found.unit && found.unit.execStart) || site.nodeExecStart || '',
      nodeRunUser: (found.unit && found.unit.user) || site.nodeRunUser || null,
      nodeWorkingDir: (found.unit && found.unit.workingDir) || site.nodeWorkingDir || null
    });
    db.save();
    res.json({ ok: true, unit, tookOverFrom: oldName || null, preserved: !!(found.unit && found.unit.raw) });
  } catch (e) {
    await restore().catch(() => {});
    return res.status(400).json({
      error: `Could not take the app over: ${e.message}`,
      rolledBack: true
    });
  }
});

/* -------------------------------- routes -------------------------------- */

router.get('/', requireAdmin, async (_req, res) => {
  const sites = db.find('sites', (s) => s.backend === 'node');
  const out = [];
  for (const s of sites) {
    /* Look for the panel's unit first, then any hand-made unit the operator
       already had, so an adopted app shows real state instead of "no service". */
    const candidates = [unitName(s.domain), s.nodeUnit].filter(Boolean);
    let unit = '';
    for (const c of candidates) {
      if (fs.existsSync(path.join('/etc/systemd/system', `${c}.service`))) { unit = c; break; }
    }
    const [active, enabled, listening] = await Promise.all([
      unit ? run(`systemctl is-active ${unit}`) : Promise.resolve({ stdout: '' }),
      unit ? run(`systemctl is-enabled ${unit}`) : Promise.resolve({ stdout: '' }),
      isListening(appPortOf(s))
    ]);
    out.push({
      id: s.id,
      domain: s.domain,
      ssl: !!s.ssl,
      docroot: s.docroot,
      appDir: path.join(s.docroot, 'app'),
      appPort: appPortOf(s),
      managed: s.nodeManaged || (unit === unitName(s.domain) ? 'panel' : unit ? 'existing-unit' : 'none'),
      unit,
      hasUnit: !!unit,
      panelUnit: unit === unitName(s.domain),
      runUser: s.nodeRunUser || null,
      execStart: s.nodeExecStart || null,
      workingDir: s.nodeWorkingDir || null,
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

  /* Act on whichever unit actually runs this app - the panel's own, or the
     hand-made one the operator already had. */
  let unit = unitName(domain);
  if (!fs.existsSync(path.join('/etc/systemd/system', `${unit}.service`))) {
    if (site.nodeUnit && fs.existsSync(path.join('/etc/systemd/system', `${site.nodeUnit}.service`))) {
      unit = site.nodeUnit;
    } else {
      return res.status(400).json({
        error: `No service manages ${domain}. Use "Adopt" to let the panel take it over first.`
      });
    }
  }
  const r = await run(`systemctl ${action} ${unit}`);
  if (!r.ok) return res.status(400).json({ error: (r.stdout + r.stderr).trim() || `could not ${action} the service` });
  res.json({ ok: true, action, unit, active: (await run(`systemctl is-active ${unit}`)).stdout.trim() === 'active' });
});

router.get('/:domain/logs', requireAdmin, async (req, res) => {
  const domain = String(req.params.domain || '').toLowerCase();
  const site = db.findOne('sites', (s) => s.domain === domain && s.backend === 'node');
  if (!site) return res.status(404).json({ error: 'No Node.js site with that domain' });
  const unit = fs.existsSync(path.join('/etc/systemd/system', `${unitName(domain)}.service`))
    ? unitName(domain)
    : (site.nodeUnit || unitName(domain));
  const lines = Math.min(500, Math.max(10, Number(req.query.lines) || 100));
  const r = await run(`journalctl -u ${shq(unit)} -n ${lines} --no-pager -o cat`);
  res.json({ log: r.stdout || '(no output yet)' });
});

module.exports = { router, unitName, takenPorts, portListening };
