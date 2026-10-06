'use strict';
/**
 * Browser terminal over Socket.IO using node-pty + xterm.js.
 * The shell runs with the same privileges as the panel process (usually root).
 */
const { socketAuth } = require('./auth');
const db = require('./db');

let pty = null;
try {
  pty = require('node-pty'); // optional dependency
} catch {
  console.warn('[letzControl] node-pty not available - web terminal disabled');
}

function attach(io) {
  const ns = io.of('/terminal');
  ns.use(socketAuth);
  /* Root shell for admins only - refuse the connection for panel users. */
  ns.use((socket, next) => {
    const sess = socket.request.session;
    const u = sess && db.get('users', sess.userId);
    if (u && u.role === 'admin') return next();
    next(new Error('Admin only'));
  });
  ns.on('connection', (socket) => {
    if (!pty) {
      socket.emit('data', '\r\n[letzControl] node-pty is not installed; terminal disabled.\r\n');
      socket.disconnect(true);
      return;
    }
    const shell = process.env.SHELL || '/bin/bash';
    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.env.HOME || '/',
      env: { ...process.env, TERM: 'xterm-256color' }
    });
    term.onData((d) => socket.emit('data', d));
    socket.on('data', (d) => {
      try { term.write(String(d)); } catch { /* closed */ }
    });
    socket.on('resize', (size) => {
      const cols = Math.min(500, Math.max(10, parseInt(size && size.cols, 10) || 80));
      const rows = Math.min(200, Math.max(5, parseInt(size && size.rows, 10) || 24));
      try { term.resize(cols, rows); } catch { /* closed */ }
    });
    const cleanup = () => { try { term.kill(); } catch { /* already dead */ } };
    socket.on('disconnect', cleanup);
  });
}

module.exports = { attach };
