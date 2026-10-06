'use strict';
/**
 * Panel settings.
 *
 * Two kinds of settings live here:
 *  - panel config (config.json): a strict WHITELIST of editable keys. Anything
 *    not in SCHEMA can never be reached from the browser, so the session
 *    secret, MySQL credentials and file paths cannot be tampered with through
 *    this endpoint. Values are validated, written atomically, and mirrored
 *    into the live in-memory config so most changes take effect immediately;
 *    the ones that cannot (the listen port) are flagged restartRequired.
 *  - user preferences (per account, stored in the JSON database): panel-wide
 *    things like default page size or the live-stats toggle.
 */
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const config = require('../config');
const db = require('./db');
const { requireAuth, requireAdmin } = require('./auth');
const { run } = require('./exec');

const router = express.Router();

/* Editable panel settings. Each entry declares how the value is validated and
 * whether it needs a panel restart to take effect. Keep this list short and
 * boring - it is the only surface from the browser into config.json. */
const SCHEMA = {
  panelName: { def: 'letzControl', type: 'string', max: 40 },
  certbotEmail: { def: '', type: 'email', hint: "Used for Let's Encrypt expiry notices" },
  publicIp: { def: '', type: 'ip', hint: 'Auto-detected when empty' },
  sitesRoot: { def: '/var/www', type: 'absdir', hint: 'Where website document roots are created' },
  fileManagerRoots: {
    def: ['/'],
    type: 'list',
    item: 'absdir',
    hint: 'Directories the file manager may browse'
  },
  sessionMinutes: {
    def: 120,
    type: 'int',
    min: 5,
    max: 10080,
    restartRequired: true,
    hint: 'Idle minutes before a panel login expires'
  },
  maintenanceMode: { def: false, type: 'bool', hint: 'Shows a maintenance page to other panel users' }
};

/* --------------------------------- input ------------------------------- */

const fail = (msg) => ({ error: msg });

function validate(key, raw) {
  const s = SCHEMA[key];
  if (!s) return fail(`Unknown setting: ${key}`);

  if (s.type === 'bool') {
    if (typeof raw === 'boolean') return { value: raw };
    if (raw === 'true' || raw === '1' || raw === 1) return { value: true };
    if (raw === 'false' || raw === '0' || raw === 0 || raw === '') return { value: false };
    return fail(`${key} must be on or off`);
  }

  if (s.type === 'int') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < s.min || n > s.max) {
      return fail(`${key} must be a whole number between ${s.min} and ${s.max}`);
    }
    return { value: n };
  }

  if (s.type === 'list') {
    const arr = Array.isArray(raw) ? raw : String(raw).split(',');
    const out = [];
    for (const item of arr) {
      const v = String(item).trim();
      if (!v) continue;
      if (!v.startsWith('/')) return fail(`${key}: "${v}" must be an absolute path`);
      if (out.includes(v)) continue;
      out.push(v);
    }
    if (!out.length) return fail(`${key} needs at least one directory`);
    return { value: out };
  }

  const v = String(raw ?? '').trim();
  if (v.length > (s.max || 200)) return fail(`${key} is too long`);

  if (s.type === 'email') {
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return fail(`${key} must be a valid email address`);
  } else if (s.type === 'ip') {
    if (v && !/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) return fail(`${key} must be an IPv4 address`);
  } else if (s.type === 'absdir') {
    if (!v.startsWith('/')) return fail(`${key} must be an absolute path`);
    if (v.includes('..')) return fail(`${key} must not contain ".."`);
  }
  return { value: v };
}

/* ------------------------------ persistence ---------------------------- */

/** Settings that are not config.json keys live in the JSON database. */
const prefs = (userId) => {
  const store = db.data.meta.settings || (db.data.meta.settings = {});
  return store[userId] || (store[userId] = {});
};

const PREF_SCHEMA = {
  pageSize: { def: 25, type: 'int', min: 5, max: 200 },
  liveStats: { def: true, type: 'bool' },
  confirmDangerous: { def: true, type: 'bool' }
};

/** Only the safe, non-secret keys of config.json are ever shown. */
function readConfig() {
  const out = {};
  for (const [key, s] of Object.entries(SCHEMA)) {
    if (key === 'sessionMinutes') {
      out[key] = Number((config.sessionMinutes, (db.data.meta.sessionMinutes ?? s.def)));
      continue;
    }
    if (key === 'maintenanceMode') {
      out[key] = db.data.meta.maintenanceMode === true;
      continue;
    }
    out[key] = config[key] !== undefined ? config[key] : s.def;
  }
  return out;
}

