'use strict';
/* Reset the admin password from the shell.
 *
 * The installer deliberately does NOT print the password on an upgrade, so
 * this is the way out when someone has changed it and lost it - or has never
 * managed to read the generated one.
 *
 *   cd /opt/letzcontrol && npm run reset-password
 *   cd /opt/letzcontrol && npm run reset-password -- 'my new password'
 *
 * With no argument it generates one and prints it, which is the safest default:
 * a password typed on a command line ends up in your shell history, and a weak
 * one typed by hand is worse than a generated one.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./lib/db');

const admin = db.findOne('users', (u) => u.role === 'admin');
if (!admin) {
  console.error('No admin account exists yet.');
  console.error('Start the panel once (systemctl start letzcontrol) - it creates one.');
  process.exit(1);
}

const given = process.argv[2];
/* Reject a password the shell would mangle rather than storing something the
 * user cannot reproduce at the login form. */
if (given && /^\s|\s$/.test(given)) {
  console.error('The password cannot start or end with a space.');
  process.exit(1);
}
if (given && given.length < 8) {
  console.error('That is shorter than 8 characters. Use at least 8, or pass nothing to have one generated.');
  process.exit(1);
}

const password = given || crypto.randomBytes(12).toString('base64').replace(/[+/=]/g, '').slice(0, 16);

db.update('users', admin.id, { passwordHash: bcrypt.hashSync(password, 10) });
db.save();

console.log('');
console.log('  Admin password updated.');
console.log(`    username  ${admin.username}`);
if (given) {
  console.log('    password  (the one you passed in)');
} else {
  console.log(`    password  ${password}`);
  console.log('');
  console.log('  This is the only time it is shown. Save it now, then change it in the panel.');
}
console.log('');
console.log('  Log in at the panel, then change it under Users & Plans.');
console.log('');