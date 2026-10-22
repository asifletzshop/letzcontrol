'use strict';
/** WordPress manager: wp-cli powered status, one-click install, core/plugin
 * /theme updates, settings and admin password reset. Every command runs
 *  against the site's docroot via a shell-quoted wp-cli wrapper. */
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { run } = require('./exec');
const config = require('../config');
const db = require('./db');
const { checkLimit } = require('./users');

const router = express.Router();

const WP_BIN = '/usr/local/bin/wp';
const SLUG_RE = /^[a-z0-9-]{1,64}$/i;
const USER_RE = /^[a-z0-9_.\-]{3,32}$/;
const NAME_RE = /^[a-z0-9_]{1,48}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function canAccess(req, site) {
  return req.user.role === 'admin' || site.ownerId === req.user.id;
}

function siteOf(req, res) {
  const site = db.get('sites', req.params.id);
  if (!site) { res.status(404).json({ error: 'Site not found' }); return null; }
  if (!canAccess(req, site)) { res.status(403).json({ error: 'Not your site' }); return null; }
  return site;
}

/* single-quote shell escaping for values we interpolate */
function shq(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

function wpRoot(site) {
  return path.join(site.docroot, 'public');
}

function isWp(site) {
  return fs.existsSync(path.join(wpRoot(site), 'wp-load.php'));
}

/* Every wp-cli invocation boots a full WordPress (PHP + active plugins):
 * ~100-200 MB each. Nine parallel boots exhausted the 1.8 GB box and the
 * kernel OOM-killed the panel. Cap concurrent boots globally. */
const WP_MAX = 3;
let wpBusy = 0;
const wpQueue = [];
function acquireWp() {
  if (wpBusy < WP_MAX) { wpBusy++; return Promise.resolve(); }
  return new Promise((r) => wpQueue.push(r));
}
function releaseWp() {
  const next = wpQueue.shift();
  if (next) next();
  else wpBusy--;
}

async function wp(site, args, opts = {}) {
  await acquireWp();
  try {
    return await run(
      `${WP_BIN} --path=${shq(wpRoot(site))} --allow-root ${args}`,
      { timeout: 120_000, ...opts }
    );
  } finally {
    releaseWp();
  }
}

async function wpJson(site, args, opts) {
  const r = await wp(site, `${args} --format=json`, opts);
  // wp-cli exits non-zero for some "nothing found" results while still
  // printing valid JSON - parse first, only fail if the output is garbage
  try { return JSON.parse(r.stdout); } catch { throw new Error(r.error || r.stdout.trim() || 'wp-cli failed'); }
}

/* php-cli + wp-cli.phar on demand (the Setup Wizard already installs
 * php-cli; this covers servers where it is missing). Memoised so
 * concurrent requests never download the phar twice. */
let ensureP = null;
function doEnsure() {
  return (async () => {
    const need = [];
    if (!fs.existsSync('/usr/bin/php')) need.push('php-cli');
    if (!fs.existsSync('/usr/bin/curl')) need.push('curl');
    if (need.length) {
      const r = await run(
        `apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${need.join(' ')}`,
        { timeout: 300_000 }
      );
      if (!r.ok) throw new Error(`Installing ${need.join(', ')} failed: ${r.error}`);
    }
    if (!fs.existsSync(WP_BIN)) {
      const r = await run(
        `curl -fsSL -o ${WP_BIN}.new https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar` +
        ` && chmod 755 ${WP_BIN}.new && mv ${WP_BIN}.new ${WP_BIN}`,
        { timeout: 300_000 }
      );
      if (!r.ok || !fs.existsSync(WP_BIN)) throw new Error(`Downloading wp-cli failed: ${r.error}`);
    }
  })();
}

function ensureWpCli() {
  if (fs.existsSync(WP_BIN) && fs.existsSync('/usr/bin/php')) return Promise.resolve();
  if (!ensureP) {
    ensureP = doEnsure().catch((e) => { ensureP = null; throw e; });
  }
  return ensureP;
}

const part = (p, fallback = null) => p.catch(() => fallback);

/* ---------------- fast status helpers (no wp-cli boot) ---------------- */
/* Core version straight from the file - instant, no PHP. */
function fsReadVersion(site) {
  try {
    const src = fs.readFileSync(path.join(wpRoot(site), 'wp-includes', 'version.php'), 'utf8');
    const m = /\$wp_version\s*=\s*'([^']+)'/.exec(src);
    return m ? m[1] : null;
  } catch { return null; }
}

