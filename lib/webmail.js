'use strict';
/**
 * The webmail, over https, on the names people actually type.
 *
 * Roundcube lives on a port of its own (:2088) because that keeps it off the
 * websites' own domains - but a port with no certificate is a bare HTTP
 * login form, and that is not a thing anyone should type their password into.
 *
 * So there are two ways in, and the panel sets up whichever it can:
 *
 *   https://<domain>/webmail/      the site mounts it under a name that
 *                                   already has a certificate and already
 *                                   resolves - no DNS, no second certificate
 *   https://mail.<domain>/         the mail hostname, with its own
 *                                   certificate - needs an A record and a
 *                                   cert, and the panel can add the A record
 *                                   when it hosts the domain's zone
 *
 * Both are restricted to the administering addresses, the same as the port.
 */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const dnsPromises = require('dns').promises;
const { run } = require('./exec');
const config = require('../config');
const db = require('./db');
const dns = require('./dns');

const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

const NGINX_DIR = '/etc/nginx/sites-available';
const ROUNDCUBE_ROOT = '/var/lib/roundcube';
const LETSENCRYPT = '/etc/letsencrypt/live';

/** The name the webmail answers on for a mail domain. */
const mailHost = (domain) => `mail.${domain}`;

/** The certificate name certbot files it under. */
const certName = (hostname) => hostname;

/** Is there a certificate on disk that covers this name? */
function certFor(hostname) {
  for (const dir of [`${LETSENCRYPT}/${hostname}`, `${LETSENCRYPT}/mail.${hostname}`]) {
    if (fs.existsSync(path.join(dir, 'fullchain.pem')) && fs.existsSync(path.join(dir, 'privkey.pem'))) {
      return dir;
    }
  }
  return null;
}

/** Does this name resolve to this server? */
async function pointsHere(hostname) {
  const ip = dns.serverIp();
  try {
    const addrs = await dnsPromises.resolve4(hostname);
    return { ok: addrs.includes(ip), addresses: addrs, ip };
  } catch (e) {
    return { ok: false, addresses: [], ip, error: e.code || e.message };
  }
}

/**
 * The nginx vhost for the mail hostname.
 *
 * Written twice: once over plain HTTP, so certbot has a server block to
 * validate against, and once with the certificate once there is one. The
 * plain version serves the webmail too, so it is usable in the meantime
 * rather than a dead end.
 */
function mailVhost(hostname, { secure }) {
  const certDir = path.join(LETSENCRYPT, certName(hostname));
  const ssl = secure ? `
    ssl_certificate     ${certDir}/fullchain.pem;
    ssl_certificate_key ${certDir}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
` : '';
  const body = `
    root ${ROUNDCUBE_ROOT};
    index index.php;
    # Admin tools are exposed to the whole internet and are constantly
    # scanned. The webmail is a customer service, so it can be opened up on
    # its own without opening phpMyAdmin with it.
${config.webmailPublic ? '' : '    include snippets/admins-allow.conf;\n'}    # Must stay >= PHP-FPM's upload_max_filesize, otherwise large attachments
    # are rejected by nginx with a bare 413 before Roundcube ever sees them.
    client_max_body_size 512m;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php8.3-fpm.sock;
        fastcgi_read_timeout 120;
    }
    location ~ /(config|logs|temp|vendor|SQL)/ {
        deny all;
    }
`;
  if (!secure) {
    return `# letzControl webmail: ${hostname}
server {
    listen 80;
    server_name ${hostname};
${body}
}
`;
  }
  return `# letzControl webmail: ${hostname}
server {
    listen 80;
    server_name ${hostname};
    # The ACME challenge has to stay reachable over plain HTTP for renewals.
    location ^~ /.well-known/acme-challenge/ {
        root ${ROUNDCUBE_ROOT};
        default_type text/plain;
    }
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name ${hostname};
${ssl}${body}}
`;
}

const vhostPath = (hostname) => path.join(NGINX_DIR, `webmail-${hostname}.conf`);
const vhostEnabled = (hostname) => path.join('/etc/nginx/sites-enabled', `webmail-${hostname}.conf`);

async function writeMailVhost(hostname, { secure }) {
  const file = vhostPath(hostname);
  await fsp.mkdir(NGINX_DIR, { recursive: true });
  await fsp.writeFile(file, mailVhost(hostname, { secure }));
  await fsp.rm(vhostEnabled(hostname), { force: true });
  await fsp.symlink(file, vhostEnabled(hostname));
  return file;
}

