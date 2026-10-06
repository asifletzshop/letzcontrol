'use strict';
/** systemd service manager: list, inspect, start/stop/restart/enable/disable. */
const express = require('express');
const { run } = require('./exec');
const { requireAdmin } = require('./auth');

const router = express.Router();

const ACTIONS = new Set(['start', 'stop', 'restart', 'enable', 'disable', 'reload']);
const NAME_RE = /^[A-Za-z0-9@._:+-]+$/;

function normalizeName(name) {
  const n = String(name || '');
  if (!NAME_RE.test(n)) return null;
  return n.endsWith('.service') ? n : `${n}.service`;
}

router.get('/', async (_req, res) => {
  const r = await run('systemctl list-units --type=service --all --no-legend --no-pager --plain');
  if (!r.ok) return res.status(500).json({ error: r.error || 'systemctl failed' });
  const services = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split(/\s+/);
      const [unit, load, active, sub, ...desc] = parts;
      return { unit, load, active, sub, description: desc.join(' ') };
    })
    .filter((s) => s.unit.endsWith('.service'))
    // Tag the hosting-critical units so the Services view can open on just
    // those instead of all ~140 systemd units, without a second request.
    .map((s) => ({ ...s, key: isKeyUnit(s.unit) }));
  res.json({ services });
});

/* Service details and actions are admin-only; the plain list stays open so
 * the Dashboard health strip works for every panel user. */
/* Key-services summary for the Dashboard: the units that matter for a
 * hosting box, with startup state, including ones not yet installed (so the
 * UI can offer a jump to Addons). Open to all panel users like the list. */
/* Does this unit belong to the key set (the ones a hosting box needs)? */
function isKeyUnit(unit) {
  return KEY_UNITS.some((k) => k.re.test(unit));
}

const KEY_UNITS = [
  { re: /^nginx\.service$/, name: 'Nginx' },
  { re: /^apache2\.service$/, name: 'Apache' },
  { re: /^lshttpd\.service$/, name: 'OpenLiteSpeed' },
  { re: /^(mariadb|mysql)\.service$/, name: 'MariaDB' },
  { re: /^php[\d.]+-fpm\.service$/, name: 'PHP-FPM' },
  { re: /^redis-server\.service$/, name: 'Redis' },
  { re: /^postfix\.service$/, name: 'Postfix' },
  { re: /^dovecot\.service$/, name: 'Dovecot' },
  { re: /^opendkim\.service$/, name: 'OpenDKIM' },
  { re: /^(named|bind9)\.service$/, name: 'BIND9' },
  { re: /^docker\.service$/, name: 'Docker' },
  { re: /^cron\.service$/, name: 'Cron' },
  { re: /^varnish\.service$/, name: 'Varnish' },
  { re: /^vsftpd\.service$/, name: 'vsftpd (FTP)' },
  { re: /^clamav-daemon\.service$/, name: 'ClamAV' },
  { re: /^letzcontrol\.service$/, name: 'letzControl' }
];

router.get('/key', async (_req, res) => {
  const [units, files] = await Promise.all([
    run('systemctl list-units --type=service --all --no-legend --no-pager --plain'),
    run('systemctl list-unit-files --type=service --no-legend --no-pager --plain')
  ]);
  const loaded = new Map();
  for (const l of units.stdout.split('\n')) {
    const p = l.trim().split(/\s+/);
    if (p.length > 3 && p[0].endsWith('.service')) loaded.set(p[0], { active: p[2], sub: p[3], desc: p.slice(4).join(' ') });
  }
  const fileState = new Map();
  for (const l of files.stdout.split('\n')) {
    const p = l.trim().split(/\s+/);
    if (p.length >= 2 && p[0].endsWith('.service')) fileState.set(p[0], p[1]);
  }
  const services = KEY_UNITS.map((k) => {
    let unit = null;
    for (const name of [...loaded.keys(), ...fileState.keys()]) {
      if (k.re.test(name)) { unit = name; break; }
    }
    const u = unit ? loaded.get(unit) : null;
    const found = !!unit;
    return {
      name: k.name,
      unit: unit || k.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.service',
      found,
      active: u ? u.active === 'active' : false,
      state: u ? u.active : 'unknown',
      sub: u ? u.sub : '',
      enabled: unit ? (fileState.get(unit) || '').startsWith('enabled') : false,
      enabledState: unit ? (fileState.get(unit) || 'unknown') : 'not-installed',
      desc: u ? u.desc : ''
    };
  });
  res.json({ services });
});

router.get('/:name', requireAdmin, async (req, res) => {
  const name = normalizeName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid service name' });
  const r = await run(
    `systemctl show ${name} -p Id,Description,ActiveState,SubState,UnitFileState,MainPID,MemoryCurrent,ExecMainStartTimestamp --no-pager`
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  const info = {};
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) info[line.slice(0, i)] = line.slice(i + 1);
  }
  res.json({ service: info });
});

router.post('/:name/action', requireAdmin, async (req, res) => {
  const name = normalizeName(req.params.name);
  const action = String((req.body || {}).action || '');
  if (!name) return res.status(400).json({ error: 'Invalid service name' });
  if (!ACTIONS.has(action)) return res.status(400).json({ error: 'Invalid action' });
  const r = await run(`systemctl ${action} ${name}`);
  res.json({ ok: r.ok, output: (r.stdout + r.stderr).trim() });
});

module.exports = { router };
