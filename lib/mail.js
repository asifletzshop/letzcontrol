'use strict';
/**
 * Mail manager: virtual mailboxes stored in MariaDB (Postfix/Dovecot read
 * them directly), OpenDKIM key generation and the DNS records a domain
 * needs to send & receive mail through this server.
 */
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const dnsPromises = require('dns').promises;
const mysql = require('mysql2/promise');
const { run } = require('./exec');
const { requireAdmin } = require('./auth');
const config = require('../config');
const db = require('./db');
const dns = require('./dns');

const router = express.Router();

const MAIL_MARKER = '/etc/letzcontrol/mail-configured';
const DKIM_SELECTOR = 'mail';
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i;
const VMAIL_ROOT = '/var/vmail';

const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

router.use(async (_req, res, next) => {
  if (!fs.existsSync(MAIL_MARKER)) {
    return res.status(503).json({ error: 'Mail server is not installed - add it in the Setup Wizard first' });
  }
  next();
});

async function conn() {
  const m = config.mysql;
  const base = { user: m.user, password: m.password, database: 'mailserver' };
  return mysql.createConnection(
    m.socketPath
      ? { ...base, socketPath: m.socketPath }
      : { ...base, host: m.host, port: m.port }
  );
}

/** Admins everything; normal users only their own site's domains. */
function canUseDomain(req, domain) {
  if (req.user.role === 'admin') return true;
  return !!db.findOne('sites', (s) => s.domain === domain && s.ownerId === req.user.id);
}

/** SHA512-CRYPT hash - matches Dovecot's default_password_scheme. */
async function hashPassword(pw) {
  const salt = crypto.randomBytes(9).toString('hex').slice(0, 16);
  const r = await run(`printf %s ${shq(pw)} | openssl passwd -6 -salt ${shq(salt)} -stdin`);
  if (!r.ok || !r.stdout.trim()) throw new Error('Password hashing failed');
  return r.stdout.trim();
}

const dkimPaths = (domain) => {
  const dir = path.join('/etc/opendkim/keys', domain);
  return { dir, key: path.join(dir, `${DKIM_SELECTOR}.private`), pub: path.join(dir, `${DKIM_SELECTOR}.txt`) };
};

/** The mail.txt DKIM file, flattened into one TXT value. */
async function readDkimValue(domain) {
  const p = dkimPaths(domain);
  if (!fs.existsSync(p.pub)) return null;
  const raw = await fsp.readFile(p.pub, 'utf8');
  const joined = [...raw.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
  return joined || null;
}

/** Generate the key (once), wire it into KeyTable/SigningTable, restart. */
async function ensureDkim(domain) {
  const p = dkimPaths(domain);
  if (!fs.existsSync(p.key)) {
    await fsp.mkdir(p.dir, { recursive: true });
    const g = await run(`opendkim-genkey -b 2048 -d ${shq(domain)} -s ${DKIM_SELECTOR} -D ${shq(p.dir)}`);
    if (!g.ok) throw new Error(`DKIM key generation failed: ${g.error}`);
  }
  const keyLine = `${DKIM_SELECTOR}._domainkey.${domain} ${domain}:${DKIM_SELECTOR}:${p.key}`;
  const signLine = `*@${domain} ${DKIM_SELECTOR}._domainkey.${domain}`;
  const r = await run([
    `grep -qF ${shq(keyLine)} /etc/opendkim/KeyTable 2>/dev/null || echo ${shq(keyLine)} >> /etc/opendkim/KeyTable`,
    `grep -qF ${shq(signLine)} /etc/opendkim/SigningTable 2>/dev/null || echo ${shq(signLine)} >> /etc/opendkim/SigningTable`,
    `grep -qF ${shq(domain)} /etc/opendkim/TrustedHosts 2>/dev/null || echo ${shq(domain)} >> /etc/opendkim/TrustedHosts`,
    'chown -R opendkim:opendkim /etc/opendkim',
    'systemctl restart opendkim'
  ].join(' && '));
  if (!r.ok) throw new Error(`OpenDKIM configuration failed: ${r.error}`);
  return readDkimValue(domain);
}

/** Records every mail domain needs here (plus DKIM when available). */
function mailRecords(domain, dkim) {
  const ip = dns.serverIp();
  const recs = [
    { type: 'A', name: 'mail', value: ip, ttl: 3600, note: 'Mail host A record' },
    { type: 'MX', name: '@', value: `mail.${domain}.`, priority: 10, ttl: 3600, note: 'Incoming mail' },
    { type: 'TXT', name: '@', value: `v=spf1 a mx ip4:${ip} -all`, ttl: 3600, note: 'SPF: this server may send for the domain' },
    { type: 'TXT', name: '_dmarc', value: `v=DMARC1; p=none; rua=mailto:postmaster@${domain}`, ttl: 3600, note: 'DMARC policy (create postmaster@ for reports)' }
  ];
  if (dkim) {
    recs.push({ type: 'TXT', name: `${DKIM_SELECTOR}._domainkey`, value: dkim, ttl: 3600, note: 'DKIM signing key' });
  }
  return recs;
}

/* ------------------------------- routes -------------------------------- */

/**
 * The messages waiting to go out.
 *
 * Postfix can print the queue as JSON (-j), which is worth a lot more than
 * parsing the human-readable table. A stuck queue is the single most common
 * mail problem there is - usually a domain whose MX points at a host that
 * does not answer - and it is invisible from the outside until someone
 * notices their mail is not arriving.
 */
async function queue() {
  const r = await run('postqueue -j 2>/dev/null');
  if (!r.ok) return [];
  const out = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      out.push({
        id: m.queue_id,
        size: m.message_size,
        arrivedAt: m.arrival_time ? m.arrival_time * 1000 : null,
        sender: m.sender || '',
        recipients: (m.recipients || []).map((x) => ({
          address: x.address,
          reason: x.delay_reason || ''
        }))
      });
    } catch { /* not json - skip it */ }
  }
  return out;
}

