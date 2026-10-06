'use strict';
/** MySQL/MariaDB manager: create/list/drop databases and users. */
const express = require('express');
const fs = require('fs');
const mysql = require('mysql2/promise');
const config = require('../config');
const db = require('./db');
const { run } = require('./exec');
const { checkLimit } = require('./users');

const router = express.Router();

const NAME_RE = /^[a-z0-9_]{1,48}$/;
const SYSTEM_SCHEMAS = ['information_schema', 'mysql', 'performance_schema', 'sys'];

async function conn() {
  const m = config.mysql;
  return mysql.createConnection(
    m.socketPath
      ? { socketPath: m.socketPath, user: m.user, password: m.password }
      : { host: m.host, port: m.port, user: m.user, password: m.password }
  );
}

/** 503 helper for when MySQL is unreachable/misconfigured */
router.use(async (req, res, next) => {
  try {
    const c = await conn();
    await c.ping();
    await c.end();
    next();
  } catch (e) {
    res.status(503).json({ error: `Cannot connect to MySQL (${e.message}). Check config.json -> mysql.` });
  }
});

/** A database is visible/manageable when you own the record, or when it
 * belongs to a website you own - so every site owner sees THEIR site's
 * database even if an admin (or the WP installer) created the record.
 * Legacy WP records have no siteId; their name embeds the site domain. */
function canDb(req, d) {
  if (req.user.role === 'admin' || d.ownerId === req.user.id) return true;
  if (d.siteId) {
    const site = db.get('sites', d.siteId);
    if (site) return site.ownerId === req.user.id;
  }
  return !!db.findOne('sites', (s) => s.ownerId === req.user.id
    && d.name.includes(s.domain.toLowerCase().replace(/[^a-z0-9]+/gi, '_')));
}

