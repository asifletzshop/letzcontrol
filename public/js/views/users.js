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
      return ui.el('tr', {},
        ui.el('td', {}, ui.el('strong', {}, p.name)),
        ui.el('td', {}, fmt(p.maxSites)),
        ui.el('td', {}, fmt(p.maxDatabases)),
        ui.el('td', {}, p.diskMB === -1 ? '∞' : ui.fmtBytes(p.diskMB * 1024 * 1024)),
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
          ui.el('th', {}, 'Plan'), ui.el('th', {}, 'Max sites'), ui.el('th', {}, 'Max databases'), ui.el('th', {}, 'Disk quota'), ui.el('th', {}, 'Actions'))),
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
    const body = ui.el('div', {});
    body.appendChild(ui.el('label', {}, 'Plan name',
      ui.el('input', { type: 'text', id: 'plan-name', value: plan ? plan.name : '' })));
    const field = (id, label, val) =>
      body.appendChild(ui.el('label', {}, label, ui.el('input', { type: 'number', id, min: '-1', value: String(val) })));
    field('plan-sites', 'Max websites (-1 = unlimited)', plan ? plan.maxSites : 1);
    field('plan-dbs', 'Max databases (-1 = unlimited)', plan ? plan.maxDatabases : 1);
    field('plan-disk', 'Disk quota in MB (-1 = unlimited)', plan ? plan.diskMB : 1024);

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const ok = ui.el('button', { class: 'btn btn-primary' }, plan ? 'Save' : 'Create');
    actions.append(cancel, ok);
    body.appendChild(actions);
    const m = ui.modal({ title: plan ? `Edit plan: ${plan.name}` : 'New Plan', body });
    cancel.onclick = m.close;
    ok.onclick = async () => {
      const payload = {
        name: document.getElementById('plan-name').value,
        maxSites: +document.getElementById('plan-sites').value,
        maxDatabases: +document.getElementById('plan-dbs').value,
        diskMB: +document.getElementById('plan-disk').value
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
