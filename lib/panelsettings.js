'use strict';
/**
 * Panel reachability and server clock.
 *
 * Three jobs that all change how the panel itself is reached or how the box
 * thinks about time. They live together because they interact: the panel
 * domain is an Nginx vhost that proxies to the panel PORT, so changing one
 * has to rewrite the other, and a bad port change locks you out of the panel
 * entirely - which is why that one is guarded so carefully.
 *
 *   1. Panel domain - an Nginx vhost (optional Let's Encrypt SSL) that serves
 *      the panel at a real hostname instead of http://1.2.3.4:2087.
 *   2. Panel port   - the port the panel listens on. Validated, firewalled and
 *      applied with a self-reverting watchdog so a typo cannot lose the panel.
 *   3. Server clock - the system timezone, plus NTP on/off and sync status.
 */
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const net = require('net');
const dns = require('dns').promises;
const config = require('../config');
const db = require('./db');
const { requireAdmin } = require('./auth');
const { run } = require('./exec');

const router = express.Router();

const VHOST_NAME = 'letzcontrol-panel.conf';
const MAX_BODY = '512m';

/* Ports this panel's own stack already owns. Changing the panel onto one of
 * these would collide the moment the matching service came up, so they are
 * refused even when nothing is listening right now. */
const RESERVED_PORTS = new Set([
  20, 21, 22, 23, 25, 53, 80, 110, 111, 143, 443, 465, 587, 993, 995, 3306,
  8080, 8088, 2088, 2089, 3001
]);

/* ------------------------------ validation ----------------------------- */

const fail = (msg) => ({ error: msg });

/** A real hostname: labels of letters/digits/hyphens, no bare or trailing dot. */
function validDomain(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return fail('Enter a domain name');
  if (v.length > 253) return fail('That domain name is too long');
  if (!/^[a-z0-9.-]+$/.test(v)) return fail('A domain name may only contain letters, digits, dots and hyphens');
  if (v.includes('..')) return fail('That domain name has an empty part');
  if (v.startsWith('.') || v.endsWith('.')) return fail('A domain name cannot start or end with a dot');
  const labels = v.split('.');
  if (labels.length < 2) return fail('Use a full domain name, for example panel.example.com');
  if (labels.some((l) => !l.length || l.length > 63)) return fail('One of the parts of that domain name is empty or too long');
  if (labels.some((l) => l.startsWith('-') || l.endsWith('-'))) return fail('A part of that domain name cannot start or end with a hyphen');
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,}$/.test(tld)) return fail('That does not look like a domain name - the last part must be letters');
  return { value: v };
}

/* ----------------------------- panel domain ---------------------------- */

const panelPaths = () => ({
  avail: path.join(config.nginx.confDir, 'sites-available', VHOST_NAME),
  enabled: path.join(config.nginx.confDir, 'sites-enabled', VHOST_NAME)
});

const metaPanel = () => {
  const store = db.data.meta.panel || (db.data.meta.panel = {});
  return store;
};

/** Cert on disk wins over the stored flag, so a deleted cert cannot leave a
 *  vhost pointing at files that are not there any more. */
function panelHasCert(domain) {
  const dir = path.join('/etc/letsencrypt/live', domain);
  return fs.existsSync(path.join(dir, 'fullchain.pem')) && fs.existsSync(path.join(dir, 'privkey.pem'));
}

const panelSslActive = (domain) => !!(metaPanel().ssl) && !!domain && panelHasCert(domain);

/** The vhost is generated here rather than by sites.js, so it must not be
 *  named after a domain - otherwise deleting a site of the same name would
 *  take the panel's own entry point with it. */
function panelVhost(domain, ssl, port) {
  const head = `    server_name ${domain};
    client_max_body_size ${MAX_BODY};

    access_log /var/log/nginx/letzcontrol-panel_access.log;
    error_log  /var/log/nginx/letzcontrol-panel_error.log;
`;
  /* Socket.IO drives the terminal and live stats, so the upgrade headers are
   * not optional - without them websockets fall back to polling and the
   * terminal hangs. */
  const pass = `        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        # The panel runs apt jobs and site operations that legitimately take
        # minutes (PHP installs, certbot). Nginx must outwait them, otherwise
        # the browser reports a gateway timeout on work that is still running.
        proxy_read_timeout 900s;
        proxy_send_timeout 900s;
`;
  const acme = `    location ^~ /.well-known/acme-challenge/ {
        root ${config.sitesRoot}/letzcontrol-panel;
        default_type text/plain;
    }

`;
  if (ssl) {
    return `# letzControl PANEL (${domain}, SSL) - generated, edit config.json instead
server {
    listen 80;
${head}
${acme}    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
${head}    ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

${denyDotfiles()}    location / {
${pass}    }
}
`;
  }
  return `# letzControl PANEL (${domain}) - generated, edit config.json instead
server {
    listen 80;
${head}
${acme}${denyDotfiles()}    location / {
${pass}    }
}
`;
}

