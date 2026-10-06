#!/usr/bin/env node
'use strict';
/**
 * letzControl - lightweight VPS & hosting control panel.
 * Run as root (it manages system services, vhosts and MySQL).
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');

const config = require('./config');
const db = require('./lib/db');
const auth = require('./lib/auth');
const stats = require('./lib/stats');
const services = require('./lib/services');
const files = require('./lib/files');
const docker = require('./lib/docker');
const sites = require('./lib/sites');
const databases = require('./lib/databases');
const php = require('./lib/php');
const users = require('./lib/users');
const setup = require('./lib/setup');
const dns = require('./lib/dns');
const wordpress = require('./lib/wordpress');
const mail = require('./lib/mail');
const terminal = require('./lib/terminal');
const cron = require('./lib/cron');
const servers = require('./lib/servers');
const addons = require('./lib/addons');
const settings = require('./lib/settings');
const panelsettings = require('./lib/panelsettings');
const updates = require('./lib/updates');

users.ensureSeedPlans();
users.ensureAdmin();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  name: 'letzcontrol.sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  // Read per request so Settings → "Session timeout" takes effect immediately
  // instead of needing a restart.
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: 8 * 60 * 60 * 1000
  }
});
app.use((req, res, next) => {
  const mins = Number(db.data.meta && db.data.meta.sessionMinutes);
  sessionMiddleware(req, res, (err) => {
    if (!err && req.session && req.session.cookie && Number.isFinite(mins) && mins > 0) {
      req.session.cookie.maxAge = mins * 60 * 1000;
    }
    next(err);
  });
});
io.engine.use(sessionMiddleware); // share sessions with Socket.IO

/* ---------------------------- pages ------------------------------ */
app.get('/', (req, res) => {
  if (req.session && req.session.userId) {
    return res.sendFile(path.join(__dirname, 'views', 'index.html'));
  }
  res.redirect('/login.html');
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

/* ---------------------------- API -------------------------------- */
const { requireAuth, requireAdmin } = auth;
app.use('/api/auth', auth.router);
app.use('/api/stats', requireAuth, stats.router);
app.use('/api/services', requireAuth, services.router);
app.use('/api/files', requireAuth, files.router);
app.use('/api/docker', requireAuth, docker.router);
app.use('/api/sites', requireAuth, sites.router);
app.use('/api/databases', requireAuth, databases.router);
app.use('/api/php', requireAuth, php.router);
app.use('/api/users', requireAuth, users.router);
app.use('/api/setup', requireAuth, setup.router);
app.use('/api/dns', requireAuth, dns.router);
app.use('/api/wordpress', requireAuth, wordpress.router);
app.use('/api/mail', requireAuth, mail.router);
app.use('/api/cron', requireAuth, cron.router);
app.use('/api/servers', requireAuth, servers.router);
app.use('/api/addons', requireAuth, addons.router);
app.use('/api/settings', requireAuth, settings.router);
// Panel domain / port / server clock. Admin-only inside the router too, so a
// siteowner reaching this mount still gets 403 rather than a half-answer.
app.use('/api/settings', requireAuth, panelsettings.router);
app.use('/api/updates', requireAuth, updates.router);

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'letzControl' }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));

/* ------------------------- error handler ------------------------- */
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status === 500) console.error('[letzControl]', err);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

/* ------------------------- websockets ---------------------------- */
stats.attach(io);
terminal.attach(io);

/* --------------------------- start ------------------------------- */
// PHP version/extension installs run apt for minutes - the default 5 min
// requestTimeout would cut the response while apt is still working.
server.requestTimeout = 900_000;

/* A port that cannot be bound is the one failure that locks the operator out
 * of the only tool that could fix it, so undo it here rather than waiting for
 * the rollback watchdog. panelsettings records the working port in
 * data/last-good-port before writing a new one; if this boot cannot bind, put
 * that back and exit so systemd restarts us on a port that works. */
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error('[letzControl] server error:', err.message);
    process.exit(1);
  }
  try {
    const marker = path.join(config.dataDir, 'last-good-port');
    const prev = Number(fs.readFileSync(marker, 'utf8').trim());
    if (Number.isInteger(prev) && prev > 0 && prev !== config.port) {
      const file = path.join(__dirname, 'config.json');
      const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...cur, port: prev }, null, 2));
      fs.rmSync(marker, { force: true });
      console.error(
        `[letzControl] port ${config.port} is already in use - reverted to ${prev} and restarting. `
        + 'Pick a different port in Settings.'
      );
      process.exit(1); // systemd brings us straight back up on the working port
    }
  } catch (e) {
    console.error('[letzControl] could not revert the port automatically:', e.message);
  }
  console.error(`[letzControl] port ${config.port} is already in use. Change it in config.json.`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  /* A successful bind means the saved old port is obsolete. Leaving it behind
   * would let some unrelated EADDRINUSE weeks from now silently revert the
   * panel to a port nobody chose any more. */
  try { fs.rmSync(path.join(config.dataDir, 'last-good-port'), { force: true }); } catch { /* fine */ }
  console.log(`[letzControl] panel listening on http://${config.host}:${config.port}`);
  if (process.getuid && process.getuid() !== 0) {
    console.warn('[letzControl] WARNING: not running as root - service/vhost/database management will fail.');
  }
});
