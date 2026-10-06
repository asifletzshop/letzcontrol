'use strict';
/**
 * Setup wizard: detect & install server components (nginx, apache, php,
 * mariadb, certbot, openlitespeed, docker) with a live-output job runner.
 * Admin-only; component ids are whitelisted - no user input reaches the shell.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('../config');
const { requireAdmin } = require('./auth');
const { run } = require('./exec');

const router = express.Router();
router.use(requireAdmin);

const APT = 'DEBIAN_FRONTEND=noninteractive apt-get install -y';
const PMA_VERSION = '5.2.3'; // phpMyAdmin stable; supports PHP 7.2 - 8.3

const COMPONENTS = {
  nginx: {
    name: 'Nginx',
    description: 'Front web server on ports 80/443. Serves its own sites directly and reverse-proxies Apache / OpenLiteSpeed sites.',
    steps: [`${APT} nginx`],
    async detect() {
      const r = await run('command -v nginx && nginx -v 2>&1');
      return { installed: r.ok, version: (r.stdout + r.stderr).match(/nginx\/([\d.]+)/)?.[1] || '' };
    }
  },
  apache: {
    name: 'Apache',
    description: 'Backend web server, moved to port 8080 automatically so it runs next to Nginx.',
    steps: [
      `${APT} apache2`,
      "sed -i -E 's/^Listen 80\\b/Listen 8080/' /etc/apache2/ports.conf",
      "sed -i -E 's/<VirtualHost \\*:80>/<VirtualHost *:8080>/' /etc/apache2/sites-available/000-default.conf",
      'a2dissite 000-default default-ssl 2>/dev/null || true',
      'a2enmod proxy_fcgi setenvif rewrite',
      'systemctl restart apache2'
    ],
    async detect() {
      const r = await run('command -v apache2ctl && apache2ctl -v 2>&1 | head -1');
      return { installed: r.ok, version: (r.stdout.match(/Apache\/([\d.]+)/) || [])[1] || '' };
    }
  },
  php: {
    name: 'PHP 8.3 (FPM)',
    description: 'PHP-FPM + common extensions (mysql, mbstring, xml, curl, gd, zip, intl, bcmath). More versions can be added later via the ondrej PPA.',
    steps: [`${APT} php8.3-fpm php8.3-cli php8.3-mysql php8.3-mbstring php8.3-xml php8.3-curl php8.3-gd php8.3-zip php8.3-intl php8.3-bcmath`],
    async detect() {
      const r = await run('php -v 2>/dev/null | head -1');
      return { installed: r.ok && !!r.stdout, version: (r.stdout.match(/PHP ([\d.]+)/) || [])[1] || '' };
    }
  },
  mariadb: {
    name: 'MariaDB (MySQL)',
    description: 'Database server for the Databases module. Root uses unix-socket auth; the panel is configured automatically.',
    steps: [`${APT} mariadb-server`, 'systemctl enable --now mariadb || systemctl enable --now mysql || true'],
    async detect() {
      const r = await run('command -v mariadbd || command -v mysqld');
      const v = await run('mysql --version 2>/dev/null');
      return { installed: r.ok, version: (v.stdout.match(/Ver ([\d.]+)/) || [])[1] || '' };
    },
    async post(log) {
      const t = await run('mysql -uroot -e "SELECT 1" 2>/dev/null');
      if (t.ok) {
        try {
          const cfgFile = path.join(__dirname, '..', 'config.json');
          const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
          raw.mysql = { ...(raw.mysql || {}), socketPath: '/var/run/mysqld/mysqld.sock' };
          fs.writeFileSync(cfgFile, JSON.stringify(raw, null, 2));
          config.mysql.socketPath = '/var/run/mysqld/mysqld.sock';
          log('Panel MySQL connection configured via unix socket.\n');
        } catch (e) {
          log(`Could not update config.json: ${e.message}\n`);
        }
      } else {
        log('NOTE: root socket login failed - set MySQL credentials in config.json manually.\n');
      }
    }
  },
  certbot: {
    name: 'Certbot (SSL)',
    description: "Let's Encrypt certificates for your websites (nginx plugin). Set certbotEmail in config.json for expiry notices.",
    steps: [`${APT} certbot python3-certbot-nginx`],
    async detect() {
      const r = await run('command -v certbot');
      if (!r.ok) return { installed: false, version: '' };
      // `certbot --version` boots the entire Python app (~1.6s - by far the
      // slowest detect); the dpkg package version is the same number (~60ms).
      const v = await run("dpkg-query -W -f '${Version}' certbot 2>/dev/null");
      return { installed: true, version: v.stdout.trim().replace(/[-~].*$/, '') };
    }
  },
  bind9: {
    name: 'BIND9 (DNS server)',
    description: 'Authoritative DNS server so the DNS module can host zones for your websites. Delegate once at your registrar (NS + glue pointing here).',
    steps: [
      `${APT} bind9 bind9utils dnsutils`,
      'systemctl enable --now named 2>/dev/null || systemctl enable --now bind9'
    ],
    async detect() {
      const r = await run('command -v named-checkzone && command -v named');
      if (!r.ok) return { installed: false, version: '' };
      const v = await run('named -v 2>/dev/null | head -1');
      return { installed: true, version: (v.stdout.match(/[\d.]+/) || [])[0] || '' };
    }
  },
  openlitespeed: {
    name: 'OpenLiteSpeed',
    description: 'Backend web server on port 8088 (admin console on 7080). Adds the official LiteSpeed apt repository.',
    steps: [
      `${APT} wget curl`,
      'wget -qO - https://repo.litespeed.sh | bash',
      `${APT} openlitespeed`,
      // lsphp ships WITHOUT curl/intl/redis, but WordPress plugins (Google
      // OAuth / Drive logins, ARMember social) call curl_init() directly and
      // fatal on OLS only - system PHP has these, so backends look unequal.
      `for d in ${config.openlitespeed.root}/lsphp*; do [ -d "$d" ] || continue; v=$(basename "$d"); if apt-cache show "$v-curl" >/dev/null 2>&1; then ${APT} "$v-curl" "$v-intl" "$v-redis"; fi; done`,
      `${path.join(config.openlitespeed.root, 'bin', 'lswsctrl')} start || true`
    ],
    async detect() {
      const installed = fs.existsSync(path.join(config.openlitespeed.root, 'bin', 'lswsctrl'));
      let version = '';
      if (installed) {
        const v = await run(path.join(config.openlitespeed.root, 'bin', 'lshttpd') + ' -v 2>&1 | head -1');
        version = (v.stdout.match(/([\d.]+)/) || [])[1] || '';
      }
      return { installed, version };
    }
  },
  docker: {
    name: 'Docker',
    description: 'Container engine for the Docker module.',
    steps: [`${APT} docker.io`, 'systemctl enable --now docker'],
    async detect() {
      const r = await run('command -v docker && docker --version 2>/dev/null');
      return { installed: r.ok, version: (r.stdout.match(/version ([\d.]+)/) || [])[1] || '' };
    }
  },
  nodejs: {
    name: 'Node.js',
    description: 'JavaScript runtime for the panel and Node.js apps. Installs NodeSource 22 LTS when missing; an existing modern Node is kept as-is.',
    steps: [
      `${APT} ca-certificates curl`,
      'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -',
      `${APT} nodejs`
    ],
    async detect() {
      const r = await run('node -v 2>/dev/null');
      const major = parseInt((r.stdout.match(/^v(\d+)/) || [])[1] || '0', 10);
      return { installed: r.ok && major >= 18, version: r.stdout.trim().replace(/^v/, '') };
    }
  },
  redis: {
    name: 'Redis',
    description: 'In-memory cache / key-value store used by apps for sessions, queues and object caching.',
    steps: [
      `${APT} redis-server`,
      'systemctl enable --now redis-server 2>/dev/null || systemctl enable --now redis'
    ],
    async detect() {
      const ping = await run('redis-cli ping 2>/dev/null');
      const v = await run('redis-server --version 2>/dev/null');
      return {
        installed: ping.ok && /PONG/.test(ping.stdout),
        version: (v.stdout.match(/v=([\d.]+)/) || [])[1] || ''
      };
    }
  },
  mail: {
    name: 'Mail server (Postfix + Dovecot + DKIM)',
    description: 'SMTP, IMAP & POP3 with virtual mailboxes stored in MariaDB, OpenDKIM signing, submission on 587/465. Create mailboxes afterwards in the Mail section.',
    steps: [
      'echo "postfix postfix/main_mailer_type select Internet Site" | debconf-set-selections',
      'echo "postfix postfix/mailname string $(hostname -f 2>/dev/null || hostname)" | debconf-set-selections',
      `${APT} postfix postfix-mysql dovecot-imapd dovecot-pop3d dovecot-lmtpd dovecot-mysql libsasl2-modules opendkim opendkim-tools ssl-cert`
    ],
    async detect() {
      const bins = await run('command -v postfix && command -v dovecot && command -v opendkim');
      const marker = fs.existsSync('/etc/letzcontrol/mail-configured');
      const v = await run('postconf -d mail_version 2>/dev/null');
      return {
        installed: bins.ok && marker,
        version: (v.stdout.match(/mail_version = ([\d.]+)/) || [])[1] || ''
      };
    },
    post: (log) => configureMail(log)
  },
  webmail: {
    name: 'Webmail (Roundcube)',
    description: 'Roundcube webmail served by nginx on port 2088 (http://<server-ip>:2088) for the mailboxes created in the Mail section.',
    steps: [`${APT} roundcube roundcube-core roundcube-mysql roundcube-plugins`],
    async detect() {
      const cfg = fs.existsSync('/etc/roundcube/config.inc.php');
      const marker = fs.existsSync('/etc/letzcontrol/webmail-configured');
      const v = await run('dpkg-query -W -f \'${Version}\' roundcube-core 2>/dev/null');
      return { installed: cfg && marker, version: v.stdout.trim() };
    },
    post: (log) => configureWebmail(log)
  },
  phpmyadmin: {
    name: 'phpMyAdmin',
    description: 'Web interface for browsing & managing your MySQL databases on port 2089 (http://<server-ip>:2089). Also linked from the Databases section.',
    steps: [
      'mkdir -p /var/www/phpmyadmin',
      `curl -fsSL --retry 3 -o /tmp/phpmyadmin.tgz https://files.phpmyadmin.net/phpMyAdmin/${PMA_VERSION}/phpMyAdmin-${PMA_VERSION}-all-languages.tar.gz || curl -fsSL --retry 3 -o /tmp/phpmyadmin.tgz https://github.com/phpmyadmin/phpmyadmin/releases/download/${PMA_VERSION}/phpMyAdmin-${PMA_VERSION}-all-languages.tar.gz`,
      'rm -rf /var/www/phpmyadmin.new /var/www/phpmyadmin.old && mkdir -p /var/www/phpmyadmin.new && tar -xzf /tmp/phpmyadmin.tgz -C /var/www/phpmyadmin.new --strip-components=1 && { mv /var/www/phpmyadmin /var/www/phpmyadmin.old 2>/dev/null || true; } && mv /var/www/phpmyadmin.new /var/www/phpmyadmin && rm -rf /var/www/phpmyadmin.old /tmp/phpmyadmin.tgz',
      'chown -R www-data:www-data /var/www/phpmyadmin && chmod 755 /var/www/phpmyadmin'
    ],
    async detect() {
      const installed = fs.existsSync('/var/www/phpmyadmin/index.php')
        && fs.existsSync('/etc/nginx/sites-enabled/phpmyadmin.conf');
      let version = '';
      try { version = fs.readFileSync('/etc/letzcontrol/phpmyadmin-version', 'utf8').trim(); } catch { /* no marker */ }
      return { installed, version };
    },
    post: (log) => configurePhpMyAdmin(log)
  }
};