function denyDotfiles() {
  return `    location ~ /\\. {
        deny all;
    }

`;
}

async function writePanelVhost(domain, ssl, port) {
  const p = panelPaths();
  await fsp.mkdir(path.dirname(p.avail), { recursive: true });
  await fsp.mkdir(path.join(config.sitesRoot, 'letzcontrol-panel'), { recursive: true });
  await fsp.writeFile(p.avail, panelVhost(domain, ssl, port));
  await fsp.rm(p.enabled, { force: true });
  await fsp.symlink(p.avail, p.enabled);
}

/** nginx -t then reload; a bad config must never take the front server down. */
async function applyNginx() {
  const t = await run('nginx -t');
  if (!t.ok) throw new Error(`nginx rejected the config: ${(t.stdout + t.stderr).trim()}`);
  const r = await run('systemctl reload nginx');
  return (r.stdout + r.stderr).trim() || 'reloaded';
}

/** Does this domain already point at this box? Certbot fails without it, so
 *  check first and say something useful instead of returning a raw error. */
async function resolvesHere(domain) {
  let addrs = [];
  try {
    const a = await dns.resolve4(domain);
    addrs = a;
  } catch {
    return { ok: false, addrs: [], reason: 'no A record found for that name' };
  }
  const local = new Set([...Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4').map((i) => i.address)]);
  const hit = addrs.find((ip) => local.has(ip));
  if (hit) return { ok: true, addrs, matched: hit };
  if (config.publicIp && addrs.includes(config.publicIp)) return { ok: true, addrs, matched: config.publicIp };
  return { ok: false, addrs, reason: `points at ${addrs.join(', ')}, which is not this server` };
}

/* ------------------------------ port change ---------------------------- */

/** Is anything already listening on this port? Uses the same 0.0.0.0 bind the
 *  panel itself will attempt, so a hit here is a guaranteed collision. */
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, config.host);
  });
}

function writePort(port) {
  const file = path.join(__dirname, '..', 'config.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cur = {}; }
  /* Remember the port that was working so server.js can undo a change that
   * turns out to be impossible (its EADDRINUSE handler reads this). That is
   * the fast path back; the watchdog below is the backup if this never runs. */
  try {
    fs.writeFileSync(path.join(config.dataDir, 'last-good-port'), String(cur.port || config.port));
  } catch { /* non-fatal */ }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...cur, port }, null, 2));
  fs.renameSync(tmp, file);
}

/** Open the new port and close the old one in whatever firewall is running.
 *  Neither is fatal: on a box with no firewall this is a no-op. */
async function moveFirewall(oldPort, newPort) {
  const out = [];
  if (await run('command -v ufw').then((r) => r.ok)) {
    await run(`ufw allow ${newPort}/tcp`);
    if (oldPort && oldPort !== newPort) await run(`ufw delete allow ${oldPort}/tcp`);
    out.push(`ufw: opened ${newPort}`);
  }
  if (await run('command -v firewall-cmd').then((r) => r.ok)) {
    await run(`firewall-cmd --permanent --add-port=${newPort}/tcp`);
    if (oldPort && oldPort !== newPort) await run(`firewall-cmd --permanent --remove-port=${oldPort}/tcp`);
    await run('firewall-cmd --reload');
    out.push(`firewalld: opened ${newPort}`);
  }
  if (!out.length) out.push('no firewall on this server - nothing to open');
  return out;
}

/**
 * A port change that goes wrong locks the operator out of the only tool that
 * could fix it. So arm a watchdog OUTSIDE the panel's own process tree: if the
 * panel is not answering on the new port shortly after the restart, put the
 * old port back and restart again.
 *
 * systemd-run --unit=... is used rather than a detached child because systemd
 * kills the whole control group on `systemctl restart`, which would take any
 * in-process watchdog with it.
 */