/* wp-config constants by regex instead of 3x `wp config get` boots. */
function fsReadConfig(site) {
  const out = { dbName: null, debug: false, coreAuto: 'minor', prefix: 'wp_' };
  let src;
  try {
    /* wp-cli installs wp-config next to wp-load (docroot/public); a manual
     * setup sometimes keeps it one level up - try both. */
    src = fs.readFileSync(path.join(wpRoot(site), 'wp-config.php'), 'utf8');
  } catch {
    try { src = fs.readFileSync(path.join(site.docroot, 'wp-config.php'), 'utf8'); }
    catch { return out; }
  }

  const def = (name) => {
    const m = new RegExp(`define\\(\\s*['"]${name}['"]\\s*,\\s*(.+?)\\s*\\);`).exec(src);
    return m ? m[1].trim() : null;
  };
  const str = (v) => {
    const m = /^'([^']*)'$|^"([^"]*)"$/.exec(v || '');
    return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
  };

  const d = def('DB_NAME');
  if (d !== null) out.dbName = str(d) ?? (/[A-Za-z0-9_]/.test(d) ? d : null);

  const dbg = def('WP_DEBUG');
  if (dbg !== null) out.debug = /^(true|1|'true'|"true")$/i.test(dbg);

  const ca = def('WP_AUTO_UPDATE_CORE');
  if (ca !== null) {
    const s = str(ca);
    if (ca === 'true' || ca === '1' || s === 'true') out.coreAuto = 'all';
    else if (ca === 'false' || ca === '0' || s === 'false' || s === '') out.coreAuto = 'off';
    else out.coreAuto = 'minor';
  }

  const p = /\$table_prefix\s*=\s*['"]([^'"]+)['"]/.exec(src);
  if (p) out.prefix = p[1];
  return out;
}

/* siteurl + administrators via direct SQL - no WP boot, no plugin filters. */
async function dbInfo(site, prefix, dbName) {
  const out = { siteurl: null, admins: [] };
  if (!dbName) return out; // unqualified table names need a default database
  const m = config.mysql;
  const c = await mysql.createConnection({
    ...(m.socketPath
      ? { socketPath: m.socketPath, user: m.user, password: m.password }
      : { host: m.host, port: m.port, user: m.user, password: m.password }),
    database: dbName,
    connectTimeout: 5000
  });
  try {
    const [u] = await c.query(
      'SELECT option_value FROM ?? WHERE option_name = ? LIMIT 1',
      [`${prefix}options`, 'siteurl']
    ).catch(() => [[]]);
    if (Array.isArray(u) && u[0] && u[0].option_value) out.siteurl = u[0].option_value;

    const [a] = await c.query(
      'SELECT u.user_login FROM ?? u JOIN ?? m ON m.user_id = u.ID ' +
      "WHERE m.meta_key = ? AND m.meta_value LIKE ?",
      [`${prefix}users`, `${prefix}usermeta`, `${prefix}capabilities`, '%"administrator"%']
    ).catch(() => [[]]);
    if (Array.isArray(a)) out.admins = a.map((r) => r.user_login).filter(Boolean);
  } catch { /* tables missing mid-install - keep defaults */ }
  await c.end().catch(() => {});
  return out;
}

/* Compare against wordpress.org from Node - one HTTPS call, no PHP boot. */
function coreLatest(current) {
  return new Promise((resolve) => {
    const url = 'https://api.wordpress.org/core/version-check/1.7/' +
      (current ? `?version=${encodeURIComponent(current)}` : '');
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const fallback = { coreUpdate: false, latest: null };
    let req;
    try {
      req = https.get(url, { timeout: 8000 }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; if (b.length > 500_000) req.destroy(); });
        res.on('end', () => {
          try {
            const j = JSON.parse(b);
            const offers = (j && j.offers) || [];
            if (!offers.length || !offers[0].version) return finish(fallback);
            const latest = offers[0].version;
            finish({ coreUpdate: !!current && latest !== current, latest });
          } catch { finish(fallback); }
        });
      });
    } catch { return finish(fallback); }
    req.on('error', () => finish(fallback));
    req.on('timeout', () => { req.destroy(); finish(fallback); });
  });
}

/* wp-cli runs as root, but PHP runs as www-data on every backend - so
 * hand the whole docroot to www-data after file-writing operations and
 * drop the letzControl placeholder index.html (Apache's stock
 * DirectoryIndex serves index.html before index.php). Without this,
 * wp-admin cannot write files and falls back to the FTP credentials
 * form when installing plugins/themes. Never throws. */
