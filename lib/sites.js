'use strict';
/**
 * Website / virtual host manager.
 *
 * All three web servers can run TOGETHER:
 *   - Nginx          : ports 80/443 (front-end; serves its own sites directly
 *                      and reverse-proxies Apache / OpenLiteSpeed sites)
 *   - Apache         : port 8080 (config.ports.apache)
 *   - OpenLiteSpeed  : port 8088 (config.ports.openlitespeed)
 *
 * Each site picks ONE backend. If the backend is apache/openlitespeed and
 * Nginx is installed, letzControl also creates an Nginx proxy vhost on port
 * 80 so the site is reachable on standard ports. SSL is issued with certbot
 * against the Nginx front vhost.
 */
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('../config');
const db = require('./db');
const { run } = require('./exec');
const snippets = require('./nginxsnippets');
const { checkLimit } = require('./users');

const router = express.Router();

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const PHP_RE = /^\d\.\d$/;
/* 'node' is not a web server the panel manages - it fronts an app the panel
 * neither starts nor configures (a systemd unit already on the box), purely
 * by proxying to the port in config.ports.node. Recording a Node app as
 * openlitespeed used to make every panel save rewrite its vhost back to the
 * OLS port and take the site down. */
const BACKENDS = ['nginx', 'apache', 'openlitespeed', 'node', 'docker'];
const PROXY_BACKENDS = ['apache', 'openlitespeed', 'node', 'docker'];
/* Backends that cannot execute PHP at all. */
const NO_PHP_BACKENDS = ['node', 'docker'];

/* Curated php.ini directives offered in the visual editor + validation,
 * shared with the global PHP view editor in lib/phpini.js. Keys are a
 * strict whitelist - anything not listed there can never reach a
 * .user.ini file or a patched php.ini. */
const { FIELDS: PHP_INI_FIELDS, sanitize: sanitizePhpIni } = require('./phpini');
const olsphp = require('./olsphp');

/** Write the site's <docroot>/public/.user.ini (or remove it when empty).
 *  PHP-FPM reads this for every request under the docroot (Nginx + Apache). */
async function writeUserIni(site) {
  // A Node app has no PHP SAPI under this docroot - a .user.ini there would
  // only ever be a stale leftover from when the site was something else.
  if (NO_PHP_BACKENDS.includes(site.backend)) {
    await fsp.rm(path.join(site.docroot, 'public', '.user.ini'), { force: true });
    return;
  }
  const file = path.join(site.docroot, 'public', '.user.ini');
  const entries = Object.entries(site.phpIni || {});
  if (!entries.length) {
    await fsp.rm(file, { force: true });
    return;
  }
  await fsp.writeFile(file, entries.map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o644 });
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

async function detectBackends() {
  const [nginx, apache] = await Promise.all([
    run('command -v nginx'),
    run('command -v apache2ctl || command -v apachectl')
  ]);
  return {
    nginx: nginx.ok,
    apache: apache.ok,
    openlitespeed: fs.existsSync(path.join(config.openlitespeed.root, 'bin', 'lswsctrl')),
    // Not a server the panel installs - "available" means nothing is listening
    // yet is not a reason to refuse, the app may start later.
    node: true,
    // Nor is this a server at all: a docker site is an nginx vhost forwarding
    // to a port the container publishes, so there is nothing to install or to
    // detect. It is a backend in the record only, which is what makes a linked
    // app sit in the Sites list like any other website.
    docker: true
  };
}

/* ------------------------------------------------------------------ */
/* Vhost templates                                                     */
/* ------------------------------------------------------------------ */

function serverNames(site) {
  return site.www ? `${site.domain} www.${site.domain}` : site.domain;
}

function phpSocket(phpVersion) {
  return `/run/php/php${phpVersion}-fpm.sock`;
}

/* Nginx-direct and Apache sites pass site.phpVersion to PHP-FPM as a socket.
 * OpenLiteSpeed sites do not: their PHP is a global lsapi processor, so the
 * version can only be honoured if a matching lsphp build exists. Rejecting it
 * here stops the panel from saving "PHP 8.4" for a site that would keep
 * running 8.3 (and from restarting an FPM that OLS never uses). */
function assertPhpUsable(backend, phpVersion) {
  if (!phpVersion) return null;
  if (NO_PHP_BACKENDS.includes(backend)) {
    return `A "${backend}" site is served by its own application on port ${config.ports[backend]}, ` +
           `so it does not run PHP here. Set PHP to "None (static site)" instead.`;
  }
  if (backend !== 'openlitespeed') return null;
  if (olsphp.handlerFor(phpVersion)) return null;
  return `OpenLiteSpeed cannot run PHP ${phpVersion} on this server (lsphp builds: ${olsphp.available()}). ` +
         `Pick one of those versions, or install the matching lsphp build first.`;
}

/* A certificate on disk for this domain => the vhost is written with a 443
 * block (+ HTTP->HTTPS redirect). Checking disk (not just the db flag) means
 * regenerated vhosts always pick up existing certs instead of wiping the SSL
 * config that certbot created earlier. */
function hasCert(site) {
  const dir = path.join('/etc/letsencrypt/live', site.domain);
  return fs.existsSync(path.join(dir, 'fullchain.pem')) && fs.existsSync(path.join(dir, 'privkey.pem'));
}

function sslDirectives(site) {
  return `    ssl_certificate     /etc/letsencrypt/live/${site.domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${site.domain}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
`;
}

/* ACME challenge stays reachable on :80 (certbot renewals + manual certs) */
function acmeBlock(site) {
  return `    location ^~ /.well-known/acme-challenge/ {
        root ${site.docroot}/public;
        default_type text/plain;
    }

`;
}

/* Block paths that must never be served over HTTP.
 *
 * Plugins guard these with `deny from all` in a .htaccess, but the Apache /
 * OpenLiteSpeed backends here are fronted by Nginx and this OpenLiteSpeed
 * build ignores .htaccess entirely (verified against OLS's own stock Example
 * vhost), so a plugin's .htaccess protects nothing. Backup folders hold full
 * database dumps and site archives, so the rule has to live in Nginx - and it
 * has to be part of the GENERATED template, otherwise the next vhost regen
 * silently drops it and re-exposes the backups. `^~` wins over the static
 * asset regex and the generic location. */
const DENY_PATHS = [
  'wp-content/(?:backuply|updraft|ai1wm-backups|w3tc-config|cache|maintenance|upgrades|backup-db|et-cache)/',
  'wp-content/uploads/updraft/',
  '\\.env',
  'wp-config\\.php\\.(?:bak|old|orig|save|txt|dist)',
  '\\.wp-config\\.php\\.swp'
];

/*
 * The WordPress scanner guard is included only for sites that actually run WordPress.
 *
 * This used to be unconditional, which put a WordPress-specific snippet in front of every
 * proxied site including the Next.js ones. For rozanabill.info that meant /xmlrpc.php and
 * /wp-login.php answering 403 on an application that has no WordPress behind it at all —
 * noise in the access log, and a 403 to anyone whose invoice contained a link to a
 * wp-login.php URL. The deny list for real secrets (wp-config backups, .env) still applies
 * everywhere; only the PHP-bootstrapping guard is WordPress-specific.
 */
