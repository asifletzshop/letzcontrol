'use strict';
/** Addons: optional stack components (Redis, webmail, antivirus, Docker,
 *  Varnish, cron, Node.js, Perl, FTP, phpMyAdmin, mail, DNS, SSL) with
 *  install, uninstall, service start/stop/enable/disable, nginx-vhost
 *  toggles and config editing. Install/uninstall jobs run through the Setup
 *  Wizard's runner (lib/setup) so there is ONE job, one log and one dpkg
 *  lock across the panel. Admin-only.
 */
const express = require('express');
const fs = require('fs');
const { run } = require('./exec');
const { requireAdmin } = require('./auth');
const { COMPONENTS, runEntries, publicJob } = require('./setup');
const { serverIp } = require('./dns');

const router = express.Router();
router.use(requireAdmin);

const APT = 'DEBIAN_FRONTEND=noninteractive apt-get install -y';
const APT_RM = 'DEBIAN_FRONTEND=noninteractive apt-get remove --purge -y';
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const MAX_CFG = 2 * 1024 * 1024;

const dpkgV = (pkg) => `dpkg-query -W -f '\${Version}' ${pkg} 2>/dev/null`;

const ADDONS = {
  redis: {
    name: 'Redis', icon: '⚡', cat: 'Performance',
    desc: 'In-memory cache, queue backend and WordPress object cache.',
    component: 'redis',
    services: ['redis-server'],
    config: '/etc/redis/redis.conf',
    restart: 'redis-server',
    port: '6379',
    uninstall: [
      'systemctl stop redis-server 2>/dev/null || true',
      'systemctl disable redis-server 2>/dev/null || true',
      `${APT_RM} redis-server`
    ]
  },
  varnish: {
    name: 'Varnish Cache', icon: '📦', cat: 'Performance',
    desc: 'HTTP reverse-proxy cache in front of dynamic sites (listens on 6081). Point a site at it via its nginx proxy config.',
    services: ['varnish'],
    config: '/etc/varnish/default.vcl',
    test: 'varnishd -C -f /etc/varnish/default.vcl -n /tmp/letz-vtest 2>&1',
    restart: 'varnish',
    port: '6081',
    steps: [`${APT} varnish`, 'systemctl enable --now varnish 2>/dev/null || true'],
    async detect() {
      const r = await run('command -v varnishd');
      let ver = (await run(dpkgV('varnish'))).stdout.trim();
      if (!ver) ver = (await run('varnishd -V 2>&1 | head -1')).stdout.match(/(\d+\.\d+[\d.]*)/)?.[1] || '';
      return { installed: r.ok, version: ver };
    },
    uninstall: [
      'systemctl stop varnish 2>/dev/null || true',
      'systemctl disable varnish 2>/dev/null || true',
      `${APT_RM} varnish`
    ]
  },
  webmail: {
    name: 'Roundcube Webmail', icon: '📧', cat: 'Mail',
    desc: 'Browser webmail for the panel mailboxes, on port 2088.',
    component: 'webmail',
    vhost: {
      available: '/etc/nginx/sites-available/webmail.conf',
      enabled: '/etc/nginx/sites-enabled/webmail.conf'
    },
    port: '2088',
    link: (ip) => `http://${ip}:2088/`,
    uninstall: [
      'rm -f /etc/nginx/sites-enabled/webmail.conf /etc/nginx/sites-available/webmail.conf',
      'nginx -t && systemctl reload nginx || true',
      `${APT_RM} roundcube roundcube-core roundcube-mysql roundcube-plugins`,
      'rm -f /etc/letzcontrol/webmail-configured'
    ]
  },
  mail: {
    name: 'Mail server', icon: '📮', cat: 'Mail',
    desc: 'Postfix + Dovecot + OpenDKIM for @your-domain mailboxes (managed in the Mail module).',
    component: 'mail',
    services: ['postfix'],
    extraServices: ['dovecot', 'opendkim'],
    config: '/etc/postfix/main.cf',
    test: 'postfix check 2>&1',
    restart: 'postfix',
    manage: '#/mail',
    uninstall: [
      'systemctl stop postfix dovecot opendkim 2>/dev/null || true',
      'systemctl disable postfix dovecot opendkim 2>/dev/null || true',
      `${APT_RM} postfix postfix-mysql dovecot-imapd dovecot-pop3d dovecot-lmtpd dovecot-mysql opendkim opendkim-tools`,
      'rm -f /etc/letzcontrol/mail-configured',
      'true'
    ],
    warn: 'Mailboxes stay in the database and /var/vmail, but delivery stops until reinstalled.'
  },
  antivirus: {
    name: 'ClamAV Antivirus', icon: '🛡️', cat: 'Security',
    desc: 'Virus scanner daemon with freshclam signature updates for mail and files.',
    services: ['clamav-daemon'],
    extraServices: ['clamav-freshclam'],
    config: '/etc/clamav/clamd.conf',
    restart: 'clamav-daemon',
    steps: [
      `${APT} clamav-daemon clamav-freshclam`,
      'systemctl enable --now clamav-freshclam 2>/dev/null || true',
      'systemctl enable --now clamav-daemon 2>/dev/null || true'
    ],
    async detect() {
      const r = await run('command -v clamscan');
      const v = await run(dpkgV('clamav-daemon'));
      return { installed: r.ok, version: v.stdout.trim() };
    },
    uninstall: [
      'systemctl stop clamav-daemon clamav-freshclam 2>/dev/null || true',
      'systemctl disable clamav-daemon clamav-freshclam 2>/dev/null || true',
      `${APT_RM} clamav-daemon clamav-freshclam clamav-base clamav`
    ]
  },
  certbot: {
    name: 'Certbot (SSL renewals)', icon: '🔒', cat: 'Security',
    desc: "Renews Let's Encrypt certificates automatically. Existing certs stay on disk but stop renewing if removed.",
    component: 'certbot',
    services: [],
    uninstall: [`${APT_RM} certbot python3-certbot-nginx`]
  },
  docker: {
    name: 'Docker', icon: '🐳', cat: 'Containers',
    desc: 'Container engine behind the Docker module.',
    component: 'docker',
    services: ['docker'],
    manage: '#/docker',
    uninstall: [
      'systemctl stop docker 2>/dev/null || true',
      'systemctl disable docker 2>/dev/null || true',
      `${APT_RM} docker.io`
    ],
    warn: 'Existing containers and images are left on disk.'
  },
  cron: {
    name: 'Cron', icon: '⏰', cat: 'Scheduling',
    desc: 'System scheduler behind the Cron Jobs module.',
    services: ['cron'],
    manage: '#/cron',
    steps: [`${APT} cron`, 'systemctl enable --now cron 2>/dev/null || true'],
    async detect() {
      const r = await run('command -v cron || command -v crond');
      const v = await run(dpkgV('cron'));
      return { installed: r.ok, version: v.stdout.trim() };
    },
    uninstall: [
      'systemctl stop cron 2>/dev/null || true',
      'systemctl disable cron 2>/dev/null || true',
      `${APT_RM} cron`
    ],
    warn: 'Panel cron jobs, certbot renewals and any other scheduled tasks will stop running.'
  },
  nodejs: {
    name: 'Node.js', icon: '🟢', cat: 'Runtime',
    desc: 'JavaScript runtime that powers letzControl itself and Node.js apps.',
    component: 'nodejs',
    services: [],
    uninstallable: false,
    note: 'Cannot be uninstalled - the panel runs on it.'
  },
  perl: {
    name: 'Perl', icon: '🐪', cat: 'Runtime',
    desc: 'Perl interpreter used by many system tools and admin scripts.',
    services: [],
    steps: [`${APT} perl`],
    async detect() {
      const r = await run('perl -e \'print $^V\' 2>/dev/null');
      return { installed: r.ok && !!r.stdout, version: r.stdout.trim().replace(/^v/, '') };
    },
    uninstall: [`${APT_RM} perl`],
    warn: 'System packages that depend on Perl may stop working.'
  },
  ftp: {
    name: 'FTP (vsftpd)', icon: '📂', cat: 'Network',
    desc: 'Classic FTP server on port 21 (open passive range 40000-40100 in your firewall for transfers).',
    services: ['vsftpd'],
    config: '/etc/vsftpd.conf',
    restart: 'vsftpd',
    port: '21',
    steps: [`${APT} vsftpd`, 'systemctl enable --now vsftpd 2>/dev/null || true'],
    async detect() {
      const r = await run('command -v vsftpd');
      const v = await run(dpkgV('vsftpd'));
      return { installed: r.ok, version: v.stdout.trim() };
    },
    uninstall: [
      'systemctl stop vsftpd 2>/dev/null || true',
      'systemctl disable vsftpd 2>/dev/null || true',
      `${APT_RM} vsftpd`
    ]
  },
  phpmyadmin: {
    name: 'phpMyAdmin', icon: '🗄️', cat: 'Database',
    desc: 'Web interface for the MySQL databases, on port 2089.',
    component: 'phpmyadmin',
    vhost: {
      available: '/etc/nginx/sites-available/phpmyadmin.conf',
      enabled: '/etc/nginx/sites-enabled/phpmyadmin.conf'
    },
    port: '2089',
    link: (ip) => `http://${ip}:2089/`,
    uninstall: [
      'rm -f /etc/nginx/sites-enabled/phpmyadmin.conf /etc/nginx/sites-available/phpmyadmin.conf',
      'nginx -t && systemctl reload nginx || true',
      'rm -rf /var/www/phpmyadmin',
      'rm -f /etc/letzcontrol/phpmyadmin-version'
    ]
  },
  bind9: {
    name: 'BIND9 (DNS)', icon: '🛰️', cat: 'Network',
    desc: 'Authoritative DNS server for the zones managed in the DNS module.',
    component: 'bind9',
    services: ['named'],
    config: '/etc/bind/named.conf',
    test: 'named-checkconf /etc/bind/named.conf 2>&1',
    restart: 'named',
    manage: '#/dns',
    uninstall: [
      'systemctl stop named 2>/dev/null || systemctl stop bind9 2>/dev/null || true',
      'systemctl disable named 2>/dev/null || systemctl disable bind9 2>/dev/null || true',
      `${APT_RM} bind9 bind9utils`,
      'true'
    ],
    warn: 'DNS resolution for your delegated zones stops; zone files survive on disk but are no longer loaded.'
  }
};