async function harden(site) {
  const root = wpRoot(site);
  if (fs.existsSync(path.join(root, 'wp-load.php'))) {
    await fs.promises.rm(path.join(root, 'index.html'), { force: true }).catch(() => {});
  }
  await run(`chown -R www-data:www-data ${shq(site.docroot)}`);
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

/* ---------------- fast theme status (no wp-cli boot) ---------------- */
/* `wp theme list` costs ~4.8s: wp-cli forces 6 api.wordpress.org requests
 * on every run (a forced update-check POST + themes_info per checked
 * theme). Themes are metadata we can read directly instead: directory
 * scan for name/version, the `stylesheet` option for the active theme,
 * and the update transient for hasUpdate (unserialized by one php -r
 * call - php-cli only, WordPress is never loaded). */
async function themeMeta(site, prefix, dbName) {
  const out = { active: '', transient: '' };
  if (!dbName) return out;
  const m = config.mysql;
  const c = await mysql.createConnection({
    ...(m.socketPath
      ? { socketPath: m.socketPath, user: m.user, password: m.password }
      : { host: m.host, port: m.port, user: m.user, password: m.password }),
    database: dbName,
    connectTimeout: 5000
  });
  try {
    const [s] = await c.query(
      'SELECT option_value FROM ?? WHERE option_name = ? LIMIT 1',
      [`${prefix}options`, 'stylesheet']
    ).catch(() => [[]]);
    if (Array.isArray(s) && s[0] && s[0].option_value) out.active = s[0].option_value;
    const [t] = await c.query(
      'SELECT option_value FROM ?? WHERE option_name = ? LIMIT 1',
      [`${prefix}options`, '_site_transient_update_themes']
    ).catch(() => [[]]);
    if (Array.isArray(t) && t[0] && t[0].option_value) out.transient = t[0].option_value;
  } catch { /* tables missing mid-install - defaults stay */ }
  await c.end().catch(() => {});
  return out;
}

/* PHP-serialized transient -> response keys via `php -r` (no wp-load). */
function transientResponseKeys(raw) {
  if (!raw) return Promise.resolve([]);
  const b64 = Buffer.from(String(raw), 'utf8').toString('base64');
  return run(
    `php -r ` + shq(
      '$t=@unserialize(base64_decode($argv[1]));' +
      '$r=is_object($t)&&isset($t->response)?(array)$t->response:' +
      '(is_array($t)&&isset($t["response"])?(array)$t["response"]:[]);' +
      'echo json_encode(array_keys($r));'
    ) + ` ${shq(b64)}`
  ).then((r) => {
    try { const j = JSON.parse(r.stdout); return Array.isArray(j) ? j : []; }
    catch { return []; }
  });
}

async function themesFast(site, prefix, dbName) {
  const out = [];
  const dir = path.join(wpRoot(site), 'wp-content', 'themes');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const d of names) {
    let head = '';
    try { head = fs.readFileSync(path.join(dir, d, 'style.css'), 'utf8').slice(0, 4096); }
    catch { continue; }
    if (!/Theme Name\s*:/i.test(head)) continue; // folder without a theme header
    const pick = (re) => { const m = re.exec(head); return m ? m[1].trim() : ''; };
    out.push({
      name: d,
      title: pick(/^[\s*]*Theme Name\s*:\s*(.+)$/im) || d,
      version: pick(/^[\s*]*Version\s*:\s*(.+)$/im),
      status: 'inactive',
      update: 'none'
    });
  }
  const meta = await themeMeta(site, prefix, dbName).catch(() => ({ active: '', transient: '' }));
  const upd = new Set(await transientResponseKeys(meta.transient));
  for (const t of out) {
    if (meta.active && t.name === meta.active) t.status = 'active';
    if (upd.has(t.name)) t.update = 'available';
  }
  return out;
}

/* wp-cli boots cost seconds on this box - cache the whole status for a
 * minute so revisiting the WordPress menu is instant. Every mutation
 * below busts the entry; the UI's Refresh button passes ?fresh=1.
 * Stale entries are served immediately and refreshed in the background
 * (stale-while-revalidate) so a cold build never blocks a page open. */
const statusCache = new Map();
const STATUS_TTL = 60_000;