router.get('/', async (req, res, next) => {
  try {
    const records = db.find('databases', (d) => canDb(req, d));
    res.json({
      databases: records.map((d) => {
        const owner = db.get('users', d.ownerId);
        return { ...d, owner: owner ? owner.username : '?' };
      })
    });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const name = String((req.body || {}).name || '').toLowerCase().trim();
    const dbUser = String((req.body || {}).dbUser || '').toLowerCase().trim();
    const dbPassword = String((req.body || {}).dbPassword || '');

    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid database name (a-z 0-9 _)' });
    if (!NAME_RE.test(dbUser)) return res.status(400).json({ error: 'Invalid database username (a-z 0-9 _)' });
    if (dbPassword.length < 8) return res.status(400).json({ error: 'Database password must be at least 8 characters' });
    if (SYSTEM_SCHEMAS.includes(name)) return res.status(400).json({ error: 'That name is reserved' });

    const limit = checkLimit(req.user, 'databases');
    if (!limit.ok) return res.status(403).json({ error: limit.error });

    // cPanel-style prefixing keeps names unique between panel users
    const prefix = req.user.username === 'admin' ? '' : `${req.user.username}_`;
    const fullName = `${prefix}${name}`.slice(0, 64);
    const fullUser = `${prefix}${dbUser}`.slice(0, 32);

    if (db.findOne('databases', (d) => d.name === fullName)) {
      return res.status(409).json({ error: 'Database already exists' });
    }

    const c = await conn();
    await c.query('CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [fullName]);
    await c.query("CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?", [fullUser, dbPassword]);
    await c.query("ALTER USER ?@'%' IDENTIFIED BY ?", [fullUser, dbPassword]);
    await c.query('GRANT ALL PRIVILEGES ON ??.* TO ?@\'%\'', [fullName, fullUser]);
    await c.query('FLUSH PRIVILEGES');
    await c.end();

    const record = db.insert('databases', {
      name: fullName,
      dbUser: fullUser,
      ownerId: req.user.id
    });
    res.status(201).json({ database: record });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const record = db.get('databases', req.params.id);
    if (!record) return res.status(404).json({ error: 'Database not found' });
    if (!canDb(req, record)) {
      return res.status(403).json({ error: 'Not your database' });
    }
    const c = await conn();
    await c.query('DROP DATABASE IF EXISTS ??', [record.name]);
    // Drop the user only if no other panel database uses it
    const stillUsed = db.find('databases', (d) => d.id !== record.id && d.dbUser === record.dbUser);
    if (!stillUsed.length) {
      await c.query("DROP USER IF EXISTS ?@'%'", [record.dbUser]);
    }
    await c.query('FLUSH PRIVILEGES');
    await c.end();
    db.remove('databases', record.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Rename the MySQL user and/or change its password for this database. */
router.put('/:id', async (req, res, next) => {
  try {
    const record = db.get('databases', req.params.id);
    if (!record) return res.status(404).json({ error: 'Database not found' });
    if (!canDb(req, record)) {
      return res.status(403).json({ error: 'Not your database' });
    }

    const body = req.body || {};
    const rawUser = String(body.dbUser || '').toLowerCase().trim();
    const newPass = String(body.dbPassword || '');
    if (!rawUser && !newPass) return res.status(400).json({ error: 'Nothing to update' });
    if (rawUser && !NAME_RE.test(rawUser)) {
      return res.status(400).json({ error: 'Invalid database username (a-z 0-9 _)' });
    }
    if (newPass && newPass.length < 8) {
      return res.status(400).json({ error: 'Database password must be at least 8 characters' });
    }

    // cPanel-style prefixing (same rule as create); tolerate a pasted full name
    const prefix = req.user.username === 'admin' ? '' : `${req.user.username}_`;
    const newFullUser = rawUser
      ? (prefix && rawUser.startsWith(prefix) ? rawUser : `${prefix}${rawUser}`).slice(0, 32)
      : record.dbUser;

    const c = await conn();
    if (newFullUser !== record.dbUser) {
      const [ex] = await c.query("SELECT User FROM mysql.user WHERE User = ? AND Host = '%'", [newFullUser]);
      if (ex.length) {
        await c.end();
        return res.status(409).json({ error: 'That MySQL user already exists' });
      }
      // Grants follow the account automatically on rename
      await c.query("RENAME USER ?@'%' TO ?@'%'", [record.dbUser, newFullUser]);
      await c.query('FLUSH PRIVILEGES');
    }
    if (newPass) {
      await c.query("ALTER USER ?@'%' IDENTIFIED BY ?", [newFullUser, newPass]);
    }
    await c.end();

    // One MySQL user can back several panel records - keep them all in sync
    if (newFullUser !== record.dbUser) {
      for (const d of db.all('databases')) {
        if (d.dbUser === record.dbUser) db.update('databases', d.id, { dbUser: newFullUser });
      }
    }
    res.json({ ok: true, database: db.get('databases', record.id) });
  } catch (e) { next(e); }
});

/** One-click backup: download a plain-SQL dump via mysqldump (root socket auth). */
router.get('/:id/backup', async (req, res, next) => {
  try {
    const record = db.get('databases', req.params.id);
    if (!record) return res.status(404).json({ error: 'Database not found' });
    if (!canDb(req, record)) {
      return res.status(403).json({ error: 'Not your database' });
    }
    if (!NAME_RE.test(record.name)) return res.status(500).json({ error: 'Corrupt database record' });

    const dump = await run(
      `mysqldump -uroot --single-transaction --quick --add-drop-table --routines ${record.name}`,
      { timeout: 300_000, maxBuffer: 256 * 1024 * 1024 }
    );
    if (!dump.ok) return res.status(500).json({ error: dump.error || 'mysqldump failed' });

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Disposition', `attachment; filename="${record.name}-${stamp}.sql"`);
    res.setHeader('Content-Type', 'application/sql; charset=utf-8');
    res.send(dump.stdout);
  } catch (e) { next(e); }
});

/** phpMyAdmin availability for the Databases view button. */
router.get('/phpmyadmin', async (_req, res) => {
  const installed = fs.existsSync('/var/www/phpmyadmin/index.php')
    && fs.existsSync('/etc/nginx/sites-enabled/phpmyadmin.conf');
  let version = '';
  try { version = fs.readFileSync('/etc/letzcontrol/phpmyadmin-version', 'utf8').trim(); } catch { /* no marker */ }
  res.json({ installed, version, url: `http://${_req.headers.host ? _req.headers.host.split(':')[0] : 'localhost'}:2089/` });
});

router.get('/users', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const c = await conn();
    const [rows] = await c.query('SELECT User, Host FROM mysql.user ORDER BY User');
    await c.end();
    res.json({ users: rows });
  } catch (e) { next(e); }
});

module.exports = { router };
