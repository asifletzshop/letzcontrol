'use strict';
/* Users & Plans view (admin only) */
window.UsersView = (() => {
  async function load(root, me) {
    root.innerHTML = '';
    const [{ users }, { plans }] = await Promise.all([api.get('/users'), api.get('/users/plans')]);

    /* ---------- plans ---------- */
    root.appendChild(ui.el('div', { class: 'toolbar' },
      ui.el('h3', { style: 'margin:0' }, 'Hosting Plans'),
      ui.el('span', { class: 'spacer' }),
      ui.el('button', { class: 'btn btn-primary', onclick: () => planModal(root, me) }, '+ New Plan')
    ));

    const pRows = plans.map((p) => {
      const fmt = (v) => (v === -1 ? '∞' : String(v));
      const fmtGb = (v) => (v === -1 ? '∞' : v + ' GB');
      return ui.el('tr', {},
        ui.el('td', {}, ui.el('strong', {}, p.name)),
        ui.el('td', {}, fmt(p.maxSites)),
        ui.el('td', {}, p.webserver || 'nginx'),
        ui.el('td', {}, fmt(p.maxDomains)),
        ui.el('td', {}, fmt(p.maxSubdomains)),
        ui.el('td', {}, fmt(p.maxMailboxes)),
        ui.el('td', {}, p.mailboxSizeMB === -1 ? '∞' : p.mailboxSizeMB + ' MB'),
        ui.el('td', {}, fmt(p.maxWordPress)),
        ui.el('td', {}, fmtGb(p.trafficGB)),
        ui.el('td', {},
          ui.el('button', { class: 'btn btn-sm', onclick: () => planModal(root, me, p) }, '✏ Edit'), ' ',
          ui.el('button', {
            class: 'btn btn-sm btn-danger', onclick: async () => {
              if (!(await ui.confirmBox(`Delete plan "${p.name}"?`, { okText: 'Delete' }))) return;
              try { await api.del(`/users/plans/${p.id}`); load(root, me); }
              catch (e) { ui.toast(e.message, true); }
            }
          }, '🗑')
        )
      );
    });
    root.appendChild(ui.el('div', { class: 'table-wrap' },
      ui.el('table', {},
        ui.el('thead', {}, ui.el('tr', {},
          ui.el('th', {}, 'Plan'), ui.el('th', {}, 'Sites'), ui.el('th', {}, 'Web'), 
          ui.el('th', {}, 'Domains'), ui.el('th', {}, 'Sub'), ui.el('th', {}, 'Mail'),
          ui.el('th', {}, 'M.Size'), ui.el('th', {}, 'WP'), ui.el('th', {}, 'Traffic'), ui.el('th', {}, 'Actions'))),
        ui.el('tbody', {}, ...pRows))));

    /* ---------- users ---------- */
    root.appendChild(ui.el('div', { class: 'toolbar', style: 'margin-top:28px' },
      ui.el('h3', { style: 'margin:0' }, 'Users'),
      ui.el('span', { class: 'spacer' }),
      ui.el('button', { class: 'btn btn-primary', onclick: () => userModal(root, me, plans) }, '+ New User')
    ));

    const uRows = users.map((u) => {
      const planName = u.role === 'admin' ? '—' : (u.usage.plan ? u.usage.plan.name : '⚠ none');
      const usage = u.role === 'admin' ? '—' : `${u.usage.sites} sites · ${u.usage.databases} dbs`;
      return ui.el('tr', {},
        ui.el('td', {}, ui.el('strong', {}, u.username), ' ', u.role === 'admin' ? ui.badge('admin', 'blue') : ''),
        ui.el('td', {}, planName),
        ui.el('td', { class: 'text-dim' }, usage),
        ui.el('td', {},
          ui.el('button', { class: 'btn btn-sm', onclick: () => userModal(root, me, plans, u) }, '✏ Edit'), ' ',
          u.username === 'admin' || u.id === me.id ? null : ui.el('button', {
            class: 'btn btn-sm btn-danger', onclick: async () => {
              if (!(await ui.confirmBox(`Delete user "${u.username}"?`, { okText: 'Delete' }))) return;
              try { await api.del(`/users/${u.id}`); load(root, me); }
              catch (e) { ui.toast(e.message, true); }
            }
          }, '🗑')
        )
      );
    });
    root.appendChild(ui.el('div', { class: 'table-wrap' },
      ui.el('table', {},
        ui.el('thead', {}, ui.el('tr', {},
          ui.el('th', {}, 'User'), ui.el('th', {}, 'Plan'), ui.el('th', {}, 'Usage'), ui.el('th', {}, 'Actions'))),
        ui.el('tbody', {}, ...uRows))));
  }

  function planModal(root, me, plan) {
    const body = ui.el('div', { style: 'max-height:70vh;overflow-y:auto' });

    // Plan name
    body.appendChild(ui.el('label', {}, 'Plan name',
      ui.el('input', { type: 'text', id: 'plan-name', value: plan ? plan.name : '' })));

    // Webserver
    const webSel = ui.el('select', { id: 'plan-webserver' },
      ui.el('option', { value: 'nginx' }, 'Nginx'),
      ui.el('option', { value: 'apache' }, 'Apache'),
      ui.el('option', { value: 'openlitespeed' }, 'OpenLiteSpeed'));
    if (plan && plan.webserver) webSel.value = plan.webserver;
    body.appendChild(ui.el('label', {}, 'Default web server', webSel));

    // Websites section
    body.appendChild(ui.el('h4', { style: 'margin:16px 0 8px;border-bottom:1px solid var(--border);padding-bottom:4px' }, '📦 Websites'));
    body.appendChild(ui.el('label', {}, 'Max websites (-1 = unlimited)',
      ui.el('input', { type: 'number', id: 'plan-sites', min: '-1', value: plan ? plan.maxSites : 1 })));
    body.appendChild(ui.el('label', {}, 'Max domains',
      ui.el('input', { type: 'number', id: 'plan-domains', min: '-1', value: plan ? plan.maxDomains : 1 })));
    body.appendChild(ui.el('label', {}, 'Max subdomains',
      ui.el('input', { type: 'number', id: 'plan-subdomains', min: '-1', value: plan ? plan.maxSubdomains : 5 })));
    body.appendChild(ui.el('label', {}, 'Max domain aliases',
      ui.el('input', { type: 'number', id: 'plan-aliases', min: '-1', value: plan ? plan.maxAliases : 3 })));

    // Storage
    body.appendChild(ui.el('h4', { style: 'margin:16px 0 8px;border-bottom:1px solid var(--border);padding-bottom:4px' }, '💾 Storage'));
    body.appendChild(ui.el('label', {}, 'Disk quota in MB (-1 = unlimited)',
      ui.el('input', { type: 'number', id: 'plan-disk', min: '-1', value: plan ? plan.diskMB : 1024 })));
    body.appendChild(ui.el('label', {}, 'Max FTP accounts',
      ui.el('input', { type: 'number', id: 'plan-ftp', min: '-1', value: plan ? plan.maxFtpAccounts : 3 })));

    // Mail
    body.appendChild(ui.el('h4', { style: 'margin:16px 0 8px;border-bottom:1px solid var(--border);padding-bottom:4px' }, '📧 Mail'));
    body.appendChild(ui.el('label', {}, 'Max mailboxes',
      ui.el('input', { type: 'number', id: 'plan-mailboxes', min: '-1', value: plan ? plan.maxMailboxes : 5 })));
    body.appendChild(ui.el('label', {}, 'Mailbox size in MB (-1 = unlimited)',
      ui.el('input', { type: 'number', id: 'plan-mailboxsize', min: '-1', value: plan ? plan.mailboxSizeMB : 1024 })));
    body.appendChild(ui.el('label', {}, 'Max mailing lists',
      ui.el('input', { type: 'number', id: 'plan-lists', min: '-1', value: plan ? plan.maxMailingLists : 2 })));

    // WordPress
    body.appendChild(ui.el('h4', { style: 'margin:16px 0 8px;border-bottom:1px solid var(--border);padding-bottom:4px' }, '🛰 WordPress'));
    body.appendChild(ui.el('label', {}, 'Max WordPress sites (-1 = unlimited)',
      ui.el('input', { type: 'number', id: 'plan-wordpress', min: '-1', value: plan ? plan.maxWordPress : 1 })));

    // Traffic
    body.appendChild(ui.el('h4', { style: 'margin:16px 0 8px;border-bottom:1px solid var(--border);padding-bottom:4px' }, '📊 Traffic'));
    body.appendChild(ui.el('label', {}, 'Monthly traffic limit in GB (-1 = unlimited)',
      ui.el('input', { type: 'number', id: 'plan-traffic', min: '-1', value: plan ? plan.trafficGB : 100 })));
    body.appendChild(ui.el('label', {}, 'Notify at % of limit (0-100)',
      ui.el('input', { type: 'number', id: 'plan-notifypct', min: '0', max: '100', value: plan ? plan.trafficNotifyPercent : 80 })));

    // Databases
    body.appendChild(ui.el('h4', { style: 'margin:16px 0 8px;border-bottom:1px solid var(--border);padding-bottom:4px' }, '🗄 Databases'));
    body.appendChild(ui.el('label', {}, 'Max databases (-1 = unlimited)',
      ui.el('input', { type: 'number', id: 'plan-dbs', min: '-1', value: plan ? plan.maxDatabases : 1 })));

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const ok = ui.el('button', { class: 'btn btn-primary' }, plan ? 'Save' : 'Create');
    actions.append(cancel, ok);
    body.appendChild(actions);

    const m = ui.modal({ title: plan ? `Edit plan: ${plan.name}` : 'New Plan', body, wide: true });
    cancel.onclick = m.close;
    ok.onclick = async () => {
      const payload = {
        name: document.getElementById('plan-name').value,
        webserver: document.getElementById('plan-webserver').value,
        maxSites: +document.getElementById('plan-sites').value,
        maxDomains: +document.getElementById('plan-domains').value,
        maxSubdomains: +document.getElementById('plan-subdomains').value,
        maxAliases: +document.getElementById('plan-aliases').value,
        diskMB: +document.getElementById('plan-disk').value,
        maxFtpAccounts: +document.getElementById('plan-ftp').value,
        maxMailboxes: +document.getElementById('plan-mailboxes').value,
        mailboxSizeMB: +document.getElementById('plan-mailboxsize').value,
        maxMailingLists: +document.getElementById('plan-lists').value,
        maxWordPress: +document.getElementById('plan-wordpress').value,
        trafficGB: +document.getElementById('plan-traffic').value,
        trafficNotifyPercent: +document.getElementById('plan-notifypct').value,
        maxDatabases: +document.getElementById('plan-dbs').value
      };
      try {
        if (plan) await api.put(`/users/plans/${plan.id}`, payload);
        else await api.post('/users/plans', payload);
        m.close(); ui.toast('Plan saved'); load(root, me);
      } catch (e) { ui.toast(e.message, true); }
    };
  }

  function userModal(root, me, plans, user) {
    const body = ui.el('div', {});
    if (!user) {
      body.appendChild(ui.el('label', {}, 'Username',
        ui.el('input', { type: 'text', id: 'user-name', placeholder: 'customer1' })));
    }
    body.appendChild(ui.el('label', {}, user ? 'New password (leave empty to keep)' : 'Password',
      ui.el('input', { type: 'password', id: 'user-pass' })));

    const planSel = ui.el('select', { id: 'user-plan' }, ui.el('option', { value: '' }, '— No plan —'));
    for (const p of plans) planSel.appendChild(ui.el('option', { value: p.id }, p.name));
    if (user && user.planId) planSel.value = user.planId;
    body.appendChild(ui.el('label', {}, 'Plan', planSel));

    const roleSel = ui.el('select', { id: 'user-role' },
      ui.el('option', { value: 'user' }, 'user'),
      ui.el('option', { value: 'admin' }, 'admin'));
    if (user) roleSel.value = user.role;
    body.appendChild(ui.el('label', {}, 'Role', roleSel));

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const ok = ui.el('button', { class: 'btn btn-primary' }, user ? 'Save' : 'Create');
    actions.append(cancel, ok);
    body.appendChild(actions);
    const m = ui.modal({ title: user ? `Edit user: ${user.username}` : 'New User', body });
    cancel.onclick = m.close;
    ok.onclick = async () => {
      try {
        if (user) {
          const payload = { planId: planSel.value || null, role: roleSel.value };
          const pass = document.getElementById('user-pass').value;
          if (pass) payload.password = pass;
          await api.put(`/users/${user.id}`, payload);
        } else {
          await api.post('/users', {
            username: document.getElementById('user-name').value,
            password: document.getElementById('user-pass').value,
            planId: planSel.value || null,
            role: roleSel.value
          });
        }
        m.close(); ui.toast('User saved'); load(root, me);
      } catch (e) { ui.toast(e.message, true); }
    };
  }

  return { render: (root, me) => load(root, me) };
})();