function denyBlock(site) {
  /* Only backends that actually run PHP-WordPress get the guard.
     openlitespeed is the one this panel uses for WordPress, and it was missing from the
     first version of this list — which silently stripped the scanner guard from
     letzshop.co.in and niyomiakhabar.in, both real WordPress sites. A regression caught by
     regenerating every vhost and checking the ones this change was NOT supposed to affect. */
  const WORDPRESS_BACKENDS = ["wordpress", "openlitespeed", "ols", "php", "nginx"];
  const wordpressish = !site || WORDPRESS_BACKENDS.includes(site.backend);
  return `    # Answer WordPress scanner probes without booting PHP. ~40% of the
    # traffic to a freshly restored site was automated requests for paths that
    # do not exist, and each one cost a full WordPress bootstrap (1.5-2.5s of
    # CPU) just to render a 404.
${wordpressish ? "    include snippets/wp-scanner-guard.conf;" : ""}

    # Sensitive paths (plugin backup folders, config backups, dotenv).
    # Nginx-only by design: .htaccess is not honoured by this OLS build.
    location ~ ^/(?:${DENY_PATHS.join('|')}) {
        deny all;
        return 403;
    }

`;
}

/* Request body ceiling for a site's vhost.
 *
 * Nginx rejects the whole request with "413 Request Entity Too Large" before
 * PHP is ever reached, and its default is only 1 MB - so uploading any plugin,
 * theme or media larger than that failed even though php.ini (upload_max_
 * filesize / post_max_size) allows 500M. The vhost limit must therefore be at
 * least as generous as the PHP limits, or the generous PHP setting is a lie.
 * Kept in the generated template because a manual edit is erased on the next
 * vhost regeneration. */
const MAX_BODY = '512m';

/**
 * The webmail, mounted under the site's own domain.
 *
 * A separate hostname (mail.<domain>) needs its own certificate and its own
 * DNS, and until both of those are in place there is no https URL for it at
 * all. Mounting it under a site that already has a certificate gives the
 * operator an https webmail straight away, on a name that already resolves.
 *
 * nginx picks the longest matching prefix, so /webmail/ wins over / no
 * matter which order the two are written in.
 */
function webmailBlock(site) {
  if (!site || !site.webmail) return '';
  /* The webmail is a customer service: people read their mail from home,
   * from a phone, from wherever. The admin-tools list is for the operator
   * alone, so the webmail can be opened up without opening phpMyAdmin with
   * it. */
  const restrict = config.webmailPublic
    ? ''
    : '        include snippets/admins-allow.conf;\n';
  return `
    # The webmail, under this site's own domain and certificate, so it is
    # reached over https without a second hostname to set up.
    #
    # The port it reaches is https too, and this has to say so: nginx cannot
    # serve plain HTTP and https from one port the way the panel itself does
    # - ssl is a property of the socket, not of the request - so :2088 only
    # answers TLS. Probing it over plain HTTP would get "the plain HTTP
    # request was sent to HTTPS port" back. Certificate checking is off
    # (nginx's default) because the panel's certificate names the server's
    # address, not the loopback it is reached on.
    location = /webmail { return 301 /webmail/; }
    location /webmail/ {
        proxy_pass https://127.0.0.1:${config.ports.webmail}/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size ${MAX_BODY};
${restrict}    }
`;
}

function nginxDirect(site) {
  const phpBlock = site.phpVersion
    ? `
    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:${phpSocket(site.phpVersion)};
    }
`
    : '';
  const head = `    server_name ${serverNames(site)};
    root ${site.docroot}/public;
    index index.php index.html index.htm;
    client_max_body_size ${MAX_BODY};

    access_log /var/log/nginx/${site.domain}_access.log;
    error_log  /var/log/nginx/${site.domain}_error.log;
`;
  const body = `${denyBlock(site)}${webmailBlock(site)}    # Static assets get a long browser cache so repeat visits stop
    # re-downloading CSS/JS/images over the wire.
    location ~* \\.(?:css|js|mjs|jpg|jpeg|png|gif|ico|svg|svgz|webp|avif|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|pdf)$ {
        expires 30d;
        access_log off;
    }

    location / {
        try_files $uri $uri/ =404;
    }
${phpBlock}
    location ~ /\\.(?!well-known) {
        deny all;
    }`;
  /* Same edge www -> apex redirect as the proxy template - see nginxProxy. */
  const www80 = site.www
    ? `        if ($host = "www.${site.domain}") { return 301 https://${site.domain}$request_uri; }\n`
    : '';
  const www443 = site.www
    ? `    if ($host = "www.${site.domain}") { return 301 https://${site.domain}$request_uri; }\n\n`
    : '';

  if (hasCert(site)) {
    return `# letzControl site: ${site.domain} (backend: nginx, SSL)
server {
    listen 80;
${head}
${acmeBlock(site)}    location / {
${www80}        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
${head}
${sslDirectives(site)}${www443}${body}
}
`;
  }
  return `# letzControl site: ${site.domain} (backend: nginx)
server {
    listen 80;
${head}
${body}
}
`;
}

/*
 * One extra location for a node site, which must be generated rather than added to the
 * vhost by hand, because the vhost is rewritten on every panel save.
 *
 *  location = /sw.js
 *      The service worker is served from a path ending in .js, so the static-asset regex
 *      below matches it and would force "expires 30d" with Cache-Control stripped. That is
 *      fine for a stylesheet and fatal for a worker: the browser would hold the first
 *      version it fetched for a month, so a fix to the worker could never reach a device.
 *      An exact-match location wins over the regex.
 */
const NODE_EXTRAS = (site, port) =>
  site.backend === "node"
    ? `
    location = /sw.js {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        expires off;
        add_header Cache-Control "public, max-age=0, must-revalidate" always;
    }


`
    : "";

/* An arbitrary container behind this proxy is reached over plain http and has
 * no idea the visitor used https - nginx ended the TLS. Stock WordPress is the
 * clearest case: X-Forwarded-Proto is sent, core ignores it, and it builds its
 * asset URLs from the scheme it saw. Served over https those become http://
 * stylesheets, which a browser refuses as mixed content, so the HTML arrives
 * and the site renders as raw text.
 *
 * The app cannot be told: a header never becomes $_SERVER['HTTPS'], and any
 * patch written inside the container dies with it on recreate. So when https
 * is forced onto a docker link, the app's own host is rewritten from http to
 * https in the response body instead - the one repair available at this layer,
 * and it needs no cooperation from whatever is running behind us.
 *
 * sub_filter reads the body, so the upstream must not compress it. nginx still
 * gzips for the browser (gzip_proxied any is set globally), so this costs
 * nothing but a little CPU. Only the body is touched - no binary asset passes
 * through this, because the filter lives in location / and the static-asset
 * location above it is left alone.
 */
const SUB_FILTER_TYPES =
  'text/html text/css text/javascript application/javascript application/json';
const subFilter = site =>
  site.backend === 'docker' && site.forceHttps === true
    ? `        proxy_set_header Accept-Encoding "";
        sub_filter_types ${SUB_FILTER_TYPES};
        sub_filter "http://${site.domain}" "https://${site.domain}";
        sub_filter_once off;
`
    : '';

