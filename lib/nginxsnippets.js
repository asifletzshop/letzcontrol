'use strict';
/**
 * nginx snippets that this panel's vhosts depend on.
 *
 * Every vhost the panel writes can `include` a file under /etc/nginx/snippets,
 * and nginx ships only two of them: fastcgi-php.conf and snakeoil.conf.
 * Everything else is ours. Nothing here created them, so on a machine where
 * they were absent - which is every fresh install - the installer wrote a vhost
 * that could not be parsed, `nginx -t` failed, and the operator was told only
 * that a reload failed. Worse, the broken vhost stayed on disk, so every later
 * reload kept failing until someone read the nginx error by hand.
 *
 * These are written as snippets rather than inlined into each vhost so the
 * operator can edit them afterwards, which is the point of having them.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const config = require('../config');
const { run } = require('./exec');

const SNIPPET_DIR = '/etc/nginx/snippets';

/** Write a snippet, but never clobber one that already exists.
 *
 *  Someone who has curated an allow-list has almost certainly added their own
 *  addresses, and an installer that rewrites the file on every upgrade would
 *  silently lock them out of their own admin tools. So this is create-if-absent
 *  and nothing more. */
async function ensureSnippet(name, body, log) {
  const file = path.join(SNIPPET_DIR, name);
  /* Check before doing anything. This runs on every site save, and in the
   * steady state the snippet is already there - so it must not cost a
   * subprocess spawn to find that out. */
  if (fs.existsSync(file)) return false;
  await run(`mkdir -p ${SNIPPET_DIR}`);
  fs.writeFileSync(file, body, { mode: 0o644 });
  if (log) log(`  ok: wrote /etc/nginx/snippets/${name}\n`);
  return true;
}

/** Only accept things that look like an address or a CIDR.
 *
 *  These values are interpolated into an nginx directive, so this must never be
 *  able to smuggle in a second directive. Anything unrecognised is dropped.
 *
 *  The shape is checked with net.isIP rather than a pattern: a pattern that
 *  accepts three digits per octet also accepts 999.999.999.999, which is not
 *  an address, and nginx rejects the whole configuration when it meets one.
 *  That is a 500 from an nginx reload for what should be a 400 from a
 *  settings form. */
function sanitizeCidrs(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const s = String(raw).trim();
    if (!s) continue;
    const slash = s.lastIndexOf('/');
    const addr = slash < 0 ? s : s.slice(0, slash);
    const bits = slash < 0 ? null : s.slice(slash + 1);
    const family = net.isIP(addr);
    if (!family) continue;
    if (bits !== null) {
      if (!/^\d{1,3}$/.test(bits)) continue;
      const n = Number(bits);
      if (n > (family === 4 ? 32 : 128)) continue;
    }
    out.push(s);
  }
  return out;
}

/** The addresses currently allowed to reach the admin tools.
 *
 *  Read from the snippet rather than from the config, because the snippet is
 *  what nginx actually enforces. An operator who edited the file by hand has
 *  a list the config knows nothing about, and the panel has to show the
 *  truth - or it will offer to "add" an address that is already there, and
 *  quietly drop the ones the panel cannot see. */
function readAdminsAllow() {
  const file = path.join(SNIPPET_DIR, 'admins-allow.conf');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* not written yet */ }
  const list = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*allow\s+(\S+)\s*;/);
    if (!m) continue;
    /* Loopback is always allowed and is not part of the list the panel
     * manages - showing it would invite someone to remove it. */
    if (m[1] === '127.0.0.1' || m[1] === '::1') continue;
    list.push(m[1]);
  }
  return { list, file, present: fs.existsSync(file) };
}

/**
 * Rewrite the allow-list in the snippet.
 *
 * The operator's own comment block is kept - it usually explains why an
 * address is there, and losing it is how a curated file becomes an
 * unmaintainable one. The addresses themselves are replaced, because
 * leaving stray "allow" lines behind would keep an address working that
 * the panel believes it has removed.
 */