function armRollback(oldPort, newPort) {
  const script = path.join(config.dataDir, 'port-rollback.sh');
  const body = `#!/bin/sh
# Written by letzControl when the panel port was changed ${newPort}.
# If the panel never answers on ${newPort}, put ${oldPort} back.
sleep 35
if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:${newPort}/api/health"; then
  rm -f "$0"
  exit 0
fi
CFG="$(dirname "$0")/../config.json"
[ -f "$CFG" ] || exit 1
sed -i 's/"port": *[0-9]*/"port": ${oldPort}/' "$CFG"
systemctl restart letzcontrol
rm -f "$0"
`;
  fs.writeFileSync(script, body, { mode: 0o700 });
  return run(
    `systemd-run --unit=letzcontrol-port-rollback --on-active=25 --collect /bin/sh ${script}`
  ).then(() => script);
}

/* -------------------------------- routes ------------------------------- */

router.get('/panel', requireAdmin, async (_req, res) => {
  const p = metaPanel();
  const domain = p.domain || '';
  const paths = panelPaths();
  /* Live DNS is worth reporting: the most common reason a panel domain "does
   * nothing" is that the A record still points at the old server. */
  const dnsCheck = domain ? await resolvesHere(domain) : null;
  res.json({
    port: config.port,
    host: config.host,
    domain,
    ssl: panelSslActive(domain),
    sslRequested: !!p.ssl,
    vhostWritten: domain ? fs.existsSync(paths.avail) && fs.existsSync(paths.enabled) : false,
    certOnDisk: domain ? panelHasCert(domain) : false,
    dnsHint: dnsCheck
      ? (dnsCheck.ok ? `yes - ${dnsCheck.matched}` : `no - ${dnsCheck.reason}`)
      : 'checked when you save',
    firewall: await run('command -v ufw').then((r) => r.ok)
      ? 'ufw'
      : (await run('command -v firewall-cmd').then((r) => r.ok) ? 'firewalld' : 'none'),
    // A hostname only helps if it is not already a site in this panel, and not
    // something the websites module will happily overwrite.
    conflicts: db.all('sites').filter((s) => s.domain === domain).map((s) => s.domain)
  });
});

/** Add or change the panel's own domain. */
router.post('/panel/domain', requireAdmin, async (req, res) => {
  const v = validDomain(req.body?.domain);
  if (v.error) return res.status(400).json({ error: v.error });

  const domain = v.value;
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(domain)) {
    const clash = db.all('sites').find((s) => s.domain === domain);
    if (clash) {
      return res.status(400).json({ error: `${domain} is already a website in this panel. Remove that site first.` });
    }
  }
  if (domain === 'localhost') return res.status(400).json({ error: 'Use a real domain name, not localhost' });

  const dnsCheck = await resolvesHere(domain);
  /* Let the operator continue anyway (a split-horizon name that only resolves
   * internally is legitimate), but make the consequence explicit. */
  if (!dnsCheck.ok && req.body?.force !== true) {
    return res.status(400).json({
      error: `${domain} ${dnsCheck.reason}. An SSL certificate cannot be issued until it points here.`,
      needsForce: true
    });
  }

  const wantSsl = req.body?.ssl === true || req.body?.ssl === 'true';
  const prev = { ...metaPanel() };
  const paths = panelPaths();

  try {
    metaPanel().domain = domain;
    metaPanel().ssl = wantSsl && panelHasCert(domain);
    db.save();
    await writePanelVhost(domain, metaPanel().ssl, config.port);
    const nginx = await applyNginx();
    res.json({ ok: true, domain, ssl: metaPanel().ssl, dns: dnsCheck, nginx });
  } catch (e) {
    /* Never leave the stored domain pointing at a vhost that is not there. */
    Object.assign(db.data.meta.panel, prev);
    db.save();
    await fsp.rm(paths.enabled, { force: true }).catch(() => {});
    await fsp.rm(paths.avail, { force: true }).catch(() => {});
    await run('nginx -t').then((t) => (t.ok ? run('systemctl reload nginx') : null));
    res.status(400).json({ error: e.message });
  }
});

