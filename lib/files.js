'use strict';
/** File manager API: browse, read, write, upload, download, rename, mkdir,
 *  delete, plus cPanel-style extras: touch, chmod, copy, move, zip, extract. */
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const multer = require('multer');
const config = require('../config');
const { run } = require('./exec');

const router = express.Router();
const db = require('./db');
const upload = multer({ dest: path.join(config.dataDir, 'uploads') });
const MAX_READ = 5 * 1024 * 1024; // 5 MB

/* Multer streams each part into this directory under a random name and only
 * renames it into place once the request finishes. If the client cancels or the
 * connection drops mid-transfer (which the upload panel's cancel button does
 * routinely), that temp file is never moved and never deleted - so a day of
 * cancelled uploads would quietly fill the disk. Sweep anything older than
 * UPLOAD_TMP_MAX_AGE on a timer. */
const UPLOAD_TMP_DIR = path.join(config.dataDir, 'uploads');
const UPLOAD_TMP_MAX_AGE = 6 * 60 * 60 * 1000; // 6 hours

async function sweepUploadTemp() {
  let names;
  try { names = await fsp.readdir(UPLOAD_TMP_DIR); } catch { return; }
  const cutoff = Date.now() - UPLOAD_TMP_MAX_AGE;
  for (const name of names) {
    const p = path.join(UPLOAD_TMP_DIR, name);
    try {
      const st = await fsp.stat(p);
      if (st.isFile() && st.mtimeMs < cutoff) await fsp.rm(p, { force: true });
    } catch { /* raced with another sweep or already gone */ }
  }
}
sweepUploadTemp();
const sweepTimer = setInterval(sweepUploadTemp, 60 * 60 * 1000);
sweepTimer.unref(); // never hold the process open just for the sweeper

/** Per-request allowed roots: admins keep the configured roots, every other
 *  account is confined to the docroots of the sites they own. */
router.use((req, _res, next) => {
  if (!req.user || req.user.role === 'admin') {
    req.fmRoots = config.fileManagerRoots;
  } else {
    const roots = new Set();
    for (const s of db.find('sites', (x) => x && x.ownerId === req.user.id)) {
      if (s.docroot) roots.add(path.resolve(s.docroot));
    }
    req.fmRoots = [...roots];
  }
  next();
});

/** Resolve a user-supplied path and make sure it stays inside the
 *  request's allowed roots. Symlinks are resolved first, so a link placed
 *  inside a root cannot be used to reach outside of it. */
function safePath(req, p) {
  const roots = (req.fmRoots && req.fmRoots.length) ? req.fmRoots : (req.user && req.user.role === 'admin' ? config.fileManagerRoots : []);
  const inside = (target) => roots.some((root) => {
    const r = path.resolve(root);
    return target === r || target.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  });
  const deny = () => {
    const err = new Error('Path is outside the allowed roots');
    err.status = 403;
    return err;
  };

  let resolved = path.resolve(String(p || '/'));
  if (!inside(resolved)) throw deny();

  // follow symlinks (the final target must also be inside the roots)
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // target does not exist yet (create/rename): resolve the deepest
    // existing ancestor instead, then re-attach the missing tail
    let dir = path.dirname(resolved);
    let tail = path.basename(resolved);
    for (let i = 0; i < 64 && dir !== path.dirname(dir); i++) {
      try {
        resolved = path.join(fs.realpathSync(dir), tail);
        break;
      } catch { tail = path.join(path.basename(dir), tail); dir = path.dirname(dir); }
    }
  }
  if (!inside(resolved)) throw deny();
  return resolved;
}

/** Single-quote a value so it is always literal inside a shell command. */
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

/** Make sure an archive tool is present (fresh installs may lack it). */
async function ensureBin(name) {
  if (!['zip', 'unzip', 'tar'].includes(name)) throw new Error('unsupported tool');
  const have = await run(`command -v ${name}`);
  if (have.ok) return;
  const r = await run(
    `DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${name}`,
    { timeout: 300_000 }
  );
  if (!r.ok) {
    const err = new Error(`Could not install "${name}": ${(r.stdout + r.stderr).trim() || r.error}`);
    err.status = 500;
    throw err;
  }
}

function toEntry(full, dirent, st) {
  return {
    name: dirent.name,
    path: full,
    type: dirent.isDirectory() ? 'dir' : dirent.isSymbolicLink() ? 'link' : 'file',
    size: st ? st.size : 0,
    mtime: st ? st.mtimeMs : 0,
    mode: st ? (st.mode & 0o777).toString(8) : ''
  };
}