async function buildStatus(site, fresh) {
  const cfg = fsReadConfig(site);
  const version = fsReadVersion(site);

  /* Was: 9 wp-cli boots in parallel (version, 3x config, option, user,
   * core check-update, plugin list, theme list) - each boot loads the whole
   * WordPress + active plugins, which OOM-killed the server. Now: ONE boot
   * (plugin list, plugins skipped at bootstrap) plus file reads, direct
   * SQL and one HTTPS call - everything still parallel. The old second
   * boot (theme list, ~4.8s + 6 WP.org requests) became themesFast().
   * --skip-update-check keeps wp-cli from forcing a WP.org refresh on
   * every normal build (~0.7s); ?fresh=1 still forces it so Refresh gives
   * absolutely current badges, and WP's own cron keeps the transient
   * fresh in between. */
  const [dbi, upd, plugins, themes] = await Promise.all([
    part(dbInfo(site, cfg.prefix, cfg.dbName), { siteurl: null, admins: [] }),
    part(coreLatest(version), { coreUpdate: false, latest: null }),
    part(wpJson(site,
      'plugin list --skip-plugins --skip-themes' +
      (fresh ? '' : ' --skip-update-check') +
      ' --fields=name,title,status,version,update,auto_update',
      { timeout: 45_000 }), []),
    part(themesFast(site, cfg.prefix, cfg.dbName), [])
  ]);

  const clean = (list) => (Array.isArray(list) ? list.map((x) => ({
    slug: x.name, // wp-cli's "name" column is the slug
    name: x.title || x.name,
    status: x.status || '',
    version: x.version || '',
    hasUpdate: String(x.update || '').toLowerCase() === 'available',
    autoUpdate: String(x.auto_update || '').toLowerCase() === 'on'
  })) : []);

  return {
    installed: true,
    domain: site.domain,
    wpVersion: version,
    coreUpdate: upd.coreUpdate,
    latest: upd.latest,
    debug: cfg.debug,
    dbName: cfg.dbName,
    siteurl: dbi.siteurl,
    admins: dbi.admins,
    coreAuto: cfg.coreAuto,
    phpVersion: site.phpVersion,
    ssl: !!site.ssl,
    maintenance: maintenanceState(site),
    plugins: clean(plugins),
    themes: clean(themes)
  };
}

/* Background refresh for stale entries - never blocks a response, and
 * never repopulates a cache the mutation-bust middleware just cleared. */
async function revalidate(site) {
  try {
    await ensureWpCli();
    const json = await buildStatus(site, false);
    if (statusCache.has(site.id)) statusCache.set(site.id, { t: Date.now(), json });
  } catch {
    const hit = statusCache.get(site.id);
    if (hit) hit.revalidating = false;
  }
}

router.get('/:id/status', async (req, res) => {
  const site = siteOf(req, res);
  if (!site) return;
  const fresh = String(req.query.fresh || '') === '1';
  if (!fresh) {
    const hit = statusCache.get(site.id);
    if (hit) {
      if (Date.now() - hit.t < STATUS_TTL) {
        /* The maintenance lock is checked outside the cache. A site that
         * goes into maintenance answers 503 to everybody, and a status that
         * is up to a minute stale is a status that does not know the shop
         * is down. It is one stat() call, so there is nothing to save. */
        hit.json.maintenance = maintenanceState(site);
        return res.json(hit.json);
      }
      // stale but usable: answer instantly, rebuild behind the scenes
      if (!hit.revalidating) { hit.revalidating = true; revalidate(site); }
      hit.json.maintenance = maintenanceState(site);
      return res.json(hit.json);
    }
  }
  if (!isWp(site)) return res.json({ installed: false, domain: site.domain });

  try {
    await ensureWpCli();
  } catch (e) {
    return res.json({ installed: true, domain: site.domain, error: e.message });
  }

  const payload = await buildStatus(site, fresh);
  payload.maintenance = maintenanceState(site);
  statusCache.set(site.id, { t: Date.now(), json: payload });
  res.json(payload);
});

/* Any mutation invalidates this site's cached status. */
router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const id = (req.path.split('/')[1] || '');
    if (id) statusCache.delete(id);
  }
  next();
});