/** Issue (or re-issue) Let's Encrypt for the panel domain. */
router.post('/panel/domain/ssl', requireAdmin, async (req, res) => {
  const domain = metaPanel().domain;
  if (!domain) return res.status(400).json({ error: 'Set the panel domain first' });

  const dnsCheck = await resolvesHere(domain);
  if (!dnsCheck.ok) return res.status(400).json({ error: `${domain} ${dnsCheck.reason}` });

  const email = config.certbotEmail
    ? `-m ${config.certbotEmail} --agree-tos`
    : '--register-unsafely-without-email --agree-tos';

  // certonly validates through nginx and never writes config - the panel owns
  // the vhost files and a --nginx "installer" would rewrite them underneath us.
  const r = await run(
    `certbot certonly --nginx -d ${domain} ${email} --cert-name ${domain} --expand --non-interactive`,
    { timeout: 180_000 }
  );
  if (!r.ok) {
    return res.json({ ok: false, output: (r.stdout + r.stderr).trim() });
  }

  // Reload nginx on renewal so a renewed panel cert is actually picked up.
  try {
    const rc = path.join('/etc/letsencrypt/renewal', `${domain}.conf`);
    let conf = await fsp.readFile(rc, 'utf8');
    if (!conf.includes('deploy_hook')) {
      conf = conf.replace('[renewalparams]', '[renewalparams]\ndeploy_hook = systemctl reload nginx');
      await fsp.writeFile(rc, conf);
    }
  } catch { /* nothing to hook yet */ }

  metaPanel().ssl = true;
  db.save();
  await writePanelVhost(domain, true, config.port);
  const nginx = await applyNginx();
  res.json({ ok: true, output: (r.stdout + r.stderr).trim(), nginx });
});

/** Stop serving the panel on a hostname; the IP:port keeps working. */
router.delete('/panel/domain', requireAdmin, async (_req, res) => {
  const paths = panelPaths();
  try {
    await fsp.rm(paths.enabled, { force: true });
    await fsp.rm(paths.avail, { force: true });
    const nginx = await applyNginx();
    db.data.meta.panel = {};
    db.save();
    res.json({ ok: true, nginx });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Which ports are actually taken right now (used to explain a rejection). */
router.get('/panel/ports', requireAdmin, async (_req, res) => {
  const r = await run("ss -tlnH 2>/dev/null | awk '{print $4}' | sed 's/.*://' | sort -un");
  const used = (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean).map(Number);
  res.json({
    port: config.port,
    reserved: [...RESERVED_PORTS].sort((a, b) => a - b),
    used: [...new Set(used)].sort((a, b) => a - b)
  });
});

router.post('/panel/port', requireAdmin, async (req, res) => {
  const raw = req.body?.port;
  const port = Number(raw);
  if (!Number.isInteger(port)) return res.status(400).json({ error: 'The port must be a whole number' });
  if (port < 1024 || port > 65535) {
    return res.status(400).json({ error: 'Use a port between 1024 and 65535 (ports below 1024 need root and are already taken by system services)' });
  }
  if (port === config.port) return res.status(400).json({ error: `The panel is already on port ${port}` });
  if (RESERVED_PORTS.has(port)) {
    return res.status(400).json({ error: `Port ${port} is reserved for the hosting stack (web servers, mail or MySQL)` });
  }
  const taken = await run(`ss -tlnH 2>/dev/null | awk '{print $4}' | sed 's/.*://' | grep -c ':${port}$' || true`);
  if (Number((taken.stdout || '0').trim()) > 0) {
    return res.status(400).json({ error: `Something is already listening on port ${port}` });
  }
  if (!(await portFree(port))) {
    return res.status(400).json({ error: `Port ${port} is not available` });
  }

  const oldPort = config.port;
  let watchdog;
  try {
    watchdog = await armRollback(oldPort, port);
  } catch (e) {
    return res.status(500).json({ error: `Could not arm the safety rollback (${e.message}). Not changing the port.` });
  }

  writePort(port);
  const firewall = await moveFirewall(oldPort, port);

  // The domain vhost proxies to a fixed port, so it has to follow - and nginx
  // must be RELOADED, or it keeps proxying to the old (now dead) port and the
  // domain 502s while the IP:port works fine.
  let domainNote = 'no panel domain configured';
  const domain = metaPanel().domain;
  if (domain) {
    try {
      await writePanelVhost(domain, panelSslActive(domain), port);
      await applyNginx();
      domainNote = `${domain} now proxies to port ${port}`;
    } catch (e) {
      domainNote = `WARNING: could not update the ${domain} vhost (${e.message}) - remove and re-add the domain`;
    }
  }

  res.json({
    ok: true,
    oldPort,
    port,
    firewall,
    domain: domainNote,
    watchdog,
    url: `http://${config.publicIp || 'SERVER_IP'}:${port}`,
    message: `Restarting now. Open ${port} afterwards.`
  });
  // Answer first, then bounce - the connection drops mid-restart otherwise.
  setTimeout(() => run('systemctl restart letzcontrol'), 600);
});

/* ------------------------------ server clock --------------------------- */

let tzCache = null;

/** Every zone the OS knows about, minus the duplicate posix/ and right/
 *  copies, so the picker lists each zone once. */
async function timezones() {
  if (tzCache && Date.now() - tzCache.at < 3600_000) return tzCache.list;
  const root = '/usr/share/zoneinfo';
  const out = [];
  const walk = async (dir, prefix) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'posix' || e.name === 'right' || e.name === 'localtime') continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, rel);
      else if (/\/zone\.(tab|info)$|\/zone1970\.tab$|\/iso3166\.tab$/.test(full) || rel === 'UTC') {
        if (rel === 'UTC') out.push(rel);
      } else if (/^[A-Za-z0-9_+-]+$/.test(e.name) && rel.includes('/')) {
        out.push(rel);
      }
    }
  };
  await walk(root, '');
  const list = [...new Set(out)].sort();
  tzCache = { at: Date.now(), list };
  return list;
}