function nginxProxy(site, port) {
  const head = `    server_name ${serverNames(site)};
    client_max_body_size ${MAX_BODY};

    access_log /var/log/nginx/${site.domain}_access.log;
    error_log  /var/log/nginx/${site.domain}_error.log;
`;
  const pass = `        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
`;
  const body = `${denyBlock(site)}${NODE_EXTRAS(site, port)}${webmailBlock(site)}    # Static assets get a long browser cache so repeat visits stop
    # re-downloading CSS/JS/images over the wire.
    location ~* \\.(?:css|js|mjs|jpg|jpeg|png|gif|ico|svg|svgz|webp|avif|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|pdf)$ {
        proxy_hide_header Cache-Control;
        proxy_hide_header Expires;
${pass}        expires 30d;
        access_log off;
    }

    location / {
${pass}${subFilter(site)}    }`;
  /* www -> apex at the edge. Without it every www hit boots WordPress
   * (~0.5 s) just to answer a 301. On :80 the rule lives inside location /
   * so the ^~ ACME location above it keeps serving certbot renewals; on :443
   * it sits at server level (no ACME there). Skipped when site.www is off. */
  const www80 = site.www
    ? `        if ($host = "www.${site.domain}") { return 301 https://${site.domain}$request_uri; }\n`
    : '';
  const www443 = site.www
    ? `    if ($host = "www.${site.domain}") { return 301 https://${site.domain}$request_uri; }\n\n`
    : '';

  if (hasCert(site)) {
    /* An app behind this proxy is reached over plain http, and unless somebody
     * tells it otherwise it has no idea the visitor arrived over https - nginx
     * ended the TLS. Stock WordPress is the clearest case: X-Forwarded-Proto is
     * sent, core ignores it, and it builds its own asset URLs from the scheme it
     * saw. So redirecting :80 to https hands the browser a page that then tries
     * to load http:// stylesheets, which it refuses as mixed content: the HTML
     * arrives and the site renders as raw text.
     *
     * Nothing at this layer can fix that for the app - a header cannot become
     * $_SERVER['HTTPS'] - so the redirect is only written when the app is known
     * to be told the real scheme. Otherwise :80 keeps serving the app and the
     * https server below still stands ready for an app that can use it.
     *
     * The one thing this layer CAN do is repair the URLs in the response body,
     * which is what subFilter() below does when https has been forced on. */
    const httpsAware = site.backend !== 'docker' || site.forceHttps === true;
    const port80 = httpsAware
      ? `    location / {\n${www80}        return 301 https://$host$request_uri;\n    }\n`
      : `${body}`;
    return `# letzControl site: ${site.domain} (proxy to ${site.backend}:${port}, SSL)
server {
    listen 80;
${head}
${acmeBlock(site)}${port80}}

server {
    listen 443 ssl http2;
${head}
${sslDirectives(site)}${www443}${body}
}
`;
  }
  return `# letzControl site: ${site.domain} (proxy to ${site.backend}:${port})
server {
    listen 80;
${head}
${acmeBlock(site)}${body}
}
`;
}

function apacheVhost(site) {
  const port = config.ports.apache;
  const phpBlock = site.phpVersion
    ? `
    <FilesMatch \\.php$>
        SetHandler "proxy:unix:${phpSocket(site.phpVersion)}|fcgi://localhost/"
    </FilesMatch>
`
    : '';
  return `# letzControl site: ${site.domain} (backend: apache)
<VirtualHost *:${port}>
    ServerName ${site.domain}
    ${site.www ? `ServerAlias www.${site.domain}` : ''}
    DocumentRoot ${site.docroot}/public

    # Nginx fronts this vhost on 443 and passes the scheme via
    # X-Forwarded-Proto - without this, PHP behind the proxy sees plain
    # HTTP and WordPress redirects wp-login.php to itself forever.
    SetEnvIf X-Forwarded-Proto "^https$" HTTPS=on

    <Directory ${site.docroot}/public>
        Options FollowSymLinks
        AllowOverride All
        DirectoryIndex index.php index.html index.htm
        Require all granted
    </Directory>
${phpBlock}
    ErrorLog \${APACHE_LOG_DIR}/${site.domain}_error.log
    CustomLog \${APACHE_LOG_DIR}/${site.domain}_access.log combined
</VirtualHost>
`;
}

/* LiteSpeed's spelling for loading .htaccess is `RewriteFile`; `autoLoadHtaccess`
 * is the LiteSpeed ENTERPRISE directive and this OpenLiteSpeed build silently
 * ignores it. Keeping RewriteFile here means OLS at least parses the file (and
 * logs it), which is what plugins such as Backuply check for. Note this build
 * does not actually APPLY .htaccess rules to requests - verified against both
 * our vhosts and OLS's own stock Example vhost - so .htaccess must not be the
 * only protection for anything: nginx-level rules carry the real weight. */
function olsVhconf(site, handler) {
  const ini = Object.entries(site.phpIni || {});
  // OLS requires Apache-style php_value / php_flag prefixes - bare "key value"
  // lines are rejected by the config parser ("Not support" errors).
  const iniLine = ([k, v]) => {
    const f = PHP_INI_FIELDS.find((x) => x.key === k);
    return f && f.type === 'bool'
      ? `  php_flag ${k} ${v === '1' ? 'On' : 'Off'}`
      : `  php_value ${k} ${v}`;
  };
  const iniBlock = ini.length
    ? `\nphpIniOverride  {\n${ini.map(iniLine).join('\n')}\n}\n`
    : '';
  return `# letzControl site: ${site.domain} (backend: openlitespeed)
docRoot                   $VH_ROOT/public
vhDomain                  ${site.domain}
vhAliases                 ${site.www ? `www.${site.domain}` : ''}
adminEmails               admin@${site.domain}
enableGzip                1

index  {
  useServer               0
  indexFiles              index.php index.html
}

errorlog $VH_ROOT/logs/error.log {
  useServer               0
  logLevel                WARN
  rollingSize             10M
}

accesslog $VH_ROOT/logs/access.log {
  useServer               0
  logFormat               "%h %l %u %t \\"%r\\" %>s %b"
  rollingSize             10M
}

scripthandler  {
  add                     lsapi:${handler} php
}

rewrite  {
  enable                  1
  RewriteFile             .htaccess
}
${iniBlock}`;
}

/* ------------------------------------------------------------------ */
/* Writers / reloaders                                                 */
/* ------------------------------------------------------------------ */

function nginxPaths(site) {
  return {
    avail: path.join(config.nginx.confDir, 'sites-available', `${site.domain}.conf`),
    enabled: path.join(config.nginx.confDir, 'sites-enabled', `${site.domain}.conf`)
  };
}

function apachePaths(site) {
  return {
    avail: path.join(config.apache.confDir, 'sites-available', `${site.domain}.conf`)
  };
}

/**
 * The port a Node app is reached on.
 *
 * Node apps are fronted by Nginx and each one needs its OWN port - two apps
 * cannot share one. config.ports.node is only a fallback for sites that predate
 * the per-site field. Using it as the answer for every site meant the vhost was
 * written from global config rather than from the site, so on a box running two
 * Node apps, regenerating either vhost repointed it at whichever app happened to
 * be on the configured port. That is exactly what happened here: one site's
 * vhost still said 3001 only because it had been written before
 * config.ports.node was changed to 3100.
 */
function appPort(site) {
  const p = Number(site.appPort);
  return Number.isInteger(p) && p > 0 ? p : Number(config.ports.node);
}

