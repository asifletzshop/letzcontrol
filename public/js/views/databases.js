'use strict';
/* Databases view: list, create, drop MySQL databases */
window.DatabasesView = (() => {
  let dbs = [];

  async function load(root, me) {
    root.innerHTML = '';
    let data;
    try {
      data = await api.get('/databases');
    } catch (e) {
      root.appendChild(ui.el('div', { class: 'banner' }, e.message));
      return;
    }
    dbs = data.databases || [];
    const pma = await api.get('/databases/phpmyadmin').catch(() => ({ installed: false }));

    root.appendChild(ui.el('div', { class: 'toolbar' },
      ui.el('button', { class: 'btn btn-primary', onclick: () => createModal(root, me) }, '+ New Database'),
      ui.el('button', { class: 'btn', onclick: () => openPma(pma, me) },
        `🖥 phpMyAdmin${pma.installed && pma.version ? ` (${pma.version})` : ''}`)
    ));

    if (!data.databases.length) {
      root.appendChild(ui.el('div', { class: 'card empty' }, 'No databases yet.'));
      return;
    }

    const rows = data.databases.map((d) => ui.el('tr', {},
      ui.el('td', { class: 'mono' }, d.name),
      ui.el('td', { class: 'mono' }, d.dbUser),
      me.role === 'admin' ? ui.el('td', { class: 'text-dim' }, d.owner) : null,
      ui.el('td', { class: 'text-dim' }, new Date(d.createdAt).toLocaleDateString()),
      ui.el('td', {},
        ui.el('button', {
          class: 'btn btn-sm',
          title: 'Open this database in phpMyAdmin',
          onclick: () => openPma(pma, me, d.name, d.dbUser)
        }, '🖥 phpMyAdmin'), ' ',
        ui.el('button', {
          class: 'btn btn-sm',
          onclick: () => editModal(root, me, d)
        }, '✏️ Edit'), ' ',
        ui.el('a', {
          class: 'btn btn-sm',
          href: `/api/databases/${d.id}/backup`,
          title: 'Download a SQL backup of this database'
        }, '📥 Backup'), ' ',
        ui.el('button', {
          class: 'btn btn-sm btn-danger',
        onclick: async () => {
          if (!(await ui.confirmBox(`Drop database "${d.name}"? This cannot be undone.`, { okText: 'Drop database' }))) return;
          try { await api.del(`/databases/${d.id}`); ui.toast('Database dropped'); load(root, me); }
          catch (e) { ui.toast(e.message, true); }
        }
      }, '🗑 Drop'))
    )).filter(Boolean);

    root.appendChild(ui.el('div', { class: 'table-wrap' },
      ui.el('table', {},
        ui.el('thead', {}, ui.el('tr', {},
          ui.el('th', {}, 'Database'), ui.el('th', {}, 'User'),
          me.role === 'admin' ? ui.el('th', {}, 'Owner') : null,
          ui.el('th', {}, 'Created'), ui.el('th', {}, 'Actions'))),
        ui.el('tbody', {}, ...rows))));
  }

  /** Rename the MySQL user and/or set a new password. */
  function editModal(root, me, d) {
    const body = ui.el('div', {});
    body.appendChild(ui.el('label', {}, 'Database user',
      ui.el('input', { type: 'text', id: 'db-user-edit', value: d.dbUser })));
    body.appendChild(ui.el('label', {}, 'New password (leave blank to keep the current one)',
      ui.el('input', { type: 'password', id: 'db-pass-edit', placeholder: '••••••••' })));
    body.appendChild(ui.el('p', { class: 'text-dim' },
      'Renaming renames the MySQL account itself — existing grants and grants to this database are preserved.'));

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const save = ui.el('button', { class: 'btn btn-primary' }, 'Save');
    actions.append(cancel, save);
    body.appendChild(actions);

    const m = ui.modal({ title: `Edit ${d.name}`, body });
    cancel.onclick = m.close;
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api.put(`/databases/${d.id}`, {
          dbUser: document.getElementById('db-user-edit').value,
          dbPassword: document.getElementById('db-pass-edit').value
        });
        m.close();
        ui.toast('Database user updated');
        load(root, me);
      } catch (e) {
        ui.toast(e.message, true);
        save.disabled = false;
      }
    };
  }

  /**
   * Open phpMyAdmin - optionally straight into a specific database.
   * First shows WHICH credentials to type: phpMyAdmin's login screen
   * ("Welcome to phpMyAdmin") wants a MySQL account, not the panel login,
   * and MySQL root is socket-only on this server, so each database must
   * be opened with its own user + password.
   */
  function openPma(pma, me, dbName, dbUser) {
    if (!pma.installed) {
      if (me.role === 'admin') installPmaModal();
      else ui.toast('phpMyAdmin is not installed yet', true);
      return;
    }
    const base = `http://${location.hostname}:2089/`;
    // Toolbar entry with exactly one database: open THAT database, not the
    // phpMyAdmin homepage (users clicking here expect "their" database).
    if (!dbName && dbs.length === 1) {
      dbName = dbs[0].name;
      dbUser = dbs[0].dbUser;
    }
    const url = dbName
      ? `${base}index.php?route=/database/structure&db=${encodeURIComponent(dbName)}`
      : base;

    const body = ui.el('div', {});
    body.appendChild(ui.el('p', { style: 'margin-top:0' },
      dbName
        ? 'phpMyAdmin will open straight in this database. Log in with its MySQL user (not the panel login):'
        : 'On the login screen, use a database\'s MySQL user and password — not the panel login:'));

    const list = ui.el('div', {
      style: 'border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-family:var(--mono);font-size:12.5px;line-height:1.9'
    });
    const shown = dbName
      ? dbs.filter((d) => d.name === dbName)
      : dbs;
    if (!shown.length) list.appendChild(ui.el('span', { class: 'text-dim' }, 'No databases yet.'));
    for (const d of shown) {
      const isTarget = d.name === dbName;
      list.appendChild(ui.el('div', { style: isTarget ? 'color:var(--accent)' : '' },
        `${d.dbUser}  →  ${d.name}${isTarget ? '  ✓ (this one)' : ''}`));
    }
    body.appendChild(list);

    body.appendChild(ui.el('p', { class: 'text-dim', style: 'font-size:12.5px;margin-bottom:0' },
      'Password: the one you set when creating the database. Forgotten it? Use ✏️ Edit in the list to set a new one. ' +
      'MySQL root cannot log in here (socket-only).'));

    // Silent-wrong-account trap: phpMyAdmin 302-redirects a session without
    // privileges for the requested db to its homepage with no error at all.
    body.appendChild(ui.el('p', {
      class: 'text-dim',
      style: 'font-size:12.5px;margin:8px 0 0;padding:8px 10px;border:1px solid var(--border);border-radius:8px'
    },
      '⚠ Opens on the phpMyAdmin homepage instead of your database? Then a different account is still ' +
      'signed in — click the user icon (top-right) → Log out, and log in again with the user above. ' +
      'After login, your databases also appear in the left sidebar.'));

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    // A plain link is never eaten by popup blockers (unlike window.open).
    const go = ui.el('a', {
      class: 'btn btn-primary',
      href: url,
      target: '_blank',
      rel: 'noopener'
    }, 'Open phpMyAdmin →');
    go.addEventListener('click', () => setTimeout(() => m.close(), 100));
    actions.append(cancel, go);
    body.appendChild(actions);
    const m = ui.modal({ title: dbName ? `phpMyAdmin — ${dbName}` : 'phpMyAdmin login', body, wide: true });
    cancel.onclick = m.close;
  }

  /** First-run helper: install phpMyAdmin from the setup wizard. */
  function installPmaModal() {
    const body = ui.el('div', {});
    body.appendChild(ui.el('p', {},
      'phpMyAdmin is not installed yet. The setup wizard will download it and serve it on port 2089.'));
    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const go = ui.el('button', { class: 'btn btn-primary' }, 'Install phpMyAdmin');
    actions.append(cancel, go);
    body.appendChild(actions);
    const m = ui.modal({ title: 'Install phpMyAdmin', body });
    cancel.onclick = m.close;
    go.onclick = async () => {
      go.disabled = true;
      try {
        await api.post('/setup/install', { components: ['phpmyadmin'] });
        m.close();
        ui.toast('Installing phpMyAdmin — follow the progress in the Setup Wizard');
        location.hash = '#/setup';
      } catch (e) {
        ui.toast(e.message, true);
        go.disabled = false;
      }
    };
  }

  function createModal(root, me) {
    const body = ui.el('div', {});
    body.appendChild(ui.el('label', {}, 'Database name', ui.el('input', { type: 'text', id: 'db-name', placeholder: 'mysite' })));
    body.appendChild(ui.el('label', {}, 'Database user', ui.el('input', { type: 'text', id: 'db-user', placeholder: 'mysite_user' })));
    body.appendChild(ui.el('label', {}, 'Password', ui.el('input', { type: 'password', id: 'db-pass' })));
    body.appendChild(ui.el('p', { class: 'text-dim' },
      me.username === 'admin' ? 'Admin databases have no prefix.' : `Names are automatically prefixed with "${me.username}_".`));

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const create = ui.el('button', { class: 'btn btn-primary' }, 'Create');
    actions.append(cancel, create);
    body.appendChild(actions);

    const m = ui.modal({ title: 'New Database', body });
    cancel.onclick = m.close;
    create.onclick = async () => {
      create.disabled = true;
      try {
        await api.post('/databases', {
          name: document.getElementById('db-name').value,
          dbUser: document.getElementById('db-user').value,
          dbPassword: document.getElementById('db-pass').value
        });
        m.close();
        ui.toast('Database created');
        load(root, me);
      } catch (e) {
        ui.toast(e.message, true);
        create.disabled = false;
      }
    };
  }

  return { render: (root, me) => load(root, me) };
})();