/* --------------------------- mail configuration -------------------------- */

/** Single shell-quote helper for values interpolated into commands. */
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

/**
 * Full mail stack configuration: MariaDB schema, Postfix virtual domains
 * via mysql maps, Dovecot SQL auth (SHA512-CRYPT), OpenDKIM milter, and
 * submission ports. Idempotent - safe to re-run after deleting the marker.
 */
async function configureMail(log) {
  const step = async (label, cmd) => {
    const r = await run(cmd, { timeout: 180_000 });
    if (!r.ok) throw new Error(`${label} failed: ${(r.error || '').slice(0, 600)}`);
    log(`  ok: ${label}\n`);
    return r;
  };

  const hn = ((await run('hostname -f 2>/dev/null')).stdout || '').trim()
    || ((await run('hostname')).stdout || '').trim()
    || 'localhost';
  const dbPass = crypto.randomBytes(18).toString('base64url');

  await step('Create mail database + mailbox table', `mysql -uroot -e ${shq(`
    CREATE DATABASE IF NOT EXISTS mailserver CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    USE mailserver;
    CREATE TABLE IF NOT EXISTS mailboxes (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(190) NOT NULL,
      domain VARCHAR(190) NOT NULL,
      password VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_username (username),
      KEY idx_domain (domain)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    CREATE USER IF NOT EXISTS 'mail'@'localhost' IDENTIFIED BY '${dbPass}';
    ALTER USER 'mail'@'localhost' IDENTIFIED BY '${dbPass}';
    GRANT SELECT, INSERT, UPDATE, DELETE ON mailserver.* TO 'mail'@'localhost';
    FLUSH PRIVILEGES;
  `)}`);

  await step('Configure Postfix', `postconf -e ${[
    `myhostname = ${hn}`,
    `mydomain = ${hn}`,
    'myorigin = $mydomain',
    'inet_interfaces = all',
    'inet_protocols = ipv4',
    'mydestination = $myhostname, localhost.$mydomain, localhost',
    'virtual_mailbox_domains = mysql:/etc/postfix/mysql-virtual-mailbox-domains.cf',
    'virtual_mailbox_maps = mysql:/etc/postfix/mysql-virtual-mailbox-maps.cf',
    'virtual_mailbox_base = /var/vmail',
    'virtual_transport = lmtp:unix:private/dovecot-lmtp',
    'mailbox_transport =',
    'smtpd_sasl_auth_enable = yes',
    'smtpd_sasl_security_options = noanonymous',
    'smtpd_sasl_type = dovecot',
    'smtpd_sasl_path = private/auth',
    'smtpd_tls_cert_file = /etc/ssl/certs/ssl-cert-snakeoil.pem',
    'smtpd_tls_key_file = /etc/ssl/private/ssl-cert-snakeoil.key',
    'smtpd_tls_security_level = may',
    'smtp_tls_security_level = may',
    'milter_protocol = 6',
    'milter_default_action = accept',
    'smtpd_milters = inet:localhost:8891',
    'non_smtpd_milters = $smtpd_milters',
    'mailbox_size_limit = 0',
    'home_mailbox ='
  ].map(shq).join(' ')}`);

  await step('Submission ports 587 (STARTTLS) & 465 (implicit TLS)', `
grep -q '^submission inet' /etc/postfix/master.cf || cat >> /etc/postfix/master.cf <<'EOF'
submission inet n       -       y       -       -       smtpd
  -o syslog_name=postfix/submission
  -o smtpd_tls_security_level=encrypt
  -o smtpd_sasl_auth_enable=yes
  -o smtpd_reject_unlisted_recipient=no
  -o smtpd_client_restrictions=permit_sasl_authenticated,reject
  -o milter_macro_daemon_name=ORIGINATING
smtps inet n       -       y       -       -       smtpd
  -o syslog_name=postfix/smtps
  -o smtpd_tls_wrappermode=yes
  -o smtpd_sasl_auth_enable=yes
  -o smtpd_reject_unlisted_recipient=no
  -o smtpd_client_restrictions=permit_sasl_authenticated,reject
  -o milter_macro_daemon_name=ORIGINATING
EOF
`);

  // Chrooted postfix daemons cannot reach /run/mysqld/mysql socket or
  // /etc/postfix map configs - disable chroot for all services (standard
  // modern practice; postfix still drops privileges per-daemon).
  await step('Disable postfix chroot', `python3 - <<'PYEOF'
import re
p = '/etc/postfix/master.cf'
out = []
for ln in open(p):
    if ln.startswith('#') or ln[:1].isspace() or not ln.strip():
        out.append(ln)
        continue
    out.append(re.sub(r'^(\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+)y(\\s)', r'\\1n\\2', ln))
open(p, 'w').writelines(out)
print('chroot column normalized')
PYEOF`);

  await step('Postfix virtual mailbox maps', `cat > /etc/postfix/mysql-virtual-mailbox-domains.cf <<EOF
user = mail
password = ${dbPass}
hosts = unix:/var/run/mysqld/mysqld.sock
dbname = mailserver
query = SELECT domain FROM mailboxes WHERE domain='%s' GROUP BY domain
EOF
cat > /etc/postfix/mysql-virtual-mailbox-maps.cf <<EOF
user = mail
password = ${dbPass}
hosts = unix:/var/run/mysqld/mysqld.sock
dbname = mailserver
query = SELECT CONCAT(domain, '/', SUBSTRING_INDEX(username, '@', 1)) FROM mailboxes WHERE username='%s'
EOF
chmod 640 /etc/postfix/mysql-virtual-mailbox-domains.cf /etc/postfix/mysql-virtual-mailbox-maps.cf`);

  await step('Dovecot SQL authentication', `sed -i \\
  -e 's|^#!include auth-sql.conf.ext|!include auth-sql.conf.ext|' \\
  -e 's|^!include auth-system.conf.ext|#!include auth-system.conf.ext|' \\
  /etc/dovecot/conf.d/10-auth.conf
cat > /etc/dovecot/dovecot-sql.conf.ext <<EOF
driver = mysql
connect = host=127.0.0.1 port=3306 dbname=mailserver user=mail password=${dbPass}
password_query = SELECT username AS user, CONCAT('{SHA512-CRYPT}', password) AS password FROM mailboxes WHERE username='%u'
user_query = SELECT CONCAT('/var/vmail/', domain, '/', SUBSTRING_INDEX(username, '@', 1)) AS home, 5000 AS uid, 5000 AS gid FROM mailboxes WHERE username='%u'
iterate_query = SELECT username FROM mailboxes
EOF
chown root:dovecot /etc/dovecot/dovecot-sql.conf.ext
chmod 640 /etc/dovecot/dovecot-sql.conf.ext`);

  await step('Dovecot settings', `cat > /etc/dovecot/conf.d/99-letzcontrol.conf <<'EOF'
protocols = imap pop3 lmtp
listen = *
mail_location = maildir:~/Maildir
auth_mechanisms = login plain
first_valid_uid = 5000
EOF`);

  await step('Dovecot <-> Postfix sockets', `python3 - <<'PYEOF'
p = '/etc/dovecot/conf.d/10-master.conf'
s = open(p).read()
auth_old = """  # Postfix smtp-auth
  #unix_listener /var/spool/postfix/private/auth {
  #  mode = 0666
  #}"""
auth_new = """  # Postfix smtp-auth
  unix_listener /var/spool/postfix/private/auth {
    mode = 0660
    user = postfix
    group = postfix
  }"""
if auth_old in s:
    s = s.replace(auth_old, auth_new)
elif 'unix_listener /var/spool/postfix/private/auth {' not in s:
    raise SystemExit('auth socket block not found in 10-master.conf')
lmtp_old = """service lmtp {
  unix_listener lmtp {
    #mode = 0666
  }
"""
lmtp_new = """service lmtp {
  unix_listener lmtp {
    #mode = 0666
  }

  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    mode = 0660
    user = postfix
    group = postfix
  }
"""
if '/var/spool/postfix/private/dovecot-lmtp' not in s:
    if lmtp_old not in s:
        raise SystemExit('lmtp block not found in 10-master.conf')
    s = s.replace(lmtp_old, lmtp_new)
open(p, 'w').write(s)
print('10-master.conf patched')
PYEOF`);

  await step('Mailbox storage /var/vmail', 'mkdir -p /var/vmail && chown -R 5000:5000 /var/vmail && chmod 755 /var/vmail');

  await step('OpenDKIM signer', `cat > /etc/opendkim.conf <<'EOF'
AutoRestart               Yes
AutoRestartRate           10/1h
UMask                     002
Syslog                    yes
SyslogSuccess             Yes
LogWhy                    Yes
Canonicalization          relaxed/simple
ExternalIgnoreList        refile:/etc/opendkim/TrustedHosts
InternalHosts             refile:/etc/opendkim/TrustedHosts
KeyTable                  refile:/etc/opendkim/KeyTable
SigningTable              refile:/etc/opendkim/SigningTable
Mode                      sv
PidFile                   /run/opendkim/opendkim.pid
SignatureAlgorithm        rsa-sha256
UserID                    opendkim:opendkim
Socket                    inet:8891@localhost
EOF
mkdir -p /etc/opendkim/keys
grep -q '127.0.0.1' /etc/opendkim/TrustedHosts 2>/dev/null || printf '127.0.0.1\\nlocalhost\\n' > /etc/opendkim/TrustedHosts
touch /etc/opendkim/KeyTable /etc/opendkim/SigningTable
chown -R opendkim:opendkim /etc/opendkim
chmod 750 /etc/opendkim`);

  await step('Enable & restart mail services',
    'systemctl enable postfix dovecot opendkim 2>/dev/null; systemctl restart postfix dovecot opendkim');

  const chk = await run('postfix check 2>&1');
  log(`postfix check: ${chk.ok ? 'OK' : chk.error}\n`);
  const dv = await run('doveconf -n 2>&1');
  log(`doveconf -n: ${dv.ok ? 'OK' : dv.error}\n`);
  if (!chk.ok || !dv.ok) throw new Error('Postfix/Dovecot configuration validation failed');

  fs.mkdirSync('/etc/letzcontrol', { recursive: true });
  fs.writeFileSync('/etc/letzcontrol/mail-configured', new Date().toISOString());
}

/** Roundcube nginx vhost on :2088 + sane IMAP/SMTP defaults. */
async function configureWebmail(log) {
  const step = async (label, cmd) => {
    const r = await run(cmd, { timeout: 120_000 });
    if (!r.ok) throw new Error(`${label} failed: ${(r.error || '').slice(0, 600)}`);
    log(`  ok: ${label}\n`);
    return r;
  };

  await step('Webmail nginx vhost (port 2088)', `cat > /etc/nginx/sites-available/webmail.conf <<'EOF'
server {
    listen 2088;
    server_name _;
    root /var/lib/roundcube;
    index index.php;
    # Admin tools are exposed on their own port to the whole internet and are
    # constantly scanned. Only the administering addresses may connect.
    include snippets/admins-allow.conf;
    # Must stay >= PHP-FPM's upload_max_filesize, otherwise large attachments
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
}
EOF
ln -sf /etc/nginx/sites-available/webmail.conf /etc/nginx/sites-enabled/webmail.conf`);

  await step('Roundcube settings', `sed -i 's/?>[[:space:]]*$//' /etc/roundcube/config.inc.php 2>/dev/null || true
grep -q letzWebmail /etc/roundcube/config.inc.php 2>/dev/null || cat >> /etc/roundcube/config.inc.php <<'EOF'

/* letzControl webmail settings */
$config['product_name'] = 'letzWebmail';
$config['default_host'] = 'localhost';
$config['default_port'] = 143;
$config['smtp_host'] = 'localhost:25';
$config['support_url'] = '';
EOF`);

  /* Self-service mailbox password changes from webmail.
   * The panel keeps mailbox passwords in mailserver.mailboxes as raw SHA-512
   * crypt hashes and dovecot reads that same table (prepending the
   * {SHA512-CRYPT} label in its password_query), so the plugin writes to that
   * exact table: one source of truth, and a password changed in webmail is the
   * value dovecot authenticates against. */
  const mailDbUser = 'mail';
  const sqlConf = await run('cat /etc/dovecot/dovecot-sql.conf.ext 2>/dev/null || true');
  const m = /password=(\S+)/.exec(sqlConf.stdout || '');
  if (m) {
    await step('Webmail password-change plugin', `grep -q "'password'" /etc/roundcube/config.inc.php 2>/dev/null || cat >> /etc/roundcube/config.inc.php <<'PWEOF'

/* letzControl: self-service mailbox password change (Settings > Password) */
$config['plugins'][] = 'password';
$config['password_driver'] = 'sql';
$config['password_algorithm'] = 'sha512-crypt';
/* store the bare $6$... hash - dovecot adds the scheme label when reading */
$config['password_algorithm_prefix'] = '';
$config['password_db_dsn'] = 'mysql://${mailDbUser}:${m[1]}@127.0.0.1/mailserver';
$config['password_query'] = 'UPDATE mailboxes SET password=%P WHERE username=%u';
$config['password_minlength'] = 8;
$config['password_show_fields'] = false;
PWEOF
  chown root:www-data /etc/roundcube/config.inc.php && chmod 640 /etc/roundcube/config.inc.php`);
  } else {
    log('  skip: could not read the dovecot SQL password, set up the webmail password plugin by hand\n');
  }

  await step('Reload nginx', 'nginx -t && systemctl reload nginx');

  fs.mkdirSync('/etc/letzcontrol', { recursive: true });
  fs.writeFileSync('/etc/letzcontrol/webmail-configured', new Date().toISOString());
}

/**
 * phpMyAdmin: config.inc.php (random blowfish secret) + nginx vhost on
 * port 2089. Prefers PHP 8.3 because phpMyAdmin 5.2 supports PHP < 8.4.
 */
async function configurePhpMyAdmin(log) {
  const step = async (label, cmd) => {
    const r = await run(cmd, { timeout: 120_000 });
    if (!r.ok) throw new Error(`${label} failed: ${(r.error || r.stdout + r.stderr || '').slice(0, 600)}`);
    log(`  ok: ${label}\n`);
    return r;
  };

  // Choose the FPM socket the vhost will use (8.3 preferred, else any)
  let sock = '';
  for (const want of ['8.3']) {
    if (fs.existsSync(`/run/php/php${want}-fpm.sock`) || fs.existsSync(`/etc/php/${want}/fpm`)) {
      sock = `/run/php/php${want}-fpm.sock`;
      break;
    }
  }
  if (!sock) {
    try {
      for (const d of fs.readdirSync('/etc/php').sort().reverse()) {
        if (/^\d+\.\d+$/.test(d) && fs.existsSync(`/etc/php/${d}/fpm`)) {
          sock = `/run/php/php${d}-fpm.sock`;
          break;
        }
      }
    } catch { /* no /etc/php */ }
  }
  if (!sock) throw new Error('No PHP-FPM installation found - install PHP first');
  const fpmVer = (sock.match(/php(\d+\.\d+)-fpm/) || [])[1];

  const secret = crypto.randomBytes(24).toString('base64'); // exactly 32 chars
  // Dedicated phpMyAdmin login: phpMyAdmin 5.x disables root by default, so a
  // separate full-privilege account with a real password is what makes the UI
  // usable without ever exposing a passwordless root login over HTTP.
  const pmaUser = 'letzpma';
  const pmaPass = crypto.randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
  await step(`phpMyAdmin database account ${pmaUser}`, `mysql -e "CREATE USER IF NOT EXISTS '${pmaUser}'@'localhost' IDENTIFIED BY '${pmaPass}'; CREATE USER IF NOT EXISTS '${pmaUser}'@'127.0.0.1' IDENTIFIED BY '${pmaPass}'; GRANT ALL PRIVILEGES ON *.* TO '${pmaUser}'@'localhost' WITH GRANT OPTION; GRANT ALL PRIVILEGES ON *.* TO '${pmaUser}'@'127.0.0.1' WITH GRANT OPTION; FLUSH PRIVILEGES;" || echo "could not create ${pmaUser} (phpMyAdmin login will need setting up by hand)"`);
  fs.writeFileSync('/etc/letzcontrol/phpmyadmin-credentials', `user=${pmaUser}\npassword=${pmaPass}\nurl=http://<server-ip>:2089/\n`, { mode: 0o600 });
  await step('phpMyAdmin config', `cat > /var/www/phpmyadmin/config.inc.php <<'EOF'
<?php
/* letzControl generated phpMyAdmin configuration */
$cfg['blowfish_secret'] = '${secret}';
$i = 0;
$i++;
$cfg['Servers'][$i]['host'] = 'localhost';
$cfg['Servers'][$i]['connect_type'] = 'tcp';
$cfg['Servers'][$i]['extension'] = 'mysqli';
$cfg['Servers'][$i]['compress'] = false;
/* Authenticate with a dedicated password-protected account. phpMyAdmin 5.x
 * refuses root by default (AllowRoot=false), and leaving AllowNoPassword
 * false while MySQL root has no password means NO login can ever succeed -
 * so the wizard must create that account and wire it up here. */
$cfg['Servers'][$i]['auth_type'] = 'config';
$cfg['Servers'][$i]['user'] = '${pmaUser}';
$cfg['Servers'][$i]['password'] = '${pmaPass}';
$cfg['Servers'][$i]['AllowRoot'] = false;
$cfg['Servers'][$i]['AllowNoPassword'] = false;
$cfg['CookieSameSite'] = 'Strict';
$cfg['UploadDir'] = '';
$cfg['SaveDir'] = '';
EOF
chown www-data:www-data /var/www/phpmyadmin/config.inc.php`);

  await step('phpMyAdmin nginx vhost (port 2089)', `cat > /etc/nginx/sites-available/phpmyadmin.conf <<'EOF'
server {
    listen 2089;
    server_name _;
    root /var/www/phpmyadmin;
    index index.php;
    # Admin tools are exposed on their own port to the whole internet and are
    # constantly scanned. Only the administering addresses may connect.
    include snippets/admins-allow.conf;
    # Nginx only rejects the body with 413 when it is smaller than PHP's own
    # limit; for a tool whose whole job is importing large SQL dumps the real
    # ceiling is PHP-FPM's php.ini, raised by the PHP manager.
    client_max_body_size 512m;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
    # Anchored on ^ and case-insensitive: an unanchored /(vendor|...)/ also
    # matches /js/vendor/... , which is phpMyAdmin's OWN JavaScript (jQuery,
    # CodeMirror for the SQL editor) - it 403'd those and broke the database
    # pages instead of protecting anything.
    location ~* ^/(vendor|setup|examples|test|libraries)/ {
        deny all;
    }
    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:${sock};
        fastcgi_read_timeout 300;
    }
}
EOF
ln -sf /etc/nginx/sites-available/phpmyadmin.conf /etc/nginx/sites-enabled/phpmyadmin.conf`);

  await step(`PHP ${fpmVer} FPM running`, `systemctl enable --now php${fpmVer}-fpm`);
  await step('Reload nginx', 'nginx -t && systemctl reload nginx');

  const v = await run("grep -m1 -oE '[0-9]+\\.[0-9]+\\.[0-9]+' /var/www/phpmyadmin/README 2>/dev/null | head -1");
  fs.mkdirSync('/etc/letzcontrol', { recursive: true });
  fs.writeFileSync('/etc/letzcontrol/phpmyadmin-configured', new Date().toISOString());
  fs.writeFileSync('/etc/letzcontrol/phpmyadmin-version', v.stdout.trim() || PMA_VERSION);
  log(`  ok: phpMyAdmin ${v.stdout.trim() || PMA_VERSION} ready on port 2089\n`);
}

/* ------------------------------ job runner ------------------------------ */

let job = null;

function publicJob() {
  return job || { running: false, log: '' };
}

function appendLog(text) {
  if (!job) return;
  job.log += text;
  if (job.log.length > 300_000) job.log = job.log.slice(-250_000);
}

function stream(cmd) {
  return new Promise((resolve) => {
    appendLog(`$ ${cmd}\n`);
    const child = spawn(cmd, {
      shell: true,
      env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }
    });
    child.stdout.on('data', (d) => appendLog(d.toString()));
    child.stderr.on('data', (d) => appendLog(d.toString()));
    child.on('close', (code) => {
      if (code !== 0) appendLog(`\n[exit code ${code}]\n`);
      resolve(code);
    });
    child.on('error', (e) => {
      appendLog(`\n[spawn error: ${e.message}]\n`);
      resolve(1);
    });
  });
}

