'use strict';
/** PHP manager: installed versions, one-click version installs (ondrej PPA),
 *  per-version extension install/uninstall, FPM restart, default CLI,
 *  global visual php.ini editor (system SAPIs + OpenLiteSpeed lsphp). */
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { run } = require('./exec');
const { requireAdmin } = require('./auth');
const phpini = require('./phpini');
const olsphp = require('./olsphp');

const router = express.Router();

/* The PHP page (versions, extensions, php.ini editor) is admin-only. The one
 * exception is the plain version list - the Websites view needs it for the
 * per-site PHP switch dropdown of every panel user. */
router.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '')) return next();
  return requireAdmin(req, res, next);
});

const VERSION_RE = /^\d\.\d$/;

/* Versions offered in the "install PHP" dropdown. Ubuntu only ships one PHP
 * in the archive - everything else comes from ppa:ondrej/php, which the
 * install flow adds automatically (same packaging layout for every version). */
const INSTALLABLE = ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5'];

/* Base packages installed with every new PHP version: enough for a working
 * WordPress/site stack out of the box. Everything else is in EXTENSIONS. */
const BASE_PKGS = ['fpm', 'cli', 'opcache', 'mysql', 'xml', 'mbstring', 'curl', 'zip', 'gd', 'intl', 'bcmath'];

/* Curated apt-installable extensions. `pkg` is the suffix after php<ver>-
 * (Debian/Ubuntu and the ondrej PPA use identical per-module packaging).
 * `modules` lists php -m names the package provides (normalised: lowercase,
 * alphanumeric) - used to detect "already loaded" and to avoid duplicate
 * built-in rows. noRemove = package is a dependency of others; never offer
 * an uninstall that would cascade. */
const EXTENSIONS = [
  { pkg: 'bcmath' },
  { pkg: 'bz2' },
  { pkg: 'calendar' },
  { pkg: 'ctype' },
  { pkg: 'curl' },
  { pkg: 'dba' },
  { pkg: 'dom' },
  { pkg: 'enchant' },
  { pkg: 'exif' },
  { pkg: 'ffi' },
  { pkg: 'fileinfo' },
  { pkg: 'ftp' },
  { pkg: 'gd' },
  { pkg: 'gettext' },
  { pkg: 'gmp' },
  { pkg: 'iconv' },
  { pkg: 'igbinary' },
  { pkg: 'imap' },
  { pkg: 'imagick' },
  { pkg: 'intl' },
  { pkg: 'json' },
  { pkg: 'ldap' },
  { pkg: 'mbstring' },
  { pkg: 'memcached' },
  { pkg: 'mysqli' },
  { pkg: 'mysqlnd', noRemove: true, hint: 'required by mysqli & pdo_mysql' },
  { pkg: 'opcache', modules: ['opcache', 'zendopcache'], hint: 'Zend OPcache' },
  { pkg: 'pcntl' },
  { pkg: 'pdo' },
  { pkg: 'pdo-mysql', modules: ['pdomysql'] },
  { pkg: 'phar' },
  { pkg: 'posix' },
  { pkg: 'pspell' },
  { pkg: 'readline' },
  { pkg: 'redis' },
  { pkg: 'shmop' },
  { pkg: 'simplexml' },
  { pkg: 'snmp' },
  { pkg: 'soap' },
  { pkg: 'sockets' },
  { pkg: 'sqlite3', modules: ['sqlite3', 'pdoesqlite'], hint: 'sqlite3 · pdo_sqlite' },
  { pkg: 'sysvmsg' },
  { pkg: 'sysvsem' },
  { pkg: 'sysvshm' },
  { pkg: 'tidy' },
  { pkg: 'tokenizer' },
  { pkg: 'xml' },
  { pkg: 'xmlreader' },
  { pkg: 'xmlwriter' },
  { pkg: 'xsl' },
  { pkg: 'zip' }
];

const norm = (m) => String(m).toLowerCase().replace(/[^a-z0-9]/g, '');
const modsOf = (e) => (e.modules || [norm(e.pkg)]);

