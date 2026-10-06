'use strict';
/**
 * Panel updates.
 *
 * The panel is installed by copying files, not by git clone, so it has no
 * history to compare against and nothing tells it that the code it is running
 * is no longer the code on GitHub. This module closes that gap: it compares the
 * installed version with the one on the repository's default branch and, when
 * they differ, offers the operator a button that updates in place.
 *
 * Deliberately NOT automatic. This panel runs as root with a web terminal, so
 * silently replacing its own code on a timer is a bad idea even when it is the
 * author's own repository - a bad push would take every install down at once,
 * with nobody watching. So: detect, tell the operator, let them press the
 * button, and back up before touching anything.
 */
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const config = require('../config');
const db = require('./db');
const { requireAdmin } = require('./auth');
const { run } = require('./exec');

const router = express.Router();

/* Same default as install.sh, overridable so a fork updates from its own repo. */
const REPO = process.env.LETZCONTROL_REPO || config.githubRepo || 'asifletzshop/letzcontrol';
const BRANCH = process.env.LETZCONTROL_BRANCH || 'main';
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const API = `https://api.github.com/repos/${REPO}`;

const INSTALL_DIR = path.join(__dirname, '..');
const MARKER = () => path.join(config.dataDir, 'install.json');
const LOG_FILE = () => path.join(config.dataDir, 'update.log');

/* Code that is replaced on update. data/ and config.json are deliberately NOT
 * in this list - they hold the operator's sites, users and credentials, and
 * install.sh draws the same line. */
const CODE_ITEMS = ['server.js', 'config.js', 'package.json', 'package-lock.json', 'lib', 'public', 'views', 'README.md', 'letzcontrol.service'];

const localVersion = () => {
  try { return JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
};

/* What we last installed, plus enough detail to show what changed since. */
function marker() {
  try { return JSON.parse(fs.readFileSync(MARKER(), 'utf8')); } catch { return null; }
}

function writeMarker(patch) {
  const next = { ...(marker() || {}), ...patch, updatedAt: Date.now() };
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(MARKER(), JSON.stringify(next, null, 2));
  } catch { /* non-fatal: the marker is informational */ }
  return next;
}

/* ------------------------------ http helper ---------------------------- */

/** Plain HTTPS GET with a hard timeout. Node's fetch would work too, but this
 *  keeps the failure messages specific ("could not reach GitHub") instead of a
 *  generic TypeError that tells the operator nothing useful. */
function get(url, { json = false, timeout = 12_000 } = {}) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'letzcontrol-panel',
        ...(json ? { Accept: 'application/vnd.github+json' } : {})
      },
      timeout
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return get(res.headers.location, { json, timeout }).then(resolve);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return resolve({ ok: false, error: res.statusCode === 404 ? 'not found on the repository' : `HTTP ${res.statusCode}`, status: res.statusCode });
        }
        if (json) {
          try { return resolve({ ok: true, data: JSON.parse(body) }); }
          catch { return resolve({ ok: false, error: 'the repository returned something that is not JSON' }); }
        }
        resolve({ ok: true, text: body });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timed out contacting the repository' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

/* ------------------------------- checking ------------------------------ */

const TTL = 15 * 60 * 1000;
let cache = null;

/**
 * Compare the installed version against the repository. The upstream version
 * comes from the raw package.json rather than the GitHub releases API: this
 * project ships by pushing to a branch, not by cutting releases, so a
 * releases-based check would report "up to date" forever.
 */
async function check({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache.data;

  const installed = localVersion();
  const data = {
    repo: REPO,
    branch: BRANCH,
    installed,
    updateAvailable: false,
    checkedAt: Date.now(),
    reachable: false,
    upstream: '',
    commits: [],
    note: ''
  };

  const pkg = await get(`${RAW}/package.json`, { json: true });
  if (!pkg.ok) {
    data.note = `Could not reach ${REPO} on GitHub (${pkg.error}). If this panel was installed from a different repository, set LETZCONTROL_REPO in the service environment.`;
    cache = { at: Date.now(), data };
    return data;
  }

  data.reachable = true;
  data.upstream = pkg.data.version || '';

  // Compare properly rather than with !==, so 1.2.0 > 1.10.0 does not read as
  // a downgrade and 1.2 does not look newer than 1.2.0.
  const gt = (a, b) => {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const x = Number.isFinite(pa[i]) ? pa[i] : 0;
      const y = Number.isFinite(pb[i]) ? pb[i] : 0;
      if (x !== y) return x > y;
    }
    return false;
  };
  const lt = (a, b) => gt(b, a);
  data.updateAvailable = gt(data.upstream, installed) || (data.upstream !== installed && !lt(data.upstream, installed));

  /* Show what is waiting, so "update" is not a blind leap. The compare API is
   * only meaningful with a commit to compare against, which is what the marker
   * records; without one, fall back to the latest few commits. */
  const m = marker();
  let commitQuery = 'commits?per_page=8';
  if (m && m.commit) commitQuery = `compare/${m.commit}...${BRANCH}`;
  const commits = await get(`${API}/${commitQuery}`, { json: true });
  if (commits.ok) {
    const list = Array.isArray(commits.data) ? commits.data : (commits.data.commits || []);
    data.commits = list.slice(0, 8).map((c) => ({
      sha: (c.sha || '').slice(0, 7),
      subject: String(c.commit?.message || '').split('\n')[0],
      date: c.commit?.author?.date || null,
      author: c.commit?.author?.name || ''
    }));
  }

  cache = { at: Date.now(), data };
  return data;
}

