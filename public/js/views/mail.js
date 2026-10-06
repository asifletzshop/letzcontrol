'use strict';
/* Mail view: mailboxes (create / password / delete), service status,
 * DKIM key generation and the DNS records each domain needs. */
window.MailView = (() => {
  let recordsView = null; // { domain, data } from GET /mail/records/:domain
  let domainFilter = 'all'; // website selected in the mailboxes dropdown

  function genPw() {
    const a = new Uint8Array(15);
    crypto.getRandomValues(a);
    return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function domainDatalist(id, sites) {
    const dl = ui.el('datalist', { id });
    for (const s of sites) dl.appendChild(ui.el('option', { value: s.domain }));
    return dl;
  }

  async function load(root, me) {
    root.innerHTML = '';
    let status;
    try {
      status = await api.get('/mail/status');
    } catch (e) {
      root.appendChild(ui.el('div', { class: 'banner' }, e.message));
      root.appendChild(ui.el('button', {
        class: 'btn btn-primary',
        onclick: () => { location.hash = '#/setup'; }
      }, '🧩 Open Setup Wizard'));
      return;
    }

    const [{ mailboxes }, { sites }] = await Promise.all([
      api.get('/mail/mailboxes'),
      api.get('/sites')
    ]);

    root.appendChild(ui.el('div', { class: 'toolbar' },
      ui.el('button', {
        class: 'btn btn-primary',
        onclick: () => mailboxModal(root, me, null, sites, domainFilter === 'all' ? null : domainFilter)
      }, '+ Create mailbox'),
      ui.el('span', { class: 'spacer' }),
      status.webmail.installed
        ? ui.el('a', { class: 'btn', href: status.webmail.url, target: '_blank' }, '🌐 Webmail ↗')
        : null,
      ui.el('button', { class: 'btn', onclick: () => load(root, me) }, '↻ Refresh')
    ));

    /* ---- services ---- */
    const svc = status.services;
    const svcBadge = (label, state) => ui.el('span', { style: 'margin-right:10px' },
      `${label}: `, ui.badge(state === 'active' ? 'active' : state, state === 'active' ? 'green' : 'red'));
    const svcLine = [svcBadge('Postfix', svc.postfix), svcBadge('Dovecot', svc.dovecot), svcBadge('OpenDKIM', svc.opendkim)];
    if (status.webmail.installed) svcLine.push(svcBadge('Webmail', svc.nginx));
    root.appendChild(ui.el('div', { class: 'card', style: 'margin-bottom:16px' },
      ui.el('h3', {}, 'Mail services'),
      ui.el('div', {}, ...svcLine),
      ui.el('div', { class: 'text-dim', style: 'margin-top:8px' },
        `IMAP 143/993 · POP3 110/995 · SMTP 25 / 587 / 465 · ${status.mailboxCount} mailbox(es)` +
        (status.webmail.installed ? ` · webmail on ${status.webmail.url}` : ''))));

    /* ---- mailboxes (with a per-website selector) ---- */
    root.appendChild(mailboxSection(root, me, mailboxes, sites,
      status.webmail.installed ? status.webmail.url : null));

    /* ---- DNS records ---- */
    dnsCard(root, me, sites, status);
  }

  /* -------------------------------------------------- mailboxes section -- */
  function domainChoices(sites, mailboxes) {
    const set = new Set(sites.map((s) => s.domain));
    for (const m of mailboxes) set.add(m.domain); // mail domains that are not (yet) panel sites
    return [...set].sort();
  }

  /** Heading + website dropdown + table. Rebuilt in place when the dropdown
   *  changes, so only this section re-renders (not the whole page). */
  function mailboxSection(root, me, mailboxes, sites, webmailUrl) {
    const box = ui.el('div', {});
    const rebuild = () => {
      box.innerHTML = '';
      const shown = domainFilter === 'all'
        ? mailboxes
        : mailboxes.filter((m) => m.domain === domainFilter);

      const sel = ui.el('select', { style: 'max-width:260px', 'aria-label': 'Website' },
        ui.el('option', { value: 'all' }, 'All websites'),
        ...domainChoices(sites, mailboxes).map((d) => ui.el('option', { value: d }, d)));
      sel.value = domainFilter;
      if (sel.value !== domainFilter) { domainFilter = sel.value; } // selection vanished (site removed)
      sel.onchange = () => { domainFilter = sel.value; rebuild(); };

      box.appendChild(ui.el('div', { style: 'display:flex;align-items:center;gap:12px;margin:18px 0 8px;flex-wrap:wrap' },
        ui.el('h3', { style: 'margin:0' },
          domainFilter === 'all'
            ? `Mailboxes (${mailboxes.length})`
            : `Mailboxes for ${domainFilter} (${shown.length})`),
        ui.el('span', { class: 'text-dim', style: 'font-size:12px' }, 'Website:'),
        sel
      ));

      if (!shown.length) {
        box.appendChild(ui.el('div', { class: 'card empty' },
          domainFilter === 'all'
            ? 'No mailboxes yet. Create one above - the full address (user@domain) is also the webmail login.'
            : `No mailboxes for ${domainFilter} yet. Create one above - its domain is preselected.`));
        return;
      }

      const rows = shown.map((mb) => ui.el('tr', {},
        ui.el('td', { class: 'mono' }, mb.username),
        ui.el('td', { class: 'text-dim' }, mb.domain),
        ui.el('td', {}, new Date(mb.created_at).toLocaleDateString()),
        ui.el('td', {},
          // Opens webmail already pointed at THIS mailbox: Roundcube
          // prefills the login form from ?_user=, so the person only types
          // their password instead of hunting for the right address.
          webmailUrl ? ui.el('a', {
            class: 'btn btn-sm',
            href: `${webmailUrl}?_task=login&_user=${encodeURIComponent(mb.username)}`,
            target: '_blank',
            rel: 'noopener',
            title: `Open ${mb.username} in webmail`
          }, '🌐 Webmail ↗') : null,
          webmailUrl ? ' ' : '',
          ui.el('button', { class: 'btn btn-sm', onclick: () => mailboxModal(root, me, mb, sites) }, '🔑 Password'), ' ',
          ui.el('button', {
            class: 'btn btn-sm btn-danger', onclick: async () => {
              if (!(await ui.confirmBox(`Delete mailbox ${mb.username}? Its emails will be removed permanently.`, { okText: 'Delete mailbox' }))) return;
              try { await api.del(`/mail/mailboxes/${mb.id}`); ui.toast(`${mb.username} deleted`); load(root, me); }
              catch (e) { ui.toast(e.message, true); }
            }
          }, '🗑')
        )));
      box.appendChild(ui.el('div', { class: 'table-wrap' },
        ui.el('table', {},
          ui.el('thead', {}, ui.el('tr', {},
            ui.el('th', {}, 'Address'), ui.el('th', {}, 'Domain'),
            ui.el('th', {}, 'Created'), ui.el('th', {}, 'Actions'))),
          ui.el('tbody', {}, ...rows))));
    };
    rebuild();
    return box;
  }

  /* -------------------------------------------------- mailbox modal -- */
  function mailboxModal(root, me, existing, sites, preferred) {
    const body = ui.el('div', {});
    const localIn = ui.el('input', { type: 'text', id: 'mb-local' });
    const domainIn = ui.el('input', { type: 'text', id: 'mb-domain', list: 'mb-domains' });
    const pwIn = ui.el('input', { type: 'text', id: 'mb-pw', value: genPw() });

    if (existing) {
      localIn.value = existing.username.split('@')[0];
      domainIn.value = existing.domain;
      localIn.disabled = true;
      domainIn.disabled = true;
    } else if (preferred) {
      domainIn.value = preferred;
    } else if (sites.length === 1) {
      domainIn.value = sites[0].domain;
    }

    body.appendChild(ui.el('label', {}, 'Local part (before @)', localIn));
    body.appendChild(ui.el('label', {}, 'Domain', domainIn, domainDatalist('mb-domains', sites)));
    body.appendChild(ui.el('label', {}, 'Password', pwIn));
    body.appendChild(ui.el('p', { class: 'text-dim' },
      existing
        ? 'The address is kept; only the password changes. Mailbox owners can also change it themselves in webmail (Settings → Password).'
        : 'Log in at webmail with the full address (user@domain). The password is shown here only - save it. It can be changed later from webmail (Settings → Password).'));

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const ok = ui.el('button', { class: 'btn btn-primary' }, existing ? 'Set password' : 'Create mailbox');
    actions.append(cancel, ok);
    body.appendChild(actions);
    const m = ui.modal({ title: existing ? `Password for ${existing.username}` : 'Create mailbox', body });
    cancel.onclick = m.close;

    ok.onclick = async () => {
      if (pwIn.value.length < 8) return ui.toast('Password must be at least 8 characters', true);
      ok.disabled = true;
      try {
        const r = await api.post('/mail/mailboxes', {
          local: localIn.value,
          domain: domainIn.value,
          password: pwIn.value
        });
        m.close();
        ui.toast(`${r.address} saved`);
        load(root, me);
      } catch (e) {
        ui.toast(e.message, true);
        ok.disabled = false;
      }
    };
  }

  /* -------------------------------------------------- DNS records ----- */
  function dnsCard(root, me, sites, status) {
    const card = ui.el('div', { class: 'card', style: 'margin-top:18px' },
      ui.el('h3', {}, 'DNS records for mail (MX · SPF · DKIM · DMARC)'));
    root.appendChild(card);

    const input = ui.el('input', { type: 'text', id: 'mail-rec-domain', list: 'rec-domains', placeholder: 'example.com' });
    const showBtn = ui.el('button', { class: 'btn btn-primary' }, 'Show records');
    card.appendChild(ui.el('div', { class: 'toolbar', style: 'margin-bottom:0' },
      input, domainDatalist('rec-domains', sites), ' ',
      showBtn));
    if (recordsView) input.value = recordsView.domain;

    showBtn.onclick = async () => {
      const domain = input.value.trim().toLowerCase();
      if (!domain) return ui.toast('Enter a domain', true);
      showBtn.disabled = true;
      try {
        recordsView = { domain, data: await api.get(`/mail/records/${encodeURIComponent(domain)}`) };
        load(root, me);
      } catch (e) {
        ui.toast(e.message, true);
        showBtn.disabled = false;
      }
    };

    if (!recordsView) {
      card.appendChild(ui.el('p', { class: 'text-dim' },
        'Enter a domain to see the records required to send and receive mail here. ' +
        'If the panel hosts its zone, they can be added in one click.'));
      return;
    }

    const { domain, data } = recordsView;

    if (!data.dkimReady) {
      card.appendChild(ui.el('div', { class: 'banner' },
        `No DKIM signing key for ${domain} yet. `,
        ui.el('button', {
          class: 'btn btn-primary', style: 'margin-left:8px',
          onclick: async (ev) => {
            ev.target.disabled = true;
            try {
              await api.post(`/mail/dkim/${encodeURIComponent(domain)}`);
              ui.toast('DKIM key generated');
              recordsView = { domain, data: await api.get(`/mail/records/${encodeURIComponent(domain)}`) };
              load(root, me);
            } catch (e) { ui.toast(e.message, true); ev.target.disabled = false; }
          }
        }, '🔑 Generate DKIM key')));
    }

    const rows = data.records.map((r) => ui.el('tr', {},
      ui.el('td', {}, ui.badge(r.type, r.type === 'MX' ? 'yellow' : 'green')),
      ui.el('td', { class: 'mono', style: 'white-space:normal;word-break:break-all' }, r.name),
      ui.el('td', { class: 'mono', style: 'white-space:normal;word-break:break-all' },
        r.type === 'MX' ? `${r.priority || 10} ` : '', r.value),
      ui.el('td', { class: 'text-dim', style: 'white-space:normal' }, r.note || '')));
    card.appendChild(ui.el('div', { class: 'table-wrap' },
      ui.el('table', {},
        ui.el('thead', {}, ui.el('tr', {},
          ui.el('th', {}, 'Type'), ui.el('th', {}, 'Name'),
          ui.el('th', {}, 'Value'), ui.el('th', {}, 'Meaning'))),
        ui.el('tbody', {}, ...rows))));

    if (data.zoneInPanel) {
      card.appendChild(ui.el('div', { class: 'toolbar', style: 'margin-top:12px' },
        ui.el('button', {
          class: 'btn btn-primary',
          onclick: async (ev) => {
            ev.target.disabled = true;
            try {
              const r = await api.post(`/mail/records/${encodeURIComponent(domain)}/add`);
              ui.toast(`${r.added.length} record(s) added, ${r.skipped.length} skipped${r.dkimNote ? ` (${r.dkimNote})` : ''}`);
              recordsView = { domain, data: await api.get(`/mail/records/${encodeURIComponent(domain)}`) };
              load(root, me);
            } catch (e) { ui.toast(e.message, true); ev.target.disabled = false; }
          }
        }, '＋ Add all to panel zone'),
        ui.el('span', { class: 'text-dim' }, 'Validated by named-checkzone before BIND reloads.')));
    } else {
      card.appendChild(ui.el('p', { class: 'text-dim' },
        `No panel zone for ${domain} - copy these records to your DNS provider.`));
    }
  }

  return {
    render: (root, me) => { recordsView = null; return load(root, me); },
    destroy: () => { recordsView = null; }
  };
})();