/** How much mail is stored, per domain.
 *
 * One du for all of them, not one per domain: a mailbox with a large
 * uploads folder makes each of those slow enough to notice.
 */
async function storageByDomain(domains) {
  const out = {};
  const dirs = [...new Set(domains)]
    .map((d) => path.join(VMAIL_ROOT, d))
    .filter((d) => fs.existsSync(d));
  if (!dirs.length) return out;
  const r = await run(`du -sb -- ${dirs.map(shq).join(' ')} 2>/dev/null`);
  if (!r.ok) return out;
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^(\d+)\t(.*)$/);
    if (!m) continue;
    out[path.basename(m[2])] = Number(m[1]);
  }
  return out;
}

/**
 * Is mail actually working for this domain?
 *
 * The records a domain needs are easy to write down and easy to get wrong:
 * an MX that points at a host which does not answer, an SPF that does not
 * include this server, a missing DMARC, a DKIM key that was regenerated
 * without the DNS being updated. The panel can check all of it, so it might
 * as well - and the answer is per record, so the operator is told which one
 * to fix rather than being told that mail is broken.
 */
async function readiness(domain) {
  const ip = dns.serverIp();
  const checks = [];

  /* MX: does it point at this server? */
  let mx = [];
  try { mx = await dnsPromises.resolveMx(domain); } catch { /* no MX */ }
  const mxList = [];
  let mxHere = false;
  for (const m of mx) {
    let address = '';
    try { address = (await dnsPromises.resolve4(m.exchange))[0] || ''; } catch { /* no A record */ }
    if (address === ip) mxHere = true;
    mxList.push({ exchange: m.exchange, priority: m.priority, address, here: address === ip });
  }
  checks.push({
    key: 'mx',
    label: 'MX points at this server',
    ok: mxHere,
    detail: mxList.length
      ? (mxHere
        ? mxList.map((m) => `${m.exchange} → ${m.address || 'no address'}`).join(', ')
        : `points at ${mxList.map((m) => `${m.exchange} (${m.address || 'no address'})`).join(', ')} - not this server`)
      : 'no MX record'
  });

  /* SPF: does it permit this server to send? */
  let spf = null;
  try {
    const txt = await dnsPromises.resolveTxt(domain);
    spf = txt.map((t) => t.join('')).find((v) => /^v=spf1/i.test(v)) || null;
  } catch { /* no TXT */ }
  const spfOk = !!spf && (spf.includes(ip) || /\b(mx|a)\b/i.test(spf));
  checks.push({
    key: 'spf',
    label: 'SPF allows this server to send',
    ok: spfOk,
    detail: spf ? spf : 'no SPF record'
  });

  /* DMARC: present at all. */
  let dmarc = null;
  try {
    const txt = await dnsPromises.resolveTxt(`_dmarc.${domain}`);
    dmarc = txt.map((t) => t.join('')).find((v) => /^v=DMARC1/i.test(v)) || null;
  } catch { /* no TXT */ }
  checks.push({
    key: 'dmarc',
    label: 'DMARC policy is published',
    ok: !!dmarc,
    detail: dmarc || 'no DMARC record'
  });

  /* DKIM: published, and the same key the server signs with. */
  const localDkim = await readDkimValue(domain);
  let publishedDkim = null;
  try {
    const txt = await dnsPromises.resolveTxt(`${DKIM_SELECTOR}._domainkey.${domain}`);
    publishedDkim = txt.map((t) => t.join('')).find((v) => /v=DKIM1/i.test(v)) || null;
  } catch { /* no TXT */ }
  checks.push({
    key: 'dkim',
    label: 'DKIM key is published and matches',
    ok: !!(localDkim && publishedDkim && localDkim === publishedDkim),
    detail: !localDkim
      ? 'this server has no DKIM key for the domain yet'
      : (!publishedDkim
        ? 'the key is not published in DNS'
        : (localDkim === publishedDkim
          ? 'published and matches'
          : 'published, but it is not the key this server signs with'))
  });

  return {
    domain,
    ip,
    dkimReady: !!localDkim,
    checks,
    ready: checks.every((c) => c.ok)
  };
}

