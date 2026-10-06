'use strict';
/** Live system statistics via systeminformation, over REST and Socket.IO. */
const express = require('express');
const os = require('os');
const si = require('systeminformation');
const { requireAdmin, socketAuth } = require('./auth');
const db = require('./db');

const router = express.Router();

function firstPublicIp() {
  const ifs = os.networkInterfaces();
  for (const addrs of Object.values(ifs)) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

let staticInfo = null;
async function getStatic() {
  if (!staticInfo) {
    const [osInfo, cpu] = await Promise.all([si.osInfo(), si.cpu()]);
    staticInfo = {
      hostname: osInfo.hostname,
      distro: `${osInfo.distro} ${osInfo.release}`,
      kernel: osInfo.kernel,
      arch: osInfo.arch,
      cpu: `${cpu.manufacturer} ${cpu.brand}`.trim(),
      cores: cpu.cores,
      ip: firstPublicIp()
    };
  }
  return staticInfo;
}

async function collect() {
  const [load, mem, fsSize, net] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.networkStats().catch(() => [])
  ]);
  const up = si.time().uptime;
  const disk = fsSize.find((f) => f.mount === '/') || fsSize[0] || {};
  const rx = (net || []).reduce((a, n) => a + (n.rx_sec || 0), 0);
  const tx = (net || []).reduce((a, n) => a + (n.tx_sec || 0), 0);
  return {
    ts: Date.now(),
    cpu: Math.round(load.currentLoad * 10) / 10,
    loadavg: load.avgLoad,
    memTotal: mem.total,
    memUsed: mem.active,
    memPct: mem.total ? Math.round((mem.active / mem.total) * 1000) / 10 : 0,
    diskTotal: disk.size || 0,
    diskUsed: disk.used || 0,
    diskPct: disk.use || 0,
    swapTotal: mem.swapTotal ?? mem.swaptotal ?? 0,
    swapUsed: mem.swapUsed ?? mem.swapused ?? 0,
    uptime: up,
    rxSec: Math.max(0, rx),
    txSec: Math.max(0, tx)
  };
}

/* Host metrics are administrator-only.
 *
 * These endpoints were open to any signed-in account, so a hosting customer
 * could read the host's hostname, distro, kernel, CPU model, core count and
 * public IP, plus live load/memory/swap. That is infrastructure detail that
 * belongs to the machine owner, not to a customer with one site on it - and
 * publishing it to a stranger is exactly the reconnaissance that makes a
 * targeted follow-up possible. Non-admins get their own dashboard, built from
 * their own sites and databases, which is what they actually came for.
 *
 * The guard is repeated on each route rather than only at the mount in
 * server.js, so the restriction travels with the code instead of depending on
 * how the router happens to be attached. */
router.get('/overview', requireAdmin, async (_req, res) => {
  try {
    res.json({ static: await getStatic(), live: await collect() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/live', requireAdmin, async (_req, res) => {
  try {
    res.json(await collect());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Push live stats to authenticated ADMIN sockets every 2s. The socket used to
 *  broadcast the same host metrics to every signed-in account. */
function attach(io) {
  const ns = io.of('/stats');
  ns.use(socketAuth);
  ns.use((socket, next) => {
    const u = db.get('users', socket.request.session && socket.request.session.userId);
    if (u && u.role === 'admin') return next();
    next(new Error('forbidden'));
  });
  ns.on('connection', (socket) => {
    const tick = async () => {
      try {
        socket.emit('stats', await collect());
      } catch { /* ignore transient errors */ }
    };
    tick();
    const timer = setInterval(tick, 2000);
    socket.on('disconnect', () => clearInterval(timer));
  });
}

module.exports = { router, attach };