/* ------------------------------- helpers ------------------------------ */

function detectFn(a) {
  return a.detect || (a.component ? COMPONENTS[a.component].detect : null);
}

async function svcState(unit) {
  const [act, en] = await Promise.all([
    run(`systemctl is-active ${unit} 2>/dev/null`),
    run(`systemctl is-enabled ${unit} 2>/dev/null`)
  ]);
  const state = act.stdout.trim();
  if (!state) return null; // unit does not exist on this box
  return {
    unit,
    active: state === 'active',
    state,
    enabled: en.stdout.trim() === 'enabled',
    enabledState: en.stdout.trim() || 'unknown'
  };
}

/* -------------------------------- routes ------------------------------ */

router.get('/', async (_req, res) => {
  const ip = serverIp();
  const out = await Promise.all(Object.entries(ADDONS).map(async ([id, a]) => {
    const det = await (detectFn(a) || (async () => ({ installed: false, version: '' })))()
      .catch(() => ({ installed: false, version: '' }));
    const units = [...(a.services || []), ...(a.extraServices || [])];
    const states = (await Promise.all(units.map(svcState))).filter(Boolean);
    return {
      id,
      name: a.name,
      icon: a.icon,
      cat: a.cat,
      desc: a.desc,
      port: a.port || '',
      installed: !!det.installed,
      version: det.version || '',
      services: states,
      vhostOn: a.vhost ? fs.existsSync(a.vhost.enabled) : null,
      hasConfig: !!(a.config && fs.existsSync(a.config)),
      link: a.link ? (typeof a.link === 'function' ? a.link(ip) : a.link) : '',
      manage: a.manage || '',
      uninstallable: a.uninstallable !== false,
      note: a.note || '',
      warn: a.warn || ''
    };
  }));
  res.json({ addons: out, job: publicJob(), serverIp: ip });
});