router.get('/list', async (req, res, next) => {
  try {
    const dir = safePath(req, req.query.path || '/');
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (d) => {
        const full = path.join(dir, d.name);
        let st = null;
        try { st = await fsp.lstat(full); } catch { /* unreadable */ }
        return toEntry(full, d, st);
      })
    );
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    res.json({ path: dir, entries });
  } catch (e) { next(e); }
});

router.get('/read', async (req, res, next) => {
  try {
    const file = safePath(req, req.query.path);
    const st = await fsp.stat(file);
    if (st.size > MAX_READ) return res.status(413).json({ error: 'File too large to edit in browser (max 5 MB)' });
    const content = await fsp.readFile(file, 'utf8');
    res.json({ path: file, content });
  } catch (e) { next(e); }
});

router.post('/write', async (req, res, next) => {
  try {
    const file = safePath(req, req.body.path);
    await fsp.writeFile(file, String(req.body.content ?? ''), 'utf8');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/mkdir', async (req, res, next) => {
  try {
    const dir = safePath(req, req.body.path);
    await fsp.mkdir(dir, { recursive: true });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/rename', async (req, res, next) => {
  try {
    const from = safePath(req, req.body.from);
    const to = safePath(req, req.body.to);
    await fsp.rename(from, to);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/delete', async (req, res, next) => {
  try {
    const target = safePath(req, req.body.path);
    const roots = (req.fmRoots || config.fileManagerRoots).map((r) => path.resolve(r));
    if (target === '/' || roots.includes(target)) {
      return res.status(400).json({ error: 'Refusing to delete a root directory' });
    }
    await fsp.rm(target, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/download', async (req, res, next) => {
  try {
    res.download(safePath(req, req.query.path));
  } catch (e) { next(e); }
});

router.post('/upload', upload.array('files', 20), async (req, res, next) => {
  let dir;
  try {
    dir = safePath(req, req.query.path || req.body.path || '/');
  } catch (e) {
    return next(e); // Express 4 does not catch async throws on its own
  }
  const moved = [];
  const failed = [];
  for (const f of req.files || []) {
    const dest = path.join(dir, path.basename(f.originalname));
    try {
      await fsp.rename(f.path, dest);
    } catch (renameErr) {
      // cross-device (data dir on another mount) or the name is taken by a
      // directory: copy across, then drop the temp file
      try {
        await fsp.copyFile(f.path, dest);
        await fsp.rm(f.path, { force: true });
      } catch (copyErr) {
        await fsp.rm(f.path, { force: true }).catch(() => {});
        // Report per file, and keep the panel's own paths out of the message:
        // raw fs errors leak the temp directory layout to the browser.
        failed.push({
          name: f.originalname,
          error: copyErr.code === 'ENOENT' ? 'Destination folder does not exist' :
                 copyErr.code === 'EACCES' || copyErr.code === 'EPERM' ? 'Permission denied by the server' :
                 copyErr.code === 'EISDIR' ? 'A folder with that name already exists' :
                 copyErr.code === 'ENOSPC' ? 'Server is out of disk space' : 'Could not save the file'
        });
        continue;
      }
    }
    moved.push(dest);
  }
  // All-or-nothing reads better than a half-applied batch: the client shows
  // one clear failure per file instead of silently losing some uploads.
  if (failed.length && !moved.length) {
    return res.status(400).json({ error: failed[0].error, failed });
  }
  if (failed.length) {
    return res.status(207).json({ ok: false, files: moved, failed });
  }
  res.json({ ok: true, files: moved });
});

/** Inline content for previews (images): same file, served without the
 *  Content-Disposition: attachment header the download route sets. */
router.get('/preview', async (req, res, next) => {
  try {
    const file = safePath(req, req.query.path);
    const st = await fsp.stat(file);
    if (!st.isFile()) return res.status(400).json({ error: 'Not a file' });
    res.sendFile(file);
  } catch (e) { next(e); }
});

/** Create an empty file (cPanel "New File"). Fails when it already exists. */
router.post('/touch', async (req, res, next) => {
  try {
    const file = safePath(req, req.body.path);
    const handle = await fsp.open(file, 'ax');
    await handle.close();
    res.json({ ok: true, path: file });
  } catch (e) {
    if (e.code === 'EEXIST') return res.status(409).json({ error: 'A file with that name already exists' });
    next(e);
  }
});

/** Set permissions, e.g. mode "644" or "0755". */
router.post('/chmod', async (req, res, next) => {
  try {
    const target = safePath(req, req.body.path);
    const mode = String(req.body.mode || '');
    if (!/^[0-7]{3,4}$/.test(mode)) {
      return res.status(400).json({ error: 'Mode must be 3 or 4 octal digits (e.g. 644)' });
    }
    await fsp.chmod(target, parseInt(mode, 8));
    res.json({ ok: true, mode: (parseInt(mode, 8) & 0o7777).toString(8) });
  } catch (e) { next(e); }
});

/** Copy a file or directory to an explicit destination path. */
router.post('/copy', async (req, res, next) => {
  try {
    const from = safePath(req, req.body.from);
    const to = safePath(req, req.body.to);
    if (to === from || to.startsWith(from + path.sep)) {
      return res.status(400).json({ error: 'Cannot copy a directory into itself' });
    }
    await fsp.cp(from, to, { recursive: true, force: false, errorOnExist: true });
    res.json({ ok: true, path: to });
  } catch (e) {
    if (e.code === 'EEXIST') return res.status(409).json({ error: 'Destination already exists' });
    next(e);
  }
});

/** Move/rename; falls back to copy+rm across filesystems (EXDEV). */
router.post('/move', async (req, res, next) => {
  try {
    const from = safePath(req, req.body.from);
    const to = safePath(req, req.body.to);
    if (to === from || to.startsWith(from + path.sep)) {
      return res.status(400).json({ error: 'Cannot move a directory into itself' });
    }
    try {
      await fsp.rename(from, to);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      await fsp.cp(from, to, { recursive: true, force: true });
      await fsp.rm(from, { recursive: true, force: true });
    }
    res.json({ ok: true, path: to });
  } catch (e) { next(e); }
});

/** Zip a selection of items (all from one directory) into one archive. */
router.post('/zip', async (req, res, next) => {
  try {
    const list = Array.isArray(req.body.paths) ? req.body.paths : [];
    if (!list.length || list.length > 50) return res.status(400).json({ error: 'Select between 1 and 50 items' });
    const files = list.map((p) => safePath(req, p));
    const dest = safePath(req, req.body.dest);
    if (fs.existsSync(dest)) return res.status(409).json({ error: 'An archive with that name already exists' });
    // fail fast (zip itself only warns about missing names)
    const missing = [];
    for (const f of files) if (!fs.existsSync(f)) missing.push(f);
    if (missing.length) return res.status(400).json({ error: 'Not found: ' + missing.join(', ') });
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await ensureBin('zip');

    const dirs = new Set(files.map((f) => path.dirname(f)));
    let cmd;
    if (dirs.size === 1) {
      // one directory: archive by basename (like cPanel)
      cmd = `cd ${q([...dirs][0])} && zip -qry ${q(path.basename(dest))} ${files.map((f) => q(path.basename(f))).join(' ')}`;
    } else {
      cmd = `zip -qry ${q(dest)} ${files.map(q).join(' ')}`;
    }
    const r = await run(cmd, { timeout: 300_000 });
    if (!r.ok) return res.status(500).json({ error: (r.stderr || r.error || 'zip failed').slice(0, 4000) });
    res.json({ ok: true, path: dest });
  } catch (e) { next(e); }
});

/** Extract a .zip / tar archive next to itself (or into `dest`). */
router.post('/extract', async (req, res, next) => {
  try {
    const file = safePath(req, req.body.path);
    const dest = safePath(req, req.body.dest || path.dirname(file));
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Archive not found' });
    await fsp.mkdir(dest, { recursive: true });
    let r;
    if (/\.zip$/i.test(file)) {
      await ensureBin('unzip');
      r = await run(`unzip -o -q ${q(file)} -d ${q(dest)}`, { timeout: 300_000 });
    } else if (/\.(tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i.test(file)) {
      await ensureBin('tar');
      r = await run(`tar -xf ${q(file)} -C ${q(dest)}`, { timeout: 300_000 });
    } else {
      return res.status(400).json({ error: 'Unsupported archive (zip, tar, tar.gz, tgz, tar.bz2, tar.xz)' });
    }
    if (!r.ok) return res.status(500).json({ error: (r.stderr || r.error || 'extract failed').slice(0, 4000) });
    res.json({ ok: true, path: dest });
  } catch (e) { next(e); }
});

module.exports = { router };