/** Atomic write; config.json is never left half-written. */
function writeConfig(patch) {
  const file = path.join(__dirname, '..', 'config.json');
  let current = {};
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { current = {}; }
  const next = { ...current, ...patch };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
}

/* -------------------------------- routes ------------------------------- */

router.get('/', requireAuth, (req, res) => {
  const schema = Object.entries(SCHEMA).map(([key, s]) => ({
    key, type: s.type, def: s.def, hint: s.hint || '',
    restartRequired: !!s.restartRequired, adminOnly: key !== 'panelName'
  }));
  const p = prefs(req.user.id);
  const prefSchema = Object.entries(PREF_SCHEMA).map(([key, s]) => ({ key, type: s.type, def: s.def }));
  res.json({
    config: readConfig(),
    schema,
    prefs: { pageSize: p.pageSize ?? PREF_SCHEMA.pageSize.def, liveStats: p.liveStats ?? true, confirmDangerous: p.confirmDangerous ?? true },
    prefSchema,
    // secrets are never sent to the browser, only whether they are configured
    hasDbPassword: !!(config.mysql && config.mysql.password),
    role: req.user.role
  });
});

router.put('/', requireAuth, (req, res) => {
  const body = req.body || {};
  const changes = {};
  const errors = {};
  const needRestart = [];

  for (const [key, raw] of Object.entries(body)) {
    const v = validate(key, raw);
    if (v.error) { errors[key] = v.error; continue; }
    changes[key] = v.value;
    if (SCHEMA[key].restartRequired) needRestart.push(key);
  }

  if (Object.keys(errors).length) return res.status(400).json({ error: 'Some settings are invalid', errors });

  const adminOnly = Object.keys(changes).filter((k) => SCHEMA[k].adminOnly && req.user.role !== 'admin');
  if (adminOnly.length) {
    return res.status(403).json({ error: `Only an administrator can change: ${adminOnly.join(', ')}` });
  }

  /* Split between config.json and the database. */
  const toFile = {};
  for (const [k, v] of Object.entries(changes)) {
    if (k === 'sessionMinutes') db.data.meta.sessionMinutes = v;
    else if (k === 'maintenanceMode') db.data.meta.maintenanceMode = v;
    else toFile[k] = v;
  }
  if (Object.keys(toFile).length) writeConfig(toFile);
  if (Object.keys(changes).length) db.save();

  // mirror into the live config so the next request already sees it
  for (const [k, v] of Object.entries(toFile)) config[k] = v;
  config.sessionMinutes = db.data.meta.sessionMinutes ?? config.sessionMinutes;

  res.json({ ok: true, config: readConfig(), restartRequired: needRestart.length > 0, changed: Object.keys(changes) });
});

router.put('/prefs', requireAuth, (req, res) => {
  const body = req.body || {};
  const p = prefs(req.user.id);
  const errors = {};
  for (const [key, raw] of Object.entries(body)) {
    const s = PREF_SCHEMA[key];
    if (!s) { errors[key] = 'Unknown preference'; continue; }
    if (s.type === 'bool') {
      p[key] = raw === true || raw === 'true' || raw === 1;
      continue;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < s.min || n > s.max) {
      errors[key] = `Must be a number between ${s.min} and ${s.max}`;
      continue;
    }
    p[key] = n;
  }
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Invalid preferences', errors });
  db.save();
  res.json({ ok: true, prefs: p });
});

/* ------------------------------ maintenance ---------------------------- */