router.get('/status', async (_req, res) => {
  const active = async (name) => (await run(`systemctl is-active ${name} 2>/dev/null`)).stdout.trim() || 'unknown';
  const webmail = fs.existsSync('/etc/nginx/sites-enabled/webmail.conf');
  const [postfix, dovecot, opendkim, nginx] = await Promise.all([
    active('postfix'), active('dovecot'), active('opendkim'), active('nginx')
  ]);
  const ip = dns.serverIp();
  let mailboxCount = 0;
  try {
    const c = await conn();
    const [rows] = await c.query('SELECT COUNT(*) AS n FROM mailboxes');
    mailboxCount = Number(rows[0].n) || 0;
    await c.end();
  } catch { /* schema may not exist yet */ }
  const q = await queue();
  res.json({
    installed: true,
    services: { postfix, dovecot, opendkim, nginx },
    webmail: webmail
      ? { installed: true, url: `http://${ip}:2088/`, nginx }
      : { installed: false },
    mailboxCount,
    serverIp: ip,
    queue: {
      count: q.length,
      messages: q.slice(0, 20),
      // How long the oldest message has been waiting. A queue that keeps
      // growing is a different problem from one that is about to clear.
      oldestAt: q.length ? Math.min(...q.map((m) => m.arrivedAt || 0)) : null
    }
  });
});