async function detectVersions() {
  const versions = new Set();
  // Debian/Ubuntu layout: /etc/php/<ver>/fpm
  try {
    for (const d of fs.readdirSync('/etc/php')) {
      if (VERSION_RE.test(d) && fs.existsSync(`/etc/php/${d}/fpm`)) versions.add(d);
    }
  } catch { /* no /etc/php */ }
  // Fallback: phpX.Y binaries
  const bins = await run("ls /usr/bin/php[0-9]* 2>/dev/null || true");
  for (const m of bins.stdout.matchAll(/php(\d\.\d)/g)) versions.add(m[1]);

  const def = await run('readlink -f /usr/bin/php');
  const defMatch = def.stdout.match(/php(\d\.\d)/);

  const list = [...versions].sort().map((v) => ({
    version: v,
    default: defMatch ? defMatch[1] === v : false,
    // A version can exist as CLI only (apt sometimes drags one in as a
    // metapackage side effect) - sites may only use versions with FPM.
    fpmInstalled: fs.existsSync(`/etc/php/${v}/fpm`),
    fpmSocket: fs.existsSync(`/run/php/php${v}-fpm.sock`),
    fpmService: `php${v}-fpm`,
    cli: fs.existsSync(`/usr/bin/php${v}`)
  }));
  return list;
}

/** Make sure ppa:ondrej/php is in the sources (needed for every version and
 *  extension that Ubuntu's own archive does not ship). Idempotent; the apt
 *  index refresh only runs when the PPA was actually added just now. */
async function ensureOndrej() {
  const chk = await run("grep -rqsE 'launchpad[^ ]*ondrej/php' /etc/apt/sources.list.d/ && echo FOUND || echo MISSING");
  if (chk.stdout.includes('FOUND')) return { ok: true, added: false };

  const tools = await run('command -v add-apt-repository', { timeout: 30_000 });
  if (!tools.ok) {
    const ins = await run(
      'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq software-properties-common',
      { timeout: 300_000 }
    );
    if (!ins.ok) return { ok: false, error: ins.error || 'Could not install software-properties-common' };
  }
  const add = await run('add-apt-repository -y ppa:ondrej/php', { timeout: 300_000 });
  if (!add.ok) return { ok: false, error: (add.stdout + add.stderr).trim() || add.error };
  const upd = await run('apt-get update -qq', { timeout: 240_000 });
  if (!upd.ok) return { ok: false, error: (upd.stdout + upd.stderr).trim() || upd.error };
  return { ok: true, added: true };
}

const tail = (s, n = 20_000) => (s || '').slice(-n);

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/* `versions` = PHP-FPM builds (what Nginx-direct and Apache sites use);
 * `ols` = lsphp builds behind OpenLiteSpeed processors (what OLS sites use).
 * They are different sets - an OLS site cannot run an FPM version, so the
 * Websites view picks the list that matches each site's backend. */
router.get('/', async (_req, res) => {
  res.json({ versions: await detectVersions(), ols: olsphp.versions() });
});

/** Versions offered by the install dropdown + which are already present. */
router.get('/installable', async (_req, res) => {
  const installed = (await detectVersions()).map((v) => v.version);
  res.json({ versions: INSTALLABLE, installed });
});

/** One-click PHP version install: ondrej PPA (if needed) + fpm/cli/base
 *  extensions + enable the FPM service. Long-running (apt), admin only. */
router.post('/install', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const v = String((req.body || {}).version || '');
  if (!INSTALLABLE.includes(v)) return res.status(400).json({ error: 'Unsupported PHP version' });
  if (fs.existsSync(`/etc/php/${v}/fpm`)) return res.json({ ok: true, already: true, version: v });

  const steps = [];
  const ppa = await ensureOndrej();
  if (!ppa.ok) steps.push(`[ondrej PPA] ${ppa.error}`);
  else steps.push(`[ondrej PPA] ${ppa.added ? 'added' : 'already present'}`);

  // Refuse early (with a clear message) when this version has no packages
  const chk = await run(`apt-cache policy php${v}-fpm`, { timeout: 60_000 });
  if (!/Candidate:\s+\S/.test(chk.stdout) || /Candidate:\s+\(none\)/.test(chk.stdout)) {
    return res.status(400).json({
      error: `PHP ${v} is not available on this OS`,
      output: tail(steps.join('\n') + '\n\n' + (chk.stdout + chk.stderr).trim())
    });
  }

  const pkgs = BASE_PKGS.map((p) => `php${v}-${p}`).join(' ');
  const ins = await run(
    `DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${pkgs}`,
    { timeout: 600_000 }
  );
  steps.push(`[apt] ${tail((ins.stdout + ins.stderr).trim(), 8000)}`);
  if (!ins.ok) {
    return res.status(500).json({ error: `Installing PHP ${v} failed`, output: tail(steps.join('\n')) });
  }

  const svc = await run(`systemctl enable --now php${v}-fpm`, { timeout: 60_000 });
  steps.push(`[service] ${svc.ok ? `php${v}-fpm enabled` : (svc.error || 'enable failed')}`);
  const sock = fs.existsSync(`/run/php/php${v}-fpm.sock`);
  res.json({ ok: ins.ok && svc.ok, version: v, socket: sock, output: tail(steps.join('\n')) });
});