router.get('/job', (_req, res) => res.json({ job: publicJob() }));

router.post('/install', (req, res) => {
  if (publicJob().running) return res.status(409).json({ error: 'Another installation or uninstall is already running' });
  const requested = new Set(((req.body || {}).ids || []));
  const entries = [];
  for (const [id, a] of Object.entries(ADDONS)) {
    if (!requested.has(id)) continue;
    const comp = a.component ? COMPONENTS[a.component] : null;
    const steps = a.steps || (comp && comp.steps);
    if (!steps) return res.status(400).json({ error: `${a.name} has no install steps` });
    entries.push({ name: a.name, detect: detectFn(a), steps, post: a.post || (comp && comp.post) });
  }
  if (!entries.length) return res.status(400).json({ error: 'No valid addons selected' });
  runEntries(entries, 'addon install');
  res.json({ ok: true });
});

router.post('/:id/uninstall', (req, res) => {
  const a = ADDONS[req.params.id];
  if (!a) return res.status(404).json({ error: 'Unknown addon' });
  if (a.uninstallable === false) return res.status(400).json({ error: a.note || 'This addon cannot be uninstalled' });
  if (!a.uninstall || !a.uninstall.length) return res.status(400).json({ error: 'No uninstall steps for this addon' });
  if (String((req.body || {}).confirm || '') !== req.params.id) {
    return res.status(400).json({ error: `Type "${req.params.id}" to confirm the uninstall` });
  }
  if (publicJob().running) return res.status(409).json({ error: 'Another installation or uninstall is already running' });
  runEntries([{ name: `${a.name} (uninstall)`, steps: a.uninstall }], 'addon uninstall');
  res.json({ ok: true });
});

const ACTIONS = new Set(['start', 'stop', 'restart', 'reload', 'enable', 'disable']);

