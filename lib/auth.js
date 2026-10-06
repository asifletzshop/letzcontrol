'use strict';
/** Authentication: login/logout/me + middlewares shared by REST and Socket.IO. */
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./db');

const router = express.Router();

/* --- naive login rate limiting: 5 failures -> 60s lockout per IP --- */
const attempts = new Map(); // ip -> { count, lockedUntil }
function isLocked(ip) {
  const a = attempts.get(ip);
  return a && a.lockedUntil && a.lockedUntil > Date.now();
}
function recordFail(ip) {
  const a = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  a.count += 1;
  if (a.count >= 5) {
    a.count = 0;
    a.lockedUntil = Date.now() + 60_000;
  }
  attempts.set(ip, a);
}
function clearFails(ip) { attempts.delete(ip); }

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, planId: u.planId };
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const u = db.get('users', req.session.userId);
  if (!u) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Session no longer valid' });
  }
  req.user = u;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator privileges required' });
  }
  next();
}

/** Socket.IO middleware version of requireAuth */
function socketAuth(socket, next) {
  const sess = socket.request.session;
  if (sess && sess.userId && db.get('users', sess.userId)) return next();
  next(new Error('unauthorized'));
}

router.post('/login', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (isLocked(ip)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in a minute.' });
  }
  const { username, password } = req.body || {};
  const u = db.findOne('users', (x) => x.username === String(username || '').toLowerCase().trim());
  if (!u || !(await bcrypt.compare(String(password || ''), u.passwordHash))) {
    recordFail(ip);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  clearFails(ip);
  req.session.userId = u.id;
  res.json({ user: publicUser(u) });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/password', requireAuth, async (req, res) => {
  const { current, next } = req.body || {};
  if (!(await bcrypt.compare(String(current || ''), req.user.passwordHash))) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  if (String(next || '').length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  db.update('users', req.user.id, { passwordHash: await bcrypt.hash(String(next), 10) });
  res.json({ ok: true });
});

module.exports = { router, requireAuth, requireAdmin, socketAuth, publicUser };
