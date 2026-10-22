'use strict';
/**
 * https on the fixed admin-tool ports, served from the panel's own certificate.
 *
 * The webmail (:2088) and phpMyAdmin (:2089) are nginx vhosts on ports of
 * their own, written by the setup wizard. They answer plain HTTP only, so a
 * browser pointed at https://<server>:2088 is told the connection is broken
 * rather than shown a login form - and anyone who does get a page there is
 * typing their password in the clear.
 *
 * The certificate the panel serves itself from covers the server's own
 * address, and a certificate is valid on every port at once, so the same two
 * files give a warning-free https://<server>:2088 as well: one certificate,
 * one renewal, nothing else to keep in date.
 *
 * What must never happen is a vhost naming a certificate that has gone - nginx
 * refuses to start over that and takes every site on the box with it. So the
 * lines are only written once both files are on disk, they are taken away
 * again when they are not, and the file is put back exactly as it was if nginx
 * ever disagrees with what was written. The mail vhosts follow the same rule.
 *
 * Plain HTTP stays on the port beside https: the websites mount the webmail at
 * http://127.0.0.1:2088, so turning that off would take the customers'
 * webmail with it. Both listeners in one server block is what nginx is for.
 */
const fs = require('fs');
const fsp = fs.promises;
const config = require('../config');
const { run } = require('./exec');

/* The vhosts that live on a port of their own. */
const TOOLS = [
  { name: 'webmail', file: '/etc/nginx/sites-available/webmail.conf', port: 2088 },
  { name: 'phpMyAdmin', file: '/etc/nginx/sites-available/phpmyadmin.conf', port: 2089 }
];

/* Only lines this module writes are ever removed. An operator's own
 * ssl_session_cache or ssl_stapling is left where it is - it does nothing
 * harm on a port that is not serving TLS, and it is not ours to delete. */
const CERT_LINE = /^[ \t]*ssl_(?:certificate|certificate_key|protocols)[ \t]/;

/** Is there a certificate to serve on these ports right now? */
function certReady() {
  const t = config.tls || {};
  return Boolean(t.cert && t.key) && fs.existsSync(t.cert) && fs.existsSync(t.key);
}

/**
 * Work out what a vhost should say, and say it.
 *
 *  The listen line for the port is replaced in place - by the secured block
 *  when there is a certificate, by the plain one when there is not - and every
 *  certificate line goes with it. The text comes back whether or not it differs
 *  from what was passed in, so the caller can tell "nothing to do" from "I
 *  have written something": the vhosts are machine-written, so an unchanged
 *  result means the file is already exactly right, which is the normal case on
 *  every panel start after the first.
 */
function reconcile(text, port, cert, key) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^[ \\t]*listen ${port}\\b`).test(l));
  if (at < 0) return { text, changed: false, skipped: `no listen ${port} line` };

  const indent = lines[at].match(/^[ \t]*/)[0];
  const wanted = cert && key ? [
    `${indent}listen ${port} ssl http2;`,
    `${indent}ssl_certificate     ${cert};`,
    `${indent}ssl_certificate_key ${key};`,
    `${indent}ssl_protocols       TLSv1.2 TLSv1.3;`
  ] : [`${indent}listen ${port};`];

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === at) { out.push(...wanted); continue; }
    if (CERT_LINE.test(lines[i])) continue;
    out.push(lines[i]);
  }
  const after = out.join('\n');
  return { text: after, changed: after !== text };
}

/** Put one vhost in step with the certificate, safely.
 *
 *  Written first, asked afterwards: the new text goes down, nginx is told to
 *  check it, and if it refuses the file goes back exactly as it was. A bad
 *  vhost left on disk is a server that cannot start on the next reboot, which
 *  is a far worse evening than a panel that did not turn https on. */
async function syncPortTls(tool, { check = () => run('nginx -t') } = {}) {
  const missing = !fs.existsSync(tool.file);
  if (missing) return { port: tool.port, changed: false, tls: false, skipped: 'not installed' };

  const before = await fsp.readFile(tool.file, 'utf8');
  const ready = certReady();
  const r = reconcile(before, tool.port,
    ready ? config.tls.cert : null, ready ? config.tls.key : null);
  if (!r.changed) return { port: tool.port, changed: false, tls: ready, skipped: r.skipped };

  await fsp.writeFile(tool.file, r.text);
  const t = await check();
  if (!t.ok) {
    await fsp.writeFile(tool.file, before);
    return {
      port: tool.port, changed: false, tls: ready,
      error: `nginx refused the vhost, it was left as it was: ${(t.stdout + t.stderr).trim().slice(0, 300)}`
    };
  }
  return { port: tool.port, changed: true, tls: ready };
}

/** Every fixed-port admin tool, at once.
 *
 *  One call so the caller can reload nginx once for all of them; each result
 *  is reported separately because "the webmail was updated but phpMyAdmin was
 *  refused" is a thing worth being able to see. */
async function syncAdminTls(options) {
  const tools = [];
  for (const tool of TOOLS) tools.push(await syncPortTls(tool, options));
  return { changed: tools.some((t) => t.changed), tools };
}

module.exports = { TOOLS, CERT_LINE, certReady, reconcile, syncPortTls, syncAdminTls };