router.get('/mailboxes', async (req, res) => {
  try {
    const domain = String(req.query.domain || '').trim().toLowerCase();
    const c = await conn();
    const [rows] = await c.query('SELECT id, username, domain, created_at FROM mailboxes ORDER BY domain, username');
    await c.end();
    const mine = rows.filter((r) => canUseDomain(req, r.domain) && (!domain || r.domain === domain));
    const storage = await storageByDomain(mine.map((r) => r.domain));
    res.json({
      mailboxes: mine,
      storage,
      domains: [...new Set(mine.map((r) => r.domain))].sort()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Is mail working for this domain? The per-record answer, not a verdict. */
router.get('/readiness/:domain', async (req, res) => {
  const domain = String(req.params.domain || '').toLowerCase();
  if (!DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'Invalid domain' });
  if (!canUseDomain(req, domain)) return res.status(403).json({ error: 'That domain does not belong to you' });
  try {
    res.json(await readiness(domain));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Throw away everything waiting in the queue.
 *
 *  Only useful when the messages are undeliverable - a domain whose MX
 *  points at a host that no longer exists, say. The alternative is waiting
 *  for Postfix's own expiry, which is days. */
router.post('/queue/flush', requireAdmin, async (_req, res) => {
  const before = await queue();
  if (!before.length) return res.json({ ok: true, removed: 0, message: 'The queue was already empty' });
  const r = await run('postsuper -d ALL');
  if (!r.ok) return res.status(500).json({ error: `Could not empty the queue: ${(r.stderr || r.error || '').trim()}` });
  res.json({ ok: true, removed: before.length, message: `${before.length} message(s) removed from the queue` });
});

router.post('/mailboxes', async (req, res) => {
  const b = req.body || {};
  const local = String(b.local || '').trim().toLowerCase();
  const domain = String(b.domain || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!LOCAL_RE.test(local)) return res.status(400).json({ error: 'Local part must be a-z, 0-9, . _ - (max 64, no leading/trailing dot)' });
  if (!DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'Invalid domain' });
  if (!canUseDomain(req, domain)) return res.status(403).json({ error: 'That domain does not belong to you' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const hash = await hashPassword(password);
    const c = await conn();
    // upsert: same address = refresh its password
    await c.query(
      'INSERT INTO mailboxes (username, domain, password) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE password = VALUES(password)',
      [`${local}@${domain}`, domain, hash]
    );
    await c.end();
    res.status(201).json({ ok: true, address: `${local}@${domain}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/mailboxes/:id', async (req, res) => {
  try {
    const c = await conn();
    const [rows] = await c.query('SELECT id, username, domain FROM mailboxes WHERE id = ?', [req.params.id]);
    if (!rows.length) { await c.end(); return res.status(404).json({ error: 'Mailbox not found' }); }
    const mb = rows[0];
    if (!canUseDomain(req, mb.domain)) { await c.end(); return res.status(403).json({ error: 'Not your mailbox' }); }
    await c.query('DELETE FROM mailboxes WHERE id = ?', [mb.id]);
    await c.end();

    // remove its Maildir - values were regex-validated on insert
    const local = mb.username.split('@')[0];
    if (DOMAIN_RE.test(mb.domain) && LOCAL_RE.test(local)) {
      await run(`rm -rf ${shq(path.join('/var/vmail', mb.domain, local))}`);
    }
    res.json({ ok: true, removed: mb.username });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* --------------------------- DKIM & DNS hints --------------------------- */

router.get('/records/:domain', async (req, res) => {
  const domain = String(req.params.domain || '').toLowerCase();
  if (!DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'Invalid domain' });
  if (!canUseDomain(req, domain)) return res.status(403).json({ error: 'That domain does not belong to you' });
  try {
    const dkim = await readDkimValue(domain);
    res.json({
      domain,
      zoneInPanel: !!db.findOne('zones', (z) => z.domain === domain),
      dkimReady: !!dkim,
      records: mailRecords(domain, dkim)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/dkim/:domain', async (req, res) => {
  const domain = String(req.params.domain || '').toLowerCase();
  if (!DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'Invalid domain' });
  if (!canUseDomain(req, domain)) return res.status(403).json({ error: 'That domain does not belong to you' });
  try {
    const value = await ensureDkim(domain);
    res.json({ ok: true, domain, selector: DKIM_SELECTOR, dkim: value });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Generate DKIM if needed and push everything into the panel's zone. */
router.post('/records/:domain/add', async (req, res) => {
  const domain = String(req.params.domain || '').toLowerCase();
  if (!DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'Invalid domain' });
  if (!canUseDomain(req, domain)) return res.status(403).json({ error: 'That domain does not belong to you' });
  if (!db.findOne('zones', (z) => z.domain === domain)) {
    return res.status(404).json({ error: 'This panel does not host a DNS zone for that domain - use a zone from the DNS section first, or add the records at your provider' });
  }
  try {
    let dkim = await readDkimValue(domain);
    let dkimNote = '';
    if (!dkim) {
      try { dkim = await ensureDkim(domain); }
      catch (e) { dkimNote = `DKIM generation failed: ${e.message}`; }
    }
    const result = await dns.addRecordsToZone(domain, mailRecords(domain, dkim));
    if (!result.ok) return res.status(500).json({ error: result.error });
    res.json({ ok: true, added: result.added, skipped: result.skipped, dkimNote });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router };
