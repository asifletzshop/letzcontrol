'use strict';
/**
 * letzControl configuration loader.
 * On first run a config.json is created next to this file with sane defaults
 * and a random session secret. Edit config.json to match your server.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = path.join(__dirname, 'config.json');

const defaults = {
  // Panel web server
  port: 2087,
  host: '0.0.0.0',

  // Generated on first run
  sessionSecret: crypto.randomBytes(32).toString('hex'),

  // Where letzControl stores its JSON database and uploads tmp files
  dataDir: path.join(__dirname, 'data'),

  // Where website document roots are created: <sitesRoot>/<domain>/public
  sitesRoot: '/var/www',

  // Ports used by the "extra" web servers so all three can run together.
  // Nginx keeps 80/443 and proxies to Apache / OpenLiteSpeed when a site
  // uses one of those backends, or to the app's own port for a "node" site
  // (a Node/Express app the panel only fronts - it never starts or rewrites
  // the app, it just proxies to it).
  ports: {
    apache: 8080,
    openlitespeed: 8088,
    node: 3001
  },

  // Config locations (Debian/Ubuntu layout)
  nginx: { confDir: '/etc/nginx' },
  apache: { confDir: '/etc/apache2' },
  openlitespeed: { root: '/usr/local/lsws' },

  // MySQL/MariaDB root connection used by the database manager.
  // If socketPath is set it is used instead of host/port (default on Ubuntu:
  // /var/run/mysqld/mysqld.sock with unix-socket root auth).
  mysql: { host: '127.0.0.1', port: 3306, user: 'root', password: '', socketPath: '' },

  // Email used for Let's Encrypt (empty = --register-unsafely-without-email)
  certbotEmail: '',

  // Public IP used for default DNS A records and shown in the NS instructions.
  // Leave empty to auto-detect the first non-loopback IPv4 address.
  publicIp: '',

  // Directories the file manager is allowed to touch
  fileManagerRoots: ['/'],

  // Where in-place panel updates are fetched from (owner/name). Point this at
  // your own fork if you are not running asifletzshop/letzcontrol.
  githubRepo: 'asifletzshop/letzcontrol'
};

let config;
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config = {
      ...defaults,
      ...file,
      ports: { ...defaults.ports, ...(file.ports || {}) },
      nginx: { ...defaults.nginx, ...(file.nginx || {}) },
      apache: { ...defaults.apache, ...(file.apache || {}) },
      openlitespeed: { ...defaults.openlitespeed, ...(file.openlitespeed || {}) },
      mysql: { ...defaults.mysql, ...(file.mysql || {}) }
    };
  } catch (e) {
    console.error('[letzControl] config.json is invalid JSON, using defaults:', e.message);
    config = defaults;
  }
} else {
  config = defaults;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2));
}

fs.mkdirSync(config.dataDir, { recursive: true });

module.exports = config;
