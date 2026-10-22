'use strict';
/**
 * The admin-tool ports (:2088 webmail, :2089 phpMyAdmin) are nginx vhosts the
 * panel keeps in step with its own certificate. What matters here is the two
 * halves of that promise: the https lines appear - and disappear again - with
 * the certificate, and nothing is ever left on disk that nginx would refuse to
 * start over, because that takes every site on the box down with it.
 *
 * The text rewriting is tested directly. The file writing is tested with the
 * nginx check injected, so these run anywhere: a rollback that needs a real
 * nginx to notice is a rollback nobody can test.
 *
 * Run with: npm test
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config');
const porttls = require('../lib/porttls');

/* The webmail vhost as the setup wizard writes it, trimmed to what matters. */
const PLAIN = `server {
    listen 2088;
    server_name _;
    root /var/lib/roundcube;
    index index.php;
    include snippets/admins-allow.conf;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
}
`;

const SECURED = PLAIN
  .replace('    listen 2088;\n',
    `    listen 2088 ssl http2;\n` +
    '    ssl_certificate     /etc/letsencrypt/panel-ip/fullchain.pem;\n' +
    '    ssl_certificate_key /etc/letsencrypt/panel-ip/privkey.pem;\n' +
    '    ssl_protocols       TLSv1.2 TLSv1.3;\n');

const CERT = '/etc/letsencrypt/panel-ip/fullchain.pem';
const KEY = '/etc/letsencrypt/panel-ip/privkey.pem';

test('the plain vhost gains the https lines and nothing else changes', () => {
  const r = porttls.reconcile(PLAIN, 2088, CERT, KEY);
  assert.equal(r.changed, true);
  assert.equal(r.text, SECURED);
});

test('a vhost already on https with the same certificate is left alone', () => {
  const r = porttls.reconcile(SECURED, 2088, CERT, KEY);
  assert.equal(r.changed, false);
  assert.equal(r.text, SECURED);
});

test('no certificate on disk takes the https lines away again', () => {
  const r = porttls.reconcile(SECURED, 2088, null, null);
  assert.equal(r.changed, true);
  assert.equal(r.text, PLAIN);
});

test('a vhost already plain is left alone', () => {
  const r = porttls.reconcile(PLAIN, 2088, null, null);
  assert.equal(r.changed, false);
});

test('a certificate that has been moved is replaced with the one in use', () => {
  const moved = SECURED.replace(CERT, '/old/place/fullchain.pem').replace(KEY, '/old/place/privkey.pem');
  const r = porttls.reconcile(moved, 2088, CERT, KEY);
  assert.equal(r.changed, true);
  assert.equal(r.text, SECURED);
});

test('a vhost that does not listen on the port is not touched', () => {
  const other = 'server {\n    listen 443 ssl http2;\n    server_name example.com;\n}\n';
  const r = porttls.reconcile(other, 2088, CERT, KEY);
  assert.equal(r.changed, false);
  assert.equal(r.text, other);
  assert.match(r.skipped, /listen 2088/);
});

test('settings the operator wrote by hand survive', () => {
  const own = SECURED.replace('    ssl_protocols       TLSv1.2 TLSv1.3;\n',
    '    ssl_protocols       TLSv1.2 TLSv1.3;\n    ssl_session_cache shared:SSL:10m;\n');
  const r = porttls.reconcile(own, 2088, null, null);
  assert.equal(r.changed, true);
  assert.match(r.text, /ssl_session_cache shared:SSL:10m;/);
  assert.doesNotMatch(r.text, /ssl_certificate/);
  assert.match(r.text, /listen 2088;/);
});

test('the same works for phpMyAdmin\'s port', () => {
  const pma = PLAIN.replace(/2088/g, '2089');
  const on = porttls.reconcile(pma, 2090, CERT, KEY);
  assert.equal(on.changed, false, 'a different port is none of this vhost\'s business');
  const mine = porttls.reconcile(pma, 2089, CERT, KEY);
  assert.equal(mine.changed, true);
  assert.match(mine.text, /listen 2089 ssl http2;/);
});

/* ------------------------- the file, and the rollback --------------------- */

function tmpVhost(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'porttls-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

test('writes the https lines and keeps them when nginx accepts the result', async () => {
  const file = tmpVhost('webmail.conf', PLAIN);
  const cert = tmpVhost('fullchain.pem', 'x');
  const key = tmpVhost('privkey.pem', 'y');
  const saved = { ...config.tls };
  config.tls = { cert, key };
  try {
    const r = await porttls.syncPortTls({ name: 'webmail', file, port: 2088 },
      { check: async () => ({ ok: true, stdout: '', stderr: '' }) });
    assert.equal(r.changed, true);
    assert.equal(r.tls, true);
    const after = fs.readFileSync(file, 'utf8');
    assert.match(after, /listen 2088 ssl http2;/);
    assert.ok(after.includes(`ssl_certificate     ${cert};`), 'points at the configured certificate');
    assert.ok(after.includes(`ssl_certificate_key ${key};`));
  } finally {
    config.tls = saved;
  }
});

test('puts the file back exactly as it was when nginx refuses it', async () => {
  const file = tmpVhost('webmail.conf', SECURED);
  const saved = { ...config.tls };
  /* No certificate configured: the only edit on offer is the removal of the
   * https lines, so a refusal is forced without needing a real certificate. */
  config.tls = { cert: '', key: '' };
  try {
    const r = await porttls.syncPortTls({ name: 'webmail', file, port: 2088 },
      { check: async () => ({ ok: false, stdout: '', stderr: 'emerg: invalid certificate' }) });
    assert.equal(r.changed, false, 'a refused edit reports nothing changed');
    assert.match(r.error, /invalid certificate/);
    assert.equal(fs.readFileSync(file, 'utf8'), SECURED, 'the file must come back byte for byte');
  } finally {
    config.tls = saved;
  }
});

test('a vhost that is not installed is skipped, not created', async () => {
  const missing = path.join(os.tmpdir(), `porttls-${Date.now()}-nope.conf`);
  const r = await porttls.syncPortTls({ name: 'none', file: missing, port: 2088 },
    { check: async () => ({ ok: true, stdout: '', stderr: '' }) });
  assert.equal(r.changed, false);
  assert.match(r.skipped, /not installed/);
  assert.equal(fs.existsSync(missing), false);
});