router.post('/:id/action', async (req, res) => {
  const a = ADDONS[req.params.id];
  if (!a) return res.status(404).json({ error: 'Unknown addon' });
  const body = req.body || {};
  const action = String(body.action || '');

  /* vhost addons (webmail / phpMyAdmin) toggle their nginx site instead. */
  if (a.vhost && (action === 'enable' || action === 'disable')) {
    if (action === 'enable' && !fs.existsSync(a.vhost.available)) {
      return res.status(404).json({ error: `${a.name} config not found on disk` });
    }
    const before = fs.existsSync(a.vhost.enabled);
    if (action === 'enable') await run(`ln -sfn ${shq(a.vhost.available)} ${shq(a.vhost.enabled)}`);
    else await run(`rm -f ${shq(a.vhost.enabled)}`);
    const t = await run('nginx -t 2>&1');
    if (!t.ok) {
      /* roll the toggle back - nginx must never be left broken */
      if (action === 'enable' && !before) await run(`rm -f ${shq(a.vhost.enabled)}`);
      if (action === 'disable' && before) await run(`ln -sfn ${shq(a.vhost.available)} ${shq(a.vhost.enabled)}`);
      return res.status(400).json({ error: 'nginx rejected the change - it was reverted', output: (t.stdout + t.stderr).trim() });
    }
    const rl = await run('systemctl reload nginx 2>&1');
    return res.json({ ok: rl.ok, on: fs.existsSync(a.vhost.enabled), output: (rl.stdout + rl.stderr).trim() });
  }

  if (ACTIONS.has(action)) {
    const unit = String(body.unit || (a.services || [])[0] || '');
    if (!/^[A-Za-z0-9@._:-]+$/.test(unit)) return res.status(400).json({ error: 'Invalid unit' });
    if (!(a.services || []).includes(unit)) return res.status(403).json({ error: 'That unit is not managed by this addon' });
    const r = await run(`systemctl ${action} ${unit}`);
    return res.json({ ok: r.ok, output: (r.stdout + r.stderr).trim() });
  }
  res.status(400).json({ error: 'Invalid action' });
});

/* --------------------------- config editing --------------------------- */

router.get('/:id/config', async (req, res) => {
  const a = ADDONS[req.params.id];
  if (!a) return res.status(404).json({ error: 'Unknown addon' });
  if (!a.config) return res.status(400).json({ error: `${a.name} has no editable config` });
  try {
    const st = fs.statSync(a.config);
    if (st.size > MAX_CFG) return res.status(413).json({ error: 'Config larger than 2 MB' });
    res.json({ path: a.config, content: fs.readFileSync(a.config, 'utf8'), size: st.size, mtime: st.mtimeMs });
  } catch (e) {
    res.status(404).json({ error: `Cannot read ${a.config}: ${e.message}` });
  }
});

router.put('/:id/config', async (req, res) => {
  const a = ADDONS[req.params.id];
  if (!a) return res.status(404).json({ error: 'Unknown addon' });
  if (!a.config) return res.status(400).json({ error: `${a.name} has no editable config` });
  const content = String((req.body || {}).content ?? '');
  if (!content.trim()) return res.status(400).json({ error: 'Config cannot be empty' });
  if (content.length > MAX_CFG) return res.status(413).json({ error: 'Config larger than 2 MB' });
  let original;
  try {
    original = fs.readFileSync(a.config, 'utf8');
  } catch (e) {
    return res.status(404).json({ error: `Cannot read ${a.config}: ${e.message}` });
  }

  const bak = `${a.config}.letzcontrol.bak`;
  try {
    fs.writeFileSync(bak, original);
    fs.writeFileSync(a.config, content);
  } catch (e) {
    return res.status(500).json({ error: `Write failed: ${e.message}` });
  }

  let tested = false;
  let output = '';
  if (a.test) {
    const t = await run(a.test);
    output = (t.stdout + t.stderr).trim().slice(-4000);
    const unsupported = !t.ok && /usage:|invalid option|unrecognized|unknown option|not supported|command not found/i.test(output);
    if (!t.ok && !unsupported) {
      fs.writeFileSync(a.config, original);
      return res.status(400).json({ error: 'Configuration test failed - the previous config was restored', output });
    }
    tested = !unsupported;
  }

  let restarted = false;
  if (a.restart) {
    const st = await run(`systemctl is-active ${a.restart} 2>/dev/null`);
    if (st.stdout.trim() === 'active') {
      const r = await run(`systemctl restart ${a.restart} 2>&1`);
      restarted = r.ok;
      if (!r.ok) output = `${output}\n${(r.stdout + r.stderr).trim()}`.trim();
    }
  }
  res.json({ ok: true, tested, restarted, output, backup: bak });
});

module.exports = { router };