/**
 * Where a proxying vhost forwards to.
 *
 *  nginx has no idea what sits at the far end of proxy_pass - a docker app, a
 *  node app and Apache are all, to it, a port on this machine. The site record
 *  is what knows the difference, so this is the single place that reads it:
 *  node and docker carry their own port, and the named servers are reached on
 *  the port the panel configured for them. Anything else reaching here is not
 *  a proxying backend and would already have been refused on validation.
 */
function proxyTarget(site) {
  return site.backend === 'node' || site.backend === 'docker'
    ? appPort(site)
    : config.ports[site.backend];
}

async function writeNginxVhost(site) {
  const p = nginxPaths(site);
  const content =
    site.backend === 'nginx'
      ? nginxDirect(site)
      : nginxProxy(site, proxyTarget(site));
  /* A WordPress vhost includes snippets/wp-scanner-guard.conf, which nginx does
   * not ship and this panel did not create. Writing the vhost without it leaves
   * a file on disk that cannot be parsed, so every later nginx reload fails and
   * the operator is left with a broken server block and an error that does not
   * mention the real cause. Create-if-absent, never overwriting a hand-edited
   * one. See lib/nginxsnippets.js. */
  if (/include\s+snippets\/wp-scanner-guard\.conf/.test(content)) {
    await snippets.ensureWpGuard();
  }
  await fsp.mkdir(path.dirname(p.avail), { recursive: true });
  await fsp.writeFile(p.avail, content);
  if (site.enabled !== false) {
    await fsp.mkdir(path.dirname(p.enabled), { recursive: true });
    await fsp.rm(p.enabled, { force: true });
    await fsp.symlink(p.avail, p.enabled);
  } else {
    await fsp.rm(p.enabled, { force: true });
  }
}

/**
 * Give every Node site an appPort, taking it from the vhost on disk right now.
 * A Node site created before this field existed has a working vhost pointing at
 * a real port, and that port is the truth - guessing it from config would
 * silently repoint the site at a different application.
 */
async function migrateAppPorts() {
  const sites = db.find('sites', (s) => s.backend === 'node' && !Number.isInteger(s.appPort));
  if (!sites.length) return 0;
  let fixed = 0;
  for (const site of sites) {
    let port = null;
    try {
      const conf = await fsp.readFile(nginxPaths(site).avail, 'utf8');
      const m = conf.match(/proxy_pass\s+http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) port = Number(m[1]);
    } catch { /* no vhost on disk yet */ }
    if (!port) port = Number(config.ports.node);
    db.update('sites', site.id, { appPort: port });
    fixed++;
    console.log(`[letzControl] ${site.domain}: recorded app port ${port}`);
  }
  if (fixed) db.save();
  return fixed;
}

async function ensureApachePort() {
  const portsConf = path.join(config.apache.confDir, 'ports.conf');
  const port = config.ports.apache;
  try {
    let content = await fsp.readFile(portsConf, 'utf8');
    if (!new RegExp(`^\\s*Listen\\s+${port}\\s*$`, 'm').test(content)) {
      content += `\n# Added by letzControl so Apache can run next to Nginx\nListen ${port}\n`;
      await fsp.writeFile(portsConf, content);
    }
  } catch { /* ports.conf missing - nothing to do */ }
}

async function writeApacheVhost(site) {
  await ensureApachePort();
  const p = apachePaths(site);
  await fsp.mkdir(path.dirname(p.avail), { recursive: true });
  await fsp.writeFile(p.avail, apacheVhost(site));
  if (site.enabled !== false) await run(`a2ensite ${site.domain}.conf`);
  else await run(`a2dissite ${site.domain}.conf`);
  // PHP-FPM via proxy_fcgi needs these modules; harmless if already on
  if (site.phpVersion) await run('a2enmod proxy_fcgi setenvif');
}

/** Regenerate letzControl's listener + virtualhost blocks for OLS.
 *  Everything is inlined into httpd_config.conf between marker comments
 *  (OLS include-directive support in the main config is unreliable). */
const OLS_BEGIN = '### BEGIN letzControl - do not edit (generated) ###';
const OLS_END = '### END letzControl ###';

/* Tell lsphp to honor per-site .user.ini files (LiteSpeed requires this env
 * var since PHP LSAPI 6.10). Idempotent - injected once, before regenOLS
 * reads httpd_config.conf so the two writes cannot clobber each other. */