/** Take the vhost away again.
 *
 *  A vhost that names a certificate which is not on disk stops nginx from
 *  starting at all, and every site on the box goes down with it. So the
 *  removal is used whenever the setup does not get as far as a certificate. */
async function removeMailVhost(hostname) {
  await fsp.rm(vhostPath(hostname), { force: true });
  await fsp.rm(vhostEnabled(hostname), { force: true });
}

/* The webmail's own port. Its allow-list is written into the vhost by the
 * installer rather than generated by the panel, so it has to be kept in step
 * by hand - and until it is, "let everyone use the webmail" silently does
 * nothing, because the proxy passes the client's address through and the
 * backend is what refuses them. */
const PORT_VHOST = '/etc/nginx/sites-available/webmail.conf';
const PORT_RULE = [
  '    # Admin tools are exposed on their own port to the whole internet and are',
  '    # constantly scanned. Only the administering addresses may connect.',
  '    include snippets/admins-allow.conf;'
].join('\n') + '\n';

/** Put the port vhost in step with config.webmailPublic.
 *
 *  In step means: the allow-list is in it exactly once when the webmail is
 *  for the administering addresses only, and completely gone when it is open.
 *  Checking "is it present" instead of "is it present once" matters - an
 *  earlier version of this inserted the rule a second time on every start
 *  and then could not remove it when asked to open the webmail.
 *
 *  Returns {changed, restricted}: changed tells the caller whether nginx
 *  needs reloading at all, so a normal start does not touch it. */
async function syncPortVhost() {
  if (!fs.existsSync(PORT_VHOST)) return { changed: false, restricted: false };
  const before = await fsp.readFile(PORT_VHOST, 'utf8');
  const count = (before.match(/include snippets\/admins-allow\.conf;/g) || []).length;
  const wanted = config.webmailPublic ? 0 : 1;
  if (count === wanted) return { changed: false, restricted: count === 1 };

  /* Strip every copy of the rule along with the comment that explains it,
   * so it can be put back exactly once afterwards. */
  const RULE_ANY = /(?:[ \t]*#[^\n]*\n)*[ \t]*include snippets\/admins-allow\.conf;\n/g;
  let s = before.replace(RULE_ANY, '');
  if (wanted === 1) s = s.replace('    index index.php;\n', '    index index.php;\n' + PORT_RULE);
  await fsp.writeFile(PORT_VHOST, s);
  return { changed: true, restricted: /include snippets\/admins-allow\.conf;/.test(s) };
}

/** Reload nginx, but only if the configuration is valid. */
async function reloadNginx() {
  const t = await run('nginx -t');
  if (!t.ok) {
    return { ok: false, output: (t.stdout + t.stderr).trim() };
  }
  const r = await run('systemctl reload nginx');
  return { ok: r.ok, output: (r.stdout + r.stderr).trim() || 'reloaded' };
}

/**
 * Everything about the webmail for one mail domain.
 *
 * The three things have to be in place before the hostname works, and they
 * are separate: the name has to point here, a certificate has to cover it,
 * and nginx has to be serving it. Reporting them separately is the point -
 * "the webmail is broken" is not a thing anyone can act on.
 */
async function webmailState(domain) {
  const hostname = mailHost(domain);
  const site = db.findOne('sites', (s) => s.domain === domain);
  const dnsState = await pointsHere(hostname);
  const cert = certFor(hostname);
  const vhost = fs.existsSync(vhostPath(hostname));
  const zone = db.findOne('zones', (z) => z.domain === domain);
  return {
    domain,
    hostname,
    siteId: site ? site.id : null,
    siteExists: !!site,
    siteSsl: !!(site && site.ssl),
    siteWebmail: !!(site && site.webmail),
    dns: dnsState,
    dnsInPanel: !!zone,
    cert: !!cert,
    vhost,
    ready: dnsState.ok && !!cert && vhost,
    /* The path under the site's own domain needs the site to have a
     * certificate - without one it would be plain HTTP, and a bare login
     * form is exactly what this is meant to avoid. */
    pathUrl: site && site.ssl ? `https://${domain}/webmail/` : null,
    hostUrl: dnsState.ok && cert ? `https://${hostname}/` : null
  };
}

module.exports = {
  mailHost, certFor, pointsHere, mailVhost, vhostPath, vhostEnabled,
  writeMailVhost, removeMailVhost, syncPortVhost, reloadNginx, webmailState
};