function writeAdminsAllow(list) {
  const file = path.join(SNIPPET_DIR, 'admins-allow.conf');
  const safe = sanitizeCidrs(list);
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { /* first time */ }

  /* Keep the leading comment block, whatever it says. */
  const comments = existing.split('\n')
    .filter((l) => /^\s*#/.test(l))
    .join('\n');
  const header = comments || [
    '# Admin tools (:2088 webmail, :2089 phpMyAdmin) are reachable from the whole',
    '# internet and are actively scanned. Restrict them to the addresses that',
    '# actually administer this box; everything else gets 403.',
    '# Written by letzControl. Safe to edit - it is never overwritten on upgrade.'
  ].join('\n');

  const body = [
    header,
    'set_real_ip_from 127.0.0.1;',
    'allow 127.0.0.1;',
    'allow ::1;',
    ...safe.map((v) => `allow ${v};`),
    'deny all;',
    ''
  ].join('\n');

  fs.writeFileSync(file, body, { mode: 0o644 });
  return safe;
}

/** Restrict webmail (:2088) and phpMyAdmin (:2089) to the administering IPs.
 *
 *  Both sit on a fixed port reachable from the whole internet and are scanned
 *  within minutes. Defaults to localhost only - "allow everything" is never the
 *  right default for something that can read every mailbox and every database. */
function adminsAllowBody(log) {
  const allowed = sanitizeCidrs(config.adminTools && config.adminTools.allowedCidrs);
  const body = [
    '# Admin tools (:2088 webmail, :2089 phpMyAdmin) are reachable from the whole',
    '# internet and are actively scanned. Restrict them to the addresses that',
    '# actually administer this box; everything else gets 403.',
    '# Written by letzControl. Safe to edit - it is never overwritten on upgrade.',
    'set_real_ip_from 127.0.0.1;',
    'allow 127.0.0.1;',
    'allow ::1;',
    ...allowed.map((v) => `allow ${v};`),
    'deny all;',
    ''
  ].join('\n');
  if (log) {
    log(allowed.length
      ? `  ok: admin-tool allow-list (${allowed.length} address(es) from config)\n`
      : '  ok: admin-tool allow-list (localhost only - add your address to\n' +
        '      /etc/nginx/snippets/admins-allow.conf or config.json adminTools.allowedCidrs)\n');
  }
  return body;
}

/** Cheap 404s for the paths scanners probe, so they do not each cost a full
 *  WordPress bootstrap (1.5-2.5s of CPU) rendering a 404. */
function wpScannerGuardBody() {
  return [
    '# Scanner probes, denied without booting WordPress. Written by letzControl;',
    '# safe to edit and never overwritten on upgrade.',
    '',
    'location = /wp-cron.php {',
    '    # cron is driven by the system scheduler instead (DISABLE_WP_CRON)',
    '    try_files $uri =404;',
    '    access_log off;',
    '}',
    '',
    '# Version/readme files that scanners fetch to fingerprint the install',
    'location ~* ^/(readme|license|wp-config-sample|wp-content-readme)\\.(html|php|txt)$ {',
    '    deny all;',
    '    access_log off;',
    '}',
    '',
    '# Ghost install directories probed after a migration. wp-admin,',
    '# wp-includes and wp-content are deliberately NOT here - they are real.',
    'location ~* ^/(wp|wordpress|blog|staging|site|old|backup|newsite|demo|test)/?$ {',
    '    deny all;',
    '    access_log off;',
    '}',
    '',
    '# Vulnerability scanners and admin panels that are not installed',
    'location ~* ^/(vendor|phpmyadmin|pma|adminer|shell|c99|r57|backdoor|config|setup|install)/?$ {',
    '    deny all;',
    '    access_log off;',
    '}',
    ''
  ].join('\n');
}

/** Both at once, for the code paths that write more than one vhost. */
async function ensureAdminTools(log) {
  return ensureSnippet('admins-allow.conf', adminsAllowBody(log), log);
}

async function ensureWpGuard(log) {
  return ensureSnippet('wp-scanner-guard.conf', wpScannerGuardBody(), log);
}

module.exports = {
  SNIPPET_DIR, ensureSnippet, sanitizeCidrs,
  adminsAllowBody, wpScannerGuardBody,
  ensureAdminTools, ensureWpGuard,
  readAdminsAllow, writeAdminsAllow
};