router.get('/time', requireAdmin, async (_req, res) => {
  const [show, zones] = await Promise.all([
    run('timedatectl show -p Timezone -p NTPSynchronized -p NTP -p LocalRTC'),
    timezones()
  ]);
  /* Parse the labelled form. `timedatectl show --value` prints in systemd's own
   * property order, NOT the order requested - here it returned
   * Timezone/LocalRTC/NTP/NTPSynchronized - so positional parsing silently reads
   * the wrong value into each field (it reported the clock as unsynchronised
   * when it was synchronised). */
  const kv = {};
  for (const line of (show.stdout || '').trim().split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  res.json({
    timezone: kv.Timezone || '',
    // timedatectl maintains the /etc/localtime symlink that the clock, the
    // shell and cron actually follow. /etc/timezone is only the recorded NAME
    // of the zone, but a wrong one misleads whatever does read it - and on this
    // box `timedatectl set-timezone` did not update it. Note PHP does NOT read
    // it: PHP follows its own date.timezone ini setting.
    etcTimezone: (await fsp.readFile('/etc/timezone', 'utf8').catch(() => '')).trim(),
    ntp: kv.NTP === 'yes',
    ntpSynced: kv.NTPSynchronized === 'yes',
    localRtc: kv.LocalRTC === 'yes',
    utc: new Date().toISOString(),
    local: new Date().toString(),
    offsetMinutes: -new Date().getTimezoneOffset(),
    zones: zones.length,
    zoneList: zones
  });
});

router.post('/time', requireAdmin, async (req, res) => {
  const tz = String(req.body?.timezone || '').trim();
  if (!/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(tz)) {
    return res.status(400).json({ error: 'That is not a valid timezone name' });
  }
  // Never trust the name alone - `timedatectl set-timezone` would accept
  // anything and silently fall back, and this string reaches a shell.
  const zoneFile = path.join('/usr/share/zoneinfo', tz);
  if (!fs.existsSync(zoneFile)) {
    return res.status(400).json({ error: `Unknown timezone: ${tz}` });
  }
  const r = await run(`timedatectl set-timezone ${tz}`);
  if (!r.ok) return res.status(400).json({ error: (r.stdout + r.stderr).trim() || 'Could not set the timezone' });

  const etc = (await fsp.readFile('/etc/timezone', 'utf8').catch(() => '')).trim();
  let note = '';
  if (etc !== tz) {
    // Found on a live box: /etc/timezone said Europe/Helsinki while the clock ran
    // on Asia/Kolkata. timedatectl only moves the /etc/localtime symlink, so the
    // recorded name stayed stale and anything reading it disagrees with `date`.
    await fsp.writeFile('/etc/timezone', `${tz}\n`);
    note = `Also corrected /etc/timezone (was "${etc}") so it matches the new zone`;
  }
  res.json({ ok: true, timezone: tz, note });
});

/** Turn NTP on/off. Manual clock setting is deliberately not offered: with
 *  NTP running, hand-setting the time is undone within minutes. */
router.post('/time/ntp', requireAdmin, async (req, res) => {
  const on = req.body?.enabled === true || req.body?.enabled === 'true';
  const r = await run(`timedatectl set-ntp ${on ? 'yes' : 'no'}`);
  if (!r.ok) return res.status(400).json({ error: (r.stdout + r.stderr).trim() || 'Could not change NTP' });
  res.json({ ok: true, enabled: on });
});

/** Nudge the clock into sync now instead of waiting for the next tick. */
router.post('/time/sync', requireAdmin, async (_req, res) => {
  const r = await run('timedatectl set-ntp yes && (chronyc makestep 2>/dev/null || timedatectl timesync-status 2>/dev/null || ntpdate -q 2>/dev/null || systemctl restart systemd-timesyncd 2>/dev/null)', { timeout: 90_000 });
  res.json({ ok: true, output: (r.stdout + r.stderr).trim() });
});

module.exports = { router };