/* ------------------------------------------------------------------ */
/* One-click install                                                   */
/* ------------------------------------------------------------------ */
router.post('/:id/install', async (req, res) => {
  const site = siteOf(req, res);
  if (!site) return;
  if (isWp(site)) return res.status(400).json({ error: 'WordPress is already installed here' });

  const b = req.body || {};
  const title = String(b.title || site.domain).trim().slice(0, 200) || site.domain;
  const adminUser = String(b.adminUser || '');
  const adminPassword = String(b.adminPassword || '');
  const adminEmail = String(b.adminEmail || '');
  if (!USER_RE.test(adminUser)) return res.status(400).json({ error: 'Admin username must be 3-32 chars (letters, numbers, _ . -)' });
  if (adminPassword.length < 8) return res.status(400).json({ error: 'Admin password must be at least 8 characters' });
  if (!EMAIL_RE.test(adminEmail)) return res.status(400).json({ error: 'Invalid admin email' });

  const genBase = ('wp_' + site.domain.replace(/[^a-z0-9]+/gi, '_').toLowerCase()).replace(/_+$/, '');
  const dbName = String(b.dbName || genBase).toLowerCase();
  const dbUser = String(b.dbUser || `${genBase}_u`).toLowerCase();
  const dbPassword = String(b.dbPassword || crypto.randomBytes(18).toString('base64url'));
  if (!NAME_RE.test(dbName)) return res.status(400).json({ error: 'Invalid database name (a-z, 0-9, _; max 48)' });
  if (!NAME_RE.test(dbUser)) return res.status(400).json({ error: 'Invalid database user (a-z, 0-9, _; max 48)' });
  if (dbPassword.length < 8) return res.status(400).json({ error: 'Database password must be at least 8 characters' });

  const limit = checkLimit(req.user, 'databases');
  if (!limit.ok) return res.status(403).json({ error: limit.error });

  try {
    await ensureWpCli();

    // 1. database + user (same conventions as the Databases module)
    const m = config.mysql;
    const c = await mysql.createConnection(
      m.socketPath
        ? { socketPath: m.socketPath, user: m.user, password: m.password }
        : { host: m.host, port: m.port, user: m.user, password: m.password }
    );
    await c.query('CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [dbName]);
    await c.query("CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?", [dbUser, dbPassword]);
    await c.query("ALTER USER ?@'%' IDENTIFIED BY ?", [dbUser, dbPassword]);
    await c.query('GRANT ALL PRIVILEGES ON ??.* TO ?@\'%\'', [dbName, dbUser]);
    await c.query('FLUSH PRIVILEGES');
    await c.end();
    if (!db.findOne('databases', (d) => d.name === dbName)) {
      db.insert('databases', { name: dbName, dbUser, ownerId: req.user.id, siteId: site.id });
    }

    // 2. download WordPress core (a placeholder docroot may already have
    //    index.html etc. - --force overwrites collisions only)
    let r = await wp(site, 'core download --force', { timeout: 600_000 });
    if (!r.ok && !isWp(site)) throw new Error(`Downloading WordPress failed: ${r.error}`);

    // 3. wp-config.php
    r = await wp(site,
      `config create --dbname=${shq(dbName)} --dbuser=${shq(dbUser)} --dbpass=${shq(dbPassword)} ` +
      '--dbhost=localhost --force', { timeout: 120_000 });
    if (!r.ok) throw new Error(`Creating wp-config.php failed: ${r.error}`);

    // 4. run the installer
    const url = `${site.ssl ? 'https' : 'http'}://${site.domain}`;
    r = await wp(site,
      `core install --url=${shq(url)} --title=${shq(title)} --admin_user=${shq(adminUser)} ` +
      `--admin_password=${shq(adminPassword)} --admin_email=${shq(adminEmail)} --skip-email`,
      { timeout: 300_000 });
    if (!r.ok) throw new Error(`WordPress install failed: ${r.error}`);

    await harden(site);
    res.json({
      ok: true,
      url,
      adminUser,
      adminPassword,
      db: { name: dbName, user: dbUser, password: dbPassword }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Updates & plugin/theme actions                                      */
/* ------------------------------------------------------------------ */
router.post('/:id/core-update', async (req, res) => {
  const site = siteOf(req, res);
  if (!site) return;
  if (!isWp(site)) return res.status(400).json({ error: 'WordPress is not installed' });
  try { await ensureWpCli(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const r1 = await wp(site, 'core update', { timeout: 600_000 });
  if (!r1.ok) return res.json({ ok: false, output: r1.error || r1.stderr });
  const r2 = await wp(site, 'core update-db', { timeout: 300_000 });
  await harden(site);
  res.json({ ok: r2.ok, output: (r1.stdout + r1.stderr + '\n' + r2.stdout + r2.stderr).trim(), dbUpdate: r2.ok });
});

const PLUGIN_ACTIONS = ['activate', 'deactivate', 'update', 'delete', 'auto-on', 'auto-off'];
const THEME_ACTIONS = ['activate', 'update', 'delete'];

router.post('/:id/plugin/:slug', async (req, res) => {
  const site = siteOf(req, res);
  if (!site) return;
  const slug = req.params.slug;
  const action = String((req.body || {}).action || '');
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'Invalid plugin slug' });
  if (!PLUGIN_ACTIONS.includes(action)) return res.status(400).json({ error: 'Invalid action' });
  if (!isWp(site)) return res.status(400).json({ error: 'WordPress is not installed' });
  try { await ensureWpCli(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const cmd = action === 'auto-on' ? 'auto-updates enable'
    : action === 'auto-off' ? 'auto-updates disable'
    : action;
  const r = await wp(site, `plugin ${cmd} ${slug}`, { timeout: 300_000 });
  await harden(site);
  res.json({ ok: r.ok, output: (r.stdout + r.stderr).trim() || (r.ok ? 'Done' : r.error) });
});

router.post('/:id/theme/:slug', async (req, res) => {
  const site = siteOf(req, res);
  if (!site) return;
  const slug = req.params.slug;
  const action = String((req.body || {}).action || '');
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'Invalid theme slug' });
  if (!THEME_ACTIONS.includes(action)) return res.status(400).json({ error: 'Invalid action' });
  if (!isWp(site)) return res.status(400).json({ error: 'WordPress is not installed' });
  try { await ensureWpCli(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const r = await wp(site, `theme ${action} ${slug}`, { timeout: 300_000 });
  await harden(site);
  res.json({ ok: r.ok, output: (r.stdout + r.stderr).trim() || (r.ok ? 'Done' : r.error) });
});

/* ------------------------------------------------------------------ */
/* Settings: WP_DEBUG, auto-updates, admin password                    */
/* ------------------------------------------------------------------ */
router.post('/:id/settings', async (req, res) => {
  const site = siteOf(req, res);
  if (!site) return;
  if (!isWp(site)) return res.status(400).json({ error: 'WordPress is not installed' });
  try { await ensureWpCli(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const b = req.body || {};
  const outputs = [];
  const fail = (out) => res.status(500).json({ error: out, outputs });

  if (b.debug !== undefined) {
    const r = await wp(site, `config set WP_DEBUG ${b.debug ? 'true' : 'false'} --raw`);
    if (!r.ok) return fail(`WP_DEBUG: ${r.error}`);
    outputs.push('WP_DEBUG updated');
  }
  if (b.coreAuto !== undefined) {
    // true / minor / false - 'minor' must be quoted (no --raw)
    const val = b.coreAuto === 'all' ? 'true --raw'
      : b.coreAuto === 'off' ? 'false --raw'
      : 'minor';
    const r = await wp(site, `config set WP_AUTO_UPDATE_CORE ${val}`);
    if (!r.ok) return fail(`Core auto-updates: ${r.error}`);
    outputs.push('Core auto-updates updated');
  }
  await harden(site);
  res.json({ ok: true, outputs });
});

router.post('/:id/admin-password', async (req, res) => {
  const site = siteOf(req, res);
  if (!site) return;
  const b = req.body || {};
  const username = String(b.username || '');
  const password = String(b.password || '');
  if (!USER_RE.test(username)) return res.status(400).json({ error: 'Invalid username' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!isWp(site)) return res.status(400).json({ error: 'WordPress is not installed' });
  try { await ensureWpCli(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const r = await wp(site, `user update ${username} --user_pass=${shq(password)}`);
  res.json({ ok: r.ok, output: (r.stdout + r.stderr).trim() || (r.ok ? 'Password changed' : r.error) });
});

/* ------------------------------------------------------------------ */
/* Maintenance lock                                                    */
/* ------------------------------------------------------------------ */

/* WordPress writes .maintenance in the docroot while it installs or
 * updates something, and serves a "Scheduled Maintenance" page with HTTP
 * 503 to everybody until it is removed.
 *
 * The file is normally removed again when the work finishes - but if the
 * request doing the work dies first (an out-of-memory fatal while
 * unpacking a plugin, say), nothing removes it. The site then answers 503
 * to every visitor, and the only symptom in the logs is the fatal from the
 * update that came before. This has taken the shop down twice, so the panel
 * reports the file and can clear it.
 *
 * WordPress only honours the file for ten minutes after it was written, so
 * the "stale" flag is about a lock that is still live rather than one that
 * is about to lapse. */
function maintenanceState(site) {
  const file = path.join(wpRoot(site), '.maintenance');
  try {
    const st = fs.statSync(file);
    const age = Math.max(0, Math.round((Date.now() - st.mtimeMs) / 1000));
    return { present: true, ageSeconds: age, live: age < 600 };
  } catch {
    return { present: false, ageSeconds: 0, live: false };
  }
}

router.post('/:id/maintenance', async (req, res) => {
  const site = siteOf(req, res);
  if (!site) return;
  if (!isWp(site)) return res.status(400).json({ error: 'WordPress is not installed on this site' });
  const file = path.join(wpRoot(site), '.maintenance');
  const before = maintenanceState(site);
  if (!before.present) return res.json({ ok: true, removed: false, message: 'No maintenance lock is set' });
  try {
    await fs.promises.rm(file, { force: true });
  } catch (e) {
    return res.status(500).json({ error: `Could not remove the lock: ${e.message}` });
  }
  res.json({ ok: true, removed: true, wasAgeSeconds: before.ageSeconds });
});

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

/* The LiteSpeed Cache plugin's object cache can live in Redis, and its own
 * flush is a FLUSHDB - the whole database, every site on it. Two WordPress
 * sites sharing one Redis would then lose each other's cache every time
 * either was purged from the panel.
 *
 * LSCWP builds its keys as the last five characters of the md5 of its own
 * object-cache class file, then the group, then the key. That class file
 * sits in each site's own plugins directory, so two sites have two
 * different prefixes - which is what makes it a usable boundary. Deleting
 * only the keys with this site's prefix purges this site and leaves the
 * others alone.
 */
const LSCWP_OC_CLASS = 'wp-content/plugins/litespeed-cache/src/object-cache-wp.cls.php';
/* The files the plugin generates in the docroot. All of them are rebuilt
 * on demand, so removing them is safe. The debug log is not - someone
 * looking into a cache problem wants it. */
const LSCWP_CACHE_DIRS = ['ccss', 'ucss', 'css', 'js', 'cloud', 'vpi', 'page', 'cache'];
const REDIS_CLI = '/usr/bin/redis-cli';

/* One option value, straight from the site's own database. */
async function dbOption(site, prefix, dbName, name) {
  if (!dbName) return null;
  const m = config.mysql;
  const c = await mysql.createConnection({
    ...(m.socketPath
      ? { socketPath: m.socketPath, user: m.user, password: m.password }
      : { host: m.host, port: m.port, user: m.user, password: m.password }),
    database: dbName,
    connectTimeout: 5000
  });
  try {
    const [r] = await c.query(
      'SELECT option_value FROM ?? WHERE option_name = ? LIMIT 1',
      [`${prefix}options`, name]
    );
    return r && r[0] ? r[0].option_value : null;
  } catch { return null; }
  finally { await c.end().catch(() => {}); }
}

/**
 * The prefix LiteSpeed Cache puts on every object-cache key.
 *
 * The plugin does `define('LSOC_PREFIX', substr(md5(__FILE__), -5))` - the
 * last five characters of the md5 of its own class file. Returns null when
 * the plugin is not installed, which is how the caller knows the prefix
 * cannot be relied on.
 */
function lscwpKeyPrefix(site) {
  const file = path.join(wpRoot(site), LSCWP_OC_CLASS);
  let real;
  try { real = fs.realpathSync(file); } catch { return null; }
  return crypto.createHash('md5').update(real).digest('hex').slice(-5);
}

/* Where this site's object cache lives, and the prefix its keys carry. */
async function objectCacheConf(site) {
  const cfg = fsReadConfig(site);
  if (!cfg.dbName) return null;
  const kind = await dbOption(site, cfg.prefix, cfg.dbName, 'litespeed.conf.object-kind');
  if (!kind) return null;   // the plugin is not using an external store
  const host = (await dbOption(site, cfg.prefix, cfg.dbName, 'litespeed.conf.object-host')) || '127.0.0.1';
  const port = (await dbOption(site, cfg.prefix, cfg.dbName, 'litespeed.conf.object-port')) || '6379';
  const db = (await dbOption(site, cfg.prefix, cfg.dbName, 'litespeed.conf.object-db_id')) || '0';
  return {
    driver: String(kind) === '1' ? 'redis' : 'memcached',
    host, port, db: String(db),
    keyPrefix: lscwpKeyPrefix(site)
  };
}

function redisCmd(conf, extra) {
  return run(`${REDIS_CLI} -h ${shq(conf.host)} -p ${shq(conf.port)} -n ${shq(conf.db)} ${extra}`);
}

/* Count, and delete, the keys matching a pattern. One round trip and one
 * atomic operation each, rather than scanning and deleting in the shell. */
const LUA_COUNT = "local c=0 for _,k in ipairs(redis.call('keys',ARGV[1])) do c=c+1 end return c";
const LUA_DEL = "local c=0 for _,k in ipairs(redis.call('keys',ARGV[1])) do redis.call('del',k) c=c+1 end return c";

async function redisCount(conf, pattern) {
  if (!fs.existsSync(REDIS_CLI)) return null;
  const r = await redisCmd(conf, `eval ${shq(LUA_COUNT)} 0 ${shq(pattern)}`);
  const n = Number((r.stdout || '').trim());
  return Number.isInteger(n) ? n : null;
}

async function redisDel(conf, pattern) {
  if (!fs.existsSync(REDIS_CLI)) return null;
  const r = await redisCmd(conf, `eval ${shq(LUA_DEL)} 0 ${shq(pattern)}`);
  const n = Number((r.stdout || '').trim());
  return Number.isInteger(n) ? n : null;
}

/* How much a directory holds, without walking into it. */
async function dirSize(dir) {
  let files = 0;
  let bytes = 0;
  const walk = async (d, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else {
        files++;
        try { bytes += (await fs.promises.stat(p)).size; } catch { /* raced away */ }
      }
    }
  };
  await walk(dir, 0);
  return { files, bytes };
}

/**
 * What is cached for this site, and what is shared with other sites.
 *
 * The object cache is the one that bites: a stale copy of a user record
 * there keeps a password change from taking effect, because WordPress
 * compares against the cached hash rather than the one in the database.
 */
async function cacheReport(site) {
  const out = {
    domain: site.domain,
    backend: site.backend,
    objectCache: null,
    lscwp: null,
    server: null,
    shared: []
  };

  const conf = await objectCacheConf(site);
  if (conf) {
    const keys = conf.driver === 'redis' && conf.keyPrefix
      ? await redisCount(conf, `${conf.keyPrefix}*`)
      : null;
    out.objectCache = {
      driver: conf.driver,
      host: conf.host,
      port: conf.port,
      db: conf.db,
      keyPrefix: conf.keyPrefix,
      keys
    };
    /* Anyone else on the same store. Their cache is not this site's to
     * clear, so the panel has to know before it does. */
    for (const other of db.all('sites')) {
      if (other.id === site.id || !isWp(other)) continue;
      const oc = await objectCacheConf(other);
      if (oc && oc.driver === conf.driver && oc.host === conf.host
          && oc.port === conf.port && oc.db === conf.db) {
        out.shared.push({ id: other.id, domain: other.domain });
      }
    }
  }

  const dir = path.join(wpRoot(site), 'wp-content', 'litespeed');
  if (fs.existsSync(dir)) {
    const d = await dirSize(dir);
    out.lscwp = { dir, files: d.files, bytes: d.bytes };
  }

  /* The server-level page cache belongs to OpenLiteSpeed, and every site
   * it serves shares it. */
  const serverCache = path.join(config.openlitespeed.root, 'cachedata');
  if (fs.existsSync(serverCache)) {
    const d = await dirSize(serverCache);
    out.server = { dir: serverCache, files: d.files, bytes: d.bytes, shared: true };
  }

  return out;
}

router.get('/:id/cache', async (req, res) => {
  const site = siteOf(req, res);
  if (!site) return;
  if (!isWp(site)) return res.json({ error: 'WordPress is not installed on this site' });
  try { res.json(await cacheReport(site)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * Purge the caches for a site.
 *
 * scope=site  - only what belongs to this site. The object cache is
 *               trimmed to this site's own keys, the transients are dropped
 *               and the generated files in the docroot are removed. Other
 *               sites on the same Redis are untouched.
 * scope=all   - everything, including the server-level page cache, which
 *               every OpenLiteSpeed site shares, and the whole object
 *               cache store.
 */
router.post('/:id/cache', async (req, res) => {
  const site = siteOf(req, res);
  if (!site) return;
  if (!isWp(site)) return res.status(400).json({ error: 'WordPress is not installed on this site' });

  const scope = (req.body || {}).scope === 'all' ? 'all' : 'site';
  const report = await cacheReport(site);
  const done = [];
  const notes = [];

  try { await ensureWpCli(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  /* 1. the object cache */
  if (report.objectCache) {
    const oc = report.objectCache;
    if (oc.driver === 'redis' && oc.keyPrefix) {
      const n = await redisDel({ driver: oc.driver, host: oc.host, port: oc.port, db: oc.db },
        `${oc.keyPrefix}*`);
      if (n === null) {
        notes.push('redis-cli is not available, so the object cache was left alone');
      } else {
        done.push(`object cache: ${n} of this site's key(s) removed`);
        if (report.shared.length) {
          notes.push(`the object cache is shared with ${report.shared.map((s) => s.domain).join(', ')} - only this site's keys were removed`);
        }
      }
    } else {
      const r = await wp(site, 'cache flush');
      done.push(r.ok ? 'object cache flushed' : `object cache flush failed: ${r.error}`);
      if (report.shared.length) {
        notes.push(`the object cache is shared with ${report.shared.map((s) => s.domain).join(', ')} - the flush cleared them too`);
      }
    }
  }

  /* 2. the transients */
  const t = await wp(site, 'transient delete --all');
  done.push(t.ok ? 'transients deleted' : `transients: ${(t.error || '').trim() || 'not deleted'}`);

  /* 3. the files the plugin generated in the docroot */
  if (report.lscwp) {
    let n = 0;
    for (const d of LSCWP_CACHE_DIRS) {
      const p = path.join(report.lscwp.dir, d);
      let entries;
      try { entries = await fs.promises.readdir(p); } catch { continue; }
      for (const e of entries) {
        await fs.promises.rm(path.join(p, e), { recursive: true, force: true });
        n++;
      }
    }
    done.push(n ? `${n} generated cache file(s) removed` : 'no generated cache files to remove');
  }

  /* 4. the page cache, which the server holds and every site shares */
  if (scope === 'all') {
    const purge = await wp(site, 'litespeed-purge all');
    if (purge.ok) {
      done.push('page cache purged');
      if (report.shared.length) {
        notes.push(`the shared object cache was flushed as well, so ${report.shared.map((s) => s.domain).join(', ')} lost theirs too`);
      }
    } else {
      done.push(`page cache purge failed: ${(purge.error || '').trim()}`);
    }
  } else if (report.server) {
    notes.push('the page cache is shared by every OpenLiteSpeed site and was left alone - choose "everything" to clear it');
  }

  res.json({ ok: true, scope, done, notes, report: await cacheReport(site) });
});

module.exports = { router };
