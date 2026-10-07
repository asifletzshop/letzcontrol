'use strict';
/**
 * Users & hosting plans.
 * Plans limit how many sites/databases a user may create (-1 = unlimited).
 * The built-in admin bypasses all limits.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('./db');
const { requireAdmin, publicUser } = require('./auth');
const { run } = require('./exec');

const router = express.Router();

const USERNAME_RE = /^[a-z][a-z0-9_-]{2,31}$/;

/* ------------------------------------------------------------------ */
/* Seeding                                                             */
/* ------------------------------------------------------------------ */

function ensureSeedPlans() {
  if (db.all('plans').length) return;
  db.insert('plans', { name: 'Basic', maxSites: 1, maxDatabases: 1, diskMB: 1024 });
  db.insert('plans', { name: 'Pro', maxSites: 10, maxDatabases: 10, diskMB: 10240 });
  db.insert('plans', { name: 'Unlimited', maxSites: -1, maxDatabases: -1, diskMB: -1 });
}

function ensureAdmin() {
  const admin = db.findOne('users', (u) => u.role === 'admin');
  if (admin) return;
  /* base64url rather than base64: no + / = to strip, so the length is exactly
   * what we ask for. The old version stripped those characters *after* asking
   * for 12 and could hand out a 9-character admin password. */
  const password = crypto.randomBytes(12).toString('base64url').slice(0, 16);
  db.insert('users', {
    username: 'admin',
    passwordHash: bcrypt.hashSync(password, 10),
    role: 'admin',
    planId: null
  });
  const credFile = path.join(config.dataDir, 'ADMIN_CREDENTIALS.txt');
  fs.writeFileSync(
    credFile,
    `letzControl admin credentials\n=============================\nusername: admin\npassword: ${password}\n\nDelete this file after logging in and change the password!\n`,
    { mode: 0o600 }
  );
  console.log('============================================================');
  console.log('[letzControl] Admin account created');
  console.log(`[letzControl]   username: admin`);
  console.log(`[letzControl]   password: ${password}`);
  console.log(`[letzControl]   (also saved to ${credFile})`);
  console.log('============================================================');
}

/* ------------------------------------------------------------------ */
/* Plan limit enforcement (used by sites.js & databases.js)            */
/* ------------------------------------------------------------------ */

function checkLimit(user, resource) {
  if (user.role === 'admin') return { ok: true };
  const plan = db.get('plans', user.planId);
  if (!plan) return { ok: false, error: 'Your account has no plan assigned. Contact the administrator.' };
  const key = resource === 'sites' ? 'maxSites' : 'maxDatabases';
  const max = plan[key];
  if (max === -1) return { ok: true };
  const count = db.find(resource, (r) => r.ownerId === user.id).length;
  if (count >= max) {
    return { ok: false, error: `Plan "${plan.name}" allows at most ${max} ${resource}. Upgrade your plan.` };
  }
  return { ok: true };
}

function usageFor(user) {
  const plan = db.get('plans', user.planId);
  return {
    plan: plan ? { id: plan.id, name: plan.name, maxSites: plan.maxSites, maxDatabases: plan.maxDatabases, diskMB: plan.diskMB } : null,
    sites: db.find('sites', (s) => s.ownerId === user.id).length,
    databases: db.find('databases', (d) => d.ownerId === user.id).length
  };
}

/* ------------------------------------------------------------------ */
/* Plan CRUD (admin)                                                   */
/* ------------------------------------------------------------------ */

router.get('/plans', requireAdmin, (_req, res) => res.json({ plans: db.all('plans') }));

router.post('/plans', requireAdmin, (req, res) => {
  const { name, maxSites = 1, maxDatabases = 1, diskMB = 1024 } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Plan name required' });
  const num = (v) => Math.max(-1, parseInt(v, 10) || 0);
  const plan = db.insert('plans', {
    name: String(name).trim(),
    maxSites: num(maxSites),
    maxDatabases: num(maxDatabases),
    diskMB: num(diskMB)
  });
  res.status(201).json({ plan });
});

