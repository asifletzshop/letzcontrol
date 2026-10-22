#!/usr/bin/env node
'use strict';
/**
 * Bump the version in package.json.
 *
 * The panel compares its installed version with the one in package.json on
 * the repository's default branch, so the version is what tells an install
 * that there is something new for it. A project that ships by pushing to a
 * branch - rather than by cutting releases - therefore needs the version
 * moved on every push, or an install never learns that anything changed.
 *
 * The version is bumped here rather than in the workflow's shell so it can
 * be run by hand, and tested:
 *
 *   node scripts/bump-version.js          # patch: 1.2.3 -> 1.2.4
 *   node scripts/bump-version.js minor    # minor: 1.2.3 -> 1.3.0
 *   node scripts/bump-version.js major    # major: 1.2.3 -> 2.0.0
 *
 * The new version is printed on stdout, so a caller can capture it.
 */
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const lockPath = path.join(__dirname, '..', 'package-lock.json');
const type = String(process.argv[2] || 'patch').toLowerCase();

if (!['patch', 'minor', 'major'].includes(type)) {
  console.error(`Unknown bump type "${type}" - use patch, minor or major.`);
  process.exit(2);
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (e) {
  console.error(`Could not read ${pkgPath}: ${e.message}`);
  process.exit(1);
}

/* A version that is not three numbers is not a version this can reason
 * about, and silently producing 0.1.0 from it would be worse than
 * stopping. */
const parts = String(pkg.version || '').split('.').map((n) => Number.parseInt(n, 10));
if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
  console.error(`The current version "${pkg.version}" is not a three-part number.`);
  process.exit(1);
}

const [major, minor, patch] = parts;
let next;
if (type === 'major') next = [major + 1, 0, 0];
else if (type === 'minor') next = [major, minor + 1, 0];
else next = [major, minor, patch + 1];

pkg.version = next.join('.');
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

/* The lock file carries the version too, and npm compares the two: if they
 * differ it refuses `npm ci` with "package.json and package-lock.json are
 * not in sync" and the update falls back to `npm install`, which re-resolves
 * every dependency version on a live install. A version bump that leaves
 * the lock behind therefore breaks the reproducible install for everyone,
 * silently.
 *
 * Only the version is touched here. The resolved dependency tree is left
 * exactly as npm recorded it - regenerating it would be a different change,
 * and one that belongs to a deliberate "npm update" rather than to a version
 * bump. */
try {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (lock.version !== pkg.version) lock.version = pkg.version;
  if (lock.packages && lock.packages[''] && lock.packages[''].version !== pkg.version) {
    lock.packages[''].version = pkg.version;
  }
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
} catch (e) {
  /* No lock file, or one that cannot be read: the bump is still worth
   * making, and npm install will sort the lock out. */
  console.error(`Note: the lock file was not updated (${e.message})`);
}

console.log(pkg.version);
