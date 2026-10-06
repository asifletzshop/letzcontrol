'use strict';
/** Shared visual php.ini editor: the whitelist of editable directives,
 *  input validation, and an in-place php.ini patcher that preserves
 *  comments and sections (used by the per-site editor and the global
 *  PHP view editor). */
const fs = require('fs');
const fsp = fs.promises;

const FIELDS = [
  { group: 'Memory & performance', key: 'memory_limit', label: 'memory_limit', type: 'size', placeholder: '128M', hint: 'Script memory limit (e.g. 256M)' },
  { key: 'max_execution_time', label: 'max_execution_time', type: 'number', placeholder: '30', hint: 'Seconds a script may run' },
  { key: 'max_input_time', label: 'max_input_time', type: 'number', placeholder: '60', hint: 'Seconds to parse input data' },
  { key: 'max_input_vars', label: 'max_input_vars', type: 'number', placeholder: '1000', hint: 'Max variables per request' },
  { group: 'Uploads', key: 'post_max_size', label: 'post_max_size', type: 'size', placeholder: '8M', hint: 'Max size of POST data (number alone = MB, e.g. 8M)' },
  { key: 'upload_max_filesize', label: 'upload_max_filesize', type: 'size', placeholder: '2M', hint: 'Max upload file size (number alone = MB, e.g. 64M)' },
  { key: 'max_file_uploads', label: 'max_file_uploads', type: 'number', placeholder: '20' },
  { group: 'Errors', key: 'display_errors', label: 'display_errors', type: 'bool' },
  { key: 'display_startup_errors', label: 'display_startup_errors', type: 'bool' },
  { key: 'log_errors', label: 'log_errors', type: 'bool' },
  { key: 'error_reporting', label: 'error_reporting', type: 'select', options: { '': 'default', '0': '0 — none', '1': '1 — E_ERROR', '22519': '22519 — E_ALL & ~E_NOTICE', '32767': '32767 — E_ALL' } },
  { group: 'Timezone & charset', key: 'date.timezone', label: 'date.timezone', type: 'text', placeholder: 'UTC', hint: 'e.g. Europe/Berlin' },
  { key: 'default_charset', label: 'default_charset', type: 'text', placeholder: 'UTF-8' },
  { group: 'Security', key: 'allow_url_fopen', label: 'allow_url_fopen', type: 'bool' },
  { key: 'session.cookie_httponly', label: 'session.cookie_httponly', type: 'bool' },
  { key: 'session.cookie_samesite', label: 'session.cookie_samesite', type: 'select', options: { '': 'default', 'Lax': 'Lax', 'Strict': 'Strict', 'None': 'None' } }
];

/** Whitelist-validate visual-editor input. Returns the clean object of
 *  non-empty settings ('' / missing keys are dropped = use PHP default),
 *  or a string error message. Never trusts keys or free-form values. */
function sanitize(settings) {
  if (settings == null || settings === '') settings = {};
  if (typeof settings !== 'object' || Array.isArray(settings)) return 'settings must be an object';
  const out = {};
  for (const f of FIELDS) {
    if (!(f.key in settings)) continue;
    let v = String(settings[f.key] ?? '').trim();
    if (v === '') continue; // unset -> PHP default
    if (v.length > 200 || /[\r\n]/.test(v)) return `${f.key}: invalid value`;
    if (f.type === 'number' && !/^\d{1,7}$/.test(v)) return `${f.key}: must be a whole number`;
    if (f.type === 'size') {
      // PHP treats a bare number as BYTES ("500" = 500 B, not 500M) — that
      // surprise is exactly what made uploads fail, so a bare number is
      // normalised to megabytes and the unit is required otherwise.
      if (/^\d{1,7}$/.test(v)) v = v + 'M';
      else if (!/^\d{1,7}[KMG]$/i.test(v)) return `${f.key}: use a size with unit, e.g. 500M (bare numbers count as bytes)`;
      v = v.toUpperCase();
    }
    if (f.type === 'bool' && !['0', '1'].includes(v)) return `${f.key}: must be On or Off`;
    if (f.type === 'select' && !Object.prototype.hasOwnProperty.call(f.options, v) &&
        // php.ini ships expressions the quick-pick options may not list
        // (e.g. error_reporting = E_ALL & ~E_DEPRECATED): accept safe tokens
        !/^[A-Za-z0-9_. \/~&|()+*-]{1,60}$/.test(v)) return `${f.key}: not an allowed value`;
    // no whitespace: values stay single-line in .user.ini and OLS php_value lines
    if (f.type === 'text' && !/^[\w.:/\\@+\[\](),;'"*!&$%#={}|<>?~^-]*$/.test(v)) return `${f.key}: values cannot contain spaces`;
    out[f.key] = v;
  }
  return out;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MAX_INI = 5 * 1024 * 1024;

/** Current effective values for the whitelisted keys in a php.ini file.
 *  Last active occurrence wins (that is how PHP resolves duplicates). */
async function readValues(file) {
  const out = {};
  for (const f of FIELDS) out[f.key] = '';
  let text;
  try {
    const st = await fsp.stat(file);
    if (st.size > MAX_INI) return out;
    text = await fsp.readFile(file, 'utf8');
  } catch { return out; } // missing file -> all defaults

  const active = new Map();
  const commented = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z0-9_.]+)\s*=/.exec(line);
    if (m && out[m[1]] !== undefined) { active.set(m[1], line); continue; }
    const c = /^\s*;\s*([A-Za-z0-9_.]+)\s*=/.exec(line);
    if (c && out[c[1]] !== undefined) commented.set(c[1], line);
  }
  for (const f of FIELDS) {
    if (active.has(f.key)) out[f.key] = valOf(active.get(f.key), f.key);
    else if (commented.has(f.key)) out[f.key] = ''; // commented -> PHP default
  }
  return out;
}

