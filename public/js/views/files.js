'use strict';
/* cPanel-style file manager: toolbar + breadcrumbs, multi-select table with
 * permissions column, right-click context menu, drag & drop upload, hidden
 * file toggle, filter, clipboard copy/cut/paste, zip/extract, permissions
 * editor, image preview and a text editor. */
window.FilesView = (() => {
  let cwd = '/';
  let entries = [];
  let selected = new Set();
  let clipboard = null; // { op: 'copy'|'move', paths: [...] }
  let showHidden = false;
  let filter = '';
  let rootEl = null;
  let tbody = null;
  let statusEl = null;
  let filterInput = null;
  let menu = null;
  const btn = {};

  const IMG_RE = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i;
  const ARCHIVE_RE = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i;
  const TEXT_RE = /\.(txt|md|log|ini|conf|cfg|json|js|mjs|cjs|css|scss|less|html?|htm|php|phtml|php3-8|xml|yml|yaml|sh|bash|zsh|env|htaccess|htpasswd|user\.ini|sql|py|rb|pl|c|h|cpp|go|rs|ts|jsx|tsx|vue|tpl|twig|diff|patch|gitignore|gitattributes|dockerignore|editorconfig|htaccess|lock|dist|example|sample|asc|crt|pem|key)$/i;

  const join = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;
  const base = (p) => String(p).split('/').filter(Boolean).pop() || '/';
  const parentOf = (p) => String(p).split('/').filter(Boolean).slice(0, -1).join('/') || '/';

  function ensureStyle() {
    if (document.getElementById('fm-style')) return;
    const s = document.createElement('style');
    s.id = 'fm-style';
    s.textContent = `
      .fm-tools { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px; }
      .fm-tools input[type=text] { max-width:220px; }
      .fm-sel > td { background: rgba(52,211,153,.08); }
      .fm-name { cursor:pointer; user-select:none; white-space:nowrap; }
      .fm-name:hover { text-decoration:underline; color:var(--accent-2); }
      .fm-check { width:34px; text-align:center; }
      .fm-menu { position:fixed; z-index:9999; background:var(--bg-card); border:1px solid var(--border);
        border-radius:10px; padding:5px; min-width:190px; box-shadow:0 12px 40px rgba(0,0,0,.55); }
      .fm-menu .fm-item { padding:7px 12px; cursor:pointer; font-size:13px; border-radius:6px;
        display:flex; gap:8px; align-items:center; color:var(--text); }
      .fm-menu .fm-item:hover { background:var(--bg-hover); }
      .fm-menu .fm-item.danger { color:var(--danger); }
      .fm-menu .fm-sep { height:1px; background:var(--border); margin:4px 8px; }
      .fm-drop { outline:2px dashed var(--accent); outline-offset:-6px; background:rgba(52,211,153,.06); }
      .fm-status { display:flex; gap:18px; flex-wrap:wrap; font-size:12px; color:var(--text-dim); padding:9px 4px; }
      .fm-editor { width:100%; font-family:var(--mono); font-size:13px; line-height:1.5;
        tab-size:2; min-height:52vh; resize:vertical; }
      .fm-perms { display:grid; grid-template-columns:auto repeat(3,1fr); gap:6px 14px; align-items:center; max-width:320px; }
      .fm-perms .hdr { color:var(--text-dim); font-size:12px; text-align:center; }
      .fm-img { max-width:100%; max-height:60vh; display:block; margin:0 auto; border-radius:8px; background:#fff; }
      .fm-modal-img { text-align:center; }
    `;
    document.head.appendChild(s);
    // persistent closers for the context menu
    document.addEventListener('click', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
  }

  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  async function load(root, path) {
    ensureStyle();
    wireUploadRefresh();
    rootEl = root;
    cwd = path || cwd || '/';
    selected.clear();
    closeMenu();
    root.innerHTML = '';

    let data;
    try {
      data = await api.get('/files/list?path=' + encodeURIComponent(cwd));
    } catch (e) {
      root.appendChild(ui.el('div', { class: 'banner' }, e.message));
      return;
    }
    entries = data.entries || [];

    root.appendChild(toolbar());
    root.appendChild(breadcrumb());

    const wrap = ui.el('div', { class: 'table-wrap', style: 'position:relative' });
    const table = ui.el('table', {},
      ui.el('thead', {}, ui.el('tr', {},
        ui.el('th', { class: 'fm-check' }, selectAllBox()),
        ui.el('th', {}, 'Name'),
        ui.el('th', {}, 'Size'),
        ui.el('th', {}, 'Permissions'),
        ui.el('th', {}, 'Modified'),
        ui.el('th', {}, 'Actions'))),
      ui.el('tbody', {}));
    tbody = table.querySelector('tbody');
    wrap.appendChild(table);
    root.appendChild(wrap);
    attachDrop(wrap);

    statusEl = ui.el('div', { class: 'fm-status' });
    root.appendChild(statusEl);

    renderTable();
    updateActions();
    renderStatus();
  }

  function selectAllBox() {
    const cb = ui.el('input', { type: 'checkbox', title: 'Select all' });
    cb.onclick = (e) => {
      e.stopPropagation();
      selected = cb.checked ? new Set(visible().map((x) => x.path)) : new Set();
      renderTable(); updateActions(); renderStatus();
    };
    btn.selAll = cb;
    return cb;
  }

  function toolbar() {
    Object.keys(btn).forEach((k) => delete btn[k]);

    const mk = (label, onclick, title) => {
      const b = ui.el('button', { class: 'btn', title: title || '' }, label);
      b.onclick = onclick;
      return b;
    };

    btn.up = mk('⬆ Up', () => load(rootEl, parentOf(cwd)), 'Parent directory');
    btn.home = mk('🏠 Home', () => load(rootEl, '/'));
    btn.newFile = mk('📄 New File', () => newFilePrompt(), 'Create an empty file here');
    btn.newFolder = mk('📁 New Folder', () => newFolderPrompt());
    btn.upload = mk('⬆ Upload', () => uploadPrompt(), 'Or drag & drop files onto the list');
    btn.refresh = mk('↻ Refresh', () => load(rootEl, cwd));
    btn.paste = mk('📋 Paste', () => pasteSel(), 'Paste copied/cut items here');

    btn.cut = mk('✂ Cut', () => setClipboard('move'));
    btn.copy = mk('📋 Copy', () => setClipboard('copy'));
    btn.rename = mk('✏ Rename', () => singleSel() && renamePrompt(singleSel()));
    btn.perms = mk('🔒 Permissions', () => singleSel() && permsModal(singleSel()));
    btn.zip = mk('🗜 Zip', () => zipSel());
    btn.extract = mk('📦 Extract', () => singleSel() && ARCHIVE_RE.test(singleSel().name) && extractSel(singleSel()));
    btn.download = mk('⬇ Download', () => downloadSel());
    btn.del = mk('🗑 Delete', () => deleteSel(), 'Delete selected');

    const hiddenLbl = ui.el('label', {
      style: 'display:flex;gap:6px;align-items:center;font-size:12px;color:var(--text-dim);margin:0;cursor:pointer'
    }, '👁 Hidden files');
    const hiddenCb = ui.el('input', { type: 'checkbox' });
    hiddenCb.checked = showHidden;
    hiddenCb.onchange = () => { showHidden = hiddenCb.checked; renderTable(); renderStatus(); };
    hiddenLbl.prepend(hiddenCb);

    filterInput = ui.el('input', { type: 'text', placeholder: 'filter…', style: 'width:150px' });
    filterInput.value = filter;
    filterInput.oninput = () => { filter = filterInput.value.trim().toLowerCase(); renderTable(); renderStatus(); };

    const row1 = ui.el('div', { class: 'fm-tools' },
      btn.up, btn.home,
      ui.el('span', { style: 'width:1px;height:22px;background:var(--border)' }),
      btn.newFile, btn.newFolder, btn.upload, btn.paste, btn.refresh,
      ui.el('span', { style: 'flex:1' }),
      hiddenLbl, filterInput);

    const row2 = ui.el('div', { class: 'fm-tools', style: 'margin-bottom:14px' },
      ui.el('span', { class: 'text-dim', style: 'font-size:12px' }, 'Selection:'),
      btn.cut, btn.copy, btn.rename, btn.perms, btn.zip, btn.extract, btn.download, btn.del);

    return ui.el('div', {}, row1, row2);
  }

  function breadcrumb() {
    const crumbs = ui.el('div', { class: 'breadcrumb' });
    crumbs.appendChild(ui.el('a', { onclick: () => load(rootEl, '/') }, '/ 🏠'));
    let acc = '';
    for (const p of cwd.split('/').filter(Boolean)) {
      acc += '/' + p;
      const target = acc;
      crumbs.append(' › ', ui.el('a', { onclick: () => load(rootEl, target) }, p));
    }
    return crumbs;
  }

  const visible = () => entries.filter((e) =>
    (showHidden || !e.name.startsWith('.')) &&
    (!filter || e.name.toLowerCase().includes(filter)));

  function iconOf(e) {
    if (e.type === 'dir') return '📁';
    if (e.type === 'link') return '🔗';
    if (IMG_RE.test(e.name)) return '🖼';
    if (ARCHIVE_RE.test(e.name)) return '🗜';
    if (/\.php\d?$/i.test(e.name)) return '🐘';
    return '📄';
  }

  function renderTable() {
    if (!tbody) return;
    tbody.innerHTML = '';
    const vis = visible();

    if (cwd !== '/') {
      const up = ui.el('tr', { class: 'clickable' },
        ui.el('td', { class: 'fm-check' }),
        ui.el('td', { colspan: '5' }, '⬆ ..'));
      up.onclick = () => load(rootEl, parentOf(cwd));
      tbody.appendChild(up);
    }

    if (!vis.length) {
      tbody.appendChild(ui.el('tr', {},
        ui.el('td', { colspan: '6', class: 'text-dim', style: 'text-align:center;padding:26px' },
          entries.length ? 'No matching files.' : 'Empty directory.')));
      if (btn.selAll) btn.selAll.checked = false;
      return;
    }

    for (const e of vis) {
      const isSel = selected.has(e.path);
      const cb = ui.el('input', { type: 'checkbox' });
      cb.checked = isSel;
      cb.onclick = (ev) => {
        ev.stopPropagation();
        cb.checked ? selected.add(e.path) : selected.delete(e.path);
        syncSelection();
      };

      const nameCell = ui.el('td', { class: 'fm-name' }, `${iconOf(e)} ${e.name}`);
      nameCell.onclick = (ev) => { ev.stopPropagation(); openEntry(e); };

      const actions = ui.el('td', { style: 'white-space:nowrap' },
        e.type === 'file'
          ? ui.el('a', {
              class: 'btn btn-sm',
              href: '/api/files/download?path=' + encodeURIComponent(e.path),
              title: 'Download'
            }, '⬇') : null,
        e.type === 'file' && IMG_RE.test(e.name) ? ui.el('button', {
          class: 'btn btn-sm', title: 'Preview',
          onclick: (ev) => { ev.stopPropagation(); imageModal(e); }
        }, '👁') : null,
        e.type === 'file' ? ui.el('button', {
          class: 'btn btn-sm', title: 'Edit',
          onclick: (ev) => { ev.stopPropagation(); editorModal(e); }
        }, '📝') : null, ' ',
        ui.el('button', {
          class: 'btn btn-sm', title: 'Rename',
          onclick: (ev) => { ev.stopPropagation(); renamePrompt(e); }
        }, '✏'), ' ',
        ui.el('button', {
          class: 'btn btn-sm', title: 'Permissions',
          onclick: (ev) => { ev.stopPropagation(); permsModal(e); }
        }, '🔒'), ' ',
        ui.el('button', {
          class: 'btn btn-sm btn-danger', title: 'Delete',
          onclick: async (ev) => {
            ev.stopPropagation();
            if (!(await ui.confirmBox(`Delete ${e.path}?`, { okText: 'Delete' }))) return;
            try { await api.post('/files/delete', { path: e.path }); load(rootEl, cwd); }
            catch (err) { ui.toast(err.message, true); }
          }
        }, '🗑'));

      const tr = ui.el('tr', { class: isSel ? 'fm-sel' : '' },
        ui.el('td', { class: 'fm-check' }, cb),
        nameCell,
        ui.el('td', { class: 'text-dim' }, e.type === 'dir' ? '–' : ui.fmtBytes(e.size)),
        ui.el('td', { class: 'text-dim', style: 'font-family:var(--mono);font-size:12px' }, e.mode || ''),
        ui.el('td', { class: 'text-dim', style: 'font-size:12px' }, e.mtime ? new Date(e.mtime).toLocaleString() : ''),
        actions);

      tr.dataset.path = e.path;
      tr.onclick = (ev) => {
        if (ev.target.closest('a,button,input,.fm-name')) return;
        toggleRow(e.path, false);
      };
      tr.oncontextmenu = (ev) => showMenu(ev, e);
      tr.ondblclick = () => openEntry(e);
      tbody.appendChild(tr);
    }
    if (btn.selAll) {
      const visSel = vis.filter((e) => selected.has(e.path)).length;
      btn.selAll.checked = visSel > 0 && visSel === vis.length;
      btn.selAll.indeterminate = visSel > 0 && visSel < vis.length;
    }
  }

  function toggleRow(path, additive) {
    if (additive) selected.has(path) ? selected.delete(path) : selected.add(path);
    else if (selected.has(path) && selected.size === 1) selected.delete(path);
    else selected = new Set([path]);
    syncSelection();
  }

  /** Update checkboxes/row classes + action buttons + status after a
   *  selection change without refetching the directory. */
  function syncSelection() {
    if (!tbody) return;
    for (const tr of tbody.querySelectorAll('tr')) {
      const p = tr.dataset.path;
      if (!p) continue;
      const on = selected.has(p);
      tr.classList.toggle('fm-sel', on);
      const cb = tr.querySelector('input[type=checkbox]');
      if (cb) cb.checked = on;
    }
    updateActions();
    renderStatus();
  }

  const singleSel = () => selected.size === 1
    ? entries.find((e) => e.path === [...selected][0])
    : null;
  const selEntries = () => [...selected]
    .map((p) => entries.find((e) => e.path === p))
    .filter(Boolean);

  function updateActions() {
    const n = selected.size;
    const one = singleSel();
    if (btn.up) btn.up.disabled = cwd === '/';
    if (btn.paste) btn.paste.disabled = !clipboard;
    for (const k of ['cut', 'copy', 'zip', 'del']) if (btn[k]) btn[k].disabled = n === 0;
    if (btn.rename) btn.rename.disabled = !one;
    if (btn.perms) btn.perms.disabled = !one;
    if (btn.extract) btn.extract.disabled = !(one && ARCHIVE_RE.test(one.name));
    if (btn.download) btn.download.disabled = n === 0;
  }

  function renderStatus() {
    if (!statusEl) return;
    const vis = visible();
    const sel = selEntries();
    const selBytes = sel.reduce((a, e) => a + (e.type === 'file' ? e.size || 0 : 0), 0);
    statusEl.innerHTML = '';
    statusEl.append(
      ui.el('span', {}, `${vis.length} item${vis.length === 1 ? '' : 's'}`),
      sel.length ? ui.el('span', { style: 'color:var(--accent)' },
        `${sel.length} selected (${ui.fmtBytes(selBytes)})`) : null,
      clipboard ? ui.el('span', {}, `${clipboard.op === 'copy' ? 'Copied' : 'Cut'}: ${clipboard.paths.length} item(s) — press Paste`) : null,
      ui.el('span', { style: 'margin-left:auto' },
        'double-click opens · right-click for actions · drop files to upload'));
  }

  /* ---------------------------------------------------------------- */
  /* Context menu                                                      */
  /* ---------------------------------------------------------------- */

  function showMenu(ev, e) {
    ev.preventDefault();
    ev.stopPropagation();
    closeMenu();
    if (!selected.has(e.path)) { selected = new Set([e.path]); syncSelection(); }

    const items = [];
    if (e.type === 'dir') items.push(['📂 Open', () => load(rootEl, e.path)]);
    else if (IMG_RE.test(e.name)) items.push(['👁 View', () => imageModal(e)]);
    if (e.type === 'file') {
      items.push(['📝 Edit', () => editorModal(e)]);
      items.push(['⬇ Download', () => downloadLink(e.path)]);
    }
    items.push(null);
    items.push(['✂ Cut', () => setClipboard('move')]);
    items.push(['📋 Copy', () => setClipboard('copy')]);
    items.push(['✏ Rename', () => renamePrompt(e)]);
    items.push(['🔒 Permissions', () => permsModal(e)]);
    if (ARCHIVE_RE.test(e.name)) items.push(['📦 Extract here', () => extractSel(e)]);
    else items.push(['🗜 Zip', () => zipSel()]);
    items.push(null);
    items.push(['📋 Copy path', () => {
      if (navigator.clipboard) navigator.clipboard.writeText(e.path).then(() => ui.toast('Path copied'));
      else ui.toast('Clipboard unavailable in this browser', true);
    }]);
    items.push(['🗑 Delete', () => deleteSel(), 'danger']);

    const m = ui.el('div', { class: 'fm-menu' });
    for (const it of items) {
      if (!it) { m.appendChild(ui.el('div', { class: 'fm-sep' })); continue; }
      const [label, fn, cls] = it;
      const row = ui.el('div', { class: 'fm-item' + (cls ? ' ' + cls : '') }, label);
      row.onclick = () => { closeMenu(); fn(); };
      m.appendChild(row);
    }
    document.body.appendChild(m);
    // keep inside viewport
    const r = m.getBoundingClientRect();
    const x = Math.min(ev.clientX, window.innerWidth - r.width - 8);
    const y = Math.min(ev.clientY, window.innerHeight - r.height - 8);
    m.style.left = x + 'px';
    m.style.top = y + 'px';
    menu = m;
  }

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  function openEntry(e) {
    if (e.type === 'dir') return load(rootEl, e.path);
    if (IMG_RE.test(e.name)) return imageModal(e);
    return editorModal(e);
  }

  async function editorModal(e) {
    let content;
    try {
      const r = await api.get('/files/read?path=' + encodeURIComponent(e.path));
      content = r.content;
    } catch (err) { return ui.toast(err.message, true); }

    if (content.slice(0, 512).includes('\0')) {
      let m;
      m = ui.modal({
        title: e.name,
        body: ui.el('div', {},
          ui.el('p', {}, 'Binary file — the text editor may mangle it. Prefer downloading?'),
          ui.el('div', { class: 'modal-actions' },
            ui.el('a', { class: 'btn', href: '/api/files/download?path=' + encodeURIComponent(e.path) }, '⬇ Download'),
            ui.el('button', { class: 'btn btn-primary', onclick: () => { m.close(); openEditor(e, content); } }, 'Edit anyway')))
      });
      return m;
    }
    openEditor(e, content);
  }

  function openEditor(e, content) {
    const area = ui.el('textarea', { class: 'fm-editor', spellcheck: 'false' });
    area.value = content;
    area.addEventListener('keydown', (ev) => {
      if (ev.key === 'Tab') {
        ev.preventDefault();
        const s = area.selectionStart, t = area.selectionEnd;
        area.value = area.value.slice(0, s) + '  ' + area.value.slice(t);
        area.selectionStart = area.selectionEnd = s + 2;
      }
    });

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Close');
    const save = ui.el('button', { class: 'btn btn-primary' }, '💾 Save');
    actions.append(cancel, save);
    const m = ui.modal({ title: e.path, body: ui.el('div', {}, area, actions), wide: true });
    cancel.onclick = m.close;
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api.post('/files/write', { path: e.path, content: area.value });
        ui.toast('Saved'); m.close(); load(rootEl, cwd);
      } catch (err) { ui.toast(err.message, true); save.disabled = false; }
    };
  }

  function imageModal(e) {
    const body = ui.el('div', { class: 'fm-modal-img' },
      ui.el('img', { class: 'fm-img', src: '/api/files/preview?path=' + encodeURIComponent(e.path) + '&t=' + Date.now(), alt: e.name }),
      ui.el('p', { class: 'text-dim', style: 'font-size:12px' }, `${e.name} · ${ui.fmtBytes(e.size)} · ${e.mode || ''}`),
      ui.el('div', { class: 'modal-actions' },
        ui.el('a', { class: 'btn', href: '/api/files/download?path=' + encodeURIComponent(e.path) }, '⬇ Download'),
        ui.el('button', { class: 'btn btn-primary', onclick: () => { m.close(); editorModal(e); } }, '📝 Edit')));
    const m = ui.modal({ title: e.name, body, wide: true });
  }

  function namePrompt(title, placeholder, initial, okText) {
    return new Promise((resolve) => {
      const input = ui.el('input', { type: 'text', placeholder });
      input.value = initial || '';
      const actions = ui.el('div', { class: 'modal-actions' });
      const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
      const ok = ui.el('button', { class: 'btn btn-primary' }, okText || 'OK');
      actions.append(cancel, ok);
      const m = ui.modal({ title, body: ui.el('div', {}, ui.el('label', {}, 'Name', input), actions) });
      cancel.onclick = () => { m.close(); resolve(null); };
      ok.onclick = () => { const v = input.value.trim(); m.close(); resolve(v || null); };
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ok.click(); });
      setTimeout(() => input.focus(), 30);
    });
  }

  async function newFilePrompt() {
    const name = await namePrompt(`New file in ${cwd}`, 'file.txt', '', 'Create');
    if (!name) return;
    if (name.includes('/')) return ui.toast('Name cannot contain "/"', true);
    try {
      const r = await api.post('/files/touch', { path: join(cwd, name) });
      await load(rootEl, cwd);
      const created = entries.find((x) => x.path === r.path);
      if (created) editorModal(created);
    } catch (e) { ui.toast(e.message, true); }
  }

  async function newFolderPrompt() {
    const name = await namePrompt(`New folder in ${cwd}`, 'folder-name', '', 'Create');
    if (!name) return;
    if (name.includes('/')) return ui.toast('Name cannot contain "/"', true);
    if (entries.some((e) => e.name === name)) return ui.toast('An item with that name already exists', true);
    try {
      await api.post('/files/mkdir', { path: join(cwd, name) });
      ui.toast('Folder created');
      load(rootEl, cwd);
    } catch (e) { ui.toast(e.message, true); }
  }

  async function renamePrompt(e) {
    const name = await namePrompt(`Rename ${e.name}`, 'new-name', e.name, 'Rename');
    if (!name || name === e.name) return;
    if (name.includes('/')) return ui.toast('Name cannot contain "/"', true);
    if (e.type === 'file' && entries.some((x) => x.name === name && x.path !== e.path)) {
      if (!(await ui.confirmBox(`"${name}" already exists — overwrite it?`, { okText: 'Overwrite' }))) return;
    }
    try {
      await api.post('/files/rename', { from: e.path, to: join(cwd, name) });
      selected.delete(e.path);
      load(rootEl, cwd);
    } catch (err) { ui.toast(err.message, true); }
  }

  async function deleteSel() {
    const items = selEntries();
    if (!items.length) return;
    if (!(await ui.confirmBox(
      `Delete ${items.length === 1 ? items[0].path : items.length + ' selected items'}? This cannot be undone.`,
      { okText: 'Delete' }))) return;
    const errs = [];
    for (const it of items) {
      try { await api.post('/files/delete', { path: it.path }); }
      catch (e) { errs.push(`${it.name}: ${e.message}`); }
    }
    if (errs.length) ui.modal({ title: 'Some deletes failed', body: ui.el('pre', { class: 'pre-log' }, errs.join('\n')) });
    else ui.toast(`Deleted ${items.length} item${items.length === 1 ? '' : 's'}`);
    selected.clear();
    load(rootEl, cwd);
  }

  function setClipboard(op) {
    const items = selEntries();
    if (!items.length) return;
    clipboard = { op, paths: items.map((e) => e.path) };
    ui.toast(`${op === 'copy' ? 'Copied' : 'Cut'} ${items.length} item(s) — navigate to a folder and Paste`);
    updateActions();
    renderStatus();
  }

  async function pasteSel() {
    if (!clipboard) return;
    const errs = [];
    let done = 0;
    for (const p of clipboard.paths) {
      const name = base(p);
      const to = join(cwd, name);
      if (to === p) continue;
      if (entries.some((x) => x.name === name)) { errs.push(`${name}: an item with that name already exists here`); continue; }
      try {
        await api.post(`/files/${clipboard.op === 'copy' ? 'copy' : 'move'}`, { from: p, to });
        done++;
      } catch (e) { errs.push(`${name}: ${e.message}`); }
    }
    if (clipboard.op === 'move') clipboard = null;
    if (errs.length) ui.modal({ title: 'Paste issues', body: ui.el('pre', { class: 'pre-log' }, errs.join('\n')) });
    else if (done) ui.toast(`${done} item(s) pasted`);
    selected.clear();
    load(rootEl, cwd);
  }

  async function zipSel() {
    const items = selEntries();
    if (!items.length) return;
    const suggested = items.length === 1 && items[0].type === 'file'
      ? items[0].name.replace(/\.[^.]+$/, '') + '.zip'
      : items.length === 1 ? items[0].name + '.zip' : 'archive.zip';
    const name = await namePrompt(`Zip ${items.length === 1 ? items[0].name : items.length + ' items'} into ${cwd}`, 'archive.zip', suggested, 'Zip');
    if (!name) return;
    if (name.includes('/')) return ui.toast('Name cannot contain "/"', true);
    try {
      const r = await api.post('/files/zip', { paths: items.map((e) => e.path), dest: join(cwd, name) });
      ui.toast(`Created ${base(r.path)}`);
      selected.clear();
      load(rootEl, cwd);
    } catch (e) { ui.toast(e.message, true); }
  }

  async function extractSel(e) {
    try {
      await api.post('/files/extract', { path: e.path });
      ui.toast('Extracted into ' + cwd);
      load(rootEl, cwd);
    } catch (err) { ui.toast(err.message, true); }
  }

  function downloadLink(path) {
    const a = document.createElement('a');
    a.href = '/api/files/download?path=' + encodeURIComponent(path);
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function downloadSel() {
    const items = selEntries();
    if (!items.length) return;
    if (items.length === 1 && items[0].type === 'file') return downloadLink(items[0].path);
    // multiple items or folders: zip them first, download, clean up after
    const dest = join(cwd, `.letz-dl-${Date.now()}.zip`);
    ui.toast('Preparing archive…');
    try {
      const r = await api.post('/files/zip', { paths: items.map((e) => e.path), dest });
      downloadLink(r.path);
      setTimeout(() => api.post('/files/delete', { path: r.path }).catch(() => {}), 120_000);
    } catch (e) { ui.toast(e.message, true); }
  }

  function permsModal(e) {
    const mode = (e.mode || (e.type === 'dir' ? '755' : '644')).padStart(3, '0').slice(-4);
    const body = ui.el('div', {});
    body.appendChild(ui.el('p', { class: 'text-dim', style: 'margin-top:0' }, e.path));

    const oct = ui.el('input', { type: 'text', maxlength: '4', style: 'width:90px;font-family:var(--mono)' });
    oct.value = mode;

    const grid = ui.el('div', { class: 'fm-perms' },
      ui.el('span', {}), ui.el('span', { class: 'hdr' }, 'Read'), ui.el('span', { class: 'hdr' }, 'Write'), ui.el('span', { class: 'hdr' }, 'Execute'));
    const boxes = {};
    let bi = 0;
    for (const grp of ['Owner', 'Group', 'Others']) {
      grid.appendChild(ui.el('span', { style: 'font-size:13px' }, grp));
      for (const kind of ['r', 'w', 'x']) {
        const cb = ui.el('input', { type: 'checkbox' });
        cb.dataset.i = bi++;
        grid.appendChild(ui.el('span', { style: 'text-align:center' }, cb));
        boxes[grp + kind] = cb;
      }
    }

    const syncFromOctal = () => {
      const v = oct.value.replace(/[^0-7]/g, '').padStart(3, '0').slice(-3);
      const digits = v.split('').map(Number);
      const groups = ['Owner', 'Group', 'Others'];
      groups.forEach((grp, gi) => {
        const bits = digits[gi] || 0;
        boxes[grp + 'r'].checked = !!(bits & 4);
        boxes[grp + 'w'].checked = !!(bits & 2);
        boxes[grp + 'x'].checked = !!(bits & 1);
      });
    };
    const syncFromBoxes = () => {
      let v = '';
      for (const grp of ['Owner', 'Group', 'Others']) {
        v += String((boxes[grp + 'r'].checked ? 4 : 0) + (boxes[grp + 'w'].checked ? 2 : 0) + (boxes[grp + 'x'].checked ? 1 : 0));
      }
      oct.value = v;
    };
    oct.oninput = syncFromOctal;
    for (const cb of Object.values(boxes)) cb.onchange = syncFromBoxes;
    syncFromOctal();

    body.appendChild(ui.el('div', { style: 'display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap' },
      ui.el('div', {},
        ui.el('div', { style: 'font-weight:600;color:var(--accent);margin-bottom:8px;font-size:13px' }, 'Mode'),
        ui.el('label', {}, 'Octal', oct),
        ui.el('p', { class: 'text-dim', style: 'font-size:12px' }, 'e.g. 644 files, 755 folders')),
      grid));

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const save = ui.el('button', { class: 'btn btn-primary' }, '💾 Save permissions');
    actions.append(cancel, save);
    body.appendChild(actions);
    const m = ui.modal({ title: `Permissions — ${e.name}`, body });
    cancel.onclick = m.close;
    save.onclick = async () => {
      if (!/^[0-7]{3,4}$/.test(oct.value)) return ui.toast('Mode must be 3-4 octal digits', true);
      try {
        await api.post('/files/chmod', { path: e.path, mode: oct.value });
        ui.toast('Permissions updated');
        m.close();
        load(rootEl, cwd);
      } catch (err) { ui.toast(err.message, true); }
    };
  }

  /* ---------------------------------------------------------------- */
  /* Upload (modal + drag & drop)                                      */
  /* ---------------------------------------------------------------- */

  /* Hand files to the upload centre. Every file is uploaded on its own so the
   * panel can show real per-file progress, allow cancelling one file, and
   * report which file failed. The file list refreshes once the batch settles. */
  function uploadFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const added = UploadCentre.upload(fileList, cwd, () => refreshAfterUpload());
    if (added === false) ui.toast('Too many files in one go (max 200)', true);
  }

  /* Re-read the directory as files land. Debounced because a 50-file batch
   * fires one event per file and each reload is a full directory listing.
   * Guarded on the view still being mounted: the user may have navigated
   * away while the transfer was running. */
  let refreshTimer = null;
  function refreshAfterUpload() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      // reload whatever directory is on screen now - if the user navigated
      // away mid-upload this simply refreshes the new one, which is harmless
      if (rootEl && rootEl.isConnected) load(rootEl, cwd);
    }, 400);
  }

  /* Wired once per page session: a finished file can come from a drop that
   * happened on this view or on any other, so listen at document level. */
  let refreshWired = false;
  function wireUploadRefresh() {
    if (refreshWired) return;
    refreshWired = true;
    document.addEventListener('uploads:file-done', () => refreshAfterUpload());
  }

  function uploadPrompt() {
    const input = ui.el('input', { type: 'file', multiple: '', style: 'display:none' });
    const queue = ui.el('div', { class: 'uc-queue', style: 'display:none' });

    const renderQueue = () => {
      const files = [...input.files];
      queue.style.display = files.length ? '' : 'none';
      queue.innerHTML = '';
      for (const f of files.slice(0, 40)) {
        queue.appendChild(ui.el('div', { class: 'uc-queue-row' },
          ui.el('span', {}, f.name), ui.el('span', {}, ui.fmtBytes(f.size))));
      }
      if (files.length > 40) {
        queue.appendChild(ui.el('div', { class: 'uc-queue-row' },
          ui.el('span', {}, `…and ${files.length - 40} more`), ui.el('span', {}, '')));
      }
    };

    const drop = ui.el('div', { class: 'uc-drop' },
      ui.el('div', { class: 'uc-drop-icon' }, '📦'),
      ui.el('div', { class: 'uc-drop-title' }, 'Drop files here, or click to choose'),
      ui.el('div', { class: 'uc-drop-sub text-dim' }, `Uploading to ${cwd}`),
      input);
    drop.onclick = () => input.click();
    input.onchange = renderQueue;
    // dropping onto the dialog must not bubble to the page-wide drop handler
    for (const ev of ['dragenter', 'dragover', 'dragleave', 'drop']) {
      drop.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        drop.classList.toggle('over', ev === 'dragenter' || ev === 'dragover');
      });
    }
    drop.addEventListener('drop', (e) => {
      drop.classList.remove('over');
      // keep the dialog open so the chosen list and this drop can be combined
      if (e.dataTransfer && e.dataTransfer.files.length) {
        const existing = [...input.files];
        const dt = new DataTransfer();
        for (const f of existing) dt.items.add(f);
        for (const f of e.dataTransfer.files) dt.items.add(f);
        input.files = dt.files;
        renderQueue();
      }
    });

    const hint = ui.el('p', { class: 'text-dim', style: 'font-size:12px;margin-top:10px' },
      'Existing files with the same name are replaced. You can keep using the panel while uploads run.');

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const ok = ui.el('button', { class: 'btn btn-primary' }, 'Upload');
    actions.append(cancel, ok);
    const m = ui.modal({ title: `Upload to ${cwd}`, body: ui.el('div', {}, drop, queue, hint, actions) });
    cancel.onclick = m.close;
    ok.onclick = () => {
      const files = [...input.files];
      m.close();
      uploadFiles(files);
    };
  }

  function attachDrop(wrap) {
    wrap.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); wrap.classList.add('fm-drop'); });
    wrap.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation(); wrap.classList.add('fm-drop'); });
    wrap.addEventListener('dragleave', (e) => {
      if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('fm-drop');
    });
    wrap.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      wrap.classList.remove('fm-drop');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        uploadFiles(e.dataTransfer.files);
      }
    });
  }

  /* Deep link support: #/files?path=/var/www/example.com/public
   * (the Websites view opens each site's docroot this way) */
  function initialPath() {
    const m = /[?&]path=([^&]+)/.exec(location.hash);
    if (!m) return '/';
    try { return decodeURIComponent(m[1]); } catch { return '/'; }
  }

  return {
    render: (root) => load(root, initialPath()),
    destroy: () => closeMenu()
  };
})();