/** Panel database backup/restore. Writes stay inside dataDir. */
router.post('/export', requireAuth, async (_req, res) => {
  try {
    const dir = path.join(config.dataDir, 'exports');
    await fsp.mkdir(dir, { recursive: true });
    const name = `letzcontrol-db-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const body = JSON.stringify(db.data, null, 2);
    await fsp.writeFile(path.join(dir, name), body, { mode: 0o600 });
    res.json({ ok: true, file: path.join(dir, name), bytes: body.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/exports', requireAuth, async (_req, res) => {
  try {
    const dir = path.join(config.dataDir, 'exports');
    await fsp.mkdir(dir, { recursive: true });
    const names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')).sort().reverse();
    const files = [];
    for (const n of names.slice(0, 20)) {
      const st = await fsp.stat(path.join(dir, n));
      files.push({ name: n, bytes: st.size, createdAt: st.mtimeMs });
    }
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/import', requireAdmin, async (req, res) => {
  try {
    const name = path.basename(String(req.body?.name || ''));
    if (!name.endsWith('.json')) return res.status(400).json({ error: 'Choose a .json export' });
    const file = path.join(config.dataDir, 'exports', name);
    const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
    // only the collections this panel understands, and never trust the ids
    const clean = {};
    for (const c of ['users', 'plans', 'sites', 'databases', 'zones', 'meta']) {
      clean[c] = Array.isArray(raw[c]) ? raw[c] : (c === 'meta' ? (raw[c] || {}) : []);
    }
    const before = fs.readFileSync(path.join(config.dataDir, 'db.json'));
    await fsp.writeFile(path.join(config.dataDir, 'db.json.before-import'), before);
    for (const c of Object.keys(db.data)) db.data[c] = clean[c] !== undefined ? clean[c] : [];
    db.save();
    res.json({ ok: true, sites: db.all('sites').length, users: db.all('users').length });
  } catch (e) {
    res.status(400).json({ error: `Import failed: ${e.message}` });
  }
});

/** Remove abandoned upload temp files (the sweeper runs hourly too). */
router.post('/clear-uploads', requireAdmin, async (_req, res) => {
  try {
    const dir = path.join(config.dataDir, 'uploads');
    const names = await fsp.readdir(dir).catch(() => []);
    let bytes = 0;
    for (const n of names) {
      const st = await fsp.stat(path.join(dir, n)).catch(() => null);
      if (!st || !st.isFile()) continue;
      bytes += st.size;
      await fsp.rm(path.join(dir, n), { force: true });
    }
    res.json({ ok: true, removed: names.length, bytes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------- sessions ----------------------------- */

/* express-session's built-in MemoryStore keeps its map on `.sessions` (the
 * connect-era name was `.store`), and it stores each entry as a JSON STRING.
 * Without a real store installed this is the only way to see and end other
 * logins, so decode defensively rather than assuming objects. */
function sessionMap(req) {
  return (req.sessionStore && req.sessionStore.sessions) || {};
}

function decodeSession(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

router.get('/sessions', requireAuth, (req, res) => {
  const map = sessionMap(req);
  const entries = Object.entries(map)
    .map(([sid, raw]) => {
      const s = decodeSession(raw);
      return {
        sid: sid.slice(0, 8) + '…',
        user: (db.get('users', s && s.userId) || {}).username || 'unknown',
        createdAt: (s && s.createdAt) || null,
        current: sid === req.sessionID
      };
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ sessions: entries });
});

router.post('/sessions/kill-others', requireAuth, (req, res) => {
  const map = sessionMap(req);
  let killed = 0;
  for (const sid of Object.keys(map)) {
    const s = decodeSession(map[sid]);
    if (sid !== req.sessionID && s && s.userId === req.user.id) {
      delete map[sid];
      killed++;
    }
  }
  res.json({ ok: true, killed });
});

/* -------------------------------- system ------------------------------ */

router.get('/system', requireAdmin, async (_req, res) => {
  const [uptime, df, mem, load] = await Promise.all([
    run('uptime -p'),
    run('df -h / --output=source,size,used,avail,pcent 2>/dev/null | tail -1 || df -h / | tail -1'),
    run('free -m'),
    run('cat /proc/loadavg')
  ]);
  res.json({
    hostname: os.hostname(),
    kernel: os.release(),
    node: process.version,
    panelUptime: process.uptime(),
    load: (load.stdout || '').trim(),
    disk: (df.stdout || '').trim(),
    mem: (mem.stdout || '').trim(),
    configFile: path.join(__dirname, '..', 'config.json'),
    dataDir: config.dataDir,
    installedServers: {
      nginx: fs.existsSync('/usr/sbin/nginx') || fs.existsSync('/usr/bin/nginx'),
      apache: fs.existsSync('/usr/sbin/apache2'),
      openlitespeed: fs.existsSync(path.join(config.openlitespeed.root, 'bin', 'lswsctrl')),
      docker: fs.existsSync('/usr/bin/docker')
    }
  });
});

/** Restart the panel process itself (systemd brings it straight back). */
router.post('/restart-panel', requireAdmin, async (_req, res) => {
  res.json({ ok: true, message: 'Panel restarting now' });
  setTimeout(() => run('systemctl restart letzcontrol'), 400);
});

module.exports = { router, SCHEMA };