/* Entries: { name, steps, detect?, post? }. detect() skips the entry when
 * the component is already installed (install runs); omit it for uninstall
 * runs so the steps always execute. Exported for lib/addons.js so the Setup
 * Wizard and the Addons menu share ONE job, log and dpkg lock. */
async function runEntries(entries, title = 'setup') {
  job = { running: true, log: '', startedAt: Date.now(), finishedAt: null, ok: true };
  bustComponentsCache(); // installs change detect results
  appendLog(`letzControl ${title} started ${new Date().toISOString()}\nEntries: ${entries.map((e) => e.name).join(', ')}\n`);
  try {
    for (const e of entries) {
      appendLog(`\n=== ${e.name} ===\n`);
      if (e.detect) {
        const det = await e.detect().catch(() => ({ installed: false }));
        if (det.installed) {
          appendLog(`Already installed${det.version ? ` (${det.version})` : ''} - skipped.\n`);
          continue;
        }
      }
      for (const step of e.steps) {
        const code = await stream(step);
        if (code !== 0) {
          job.ok = false;
          appendLog('Step failed; continuing with next step.\n');
        }
      }
      if (e.post) {
        try { await e.post(appendLog); } catch (e2) { job.ok = false; appendLog(`post step error: ${e2.message}\n`); }
      }
    }
  } catch (e) {
    job.ok = false;
    appendLog(`\nFatal: ${e.message}\n`);
  } finally {
    job.running = false;
    job.finishedAt = Date.now();
    bustComponentsCache(); // re-detect freshly installed components
    appendLog(`\nFinished ${new Date().toISOString()} (${job.ok ? 'OK' : 'with errors - review the log'})\n`);
  }
}