router.put('/plans/:id', requireAdmin, (req, res) => {
  const plan = db.get('plans', req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  const { name, maxSites, maxDatabases, diskMB } = req.body || {};
  const num = (v, old) => (v === undefined ? old : Math.max(-1, parseInt(v, 10) || 0));
  db.update('plans', plan.id, {
    name: name !== undefined ? String(name).trim() : plan.name,
    maxSites: num(maxSites, plan.maxSites),
    maxDatabases: num(maxDatabases, plan.maxDatabases),
    diskMB: num(diskMB, plan.diskMB)
  });
  res.json({ plan: db.get('plans', plan.id) });
});

router.delete('/plans/:id', requireAdmin, (req, res) => {
  const inUse = db.findOne('users', (u) => u.planId === req.params.id);
  if (inUse) return res.status(400).json({ error: `Plan is still assigned to user "${inUse.username}"` });
  if (!db.remove('plans', req.params.id)) return res.status(404).json({ error: 'Plan not found' });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* User CRUD (admin)                                                   */
/* ------------------------------------------------------------------ */

router.get('/', requireAdmin, (_req, res) => {
  res.json({
    users: db.all('users').map((u) => ({ ...publicUser(u), usage: usageFor(u) }))
  });
});

router.post('/', requireAdmin, async (req, res) => {
  const { username, password, planId, role = 'user' } = req.body || {};
  const uname = String(username || '').toLowerCase().trim();
  if (!USERNAME_RE.test(uname)) {
    return res.status(400).json({ error: 'Username must be 3-32 chars: a-z, 0-9, -, _ (start with a letter)' });
  }
  if (db.findOne('users', (u) => u.username === uname)) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  if (String(password || '').length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (planId && !db.get('plans', planId)) return res.status(400).json({ error: 'Unknown plan' });

  const user = db.insert('users', {
    username: uname,
    passwordHash: await bcrypt.hash(String(password), 10),
    role: role === 'admin' ? 'admin' : 'user',
    planId: planId || null
  });
  res.status(201).json({ user: publicUser(user) });
});

router.put('/:id', requireAdmin, async (req, res) => {
  const user = db.get('users', req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password, planId, role } = req.body || {};
  const patch = {};
  if (password) {
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    patch.passwordHash = await bcrypt.hash(String(password), 10);
  }
  if (planId !== undefined) {
    if (planId && !db.get('plans', planId)) return res.status(400).json({ error: 'Unknown plan' });
    patch.planId = planId || null;
  }
  if (role !== undefined) {
    if (user.username === 'admin' && role !== 'admin') {
      return res.status(400).json({ error: 'Cannot demote the built-in admin' });
    }
    patch.role = role === 'admin' ? 'admin' : 'user';
  }
  db.update('users', user.id, patch);
  res.json({ user: publicUser(db.get('users', user.id)) });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const user = db.get('users', req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  if (user.username === 'admin') return res.status(400).json({ error: 'Cannot delete the built-in admin' });

  const ownedSites = db.find('sites', (s) => s.ownerId === user.id).length;
  const ownedDbs = db.find('databases', (d) => d.ownerId === user.id).length;
  if (ownedSites || ownedDbs) {
    return res.status(400).json({
      error: `User still owns ${ownedSites} site(s) and ${ownedDbs} database(s). Reassign or delete them first.`
    });
  }
  db.remove('users', user.id);
  /* Per-account preferences (page size, dashboard layout, ...) are keyed by
   * user id, so removing the user has to remove them too - otherwise every
   * deleted account leaves a small orphan behind in the JSON database. */
  if (db.data.meta && db.data.meta.settings) {
    delete db.data.meta.settings[user.id];
  }
  db.save();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Own usage (any authenticated user)                                  */
/* ------------------------------------------------------------------ */

router.get('/me/usage', (req, res) => {
  res.json({ usage: usageFor(req.user), admin: req.user.role === 'admin' });
});

/* ------------------------------------------------------------------ */
/* Scoped dashboard for a hosting customer                             */
/* ------------------------------------------------------------------ */

/* Disk usage is a `du` over the customer's own docroots, which is far too
 * slow to run on every dashboard load - one 600 MB uploads folder is a
 * noticeable pause. Cache it briefly so a page reload does not re-walk the
 * disk, and so a customer cannot use dashboard refreshes to pin the CPU. */
const diskCache = new Map();
const DISK_TTL = 60_000;

async function diskUsageMb(user) {
  const hit = diskCache.get(user.id);
  if (hit && Date.now() - hit.at < DISK_TTL) return hit.mb;

  const dirs = db.find('sites', (s) => s.ownerId === user.id)
    .map((s) => s.docroot)
    .filter(Boolean);
  if (!dirs.length) {
    diskCache.set(user.id, { at: Date.now(), mb: 0 });
    return 0;
  }
  /* One du for all of them. The paths come from the panel's own site records,
   * but quote them anyway - a docroot is a path on disk and never goes near a
   * shell unquoted. */
  const cmd = 'du -sm -- ' + dirs.map((d) => `'${String(d).replace(/'/g, `'\\''`)}'`).join(' ');
  const r = await run(`${cmd} 2>/dev/null | awk '{s+=$1} END {print s+0}'`);
  const mb = r.ok ? Math.max(0, parseInt((r.stdout || '0').trim(), 10) || 0) : 0;
  diskCache.set(user.id, { at: Date.now(), mb });
  return mb;
}

/**
 * Everything the customer dashboard needs, scoped to the caller.
 *
 * Deliberately built from their OWN records rather than from host metrics: the
 * admin dashboard reads CPU, memory, kernel, IP and services, none of which a
 * customer has any business seeing. Only the plan limits and the customer's
 * own sites/databases come back here, and docroot paths are stripped - the
 * customer needs their domain, not the server's directory layout.
 */
router.get('/me/dashboard', async (req, res) => {
  try {
    const user = req.user;
    const plan = db.get('plans', user.planId);
    const sites = db.find('sites', (s) => s.ownerId === user.id);
    const dbs = db.find('databases', (d) => d.ownerId === user.id);
    res.json({
      user: { username: user.username, role: user.role },
      plan: plan
        ? { name: plan.name, maxSites: plan.maxSites, maxDatabases: plan.maxDatabases, diskMB: plan.diskMB }
        : null,
      usage: {
        sites: sites.length,
        databases: dbs.length,
        diskMB: await diskUsageMb(user)
      },
      sites: sites.map((s) => ({
        id: s.id,
        domain: s.domain,
        backend: s.backend,
        ssl: !!s.ssl,
        www: !!s.www,
        createdAt: s.createdAt || null
      })),
      databases: dbs.map((d) => ({
        id: d.id,
        name: d.name,
        host: d.host || '',
        createdAt: d.createdAt || null
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, ensureSeedPlans, ensureAdmin, checkLimit };
