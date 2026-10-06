'use strict';
/** OpenLiteSpeed PHP (lsphp) discovery.
 *
 *  OLS has NO per-vhost PHP configuration the way Nginx/Apache do: an
 *  extProcessor is a global block in httpd_config.conf, and a vhost's
 *  `scripthandler { add lsapi:<processor> php }` must name one of those
 *  blocks. Stock OLS ships a single processor named `lsphp` whose `path`
 *  points at a build directory (lsphp83, lsphp84, ...), so effectively there
 *  is one usable PHP version per installed build - and PHP-FPM versions
 *  (php8.4-fpm etc.) mean nothing on an OLS site.
 *
 *  This module maps installed lsphp builds to the processor that serves them
 *  so the panel can offer only versions OLS can actually run, and refuse a
 *  version it cannot honour instead of silently serving another one.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const VERSION_RE = /^\d\.\d$/;

/** PHP version of an lsphp build directory name: lsphp83 -> "8.3" */
function buildVersion(dir) {
  const m = /^lsphp(\d)(\d+)$/.exec(dir || '');
  if (!m) return null;
  const v = `${m[1]}.${m[2]}`;
  return VERSION_RE.test(v) ? v : null;
}

/** Every extProcessor block in httpd_config.conf, with the lsphp build its
 *  `path` points at. Returns [] when OLS is not installed. */
function processors() {
  const file = path.join(config.openlitespeed.root, 'conf', 'httpd_config.conf');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const m of text.matchAll(/^[ \t]*extProcessor[ \t]+(\S+)[ \t]*\{([\s\S]*?)^[ \t]*\}/gm)) {
    const [, name, body] = m;
    const p = /^[ \t]*path[ \t]+(\S+)/m.exec(body);            // lsphp83/bin/lsphp
    const build = p ? p[1].split('/')[0] : null;
    out.push({
      name,
      build,
      version: build ? buildVersion(build) : null,
      socket: (/^[ \t]*address[ \t]+(uds:\/\/\S+)/m.exec(body) || [])[1] || ''
    });
  }
  return out;
}

/** lsphp builds present on disk: [{ dir, version }], newest last. */
function builds() {
  const root = config.openlitespeed.root;
  const out = [];
  try {
    for (const d of fs.readdirSync(root)) {
      const version = buildVersion(d);
      if (version && fs.existsSync(path.join(root, d, 'bin', 'lsphp'))) out.push({ dir: d, version });
    }
  } catch { /* OLS not installed */ }
  return out.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
}

/** Processor name that serves PHP <version> on OLS, or null when no such
 *  build exists. With no version requested, returns the processor backed by
 *  a real lsphp build (OLS' stock default), or null when OLS has none. */
function handlerFor(version) {
  const list = processors().filter((p) => p.version);
  if (!list.length) return null;
  if (version) {
    const hit = list.find((p) => p.version === String(version));
    return hit ? hit.name : null;
  }
  const built = list.find((p) => fs.existsSync(path.join(config.openlitespeed.root, p.build, 'bin', 'lsphp')));
  return (built || list[0]).name;
}

/** What the Websites view offers for an OpenLiteSpeed site - one entry per
 *  processor that has a real build behind it. */
function versions() {
  const seen = new Set();
  const out = [];
  for (const p of processors()) {
    if (!p.version || seen.has(p.version)) continue;
    if (!fs.existsSync(path.join(config.openlitespeed.root, p.build, 'bin', 'lsphp'))) continue;
    seen.add(p.version);
    out.push({ version: p.version, processor: p.name, build: p.build, label: `PHP ${p.version} (lsphp ${p.build})` });
  }
  return out;
}

/** Human list of runnable versions, for error messages. */
const available = () => versions().map((v) => v.version).join(', ') || 'none installed';

module.exports = { available, builds, handlerFor, processors, versions };