/** All extensions for a version: installed (apt/loaded) + available + built-ins. */
router.get('/:version/extensions', async (req, res) => {
  const v = req.params.version;
  if (!VERSION_RE.test(v)) return res.status(400).json({ error: 'Invalid version' });

  let r = await run(`php${v} -m`, { timeout: 30_000 });
  if (!r.ok) r = await run('php -m', { timeout: 30_000 });
  if (!r.ok) return res.status(400).json({ error: `PHP ${v} CLI not found` });
  const modLines = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('['));
  const loaded = new Map(modLines.map((m) => [norm(m), m]));

  // Which curated packages are present in dpkg?
  const q = await run(
    `dpkg-query -W -f='\${Package} \${Status}\n' ${EXTENSIONS.map((e) => `php${v}-${e.pkg}`).join(' ')} 2>/dev/null || true`,
    { timeout: 30_000 }
  );
  const inDpkg = new Set(
    q.stdout.split('\n')
      .filter((l) => l.endsWith('install ok installed'))
      .map((l) => l.split(' ')[0].replace(`php${v}-`, ''))
  );

  const covered = new Set();
  const curated = EXTENSIONS.map((e) => {
    const mods = modsOf(e);
    mods.forEach((m) => covered.add(m));
    const pkgInstalled = inDpkg.has(e.pkg);
    const loadedHit = mods.some((m) => loaded.has(m));
    return {
      name: e.pkg,
      hint: e.hint || '',
      installed: pkgInstalled || loadedHit,
      removable: pkgInstalled && !e.noRemove,
      builtin: false
    };
  }).sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));

  // Loaded modules no curated package provides => compiled in (built-in)
  const builtins = modLines
    .filter((m) => !covered.has(norm(m)))
    .sort((a, b) => a.localeCompare(b))
    .map((m) => ({ name: m, hint: '', installed: true, removable: false, builtin: true }));

  res.json({ version: v, extensions: [...curated, ...builtins] });
});