/* -------------------------------- routes ------------------------------- */

router.get('/', requireAdmin, async (req, res) => {
  res.json({ ...(await check({ fresh: req.query.fresh === '1' })), job: publicJob() });
});

router.post('/check', requireAdmin, async (_req, res) => {
  res.json(await check({ fresh: true }));
});

/* -------------------------------- update ------------------------------- */

let job = null;
const publicJob = () => (job ? { running: job.running, log: readLog(), ok: job.ok, error: job.error } : { running: false, log: readLog(), ok: null, error: '' });

/** The log has to survive the restart that the update itself causes, so it is
 *  written to a file rather than held in memory. */
function appendLog(text) {
  const line = text.endsWith('\n') ? text : `${text}\n`;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    if (!job) job = { running: false, ok: null, error: '' };
    fs.appendFileSync(LOG_FILE(), line);
  } catch { /* nothing useful to do */ }
}

function readLog() {
  try { return fs.readFileSync(LOG_FILE(), 'utf8').slice(-60_000); } catch { return ''; }
}

function stream(cmd, opts = {}) {
  return new Promise((resolve) => {
    appendLog(`$ ${cmd}`);
    const child = spawn(cmd, {
      shell: true,
      cwd: INSTALL_DIR,
      env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
      ...opts
    });
    child.stdout.on('data', (d) => appendLog(d.toString().trimEnd()));
    child.stderr.on('data', (d) => appendLog(d.toString().trimEnd()));
    child.on('close', (code) => { resolve(code); });
    child.on('error', (e) => { appendLog(`[could not run: ${e.message}]`); resolve(1); });
  });
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Tar up everything an update could possibly damage, before touching any of it. */
async function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(config.dataDir, 'backups');
  await fsp.mkdir(dir, { recursive: true });
  const out = path.join(dir, `pre-update-${stamp}.tar.gz`);
  const items = ['config.json', 'data'].filter((i) => fs.existsSync(path.join(INSTALL_DIR, i)));
  if (!items.length) return null;
  const r = await run(`tar czf ${shq(out)} ${items.map(shq).join(' ')}`);
  return r.ok ? out : null;
}

/**
 * Update in place. Same contract as install.sh: fetch, copy only the code, run
 * npm, restart. Anything that can fail loudly does, before the old code is
 * replaced, so a failure leaves the running panel untouched.
 */
