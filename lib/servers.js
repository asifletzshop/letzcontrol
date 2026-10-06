'use strict';
/** Web server manager: detect the installed HTTP servers (Nginx, Apache,
 *  OpenLiteSpeed), start/stop/enable/disable them, safely edit their main
 *  config (backup -> write -> validate -> reload, automatic rollback when
 *  validation fails) and uninstall them. Admin-only - these front every site.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { run } = require('./exec');
const { requireAdmin } = require('./auth');
const config = require('../config');
const { COMPONENTS } = require('./setup');

const router = express.Router();
router.use(requireAdmin);

const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const MAX_CFG = 2 * 1024 * 1024;

const SERVERS = {
  nginx: {
    name: 'Nginx',
    unit: 'nginx',
    pkg: 'nginx',
    config: '/etc/nginx/nginx.conf',
    test: 'nginx -t',
    reload: 'systemctl reload nginx',
    ports: '80, 443 · front for Apache 8080, OpenLiteSpeed 8088, webmail 2088, phpMyAdmin 2089',
    desc: 'Entry point for every website: SSL termination, static files and reverse proxying. Uninstalling it makes all sites unreachable over HTTP(S).'
  },
  apache: {
    name: 'Apache',
    unit: 'apache2',
    pkg: 'apache2',
    config: '/etc/apache2/apache2.conf',
    test: 'apache2ctl configtest',
    reload: 'systemctl reload apache2',
    ports: '8080 (backend)',
    desc: 'Backend HTTP server for sites whose backend is Apache; serves PHP through PHP-FPM.'
  },
  openlitespeed: {
    name: 'OpenLiteSpeed',
    unit: 'lshttpd',
    pkg: 'openlitespeed',
    config: path.join(config.openlitespeed.root, 'conf', 'httpd_config.conf'),
    test: `${path.join(config.openlitespeed.root, 'bin', 'lshttpd')} -t`,
    reload: `systemctl reload lshttpd 2>/dev/null || ${path.join(config.openlitespeed.root, 'bin', 'lswsctrl')} restart || true`,
    ports: '8088 (backend) · 7080 (admin console)',
    desc: 'LiteSpeed backend with the LSCache page cache, for sites whose backend is OpenLiteSpeed.'
  }
};

/* systemctl prints nothing for a unit that does not exist - treat empty as
 * "unknown" rather than lying about the state. */
async function unitState(unit) {
  const [a, e] = await Promise.all([
    run(`systemctl is-active ${unit} 2>/dev/null`),
    run(`systemctl is-enabled ${unit} 2>/dev/null`)
  ]);
  return {
    active: a.stdout.trim() === 'active',
    activeState: a.stdout.trim() || 'unknown',
    enabled: e.stdout.trim() === 'enabled',
    enabledState: e.stdout.trim() || 'unknown'
  };
}

router.get('/', async (_req, res) => {
  const out = await Promise.all(Object.entries(SERVERS).map(async ([id, s]) => {
    const [det, st, size] = await Promise.all([
      COMPONENTS[id].detect().catch(() => ({ installed: false, version: '' })),
      unitState(s.unit),
      run(`stat -c%s ${shq(s.config)} 2>/dev/null`)
    ]);
    return {
      id,
      name: s.name,
      desc: s.desc,
      ports: s.ports,
      config: s.config,
      installed: !!det.installed,
      version: det.version || '',
      active: st.active,
      activeState: st.activeState,
      enabled: st.enabled,
      enabledState: st.enabledState,
      configSize: size.ok ? parseInt(size.stdout.trim(), 10) || 0 : null
    };
  }));
  res.json({ servers: out });
});

const ACTIONS = new Set(['start', 'stop', 'restart', 'reload', 'enable', 'disable']);

