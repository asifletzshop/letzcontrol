'use strict';
/**
 * The panel's front door: one port, two protocols.
 *
 * When a panel is reached by a bare address there is no hostname to hang a
 * certificate name on, so what covers it is a short-lived certificate issued
 * for the IP address itself - six days at a time, renewed in the background by
 * acme.sh, which owns those files and is never driven from here. This module
 * only reads what is already on disk.
 *
 * Plain HTTP and TLS are told apart by the first byte of the connection, so a
 * bookmarked http:// address, a script, an API call and the panel's own health
 * probe all keep working exactly as they always have, while a browser that
 * arrives over https gets a real, trusted connection. Because the two sides
 * are independent, a certificate that has gone missing or gone bad degrades to
 * plain HTTP rather than taking the panel down with it.
 */
const fs = require('fs');
const net = require('net');
const https = require('https');
const tls = require('tls');
const { X509Certificate } = require('crypto');

/* A TLS handshake record always begins with a byte that no HTTP method starts
 * with: outside printable ASCII is a handshake, everything else is HTTP. */
function looksLikeTls(b) {
  return b[0] < 0x21 || b[0] > 0x7e;
}

/* Read a certificate and its key, and refuse the pair unless they actually go
 * together - a mismatched key is exactly the sort of thing a renewal can leave
 * behind, and serving it would fail on every handshake anyway. */
function readMaterial(certPath, keyPath) {
  const cert = fs.readFileSync(certPath);
  const key = fs.readFileSync(keyPath);
  tls.createSecureContext({ key, cert });
  return { key, cert };
}

function expiryOf(cert) {
  try { return Date.parse(new X509Certificate(cert).validTo) || 0; } catch { return 0; }
}

/**
 * Listen on port, sending each connection to httpServer or to a TLS server
 * built from certPath/keyPath. Pass no paths and the port serves plain HTTP,
 * which is all it has ever done.
 *
 * The first byte is taken with read() rather than a 'data' event: a TLS
 * handshake handed these bytes is fed from the same buffer, so a streaming
 * read that empties it leaves the handshake with nothing to begin from.
 * read(1) keeps the socket paused, and unshift() puts the byte back where the
 * server taking over expects to find it.
 *
 * The TLS server, once built, is never rebuilt - a renewed certificate is
 * swapped in on top of it with setSecureContext(), which disturbs no open
 * connection. The files are checked once a minute, so a renewal takes effect
 * on its own with no restart and no window of answering with a stale or
 * half-written certificate.
 *
 * Returns { server, tlsAvailable } - tlsAvailable() is false while no valid
 * certificate is being served, which is what tells the caller not to send
 * anybody at https.
 */
function listen({
  port, host, app, httpServer, certPath, keyPath, log = () => {}, onTlsServer = () => {},
  refreshMs = 60_000
}) {
  let secureServer = null;
  let stamp = null;
  let expires = 0;

  const stampOf = () => {
    if (!certPath || !keyPath) return null;
    try {
      return [certPath, keyPath].map((f) => { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; }).join('|');
    } catch { return 'missing'; }
  };

  function refresh() {
    const next = stampOf();
    if (next === stamp) return;
    let material = null;
    try {
      material = readMaterial(certPath, keyPath);
    } catch (e) {
      /* Keep serving whatever is already loaded; never trade a working panel
       * for an unreadable file. */
      log(`TLS certificate not loaded (${e.message}), continuing without it`);
      stamp = next || 'missing';
      return;
    }
    if (!material) { stamp = 'missing'; return; }
    if (!secureServer) {
      secureServer = https.createServer({ ...material, minVersion: 'TLSv1.2' }, app);
      onTlsServer(secureServer);
      log(`https enabled (certificate valid until ${new Date(expiryOf(material.cert)).toISOString().slice(0, 10)})`);
    } else {
      secureServer.setSecureContext(material);
      log('certificate renewed, the new one is in use');
    }
    stamp = next;
    expires = expiryOf(material.cert);
  }

  refresh();
  const timer = setInterval(refresh, refreshMs);
  if (timer.unref) timer.unref();

  const server = net.createServer((sock) => {
    sock.on('error', () => {}); // a client hanging up mid-handshake is normal
    let settled = false;
    /* A connection that opens and then says nothing is neither a browser nor
     * a script; drop it rather than hold the socket open forever. */
    const stall = setTimeout(() => { if (!settled) sock.destroy(); }, 10_000);
    const decide = () => {
      const first = sock.read(1);
      if (first === null) return sock.once('readable', decide);
      settled = true;
      clearTimeout(stall);
      sock.unshift(first);
      const isTls = looksLikeTls(first);
      if (!isTls) return httpServer.emit('connection', sock);
      if (!secureServer) return sock.destroy(); // https asked for, none to give
      return secureServer.emit('connection', sock);
    };
    decide();
  });

  server.listen(port, host);

  return {
    server,
    tlsAvailable: () => Boolean(secureServer) && (!expires || Date.now() < expires - 60_000)
  };
}

module.exports = { looksLikeTls, readMaterial, expiryOf, listen };