router.post('/apply', requireAdmin, async (req, res) => {
  if (job && job.running) return res.status(409).json({ error: 'An update is already running' });

  const info = await check({ fresh: true });
  if (!info.reachable) return res.status(400).json({ error: info.note });
  if (!info.updateAvailable) {
    return res.status(400).json({ error: `Already on the latest version (${info.installed}).` });
  }

  job = { running: true, ok: null, error: '' };
  const tmp = path.join(config.dataDir, 'update-src');

  try {
    fs.writeFileSync(LOG_FILE(), '');
  } catch { /* fine */ }
  appendLog(`letzControl update: ${info.installed} -> ${info.upstream}`);
  appendLog(`repository: ${REPO} (${BRANCH})`);
  appendLog('');

  (async () => {
    try {
      appendLog('--- backing up config.json and data ---');
      const bak = await backup();
      appendLog(bak ? `backup written to ${bak}` : 'nothing to back up');
      appendLog('');

      await fsp.rm(tmp, { recursive: true, force: true });
      await fsp.mkdir(tmp, { recursive: true });

      appendLog('--- downloading ---');
      const tarball = path.join(tmp, 'src.tar.gz');
      const dl = await run(`curl -fsSL --retry 2 --max-time 120 -o ${shq(tarball)} ${shq(`${API}/tarball/${BRANCH}`)}`, { timeout: 180_000 });
      if (!dl.ok) throw new Error(`download failed: ${(dl.stdout + dl.stderr).trim()}`);
      appendLog('downloaded');

      await run(`tar xzf ${shq(tarball)} -C ${shq(tmp)}`, { timeout: 120_000 });
      /* A GitHub tarball unpacks into <repo>-<ref>/; find the real root rather
       * than assuming a directory name that changes with the branch. */
      let src = tmp;
      if (!fs.existsSync(path.join(src, 'package.json'))) {
        const found = fs.readdirSync(tmp).map((n) => path.join(tmp, n)).find((n) => fs.existsSync(path.join(n, 'package.json')));
        if (!found) throw new Error('the downloaded archive does not look like letzControl');
        src = found;
      }
      if (!fs.existsSync(path.join(src, 'server.js'))) throw new Error('the download has no server.js');

      appendLog('');
      appendLog('--- installing dependencies into a staging directory ---');
      /* Build node_modules in the staging dir FIRST, from the NEW
       * package.json. Running npm inside the install dir instead would install
       * from the old package.json (so any new dependency is missing), and
       * `npm ci` deletes node_modules before it installs - a failure there
       * would leave the panel with no dependencies at all. Staging it means a
       * failed npm leaves the running panel completely untouched. */
      const lock = fs.existsSync(path.join(src, 'package-lock.json'));
      const npmCmd = `cd ${shq(src)} && ${lock
        ? 'npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund'
        : 'npm install --omit=dev --no-audit --no-fund'}`;
      const npmOut = await stream(npmCmd, { timeout: 900_000 });
      if (npmOut !== 0 || !fs.existsSync(path.join(src, 'node_modules'))) {
        throw new Error('npm install failed - the running panel was left untouched');
      }

      appendLog('');
      appendLog('--- installing files ---');
      for (const item of CODE_ITEMS) {
        const from = path.join(src, item);
        if (!fs.existsSync(from)) continue;
        const to = path.join(INSTALL_DIR, item);
        await fsp.rm(to, { recursive: true, force: true });
        await fsp.cp(from, to, { recursive: true });
        appendLog(`installed ${item}`);
      }
      /* Swap the prepared dependencies in last - everything else is already in
       * place by the time the old copy goes. */
      await fsp.rm(path.join(INSTALL_DIR, 'node_modules'), { recursive: true, force: true });
      await fsp.cp(path.join(src, 'node_modules'), path.join(INSTALL_DIR, 'node_modules'), { recursive: true });
      appendLog('installed node_modules');

      const newVersion = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf8')).version || '?';
      // Record the commit we are now on so the next check can list the exact
      // changes rather than just "something is newer".
      let sha = '';
      try {
        const head = await get(`${API}/commits/${BRANCH}`, { json: true });
        if (head.ok) sha = head.data.sha || '';
      } catch { /* informational only */ }
      writeMarker({ version: newVersion, commit: sha, previousVersion: info.installed });

      appendLog('');
      appendLog(`--- updated to ${newVersion}${sha ? ` (${sha.slice(0, 7)})` : ''} ---`);
      appendLog('restarting the panel now; this page will briefly disconnect');

      job.running = false;
      job.ok = true;
      cache = null; // the next check must not report the old version
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});

      setTimeout(() => run('systemctl restart letzcontrol'), 800);
    } catch (e) {
      appendLog('');
      appendLog(`UPDATE FAILED: ${e.message}`);
      appendLog('The panel was left running the version it had before.');
      job.running = false;
      job.ok = false;
      job.error = e.message;
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  })();

  res.json({ ok: true, from: info.installed, to: info.upstream, job: publicJob() });
});

/** Clear the stored log once it has been read. */
router.post('/log/clear', requireAdmin, (_req, res) => {
  try { fs.writeFileSync(LOG_FILE(), ''); } catch { /* fine */ }
  res.json({ ok: true });
});

/* Backups made before an update, so a bad update can be undone by hand. */
router.get('/backups', requireAdmin, async (_req, res) => {
  const dir = path.join(config.dataDir, 'backups');
  const names = await fsp.readdir(dir).catch(() => []);
  const files = [];
  for (const n of names.filter((n) => n.startsWith('pre-update-')).sort().reverse().slice(0, 10)) {
    const st = await fsp.stat(path.join(dir, n)).catch(() => null);
    if (st) files.push({ name: n, bytes: st.size, createdAt: st.mtimeMs });
  }
  res.json({ files });
});

module.exports = { router };