async function runJob(ids) {
  await runEntries(ids.map((id) => ({
    name: COMPONENTS[id].name,
    steps: COMPONENTS[id].steps,
    detect: COMPONENTS[id].detect,
    post: COMPONENTS[id].post
  })), 'setup');
}

/* ------------------------------ routes ------------------------------ */

/* Detection results change rarely (only when a component is installed), so
 * they are cached for a minute and busted when a job starts/finishes. The
 * wizard used to block on all 13 detectors serially (~2.9s of blank page). */
let componentsCache = null; // { at, data }
const COMPONENTS_TTL = 60_000;

function bustComponentsCache() { componentsCache = null; }

router.get('/components', async (req, res) => {
  const fresh = req.query.fresh === '1';
  if (!fresh && componentsCache && Date.now() - componentsCache.at < COMPONENTS_TTL) {
    return res.json({ components: componentsCache.data, job: publicJob() });
  }
  // Detectors are independent - run them in parallel (slowest one decides).
  const out = await Promise.all(Object.entries(COMPONENTS).map(async ([id, c]) => {
    let det = { installed: false, version: '' };
    try { det = await c.detect(); } catch { /* ignore */ }
    return { id, name: c.name, description: c.description, installed: !!det.installed, version: det.version || '' };
  }));
  componentsCache = { at: Date.now(), data: out };
  res.json({ components: out, job: publicJob() });
});

router.post('/install', (req, res) => {
  if (job && job.running) return res.status(409).json({ error: 'An installation is already running' });
  const requested = new Set(((req.body || {}).components || []));
  const ids = Object.keys(COMPONENTS).filter((id) => requested.has(id));
  if (!ids.length) return res.status(400).json({ error: 'No valid components selected' });
  runJob(ids).catch((e) => {
    if (job) { job.running = false; job.ok = false; appendLog(`\nFatal: ${e.message}\n`); }
  });
  res.json({ ok: true });
});

router.get('/job', (_req, res) => res.json({ job: publicJob() }));

module.exports = { router, COMPONENTS, runEntries, publicJob };