async function ensureUserIniEnv(root) {
  const file = path.join(root, 'conf', 'httpd_config.conf');
  let text;
  try { text = await fsp.readFile(file, 'utf8'); } catch { return; }
  if (text.includes('LSPHP_ENABLE_USER_INI')) return;
  const lines = text.split('\n');
  const i = lines.findIndex((l) => /^extProcessor\s+\S*lsphp\S*\s*\{/.test(l));
  if (i === -1) return;
  lines.splice(i + 1, 0, '    env                             LSPHP_ENABLE_USER_INI=on');
  await fsp.writeFile(file, lines.join('\n'));
}

/* OLS runs lsphp as the server user (nobody) unless told otherwise, while
 * Nginx/Apache PHP-FPM run as www-data. WordPress files therefore need to
 * be writable by BOTH - simplest is to make every PHP process www-data, so
 * one `chown -R www-data` after wp-cli operations keeps wp-admin from
 * asking for FTP credentials, no matter which backend serves the site.
 * Top-level user/group lines only (block members are indented). Idempotent. */
async function ensureOlsWebUser(root) {
  const file = path.join(root, 'conf', 'httpd_config.conf');
  let text;
  try { text = await fsp.readFile(file, 'utf8'); } catch { return; }
  const next = text
    .replace(/^user[ \t]+(\S+)[ \t]*$/m, (m, u) => (u === 'www-data' ? m : 'user                             www-data'))
    .replace(/^group[ \t]+(\S+)[ \t]*$/m, (m, g) => (g === 'www-data' ? m : 'group                            www-data'));
  if (next === text) return;
  await fsp.writeFile(file, next);
  // The lsphp listening socket lives in /tmp/lshttpd, owned by the old user
  await run('chown -R www-data:www-data /tmp/lshttpd');
}

async function regenOLS() {
  const root = config.openlitespeed.root;
  const port = config.ports.openlitespeed;
  await ensureUserIniEnv(root);
  await ensureOlsWebUser(root);
  const sites = db.find('sites', (s) => s.backend === 'openlitespeed' && s.enabled !== false);

  const mainConf = path.join(root, 'conf', 'httpd_config.conf');

  // Per-site vhconf files
  for (const site of sites) {
    const vdir = path.join(root, 'conf', 'vhosts', site.domain);
    await fsp.mkdir(vdir, { recursive: true });
    // The scripthandler must name a processor that exists: resolve the site's
    // PHP version to its lsphp processor, falling back to OLS' default one.
    const handler = olsphp.handlerFor(site.phpVersion) || 'lsphp';
    await fsp.writeFile(path.join(vdir, 'vhconf.conf'), olsVhconf(site, handler));
  }

  // Generated block: one listener + one virtualhost entry per site
  let block = `${OLS_BEGIN}\nlistener letzcontrol {\n  address                 *:${port}\n  secure                  0\n`;
  for (const site of sites) {
    block += `  map                     ${site.domain} ${site.domain}\n`;
    if (site.www) block += `  map                     ${site.domain} www.${site.domain}\n`;
  }
  block += '}\n\n';
  for (const site of sites) {
    block += `virtualhost ${site.domain} {
  vhRoot                  ${site.docroot}
  configFile              $SERVER_ROOT/conf/vhosts/${site.domain}/vhconf.conf
  allowSymbolLink         0
  enableScript            1
  restrained              0
}

`;
  }
  block += OLS_END + '\n';

  try {
    let main = await fsp.readFile(mainConf, 'utf8');
    // Drop a previously generated block, if any
    const b = main.indexOf(OLS_BEGIN);
    const e = main.indexOf(OLS_END);
    if (b !== -1 && e !== -1 && e > b) {
      main = main.slice(0, b) + main.slice(e + OLS_END.length + 1);
    }
    // Drop the legacy include line from older versions
    main = main.replace(/\n?# letzControl managed virtual hosts\ninclude conf\/letzcontrol-vhosts\.conf\n?/g, '\n');
    // The stock "listener Default" sits on our port; only one listener can
    // bind a port, so move the stock one aside (idempotent).
    const stockRe = new RegExp(`(listener\\s+Default\\s*\\{[\\s\\S]*?address\\s+)\\*:${port}\\b`);
    if (stockRe.test(main)) {
      main = main.replace(stockRe, `$1*:${port + 1}`);
    }
    await fsp.writeFile(mainConf, main.trimEnd() + '\n\n' + block);
    // Remove the legacy include file, no longer used
    await fsp.rm(path.join(root, 'conf', 'letzcontrol-vhosts.conf'), { force: true });
  } catch { /* OLS not installed yet */ }
}

async function reloadServers(backends, results) {
  const set = new Set(backends);
  if (set.has('nginx')) {
    const t = await run('nginx -t');
    if (t.ok) {
      const r = await run('systemctl reload nginx');
      results.push({ server: 'nginx', ok: r.ok, output: (r.stdout + r.stderr).trim() || 'reloaded' });
    } else {
      results.push({ server: 'nginx', ok: false, output: (t.stdout + t.stderr).trim() });
    }
  }
  if (set.has('apache')) {
    const t = await run('apachectl configtest');
    if (t.ok || t.stderr.includes('Syntax OK')) {
      const r = await run('systemctl reload apache2');
      results.push({ server: 'apache', ok: r.ok, output: (r.stdout + r.stderr).trim() || 'reloaded' });
    } else {
      results.push({ server: 'apache', ok: false, output: (t.stdout + t.stderr).trim() });
    }
  }
  if (set.has('openlitespeed')) {
    // Full stop -> reap lsphp -> start. A plain graceful restart can leave old
    // lsphp children alive, still serving with a stale php.ini (e.g. modules
    // installed since then never load).
    const ctrl = path.join(config.openlitespeed.root, 'bin', 'lswsctrl');
    await run(`${ctrl} stop || true`);
    await run('pkill -9 -x lsphp || true');
    const r = await run(`${ctrl} start || ${ctrl} restart`);
    results.push({ server: 'openlitespeed', ok: r.ok, output: (r.stdout + r.stderr).trim() || 'restarted' });
  }
}

/* ------------------------------------------------------------------ */
/* Document root                                                       */
/* ------------------------------------------------------------------ */

/* The document root is interpolated into nginx, Apache and OLS config
 * files, so it has to survive being a single directive value. These
 * characters either end the directive early, start a comment, or ask the
 * server to expand something:
 *   ;      ends a directive (nginx, Apache)
 *   #      starts a comment (nginx, OLS)
 *   { }    block delimiters (nginx)
 *   $      variable expansion (nginx, OLS)
 *   " ' `  quoting - a quoted value is legal, but a stray quote turns a
 *          generated line into a broken vhost
 *   \      escape character
 *   space  splits the value into two words, and a newline would let a whole
 *          extra directive be injected
 */
const UNSAFE_DOCROOT_RE = /[\s;{}#$"'`\\]/;

/* Directories that must never become a document root, and nothing inside
 * them. Serving /etc hands out /etc/shadow, the MySQL credentials and the
 * SSH keys; /root holds this panel's own backups. */
const FORBIDDEN_DOCROOT_ROOTS = [
  '/etc', '/root', '/proc', '/sys', '/dev', '/boot',
  '/usr', '/bin', '/sbin', '/lib', '/lib64', '/run',
  '/var/log', '/var/lib', '/var/cache', '/var/spool', '/tmp', '/var/tmp'
];

/* Is `child` the same as `parent`, or somewhere below it? */
function isInside(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/* single-quote shell escaping for values interpolated into a command */
function shq(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

/**
 * Check a proposed document root. Returns an error message, or null when
 * the path is acceptable.
 *
 * The path ends up in server config files and decides what the web server
 * hands to the public, so it is checked on three fronts: the characters
 * that would break the config it lands in, the directories that must never
 * be published, and the folders other sites already use.
 */
function docrootProblem(raw, site, user) {
  const input = String(raw ?? '').trim();
  if (!input) return 'Enter a folder path';
  if (input.length > 200) return 'That path is too long';
  if (UNSAFE_DOCROOT_RE.test(input)) {
    return 'The path may not contain spaces, quotes, $, ;, #, {, }, \\ or other special characters';
  }
  if (!input.startsWith('/')) return 'The path must be absolute, starting with /';
  if (/[\x00-\x1f\x7f]/.test(input)) return 'The path contains control characters';

  /* resolve() collapses "..", so a path that tried to climb out of its own
   * parent now shows up as itself and is caught by the checks below. */
  const resolved = path.resolve(input);

  for (const bad of FORBIDDEN_DOCROOT_ROOTS) {
    if (isInside(resolved, bad)) {
      return `${bad} is a system directory and cannot be served to the public`;
    }
  }
  if (resolved.split('/').filter(Boolean).length < 2) {
    return 'Pick a folder at least two levels deep, for example /var/www/example.com';
  }
  for (const other of db.all('sites')) {
    if (!other.docroot || other.id === site.id) continue;
    /* Two sites must not share a document root, and one must not sit inside
     * the other's: the folder actually published is <docroot>/public, and
     * nesting makes it far too easy for one site to serve another's files. */
    if (isInside(resolved, other.docroot) || isInside(other.docroot, resolved)) {
      return `${other.domain} already uses ${other.docroot}. Two sites cannot share or nest document roots.`;
    }
  }
  if (user.role !== 'admin' && !isInside(resolved, config.sitesRoot)) {
    return `Only an administrator can place a site outside ${config.sitesRoot}`;
  }
  return null;
}

/**
 * Move a directory. rename() is atomic and instant within one filesystem;
 * across filesystems it fails with EXDEV, so the files are copied and the
 * original removed only once the copy has succeeded.
 */
async function moveDirectory(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
    return 'renamed';
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    const cp = await run(`cp -a ${shq(from)} ${shq(to)}`);
    if (!cp.ok) {
      await fsp.rm(to, { recursive: true, force: true });
      throw new Error(`could not copy the files: ${(cp.stderr || cp.error || '').trim()}`);
    }
    await fsp.rm(from, { recursive: true, force: true });
    return 'copied';
  }
}

/**
 * A Node app lives inside its document root, so moving the folder moves the
 * app - and the systemd unit that starts it still points at the old path.
 * Rewrite WorkingDirectory when it points into the old docroot; leave the
 * unit alone when it points elsewhere, because then the app did not move.
 */
async function moveNodeUnit(site, oldDocroot, newDocroot) {
  if (site.backend !== 'node') return null;
  // Required lazily: nodeapps requires sites back, and a top-level require
  // here would make the two modules load in an order that leaves one of
  // them half-initialised.
  const { unitName } = require('./nodeapps');
  const unit = unitName(site.domain);
  const unitPath = path.join('/etc/systemd/system', `${unit}.service`);
  let text;
  try { text = await fsp.readFile(unitPath, 'utf8'); } catch { return null; }
  const m = text.match(/^[ \t]*WorkingDirectory[ \t]*=(.*)$/m);
  if (!m) return null;
  const current = m[1].trim();
  if (!current.startsWith('/') || /[\r\n]/.test(current)) return null;
  if (!isInside(current, oldDocroot)) return null;   // the app did not move
  const next = path.join(newDocroot, path.relative(oldDocroot, current));
  if (/[\r\n]/.test(next)) return null;
  const updated = text.replace(
    /^([ \t]*WorkingDirectory[ \t]*=).*$/m,
    (_mm, p1) => `${p1} ${next}`
  );
  // Keep the first original: a rollback calls this again in reverse, and the
  // backup must not be overwritten with the half-moved text.
  const backup = `${unitPath}.pre-docroot-move`;
  if (!fs.existsSync(backup)) await fsp.writeFile(backup, text, { mode: 0o644 });
  await fsp.writeFile(unitPath, updated, { mode: 0o644 });
  await run('systemctl daemon-reload');
  const st = await run(`systemctl restart ${unit}`);
  return {
    server: unit,
    ok: st.ok,
    output: st.ok
      ? `WorkingDirectory -> ${next}`
      : ((st.stdout + st.stderr).trim() || 'the service did not restart')
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function canAccess(req, site) {
  return req.user.role === 'admin' || site.ownerId === req.user.id;
}

function placeholderPage(domain) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${domain}</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
div{text-align:center}h1{color:#34d399}</style></head>
<body><div><h1>&#9889; ${domain}</h1><p>Website provisioned by letzControl. Replace this file in <code>public/</code>.</p></div></body></html>
`;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

router.get('/backends', async (_req, res) => {
  res.json({ backends: await detectBackends(), ports: config.ports });
});

router.get('/', (req, res) => {
  const sites = req.user.role === 'admin'
    ? db.all('sites')
    : db.find('sites', (s) => s.ownerId === req.user.id);
  res.json({
    sites: sites.map((s) => {
      const owner = db.get('users', s.ownerId);
      return { ...s, owner: owner ? owner.username : '?' };
    })
  });
});

/* ------------------------------------------------------------------ */
/* Site health                                                         */
/* ------------------------------------------------------------------ */

/* Whether a site is actually answering right now.
 *
 * A site record says what is configured; this says whether it works, which
 * is the question a customer actually has. The probe goes to the local
 * server with the site's own Host header and SNI, so it exercises the same
 * vhost and the same backend a visitor would get - without going out to the
 * internet and back.
 *
 * The answers are cached briefly: a dashboard reload should not turn into
 * one request per site per refresh, and a customer should not be able to
 * use refreshes to pin the server.
 */
const HEALTH_TTL = 60_000;
const healthCache = { at: 0, byId: new Map() };

/* Probe a site with curl rather than from inside the panel's own process.
 *
 * Two reasons, both learned the hard way:
 *
 *  - Asking for "/" on a WordPress site boots PHP, every plugin and the
 *    whole object cache - about a second and a lot of memory per site. Six
 *    of those at once on a busy box overruns any sensible timeout and every
 *    site looks down. A static file is a fast answer straight from the web
 *    server, and it still proves the vhost and the server are replying.
 *
 *  - An HTTP client inside the panel process could open a socket and finish
 *    the TLS handshake and then never receive a response, on a box where the
 *    same request from a separate process answered in 40 ms. The panel
 *    already shells out for everything else it needs to know about the box
 *    (wp-cli, systemctl, mysqldump, certbot), so asking curl is both
 *    consistent and the thing that demonstrably works.
 *
 * The request goes to the local server with the site's own name, so it
 * exercises the same vhost and the same backend a visitor would get without
 * going out to the internet and back.
 */
async function probeSite(site) {
  if (site.enabled === false) return { status: 'disabled', code: 0, ms: 0 };
  const started = Date.now();
  const scheme = site.ssl ? 'https' : 'http';
  const port = site.ssl ? 443 : 80;
  const cmd = `curl -s -o /dev/null -m 8 -k ` +
    `--resolve ${shq(`${site.domain}:${port}:127.0.0.1`)} ` +
    `-w '%{http_code}' ${shq(`${scheme}://${site.domain}/favicon.ico`)}`;
  const r = await run(cmd);
  const code = Number((r.stdout || '').trim()) || 0;
  const ms = Date.now() - started;
  /* Any answer counts: a 404 still means the server and the vhost replied,
   * which is what this check is asking. No answer at all means it did not. */
  if (!code) return { status: 'down', code: 0, ms };
  return { status: code < 500 ? 'up' : 'error', code, ms };
}

router.get('/health', async (req, res) => {
  const sites = req.user.role === 'admin'
    ? db.all('sites')
    : db.find('sites', (s) => s.ownerId === req.user.id);

  /* The probe results are the same for everyone, so they are cached once and
   * filtered per account. */
  const fresh = Date.now() - healthCache.at < HEALTH_TTL;
  if (!fresh) {
    const results = await Promise.all(sites.map(async (s) => {
      const h = await probeSite(s);
      healthCache.byId.set(s.id, h);
      return h;
    }));
    void results;
    healthCache.at = Date.now();
  } else {
    /* A site with no cached result is one added since the cache was filled. */
    await Promise.all(sites.filter((s) => !healthCache.byId.has(s.id)).map(async (s) => {
      healthCache.byId.set(s.id, await probeSite(s));
    }));
  }

  res.json({
    sites: sites.map((s) => ({
      id: s.id,
      domain: s.domain,
      backend: s.backend,
      ssl: !!s.ssl,
      enabled: s.enabled !== false,
      ...(healthCache.byId.get(s.id) || { status: 'unknown', code: 0, ms: 0 })
    }))
  });
});

router.post('/', async (req, res) => {
  const { domain, backend, phpVersion, www = true } = req.body || {};
  const d = String(domain || '').toLowerCase().trim();

  if (!DOMAIN_RE.test(d)) return res.status(400).json({ error: 'Invalid domain name' });
  if (!BACKENDS.includes(backend)) return res.status(400).json({ error: 'Invalid backend server' });
  if (phpVersion && !PHP_RE.test(String(phpVersion))) return res.status(400).json({ error: 'Invalid PHP version' });
  if (db.findOne('sites', (s) => s.domain === d)) return res.status(409).json({ error: 'This domain already exists' });

  const limit = checkLimit(req.user, 'sites');
  if (!limit.ok) return res.status(403).json({ error: limit.error });

  // Admins may create sites for another panel user
  let ownerId = req.user.id;
  const reqOwner = (req.body || {}).ownerId;
  if (reqOwner && reqOwner !== req.user.id) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can choose an owner' });
    const owner = db.get('users', reqOwner);
    if (!owner) return res.status(400).json({ error: 'Unknown owner' });
    ownerId = owner.id;
  }

  const installed = await detectBackends();
  if (!installed[backend]) {
    return res.status(400).json({ error: `${backend} is not installed on this server` });
  }

  const phpErr = assertPhpUsable(backend, phpVersion);
  if (phpErr) return res.status(400).json({ error: phpErr });

  let docroot = path.join(config.sitesRoot, d);
  if ((req.body || {}).docroot) {
    // The site does not exist yet, so it cannot clash with itself.
    const problem = docrootProblem(req.body.docroot, { id: '__new__' }, req.user);
    if (problem) return res.status(400).json({ error: problem });
    docroot = path.resolve(String(req.body.docroot).trim());
  }
  try {
    await fsp.mkdir(path.join(docroot, 'public'), { recursive: true });
    await fsp.mkdir(path.join(docroot, 'logs'), { recursive: true });
    // Never drop a placeholder into a node site's docroot: nginx proxies
    // straight to the app, and a stray index.html there would just confuse
    // whoever deploys the app next.
    if (!NO_PHP_BACKENDS.includes(backend)) {
      await fsp.writeFile(path.join(docroot, 'public', 'index.html'), placeholderPage(d), { flag: 'wx' }).catch(() => {});
    }
  } catch (e) {
    return res.status(500).json({ error: `Could not create docroot: ${e.message}` });
  }

  const site = db.insert('sites', {
    domain: d,
    backend,
    phpVersion: phpVersion || null,
    www: !!www,
    docroot,
    ssl: false,
    enabled: true,
    ownerId
  });

  const results = [];
  try {
    if (backend === 'apache') await writeApacheVhost(site);
    if (backend === 'openlitespeed') await regenOLS();
    if (installed.nginx) await writeNginxVhost(site);
    await reloadServers(['nginx', backend].filter((s) => s !== 'node'), results);
  } catch (e) {
    db.remove('sites', site.id);
    return res.status(500).json({ error: `Failed to write vhost: ${e.message}` });
  }

  res.status(201).json({ site, results });
});

/* Fields offered by the visual php.ini editor (single source of truth) */
router.get('/phpini/fields', (_req, res) => {
  res.json({ fields: PHP_INI_FIELDS });
});

/* Save visual php.ini settings for a site.
 * Nginx/Apache sites: written to <docroot>/public/.user.ini (FPM reads it).
 * OpenLiteSpeed sites: applied via phpIniOverride in the vhost config. */
router.post('/:id/phpini', async (req, res) => {
  const site = db.get('sites', req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  if (!canAccess(req, site)) return res.status(403).json({ error: 'Not your site' });
  if (NO_PHP_BACKENDS.includes(site.backend)) {
    return res.status(400).json({ error: `This site is served by its own application on port ${config.ports[site.backend]} and does not use PHP - there is no php.ini to configure.` });
  }

  const ini = sanitizePhpIni((req.body || {}).settings);
  if (typeof ini === 'string') return res.status(400).json({ error: ini });

  db.update('sites', site.id, { phpIni: ini });
  const updated = db.get('sites', site.id);

  const results = [];
  try {
    await writeUserIni(updated);
    const installed = await detectBackends();
    if (updated.backend === 'openlitespeed') {
      await regenOLS();
      await reloadServers(['openlitespeed'], results);
    }
    if (updated.phpVersion && updated.backend !== 'openlitespeed') {
      // flush FPM's .user.ini directory cache so changes apply immediately
      // (OLS applies them through its own vhost reload + lsphp restart)
      const r = await run(`systemctl restart php${updated.phpVersion}-fpm`);
      results.push({ server: `php${updated.phpVersion}-fpm`, ok: r.ok, output: (r.stdout + r.stderr).trim() || 'restarted' });
    }
  } catch (e) {
    return res.status(500).json({ error: `Failed to apply php.ini: ${e.message}`, results });
  }
  res.json({ site: updated, results });
});

/* Edit site settings: switch "served by", change PHP version or www alias.
 * Configs of the old backend are removed, configs of the new one written,
 * then every affected server is reloaded. */
router.put('/:id', async (req, res) => {
  const site = db.get('sites', req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  if (!canAccess(req, site)) return res.status(403).json({ error: 'Not your site' });

  const { backend, phpVersion, www, ownerId } = req.body || {};
  const newBackend = backend === undefined ? site.backend : backend;
  if (!BACKENDS.includes(newBackend)) return res.status(400).json({ error: 'Invalid backend server' });
  const newPhp = phpVersion === undefined ? site.phpVersion : (phpVersion || null);
  if (newPhp && !PHP_RE.test(String(newPhp))) return res.status(400).json({ error: 'Invalid PHP version' });
  const newWww = www === undefined ? site.www : !!www;

  const patch = { backend: newBackend, phpVersion: newPhp, www: newWww };
  if (ownerId !== undefined && ownerId !== null && ownerId !== '') {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can change ownership' });
    const owner = db.get('users', ownerId);
    if (!owner) return res.status(400).json({ error: 'Unknown owner' });
    patch.ownerId = owner.id;
  }

  const installed = await detectBackends();
  if (!installed[newBackend]) {
    return res.status(400).json({ error: `${newBackend} is not installed on this server` });
  }

  const phpErr = assertPhpUsable(newBackend, newPhp);
  if (phpErr) return res.status(400).json({ error: phpErr });

  const oldBackend = site.backend;
  db.update('sites', site.id, patch);
  const updated = db.get('sites', site.id);

  const results = [];
  try {
    // remove configs that no longer apply after a backend switch
    if (oldBackend === 'apache' && newBackend !== 'apache') {
      await run(`a2dissite ${site.domain}.conf`);
      await fsp.rm(apachePaths(site).avail, { force: true });
    }
    if (oldBackend === 'openlitespeed' && newBackend !== 'openlitespeed') {
      await fsp.rm(path.join(config.openlitespeed.root, 'conf', 'vhosts', site.domain), { recursive: true, force: true });
      await regenOLS();
    }
    // write configs for the current state ('node' has none of its own - the
    // panel only proxies to the app, so writing the nginx vhost is enough)
    if (newBackend === 'apache') await writeApacheVhost(updated);
    if (newBackend === 'openlitespeed') await regenOLS();
    if (installed.nginx) await writeNginxVhost(updated);
    // a leftover .user.ini would sit in a PHP-less docroot forever
    if (NO_PHP_BACKENDS.includes(newBackend)) await writeUserIni(updated);
    const servers = [...new Set(['nginx', oldBackend, newBackend]
      .filter((s) => installed[s] && s !== 'node'))];
    await reloadServers(servers, results);
  } catch (e) {
    return res.status(500).json({ error: `Failed to apply settings: ${e.message}`, results });
  }
  res.json({ site: updated, results });
});

/**
 * Change the folder a site is served from.
 *
 * The document root decides what the web server hands to the public, so this
 * is a deliberate operation: the folder is validated, the files are moved
 * (or deliberately left where they are), the vhost is rewritten and the
 * servers are reloaded. If any of that fails, the files and the record are
 * put back the way they were.
 */
router.put('/:id/docroot', async (req, res) => {
  const site = db.get('sites', req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  if (!canAccess(req, site)) return res.status(403).json({ error: 'Not your site' });

  const body = req.body || {};
  const moveFiles = body.moveFiles !== false;
  const problem = docrootProblem(body.docroot, site, req.user);
  if (problem) return res.status(400).json({ error: problem });

  const oldDocroot = site.docroot;
  const newDocroot = path.resolve(String(body.docroot).trim());
  if (newDocroot === path.resolve(oldDocroot)) {
    return res.status(400).json({ error: 'The site already uses this folder' });
  }

  /* Moving into a folder that already holds something would merge two
   * document roots together, so the target has to be empty or absent. */
  if (moveFiles && fs.existsSync(newDocroot)) {
    const entries = await fsp.readdir(newDocroot);
    if (entries.length) {
      return res.status(400).json({
        error: `${newDocroot} already exists and is not empty. Choose an empty folder, ` +
               'or untick "move the files" to point the site at it as it is.'
      });
    }
  }

  const results = [];
  let moved = false;
  try {
    if (moveFiles && fs.existsSync(oldDocroot)) {
      await moveDirectory(oldDocroot, newDocroot);
      moved = true;
    } else {
      await fsp.mkdir(path.join(newDocroot, 'public'), { recursive: true });
      await fsp.mkdir(path.join(newDocroot, 'logs'), { recursive: true });
    }
  } catch (e) {
    return res.status(500).json({ error: `Could not prepare the new folder: ${e.message}` });
  }

  db.update('sites', site.id, { docroot: newDocroot });
  const updated = db.get('sites', site.id);

  try {
    /* The .user.ini belongs to the folder, not to the site record. When the
     * files were moved it travelled with them, so only the stale copy in the
     * old folder needs clearing. */
    if (!moved) {
      await fsp.rm(path.join(oldDocroot, 'public', '.user.ini'), { force: true });
    }
    await writeUserIni(updated);

    const installed = await detectBackends();
    if (updated.backend === 'apache') await writeApacheVhost(updated);
    if (updated.backend === 'openlitespeed') await regenOLS();
    if (installed.nginx) await writeNginxVhost(updated);

    const unit = await moveNodeUnit(updated, oldDocroot, newDocroot);
    if (unit) results.push(unit);

    await reloadServers(['nginx', updated.backend].filter((s) => s !== 'node'), results);
  } catch (e) {
    /* Put the files and the record back the way they were. A site left
     * pointing at a folder that no longer holds its files is worse than one
     * that never changed. */
    db.update('sites', site.id, { docroot: oldDocroot });
    if (moved) {
      try { await moveDirectory(newDocroot, oldDocroot); } catch { /* keep going */ }
    }
    const reverted = db.get('sites', site.id);
    try {
      await writeUserIni(reverted);
      // The unit was already rewritten, so point it back at the old path.
      await moveNodeUnit(reverted, newDocroot, oldDocroot);
      const installed = await detectBackends();
      if (reverted.backend === 'apache') await writeApacheVhost(reverted);
      if (reverted.backend === 'openlitespeed') await regenOLS();
      if (installed.nginx) await writeNginxVhost(reverted);
      await reloadServers(['nginx', reverted.backend].filter((s) => s !== 'node'), results);
    } catch { /* the original error is the useful one */ }
    return res.status(500).json({
      error: `Failed to apply the new folder - the site was left on ${oldDocroot}: ${e.message}`,
      results
    });
  }

  res.json({ site: updated, results, moved, previousDocroot: oldDocroot });
});

router.post('/:id/toggle', async (req, res) => {
  const site = db.get('sites', req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  if (!canAccess(req, site)) return res.status(403).json({ error: 'Not your site' });

  site.enabled = site.enabled === false; // flip
  db.save();

  const results = [];
  const installed = await detectBackends();
  try {
    if (site.backend === 'apache') await writeApacheVhost(site);
    if (site.backend === 'openlitespeed') await regenOLS();
    if (installed.nginx) await writeNginxVhost(site);
    await reloadServers(['nginx', site.backend].filter((s) => s !== 'node'), results);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ site, results });
});

router.post('/:id/ssl', async (req, res) => {
  const site = db.get('sites', req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  if (!canAccess(req, site)) return res.status(403).json({ error: 'Not your site' });

  const installed = await detectBackends();
  if (!installed.nginx) {
    return res.status(400).json({ error: 'SSL requires Nginx (the front server) to be installed' });
  }
  const domains = site.www ? `-d ${site.domain} -d www.${site.domain}` : `-d ${site.domain}`;
  const email = config.certbotEmail
    ? `-m ${config.certbotEmail} --agree-tos`
    : '--register-unsafely-without-email --agree-tos';
  /* certonly + --nginx plugin: validates via nginx but never saves config
   * changes - the panel owns the vhost files. --expand lets an existing
   * certificate grow to cover www; --allow-subset-of-names keeps issuance
   * succeeding when an alias (e.g. www) has no DNS record yet. */
  const r = await run(
    `certbot certonly --nginx ${domains} ${email} --cert-name ${site.domain} ` +
    '--expand --allow-subset-of-names --non-interactive',
    { timeout: 180_000 }
  );
  if (!r.ok) {
    return res.json({ ok: false, output: (r.stdout + r.stderr).trim() });
  }
  db.update('sites', site.id, { ssl: true });

  // Auto-reload nginx when this cert renews, so renewed certs actually get
  // picked up without anyone touching the panel (idempotent per lineage).
  try {
    const rc = path.join('/etc/letsencrypt/renewal', `${site.domain}.conf`);
    let conf = await fsp.readFile(rc, 'utf8');
    if (!conf.includes('deploy_hook')) {
      conf = conf.replace('[renewalparams]', '[renewalparams]\ndeploy_hook = systemctl reload nginx');
      await fsp.writeFile(rc, conf);
    }
  } catch { /* no renewal config yet - nothing to do */ }

  // Cert is on disk now: regenerate the vhost so it gains the 443 block,
  // then reload nginx (config is tested first by reloadServers).
  const results = [];
  let warning;
  try {
    await writeNginxVhost(db.get('sites', site.id));
    await reloadServers(['nginx'], results);
  } catch (e) {
    warning = `Certificate issued, but applying it failed: ${e.message}`;
  }
  res.json({ ok: true, output: (r.stdout + r.stderr).trim(), results, warning });
});

router.delete('/:id', async (req, res) => {
  const site = db.get('sites', req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  if (!canAccess(req, site)) return res.status(403).json({ error: 'Not your site' });

  const results = [];
  const installed = await detectBackends();
  try {
    if (site.backend === 'apache') {
      await run(`a2dissite ${site.domain}.conf`);
      await fsp.rm(apachePaths(site).avail, { force: true });
    }
    if (installed.nginx) {
      const p = nginxPaths(site);
      await fsp.rm(p.enabled, { force: true });
      await fsp.rm(p.avail, { force: true });
    }
    if (site.backend === 'openlitespeed') {
      await fsp.rm(path.join(config.openlitespeed.root, 'conf', 'vhosts', site.domain), { recursive: true, force: true });
    }
    db.remove('sites', site.id);
    if (site.backend === 'openlitespeed') await regenOLS(); // regenerate without this site
    await reloadServers(['nginx', site.backend], results);

    if (req.query.deleteFiles === 'true') {
      await fsp.rm(site.docroot, { recursive: true, force: true });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ ok: true, results });
});

module.exports = {
  router, migrateAppPorts, appPort, proxyTarget, writeNginxVhost,
  reloadServers, nginxPaths, DOMAIN_RE
};
