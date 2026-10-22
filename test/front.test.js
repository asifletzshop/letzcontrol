'use strict';
/**
 * The front door - one port, both protocols - is the piece of the panel that
 * has to be right before anything else can matter: get it wrong and the panel
 * is unreachable. These tests run the real listener on a loopback port with a
 * throwaway certificate, and cover the three things that can go wrong: the
 * two protocols being told apart, a renewed certificate taking effect on its
 * own, and plain HTTP surviving with no certificate at all.
 *
 * They need openssl to make the throwaway certificate, and skip if it is not
 * there. Run with: npm test
 */
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const front = require('../lib/front');

function selfSigned(dir, name, cn) {
  const key = path.join(dir, `${name}.key`);
  const cert = path.join(dir, `${name}.pem`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${cn}`,
    '-keyout', key, '-out', cert, '-days', '2'
  ], { stdio: 'ignore' });
  return { key, cert };
}

const get = (url, opts = {}) => new Promise((resolve, reject) => {
  const mod = url.startsWith('https:') ? https : http;
  const req = mod.get(url, opts, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject);
  req.setTimeout(4000, () => req.destroy(new Error('timed out')));
});

async function start(opts) {
  const door = front.listen({ port: 0, host: '127.0.0.1', refreshMs: 150, ...opts });
  await new Promise((r) => door.server.once('listening', r));
  door.port = door.server.address().port;
  return door;
}

/* An express app is not needed to prove routing - a plain request handler that
 * says which protocol answered it does the same job with less machinery. */
const app = (req, res) => res.end(req.socket.encrypted ? 'secure' : 'plain');

test('looksLikeTls separates a handshake from an HTTP method', () => {
  const tlsByte = (b) => front.looksLikeTls(Buffer.from([b]));
  for (const b of [0x16, 0x17, 0x15, 0x80, 0xff, 0x00]) assert.equal(tlsByte(b), true, `byte ${b}`);
  for (const m of ['GET /', 'POST /', 'HEAD /', 'PUT /', 'OPTIONS /', 'PATCH /', 'DELETE /']) {
    assert.equal(front.looksLikeTls(Buffer.from(m)), false, m);
  }
});

test('one port serves plain HTTP and https, each to the right server', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'front-'));
  let pair;
  try { pair = selfSigned(dir, 'a', 'panel-test-a'); } catch (e) { t.skip(`openssl: ${e.message}`); return; }

  /* Exactly how the panel is wired: one express app behind both servers, and
   * Socket.IO attached to both, since the dashboard pushes over it. */
  const httpServer = http.createServer(app);
  let io = null;
  try { io = new (require('socket.io').Server)(httpServer); } catch { /* not installed: skip the push-channel checks */ }

  const door = await start({
    app,
    httpServer,
    certPath: pair.cert,
    keyPath: pair.key,
    onTlsServer: io ? (s) => io.attach(s) : undefined
  });
  t.after(() => door.server.close());

  const base = `http://127.0.0.1:${door.port}`;
  const secure = `https://127.0.0.1:${door.port}`;

  assert.equal((await get(base)).body, 'plain', 'http:// is still plain HTTP');
  assert.equal((await get(secure, { rejectUnauthorized: false })).body, 'secure');
  assert.equal(door.tlsAvailable(), true);

  /* The push channel the dashboard depends on rides on the same listener, so
   * it has to survive the split too. */
  if (io) {
    const sio = await get(`${base}/socket.io/?EIO=4&transport=polling`);
    assert.match(sio.body, /^\d?\{?"sid"/, 'socket.io answers over plain HTTP');
    const sioSecure = await get(`${secure}/socket.io/?EIO=4&transport=polling`, { rejectUnauthorized: false });
    assert.match(sioSecure.body, /^\d?\{?"sid"/, 'socket.io answers over https');
  }
});

test('a renewed certificate takes effect without a restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'front-'));
  let first; let second;
  try {
    first = selfSigned(dir, 'a', 'panel-test-first');
    second = selfSigned(dir, 'b', 'panel-test-second');
  } catch (e) { t.skip(`openssl: ${e.message}`); return; }

  /* The door reads fixed paths, so renewal is a matter of putting a new pair
   * of files down at the same place - exactly what acme.sh does. */
  const live = { cert: path.join(dir, 'live.pem'), key: path.join(dir, 'live.key') };
  fs.copyFileSync(first.cert, live.cert);
  fs.copyFileSync(first.key, live.key);

  const door = await start({
    app,
    httpServer: http.createServer(app),
    certPath: live.cert,
    keyPath: live.key
  });
  t.after(() => door.server.close());

  const who = () => get(`https://127.0.0.1:${door.port}/`, { rejectUnauthorized: false })
    .then((r) => r.body);
  assert.equal(await who(), 'secure');

  /* What matters is not the file on disk but the certificate the panel hands
   * out, so read it off the wire. */
  const peerCn = () => new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port: door.port, rejectUnauthorized: false }, () => {
      const cn = String((s.getPeerCertificate().subject || {}).CN || '');
      s.end();
      resolve(cn);
    });
    s.on('error', reject);
  });

  assert.equal(await peerCn(), 'panel-test-first');

  fs.copyFileSync(second.cert, live.cert);
  fs.copyFileSync(second.key, live.key);

  /* Wait for the poll to notice. */
  const deadline = Date.now() + 8000;
  let cn = 'panel-test-first';
  while (Date.now() < deadline && cn !== 'panel-test-second') {
    await new Promise((r) => setTimeout(r, 150));
    cn = await peerCn().catch(() => cn);
  }
  assert.equal(cn, 'panel-test-second', 'the renewed certificate should be served within a few polls');
  assert.equal(await who(), 'secure', 'and the panel keeps answering throughout');
});

test('with no certificate the port serves plain HTTP only', async (t) => {
  const door = await start({ app, httpServer: http.createServer(app) });
  t.after(() => door.server.close());

  assert.equal((await get(`http://127.0.0.1:${door.port}/`)).body, 'plain');
  assert.equal(door.tlsAvailable(), false, 'and never offers https');
  await assert.rejects(get(`https://127.0.0.1:${door.port}/`, { rejectUnauthorized: false }));
});

test('an unreadable certificate leaves plain HTTP running', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'front-'));
  const missing = path.join(dir, 'not-there.pem');
  const log = [];
  const door = await start({
    app,
    httpServer: http.createServer(app),
    certPath: missing,
    keyPath: path.join(dir, 'not-there.key'),
    log: (m) => log.push(m)
  });
  t.after(() => door.server.close());

  assert.equal((await get(`http://127.0.0.1:${door.port}/`)).body, 'plain');
  assert.equal(door.tlsAvailable(), false);
  assert.equal(log.filter((m) => m.includes('not loaded')).length, 1, 'says so once, not once a minute');
});