router.post('/:id/action', async (req, res) => {
  const s = SERVERS[req.params.id];
  if (!s) return res.status(404).json({ error: 'Unknown web server' });
  const action = String((req.body || {}).action || '');
  if (!ACTIONS.has(action)) return res.status(400).json({ error: 'Invalid action' });
  const r = await run(`systemctl ${action} ${s.unit}`);
  res.json({ ok: r.ok, output: (r.stdout + r.stderr).trim() });
});

/* -------------------------- config editing -------------------------- */

router.get('/:id/config', async (req, res) => {
  const s = SERVERS[req.params.id];
  if (!s) return res.status(404).json({ error: 'Unknown web server' });
  try {
    const st = fs.statSync(s.config);
    if (st.size > MAX_CFG) return res.status(413).json({ error: 'Config larger than 2 MB' });
    res.json({ path: s.config, content: fs.readFileSync(s.config, 'utf8'), size: st.size, mtime: st.mtimeMs });
  } catch (e) {
    res.status(404).json({ error: `Cannot read ${s.config}: ${e.message}` });
  }
});

/** Save -> validate -> reload. A failed validation restores the previous
 *  config so a typo can never leave the server down. */
router.put('/:id/config', async (req, res) => {
  const s = SERVERS[req.params.id];
  if (!s) return res.status(404).json({ error: 'Unknown web server' });
  const content = String((req.body || {}).content ?? '');
  if (!content.trim()) return res.status(400).json({ error: 'Config cannot be empty' });
  if (content.length > MAX_CFG) return res.status(413).json({ error: 'Config larger than 2 MB' });
  let original;
  try {
    original = fs.readFileSync(s.config, 'utf8');
  } catch (e) {
    return res.status(404).json({ error: `Cannot read ${s.config}: ${e.message}` });
  }

  const bak = `${s.config}.letzcontrol.bak`;
  try {
    fs.writeFileSync(bak, original);
    fs.writeFileSync(s.config, content);
  } catch (e) {
    return res.status(500).json({ error: `Write failed: ${e.message}` });
  }

  let tested = false;
  let output = '';
  if (s.test) {
    const t = await run(`${s.test} 2>&1`);
    output = (t.stdout + t.stderr).trim();
    /* A binary that does not understand the test flag prints its usage -
     * that is "test unavailable", not a bad config. */
    const unsupported = !t.ok && /usage:|invalid option|unrecognized|unknown option|not supported/i.test(output);
    if (!t.ok && !unsupported) {
      fs.writeFileSync(s.config, original);
      return res.status(400).json({
        error: 'Configuration test failed - the previous config was restored',
        output
      });
    }
    tested = !unsupported;
  }

  let reloaded = false;
  const st = await unitState(s.unit);
  if (st.active) {
    const r = await run(`${s.reload} 2>&1`);
    reloaded = r.ok;
    if (!r.ok) output = `${output}\n${(r.stdout + r.stderr).trim()}`.trim();
  }
  res.json({ ok: true, tested, reloaded, output, backup: bak });
});

/* ----------------------------- uninstall ----------------------------- */

router.post('/:id/uninstall', async (req, res) => {
  const s = SERVERS[req.params.id];
  if (!s) return res.status(404).json({ error: 'Unknown web server' });
  if (String((req.body || {}).confirm || '') !== req.params.id) {
    return res.status(400).json({ error: `Type "${req.params.id}" to confirm the uninstall` });
  }
  const steps = [
    `systemctl stop ${s.unit} 2>/dev/null || true`,
    `systemctl disable ${s.unit} 2>/dev/null || true`,
    `DEBIAN_FRONTEND=noninteractive apt-get remove --purge -y ${s.pkg}`
  ];
  const log = [];
  let ok = true;
  for (const cmd of steps) {
    const r = await run(cmd, { timeout: 300_000 });
    log.push(`$ ${cmd}\n${(r.stdout + r.stderr).trim()}`);
    if (!r.ok) ok = false;
  }
  const det = await COMPONENTS[req.params.id].detect().catch(() => ({ installed: false }));
  res.json({ ok: ok && !det.installed, installed: !!det.installed, output: log.join('\n\n') });
});

module.exports = { router };