/** Install or remove one extension for a version, then restart its FPM. */
router.post('/:version/extensions/:name', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const v = req.params.version;
  if (!VERSION_RE.test(v)) return res.status(400).json({ error: 'Invalid version' });
  const ext = EXTENSIONS.find((e) => e.pkg === req.params.name);
  if (!ext) return res.status(400).json({ error: 'Unknown extension' });
  const action = String((req.body || {}).action || '');
  if (!['install', 'remove'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  if (action === 'remove' && ext.noRemove) {
    return res.status(400).json({ error: `${ext.pkg} is required by other extensions and cannot be removed` });
  }

  // Some extensions (redis, imagick, ...) only exist in the ondrej PPA
  const ppa = await ensureOndrej();
  if (!ppa.ok) return res.status(500).json({ error: 'Could not prepare the ondrej/php PPA', output: ppa.error });

  const pkg = `php${v}-${ext.pkg}`;
  const verb = action === 'install' ? 'install' : 'remove';
  const r = await run(
    `DEBIAN_FRONTEND=noninteractive apt-get ${verb} -y -qq ${pkg}`,
    { timeout: 300_000 }
  );
  const output = tail((r.stdout + r.stderr).trim());
  if (!r.ok) return res.json({ ok: false, output: output || r.error });

  const svc = await run(`systemctl restart php${v}-fpm`, { timeout: 60_000 });
  res.json({
    ok: true,
    output: (output ? output + '\n' : '') + (svc.ok ? `php${v}-fpm restarted` : (svc.error || 'fpm restart failed'))
  });
});

router.post('/:version/restart-fpm', async (req, res) => {
  const v = req.params.version;
  if (!VERSION_RE.test(v)) return res.status(400).json({ error: 'Invalid version' });
  const r = await run(`systemctl restart php${v}-fpm`);
  res.json({ ok: r.ok, output: (r.stdout + r.stderr).trim() || 'restarted' });
});

router.post('/default', async (req, res) => {
  const v = String((req.body || {}).version || '');
  if (!VERSION_RE.test(v)) return res.status(400).json({ error: 'Invalid version' });
  if (!fs.existsSync(`/usr/bin/php${v}`)) {
    return res.status(400).json({ error: `php${v} CLI binary not found` });
  }
  const r = await run(`update-alternatives --set php /usr/bin/php${v}`);
  res.json({ ok: r.ok, output: (r.stdout + r.stderr).trim() });
});

/* ------------------------------------------------------------------ */
/* Global visual php.ini editor                                        */
/* ------------------------------------------------------------------ */

/** Discover every editable php.ini: system SAPIs (/etc/php/<ver>/<sapi>)
 *  plus each OpenLiteSpeed lsphp build. Ids are stable and derived only
 *  from directory names - never from user input. */
function listIniTargets() {
  const targets = [];
  try {
    for (const v of fs.readdirSync('/etc/php').sort()) {
      if (!VERSION_RE.test(v)) continue;
      for (const sapi of ['fpm', 'cli', 'apache2']) {
        if (!fs.existsSync(`/etc/php/${v}/${sapi}`)) continue;
        targets.push({
          id: `${sapi}:${v}`,
          label: `PHP ${v} — ${sapi}${sapi === 'fpm' ? '-fpm service' : sapi === 'apache2' ? ' (Apache/mod_php)' : ' (CLI)'}`,
          path: `/etc/php/${v}/${sapi}/php.ini`,
          kind: sapi,
          service: sapi === 'fpm' ? `php${v}-fpm` : sapi === 'apache2' ? 'apache2' : ''
        });
      }
    }
  } catch { /* no /etc/php */ }
  try {
    for (const d of fs.readdirSync('/usr/local/lsws').sort()) {
      if (!/^lsphp\d+$/.test(d)) continue;
      const base = `/usr/local/lsws/${d}/etc/php`;
      for (const sub of fs.readdirSync(base)) {
        if (!VERSION_RE.test(sub)) continue;
        const file = `${base}/${sub}/litespeed/php.ini`;
        if (!fs.existsSync(file)) continue;
        targets.push({ id: `ols:${d}`, label: `OpenLiteSpeed lsphp ${sub}`, path: file, kind: 'ols', service: '' });
      }
    }
  } catch { /* no OLS */ }
  return targets;
}

const findTarget = (id) => listIniTargets().find((t) => t.id === id);

router.get('/phpini/fields', (_req, res) => {
  res.json({ fields: phpini.FIELDS });
});

router.get('/phpini/targets', (_req, res) => {
  res.json({ targets: listIniTargets() });
});

/** Current whitelisted values in the chosen php.ini. */
router.get('/phpini/values', async (req, res) => {
  const t = findTarget(String(req.query.target || ''));
  if (!t) return res.status(404).json({ error: 'Unknown php.ini target' });
  res.json({ target: t, values: await phpini.readValues(t.path) });
});

/** Save the visual editor into a php.ini and restart whatever SAPI reads it.
 *  The patcher rewrites only whitelisted keys - comments and sections stay. */
router.post('/phpini', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const t = findTarget(String((req.body || {}).target || ''));
  if (!t) return res.status(400).json({ error: 'Unknown php.ini target' });

  const settings = phpini.sanitize((req.body || {}).settings);
  if (typeof settings === 'string') return res.status(400).json({ error: settings });

  let applied;
  try {
    applied = await phpini.applyValues(t.path, settings);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Could not write php.ini' });
  }
  if (!applied.wrote) return res.json({ ok: true, changed: [], results: [{ server: t.label, ok: true, output: 'no changes' }] });

  const results = [];
  if (t.kind === 'fpm') {
    const r = await run(`systemctl restart ${t.service}`, { timeout: 60_000 });
    results.push({ server: t.service, ok: r.ok, output: (r.stdout + r.stderr).trim() || 'restarted' });
  } else if (t.kind === 'apache') {
    const test = await run('apachectl configtest');
    if (test.ok || test.stderr.includes('Syntax OK')) {
      const r = await run('systemctl restart apache2', { timeout: 60_000 });
      results.push({ server: 'apache2', ok: r.ok, output: (r.stdout + r.stderr).trim() || 'restarted' });
    } else {
      results.push({ server: 'apache2', ok: false, output: (test.stdout + test.stderr).trim() });
    }
  } else if (t.kind === 'ols') {
    // Full stop -> reap lsphp -> start: stale children would keep serving
    // the old php.ini after a graceful restart.
    const ctrl = path.join(config.openlitespeed.root, 'bin', 'lswsctrl');
    await run(`${ctrl} stop || true`);
    await run('pkill -9 -x lsphp || true');
    const r = await run(`${ctrl} start || ${ctrl} restart`, { timeout: 60_000 });
    results.push({ server: 'openlitespeed', ok: r.ok, output: (r.stdout + r.stderr).trim() || 'restarted' });
  } else {
    results.push({ server: 'CLI', ok: true, output: 'php.ini saved — CLI picks it up in new processes (no restart needed)' });
  }
  res.json({ ok: results.every((r) => r.ok), changed: applied.changed, results });
});

module.exports = { router };