/** Extract the value from a `key = value` line: strip quote-aware inline
 *  comments, surrounding quotes, and normalise booleans (On/Off/Yes/No/
 *  true/false -> 1/0) so the visual editor's selects always match. */
function valOf(line, key) {
  const i = line.indexOf('=');
  if (i === -1) return '';
  let v = line.slice(i + 1).trim();
  let inQuote = null;
  for (let j = 0; j < v.length; j++) {
    const ch = v[j];
    if (inQuote) { if (ch === inQuote) inQuote = null; continue; }
    if (ch === '"' || ch === "'") { inQuote = ch; continue; }
    if (ch === ';' && (j === 0 || /\s/.test(v[j - 1]))) { v = v.slice(0, j).trim(); break; }
  }
  if (v.length > 1 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    v = v.slice(1, -1);
  }
  const low = v.toLowerCase();
  if (['on', 'yes', 'true'].includes(low)) return '1';
  if (['off', 'no', 'false'].includes(low)) return '0';
  return v;
}

/** Patch a php.ini file in place from sanitized settings:
 *  - set value: rewrite the active `key = ...` line (last one wins),
 *    else uncomment the commented `key = ...` line (stays in its section),
 *    else append under a marker at the end of the file;
 *  - cleared value: comment the active line out (original stays as doc).
 *  A rolling backup `<file>.letzbak` is written first. Comments, sections
 *  and unrelated directives are left untouched. */
async function applyValues(file, settings) {
  const clean = typeof settings === 'object' && settings && !Array.isArray(settings) ? settings : {};
  let text = '';
  try { text = await fsp.readFile(file, 'utf8'); } catch { /* fresh file */ }
  if (text.length > MAX_INI) throw new Error('php.ini too large to edit');

  const lines = text.split('\n');
  const changed = [];
  const appended = [];

  for (const f of FIELDS) {
    const key = f.key;
    if (!Object.prototype.hasOwnProperty.call(clean, key)) continue; // untouched -> left alone
    const val = String(clean[key] ?? '').trim();
    // locate active and commented occurrences (last one wins in PHP)
    let activeIdx = -1, commentIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = new RegExp(`^\\s*${escRe(key)}\\s*=`).exec(lines[i]);
      if (m) activeIdx = i;
      else if (new RegExp(`^\\s*;\\s*${escRe(key)}\\s*=`).test(lines[i])) commentIdx = i;
    }
    if (val === '') {
      if (activeIdx >= 0) {
        lines[activeIdx] = lines[activeIdx].replace(/^(\s*)/, '$1;');
        changed.push({ key, value: '', set: false });
      }
    } else {
      if (activeIdx >= 0) {
        const indent = (/^\s*/.exec(lines[activeIdx]) || [''])[0];
        lines[activeIdx] = `${indent}${key} = ${val}`;
      } else if (commentIdx >= 0) {
        const indent = (/^\s*/.exec(lines[commentIdx]) || [''])[0];
        lines[commentIdx] = `${indent}${key} = ${val}`;
      } else {
        appended.push(`${key} = ${val}`);
      }
      changed.push({ key, value: val, set: true });
    }
  }

  if (appended.length) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push('', '; --- letzControl visual editor ---', ...appended);
  }

  const next = lines.join('\n');
  if (next !== text) {
    try { await fsp.writeFile(file + '.letzbak', text, { mode: 0o644 }); } catch { /* best effort */ }
    await fsp.writeFile(file, next, 'utf8');
  }
  return { changed, appended, wrote: next !== text };
}

module.exports = { FIELDS, sanitize, readValues, applyValues };
