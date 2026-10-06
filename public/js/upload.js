'use strict';
/* Upload centre: a floating panel that shows every file being uploaded with
 * live progress, throughput and ETA.
 *
 * Why not one request for the whole batch (the old behaviour): a single
 * multipart POST gives one progress bar for the whole batch, so a 100-file
 * drop was a blank wait with no per-file state, no way to cancel one bad
 * file, and no way to tell which file failed. Here every file is its own
 * request, so progress is real per file and a bounded pool keeps the panel
 * from opening hundreds of parallel sockets.
 *
 * Uploads survive panel navigation - the panel lives on document.body, not in
 * the view, and closing it only hides it.
 */
window.UploadCentre = (() => {
  const POOL = 3;           // parallel transfers
  const MAX_FILES = 200;    // sane cap; browsers choke long before this

  let panel = null;
  let bodyEl = null;
  let headEl = null;
  let active = 0;           // running transfers
  let pending = [];         // queued items
  const rows = new Map();   // file -> row record
  const idleHooks = [];     // callbacks to run once everything is settled

  const fmtSpeed = (bps) => {
    if (!bps || !isFinite(bps)) return '';
    return `${ui.fmtBytes(bps)}/s`;
  };

  const fmtEta = (sec) => {
    if (!isFinite(sec) || sec < 0 || sec > 86400 * 7) return '';
    if (sec < 1) return 'almost done';
    if (sec < 60) return `${Math.ceil(sec)}s left`;
    if (sec < 3600) return `${Math.ceil(sec / 60)}m left`;
    return `${(sec / 3600).toFixed(1)}h left`;
  };

  function ensurePanel() {
    if (panel) return panel;
    panel = ui.el('div', { class: 'uc-panel' });
    headEl = ui.el('div', { class: 'uc-head' });
    bodyEl = ui.el('div', { class: 'uc-body' });
    const foot = ui.el('div', { class: 'uc-foot' });
    const toggle = ui.el('button', { class: 'uc-min', title: 'Collapse' }, '▾');
    toggle.onclick = () => {
      panel.classList.toggle('uc-collapsed');
      toggle.textContent = panel.classList.contains('uc-collapsed') ? '▴' : '▾';
    };
    const close = ui.el('button', { class: 'uc-min', title: 'Hide (uploads keep running)' }, '✕');
    close.onclick = () => { panel.classList.add('uc-hidden'); };
    const clear = ui.el('button', { class: 'uc-min', title: 'Remove finished entries' }, 'Clear');
    clear.onclick = clearFinished;
    foot.append(toggle, clear, close);
    panel.append(headEl, bodyEl, foot);
    document.body.appendChild(panel);
    return panel;
  }

  function renderHead() {
    headEl.innerHTML = '';
    const items = [...rows.values()];
    const total = items.length;
    const done = items.filter((r) => r.state === 'done' || r.state === 'error' || r.state === 'cancel').length;
    const sent = items.reduce((a, r) => a + r.loaded, 0);
    const bytes = items.reduce((a, r) => a + (r.total || 0), 0);
    const failed = items.filter((r) => r.state === 'error').length;

    headEl.appendChild(ui.el('div', { class: 'uc-title' },
      total === done ? (failed ? `Upload finished - ${done - failed} of ${total} ok` : `Uploaded ${total} file${total === 1 ? '' : 's'}`)
        : `Uploading ${done + 1} of ${total}...`));

    const pct = bytes ? Math.min(100, (sent / bytes) * 100) : (total ? (done / total) * 100 : 0);
    const bar = ui.el('div', { class: 'uc-bar' }, ui.el('div', { class: 'uc-fill' + (failed ? ' warn' : '') }));
    bar.firstChild.style.width = `${pct}%`;
    headEl.appendChild(bar);

    const bits = [];
    if (bytes) bits.push(`${ui.fmtBytes(sent)} of ${ui.fmtBytes(bytes)}`);
    const cur = items.find((r) => r.state === 'active' && r.speed);
    if (cur) bits.push(fmtSpeed(cur.speed));
    const eta = remainingEta(items);
    if (eta) bits.push(fmtEta(eta));
    if (failed) bits.push(`${failed} failed`);
    headEl.appendChild(ui.el('div', { class: 'uc-sub text-dim' }, bits.join('  ·  ')));
  }

  function remainingEta(items) {
    let left = 0;
    let speed = 0;
    for (const r of items) {
      if (r.state !== 'active' && r.state !== 'queued') continue;
      left += Math.max(0, (r.total || 0) - r.loaded);
      speed += r.speed || 0;
    }
    return speed > 0 ? left / speed : 0;
  }

  function clearFinished() {
    for (const [file, r] of rows) {
      if (r.state === 'done' || r.state === 'error' || r.state === 'cancel') {
        r.row.remove();
        rows.delete(file);
      }
    }
    if (!rows.size && panel) { panel.remove(); panel = null; headEl = bodyEl = null; }
    else renderHead();
  }

  function makeRow(file, target) {
    const icon = ui.el('div', { class: 'uc-icon' }, '⬆');
    const name = ui.el('div', { class: 'uc-name', title: file.name }, file.name);
    const meta = ui.el('div', { class: 'uc-meta text-dim' }, ui.fmtBytes(file.size));
    const pctTxt = ui.el('div', { class: 'uc-pct' }, '0%');
    const fill = ui.el('div', { class: 'uc-fill' });
    const bar = ui.el('div', { class: 'uc-bar sm' }, fill);
    const cancel = ui.el('button', { class: 'uc-x', title: 'Cancel this file' }, '✕');
    const row = ui.el('div', { class: 'uc-row' }, icon, ui.el('div', { class: 'uc-main' }, name, bar, meta), pctTxt, cancel);
    return { row, fill, pctTxt, meta, cancel };
  }

  /** Queue files for `target` dir. Returns nothing; watch the panel. */
  function upload(fileList, target, onSettled) {
    const files = [...fileList].filter(Boolean).slice(0, MAX_FILES);
    if (!files.length) return;

    ensurePanel();
    panel.classList.remove('uc-hidden');

    const recsCreated = [];
    for (const file of files) {
      if (rows.has(file)) continue; // same File object twice in one drop
      const ui_ = makeRow(file, target);
      const rec = {
        file, target, ...ui_, state: 'queued', settled: false, loaded: 0, total: file.size || 0,
        speed: 0, startedAt: 0, lastAt: 0, lastLoaded: 0, handle: null
      };
      rows.set(file, rec);
      rec.row.classList.add('queued');
      bodyEl.appendChild(rec.row);
      rec.cancel.onclick = () => {
        if (rec.state === 'done') return;
        // abort() fires xhr.onabort, which rejects the promise and lands in
        // finish() a moment later - so mark it settled first, otherwise the
        // same record is finished twice and the active-slot counter drifts
        // (which would eventually start more transfers than POOL).
        finish(rec, 'cancel');
        if (rec.handle) rec.handle.abort();
      };
      pending.push(rec);
      recsCreated.push(file);
    }
    renderHead();
    pump();
    /* onSettled fires when THIS batch is done - NOT straight away. Calling it
     * immediately (as this used to) reloaded the file listing before a single
     * byte had landed, so freshly uploaded files only appeared after a manual
     * refresh. */
    const batch = new Set(recsCreated);
    idleHooks.push(() => {
      const stillBusy = [...batch].some((f) => {
        const r = rows.get(f);
        return r && r.state !== 'done' && r.state !== 'error' && r.state !== 'cancel';
      });
      if (!stillBusy) onSettled();
    });
  }

  function pump() {
    while (active < POOL && pending.length) {
      const rec = pending.shift();
      if (rec.state === 'cancel') continue;
      rec.row.classList.add('cancelled');
      start(rec);
    }
  }

  function start(rec) {
    active++;
    rec.state = 'active';
    rec.row.classList.remove('queued');
    rec.startedAt = Date.now();
    rec.lastAt = rec.startedAt;
    rec.lastLoaded = 0;
    rec.row.classList.add('active');

    const fd = new FormData();
    fd.append('files', rec.file, rec.file.name);
    const target = rec.target;

    rec.handle = api.uploadXhr('/files/upload?path=' + encodeURIComponent(target), fd, {
      onStart: ({ total }) => {
        // multipart framing adds a little overhead; trust the browser's number
        if (total) { rec.total = total; rec.meta.textContent = ui.fmtBytes(total); }
      },
      onProgress: ({ loaded, total }) => {
        if (total) rec.total = total;
        rec.loaded = loaded;
        const now = Date.now();
        const dt = (now - rec.lastAt) / 1000;
        if (dt >= 0.35) {
          const inst = (loaded - rec.lastLoaded) / dt;
          // smooth: blend with the last reading so the number is readable
          rec.speed = rec.speed ? rec.speed * 0.6 + inst * 0.4 : inst;
          rec.lastAt = now;
          rec.lastLoaded = loaded;
        }
        const pct = rec.total ? Math.min(100, (loaded / rec.total) * 100) : 0;
        rec.fill.style.width = `${pct}%`;
        rec.pctTxt.textContent = `${Math.floor(pct)}%`;
        const bits = [ui.fmtBytes(loaded), fmtSpeed(rec.speed), fmtEta(rec.speed ? (rec.total - loaded) / rec.speed : 0)]
          .filter(Boolean).join('  ·  ');
        rec.meta.textContent = bits || ui.fmtBytes(rec.file.size);
        renderHead();
      }
    });

    rec.handle.promise.then(
      () => finish(rec, 'done'),
      (err) => {
        if (err && err.aborted) return finish(rec, 'cancel');
        rec.error = err.message || 'Upload failed';
        finish(rec, 'error');
      }
    );
  }

  function finish(rec, state) {
    if (rec.settled) return; // abort() and the promise rejection race each other
    rec.settled = true;
    active = Math.max(0, active - 1);
    rec.state = state;
    rec.row.classList.remove('active');
    rec.row.classList.add(state);
    rec.cancel.remove();
    rec.handle = null;

    if (state === 'done') {
      rec.fill.style.width = '100%';
      rec.pctTxt.textContent = '✓';
      rec.pctTxt.classList.add('ok');
      rec.meta.textContent = ui.fmtBytes(rec.file.size);
      rec.meta.classList.remove('text-dim');
    } else if (state === 'error') {
      rec.pctTxt.textContent = '✕';
      rec.pctTxt.classList.add('bad');
      rec.pctTxt.title = rec.error || '';
      rec.meta.textContent = rec.error || 'Failed';
      rec.meta.classList.remove('text-dim');
      rec.row.classList.add('has-error');
    } else {
      rec.pctTxt.textContent = '—';
      rec.meta.textContent = 'Cancelled';
      rec.meta.classList.remove('text-dim');
    }
    renderHead();
    pump();
    notifyDone(state, rec);
  }

  let lastNotify = 0;
  function notifyDone(state, rec) {
    if (state === 'active') return;
    const now = Date.now();
    const items = [...rows.values()];
    const settled = items.every((r) => r.state === 'done' || r.state === 'error' || r.state === 'cancel');
    if (state === 'done') {
      // let the file list refresh the moment this file is actually on disk,
      // so a single upload shows up without any manual refresh
      document.dispatchEvent(new CustomEvent('uploads:file-done', { detail: { name: rec.file.name } }));
    }
    if (settled) {
      // everything is quiet: run the batch callbacks, then clear them
      const hooks = idleHooks.splice(0, idleHooks.length);
      for (const h of hooks) { try { h(); } catch { /* view may be gone */ } }
    }
    if (state === 'error') {
      // surface failures immediately - they are the reason the user is watching
      ui.toast(`${rec.file.name}: ${rec.error || 'upload failed'}`, true);
    }
    if (settled && now - lastNotify > 400) {
      lastNotify = now;
      const ok = items.filter((r) => r.state === 'done').length;
      const bad = items.filter((r) => r.state === 'error').length;
      const cancelled = items.filter((r) => r.state === 'cancel').length;
      const parts = [`${ok} uploaded`];
      if (bad) parts.push(`${bad} failed`);
      if (cancelled) parts.push(`${cancelled} cancelled`);
      if (!bad && !cancelled) ui.toast(parts.join(', '));
      document.dispatchEvent(new CustomEvent('uploads:settled', { detail: { ok, bad, cancelled } }));
    }
  }

  return { upload };
})();