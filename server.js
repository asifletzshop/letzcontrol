#!/usr/bin/env node
'use strict';
/**
 * letzControl - lightweight VPS & hosting control panel.
 * Run as root (it manages system services, vhosts and MySQL).
 */
const path = require('path');
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
server.listen(config.port, config.host, () => {
  console.log(`[letzControl] panel listening on http://${config.host}:${config.port}`);
  if (process.getuid && process.getuid() !== 0) {
    console.warn('[letzControl] WARNING: not running as root - service/vhost/database management will fail.');
  }
});
