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
console.log(pkg.version);
