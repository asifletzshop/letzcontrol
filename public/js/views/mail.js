'use strict';
/* Mail view: mailboxes (create / password / delete), service health, the
 * outgoing queue, per-domain mail readiness, client settings and the DNS
 * records each domain needs. */
window.MailView = (() => {
  let recordsView = null; // { domain, data } from GET /mail/records/:domain
  let domainFilter = 'all'; // website selected in the mailboxes dropdown
  let search = '';          // the mailbox search box

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

  const bytes = (n) => {
    if (n === null || n === undefined) return '–';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = Number(n);
    let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
  };

  const ago = (ms) => {
    if (!ms) return '–';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  };

  /* A card that shows one number, the way the dashboard does. */
  function statCard(id, label, icon, tone, sub) {
    return ui.el('div', { class: 'stat-card tone-' + tone },
      ui.el('div', { class: 'stat-head' },
        ui.el('span', { class: 'stat-icon' }, icon),
        ui.el('div', { class: 'stat-label' }, label)),
      ui.el('div', { class: 'stat-value', id }, '–'),
      ui.el('div', { class: 'stat-sub' }, sub || ''));
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

    const [{ mailboxes, storage, domains }, { sites }] = await Promise.all([
      api.get('/mail/mailboxes'),
      api.get('/sites')
    ]);

    root.appendChild(ui.el('div', { class: 'toolbar' },
      ui.el('button', {
        class: 'btn btn-primary',
        onclick: () => mailboxModal(root, me, null, sites, domainFilter === 'all' ? null : domainFilter)
      }, '+ New mailbox'),
      ui.el('span', { class: 'spacer' }),
      status.webmail.installed
        ? ui.el('a', { class: 'btn', href: status.webmail.url, target: '_blank', rel: 'noopener' }, '🌐 Webmail ↗')
        : null,
      ui.el('button', { class: 'btn', onclick: () => load(root, me) }, '↻ Refresh')
    ));

    /* ---------- the numbers ---------- */
    const totalStorage = Object.values(storage || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    const queueCount = (status.queue && status.queue.count) || 0;

    root.appendChild(ui.el('div', { class: 'hero-grid', style: 'margin-bottom:16px' },
      statCard('mb-count', 'Mailboxes', '✉️', 'green', `across ${domains.length} domain(s)`),
      statCard('dom-count', 'Mail domains', '🌐', 'cyan', `server ${status.serverIp}`),
      statCard('q-count', 'In the queue', '⏳', queueCount ? 'amber' : 'green',
        queueCount ? 'waiting to be delivered' : 'nothing waiting'),
      statCard('st-count', 'Mail stored', '💾', 'violet', 'on disk for this server')
    ));

    /* ---------- service health and client settings ---------- */
    const svc = status.services;
    const svcRow = (name, state, detail) => ui.el('div', { class: 'svc-row' },
      ui.el('span', { class: 'dot ' + (state === 'active' ? 'ok' : 'bad') }),
      ui.el('span', { class: 'svc-name' }, name),
      ui.el('span', { class: 'svc-state ' + (state === 'active' ? 'ok' : 'bad') }, state),
      detail ? ui.el('span', { class: 'text-dim', style: 'font-size:11.5px;margin-left:8px' }, detail) : null);

    const health = ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Service health'),
      ui.el('div', { class: 'svc-list' },
        svcRow('Postfix', svc.postfix, 'SMTP · queues'),
        svcRow('Dovecot', svc.dovecot, 'IMAP · POP3'),
        svcRow('OpenDKIM', svc.opendkim, 'signs outgoing mail'),
        status.webmail.installed ? svcRow('Webmail', svc.nginx, 'Roundcube') : null));

    const client = ui.el('div', { class: 'card' },
      ui.el('h3', {}, 'Mail client settings'),
      ui.el('div', { class: 'client-grid' },
        clientRow('IMAP (SSL)', `mail.${status.serverIp}`, '993', 'username = the full address'),
        clientRow('IMAP (STARTTLS)', `mail.${status.serverIp}`, '143', 'username = the full address'),
        clientRow('SMTP (SSL)', `mail.${status.serverIp}`, '465', 'same username and password'),
        clientRow('SMTP (STARTTLS)', `mail.${status.serverIp}`, '587', 'same username and password'),
        clientRow('POP3 (SSL)', `mail.${status.serverIp}`, '995', 'username = the full address')
      ),
      ui.el('p', { class: 'text-dim', style: 'font-size:12px;margin:10px 0 0' },
        'Use the full address (user@domain) as the username. The password is the one set when the mailbox was created.'));

    root.appendChild(ui.el('div', { class: 'ops-grid', style: 'margin-bottom:16px' }, health, client));

    /* ---------- the queue ---------- */
    if (queueCount) root.appendChild(queueCard(root, me, status.queue));

    /* ---------- the webmail over https ---------- */
    root.appendChild(webmailSection(root, me));

    /* ---------- mailboxes (with a per-website selector) ---- */
    root.appendChild(mailboxSection(root, me, mailboxes, storage, sites,
      status.webmail.installed ? status.webmail.url : null));

    /* ---------- DNS records ---------- */
    dnsCard(root, me, sites, status);
  }

  /* -------------------------------------------------- the webmail ----- */
  /* Two ways in, and they need different things.
   *
   *   https://<domain>/webmail/      needs the site to have a certificate -
   *                                   which it usually already does, because
   *                                   that is what the panel issues it for.
   *   https://mail.<domain>/         needs an A record for mail.<domain> and
   *                                   a certificate of its own.
   *
   * A bare HTTP login form is the thing this avoids, so neither is offered
   * without its certificate. */
  function webmailSection(root, me) {
    const card = ui.el('div', { class: 'card', style: 'margin-bottom:16px' },
      ui.el('h3', {}, 'Webmail over https'),
      ui.el('div', { class: 'text-dim' }, 'Checking…'));

    api.get('/mail/webmail').then((d) => {
      if (!root.isConnected) return;
      card.innerHTML = '';
      card.appendChild(ui.el('h3', {}, 'Webmail over https'));
      card.appendChild(ui.el('p', { class: 'text-dim', style: 'margin-top:0' },
        'The webmail is a login form, so it should never be reached over plain HTTP. '
        + 'It can be mounted under a website that already has a certificate, or given '
        + 'its own name at mail.<domain> with a certificate of its own.'));

      if (!d.domains || !d.domains.length) {
        card.appendChild(ui.el('div', { class: 'text-dim' },
          'No mail domains yet. Create a mailbox and the domain it belongs to will appear here.'));
        return;
      }
      for (const s of d.domains) card.appendChild(webmailRow(root, me, s));

      /* A hosting customer's webmail is a service for the customer: they
       * read their mail from home, from a phone. Restricting it to the
       * addresses that administer the box makes it useless to them - but a
       * login form on the internet is a target, so the choice is the
       * operator's to make. */
      const access = ui.el('div', { class: 'wm-access' });
      const isOpen = !!d.public;
      const accessChk = ui.el('input', { type: 'checkbox' });
      accessChk.checked = isOpen;
      access.appendChild(ui.el('label', { class: 'checkbox-label' }, accessChk,
        'Let everyone with a mailbox use the webmail, not only the administering addresses'));
      access.appendChild(ui.el('div', { class: 'text-dim', style: 'font-size:12px' },
        'A login form on the internet is a target for password guessing. The webmail is '
        + 'separate from phpMyAdmin, so opening it does not open that.'));
      const apply = ui.el('button', { class: 'btn btn-sm' }, 'Apply');
      apply.onclick = async () => {
        apply.disabled = true;
        try {
          const r = await api.post('/mail/webmail/access', { open: accessChk.checked });
          ui.toast(r.message || 'Done');
          load(root, me);
        } catch (e) { ui.toast(e.message, true); apply.disabled = false; }
      };
      access.appendChild(apply);
      card.appendChild(access);
    }).catch((e) => {
      card.innerHTML = '';
      card.appendChild(ui.el('h3', {}, 'Webmail over https'));
      card.appendChild(ui.el('div', { class: 'text-dim' }, e.message));
    });
    return card;
  }

  function webmailRow(root, me, s) {
    const row = ui.el('div', { class: 'wm-row' });

    /* --- mounted under the site's own domain --- */
    const pathBox = ui.el('div', { class: 'wm-cell' });
    pathBox.appendChild(ui.el('div', { class: 'wm-title' }, `https://${s.domain}/webmail/`));
    if (s.siteWebmail && s.siteSsl) {
      pathBox.appendChild(ui.el('div', { class: 'wm-state ok' },
        ui.el('span', { class: 'dot ok' }), 'mounted, and it has a certificate'));
    } else if (!s.siteExists) {
      pathBox.appendChild(ui.el('div', { class: 'wm-state' },
        ui.el('span', { class: 'dot idle' }), 'no website with that domain to mount it on'));
    } else if (!s.siteSsl) {
      pathBox.appendChild(ui.el('div', { class: 'wm-state' },
        ui.el('span', { class: 'dot warn' }), 'the website has no certificate yet'));
    } else {
      pathBox.appendChild(ui.el('div', { class: 'wm-state' },
        ui.el('span', { class: 'dot idle' }), 'not mounted'));
    }
    const mountBtn = ui.el('button', { class: 'btn btn-sm' },
      s.siteWebmail ? 'Unmount' : 'Mount here');
    mountBtn.disabled = !s.siteExists || !s.siteSsl;
    mountBtn.onclick = async () => {
      mountBtn.disabled = true;
      try {
        const r = await api.post('/mail/webmail/mount', { domain: s.domain, off: !!s.siteWebmail });
        ui.toast(r.message || 'Done');
        load(root, me);
      } catch (e) { ui.toast(e.message, true); mountBtn.disabled = false; }
    };
    pathBox.appendChild(mountBtn);
    if (s.siteWebmail && s.pathUrl) {
      pathBox.appendChild(ui.el('a', {
        class: 'btn btn-sm', href: s.pathUrl, target: '_blank', rel: 'noopener'
      }, '🌐 Open ↗'));
    }
    row.appendChild(pathBox);

    /* --- its own hostname --- */
    const hostBox = ui.el('div', { class: 'wm-cell' });
    hostBox.appendChild(ui.el('div', { class: 'wm-title' }, `https://${s.hostname}/`));
    if (s.ready) {
      hostBox.appendChild(ui.el('div', { class: 'wm-state ok' },
        ui.el('span', { class: 'dot ok' }), 'pointing here, with a certificate'));
    } else {
      const bits = [];
      if (!s.dns.ok) bits.push('the name does not point here');
      if (!s.cert) bits.push('no certificate');
      if (!s.vhost) bits.push('no vhost');
      hostBox.appendChild(ui.el('div', { class: 'wm-state' },
        ui.el('span', { class: 'dot warn' }), bits.join(' · ') || 'not set up'));
    }
    const hostBtn = ui.el('button', { class: 'btn btn-sm' }, 'Set up');
    hostBtn.onclick = async () => {
      hostBtn.disabled = true;
      ui.toast('Setting up…');
      try {
        const r = await api.post('/mail/webmail/hostname', { domain: s.domain });
        ui.toast(r.message || 'Done');
        if (r.problems && r.problems.length) {
          ui.modal({
            title: 'What still needs doing',
            body: ui.el('div', {},
              ...(r.steps || []).map((x) => ui.el('div', { class: 'wm-state ok' }, `✓ ${x}`)),
              ...(r.problems || []).map((x) => ui.el('div', { class: 'wm-state' }, `• ${x}`)))
          });
        }
        load(root, me);
      } catch (e) {
        ui.toast(e.message, true);
        hostBtn.disabled = false;
      }
    };
    hostBox.appendChild(hostBtn);
    if (s.hostUrl) {
      hostBox.appendChild(ui.el('a', {
        class: 'btn btn-sm', href: s.hostUrl, target: '_blank', rel: 'noopener'
      }, '🌐 Open ↗'));
    }
    row.appendChild(hostBox);

    return row;
  }

  function clientRow(protocol, host, port, note) {
    return ui.el('div', { class: 'client-row' },
      ui.el('div', { class: 'client-name' }, protocol),
      ui.el('div', { class: 'client-endpoint' },
        ui.el('span', { class: 'mono' }, host),
        ui.el('span', { class: 'client-port mono' }, port)),
      ui.el('div', { class: 'text-dim', style: 'font-size:11.5px' }, note));
  }

  /* -------------------------------------------------- the queue -------- */
  function queueCard(root, me, queue) {
    const card = ui.el('div', { class: 'card', style: 'margin-bottom:16px' });
    card.appendChild(ui.el('h3', {},
      `Messages waiting to go out (${queue.count})`,
      ui.el('span', { class: 'spacer' }),
      queue.oldestAt ? ui.el('span', { class: 'text-dim', style: 'text-transform:none;letter-spacing:0' },
        `oldest ${ago(queue.oldestAt)}`) : null));

    const list = ui.el('div', { class: 'queue-list' });
    for (const m of queue.messages) {
      for (const r of m.recipients) {
        list.appendChild(ui.el('div', { class: 'queue-row' },
          ui.el('span', { class: 'dot warn' }),
          ui.el('div', { class: 'queue-body' },
            ui.el('div', { class: 'queue-to mono' }, r.address || m.sender),
            ui.el('div', { class: 'queue-reason' }, r.reason || 'no reason given')),
          ui.el('span', { class: 'text-dim queue-when' }, ago(m.arrivedAt))));
      }
    }
    card.appendChild(list);

    card.appendChild(ui.el('p', { class: 'text-dim', style: 'font-size:12.5px;margin:12px 0 0' },
      'A message stays here until the receiving server accepts it. Most of the time the '
      + 'reason is a domain whose MX record points at a host that does not answer.'));

    const flush = ui.el('button', { class: 'btn btn-sm btn-danger', style: 'margin-top:10px' }, '🗑 Empty the queue');
    flush.onclick = async () => {
      if (!(await ui.confirmBox(
        `Delete all ${queue.count} waiting message(s)? They will not be delivered. `
        + 'Fix the DNS first, otherwise the next message goes to the same place.',
        { okText: 'Empty the queue' }))) return;
      flush.disabled = true;
      try {
        const r = await api.post('/mail/queue/flush');
        ui.toast(r.message || 'The queue was emptied');
        load(root, me);
      } catch (e) { ui.toast(e.message, true); flush.disabled = false; }
    };
    card.appendChild(flush);
    return card;
  }

  /* -------------------------------------------------- mailboxes section -- */
  function domainChoices(sites, mailboxes) {
    const set = new Set(sites.map((s) => s.domain));
    for (const m of mailboxes) set.add(m.domain); // mail domains that are not (yet) panel sites
    return [...set].sort();
  }

  /** Heading + website dropdown + the mailboxes, grouped by domain.
   *
   *  Grouped, because a domain is the unit that matters: it has its own DNS,
   *  its own DKIM key and its own storage, and a flat list of addresses
   *  scatters those apart. */
  function mailboxSection(root, me, mailboxes, storage, sites, webmailUrl) {
    const box = ui.el('div', {});
    const rebuild = () => {
      box.innerHTML = '';
      const shown = domainFilter === 'all'
        ? mailboxes
        : mailboxes.filter((m) => m.domain === domainFilter);
      const q = search.trim().toLowerCase();
      const filtered = q ? shown.filter((m) => m.username.toLowerCase().includes(q)) : shown;

      const sel = ui.el('select', { style: 'max-width:260px', 'aria-label': 'Website' },
        ui.el('option', { value: 'all' }, 'All websites'),
        ...domainChoices(sites, mailboxes).map((d) => ui.el('option', { value: d }, d)));
      sel.value = domainFilter;
      if (sel.value !== domainFilter) { domainFilter = sel.value; } // selection vanished (site removed)
      sel.onchange = () => { domainFilter = sel.value; rebuild(); };

      const searchIn = ui.el('input', {
        type: 'search', placeholder: 'Search addresses…', value: search,
        style: 'max-width:220px'
      });
      searchIn.oninput = () => {
        search = searchIn.value;
        // Rebuild the list, but keep the caret in the search box.
        rebuild();
        const again = box.querySelector('input[type=search]');
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      };

      box.appendChild(ui.el('div', { class: 'section-head' },
        ui.el('h3', { style: 'margin:0' },
          domainFilter === 'all'
            ? `Mailboxes (${mailboxes.length})`
            : `Mailboxes for ${domainFilter} (${shown.length})`),
        ui.el('span', { class: 'spacer' }),
        ui.el('span', { class: 'text-dim', style: 'font-size:12px' }, 'Website:'),
        sel,
        searchIn
      ));

      if (!mailboxes.length) {
        box.appendChild(ui.el('div', { class: 'card empty' },
          'No mailboxes yet. Create one above - the full address (user@domain) is also the webmail login.'));
        return;
      }
      if (!filtered.length) {
        box.appendChild(ui.el('div', { class: 'card empty' },
          q ? `No address matches “${q}”.` : `No mailboxes for ${domainFilter} yet.`));
        return;
      }

      /* Grouped by domain, with a readiness badge for each. */
      const groups = new Map();
      for (const mb of filtered) {
        if (!groups.has(mb.domain)) groups.set(mb.domain, []);
        groups.get(mb.domain).push(mb);
      }

      for (const [domain, list] of groups) {
        const group = ui.el('div', { class: 'mb-group' });
        const head = ui.el('div', { class: 'mb-group-head' },
          ui.el('span', { class: 'mb-domain' }, domain),
          ui.el('span', { class: 'text-dim', style: 'font-size:12px' },
            `${list.length} mailbox${list.length === 1 ? '' : 'es'}`),
          storage && storage[domain] !== undefined
            ? ui.el('span', { class: 'text-dim', style: 'font-size:12px' }, `· ${bytes(storage[domain])} stored`)
            : null,
          ui.el('span', { class: 'spacer' }),
          readinessBadge(domain));
        group.appendChild(head);
        group.appendChild(mailboxTable(root, me, list, webmailUrl));
        box.appendChild(group);
      }
    };
    rebuild();
    return box;
  }

  /** The per-domain readiness badge, fetched once and cached. */
  const readinessCache = new Map();
  function readinessBadge(domain) {
    const badge = ui.el('span', { class: 'readiness' }, ui.el('span', { class: 'dot idle' }), 'checking…');
    const cached = readinessCache.get(domain);
    if (cached && Date.now() - cached.at < 60_000) { paint(cached.data); return badge; }
    api.get(`/mail/readiness/${encodeURIComponent(domain)}`).then((d) => {
      readinessCache.set(domain, { at: Date.now(), data: d });
      paint(d);
    }).catch(() => {
      badge.textContent = '';
      badge.appendChild(ui.el('span', { class: 'dot idle' }));
      badge.appendChild(document.createTextNode('not checked'));
    });
    function paint(d) {
      badge.textContent = '';
      badge.appendChild(ui.el('span', { class: 'dot ' + (d.ready ? 'ok' : 'warn') }));
      badge.appendChild(document.createTextNode(d.ready ? 'mail is set up' : `${d.checks.filter((c) => !c.ok).length} thing(s) to fix`));
      badge.title = d.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? ' — ' + c.detail : ''}`).join('\n');
    }
    return badge;
  }

  function mailboxTable(root, me, list, webmailUrl) {
    const rows = list.map((mb) => ui.el('tr', {},
      ui.el('td', { class: 'mono' }, mb.username),
      ui.el('td', { class: 'text-dim' }, new Date(mb.created_at).toLocaleDateString()),
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
        ui.el('button', { class: 'btn btn-sm', onclick: () => mailboxModal(root, me, mb) }, '🔑 Password'), ' ',
        copyButton(mb.username),
        ' ',
        ui.el('button', {
          class: 'btn btn-sm btn-danger', onclick: async () => {
            if (!(await ui.confirmBox(`Delete mailbox ${mb.username}? Its emails will be removed permanently.`, { okText: 'Delete mailbox' }))) return;
            try { await api.del(`/mail/mailboxes/${mb.id}`); ui.toast(`${mb.username} deleted`); load(root, me); }
            catch (e) { ui.toast(e.message, true); }
          }
        }, '🗑')
      )));
    return ui.el('div', { class: 'table-wrap' },
      ui.el('table', {},
        ui.el('thead', {}, ui.el('tr', {},
          ui.el('th', {}, 'Address'), ui.el('th', {}, 'Created'), ui.el('th', {}, 'Actions'))),
        ui.el('tbody', {}, ...rows)));
  }

  /** Copy an address to the clipboard. */
  function copyButton(text) {
    const b = ui.el('button', { class: 'btn btn-sm', title: `Copy ${text}` }, '📋');
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        ui.toast(`${text} copied`);
      } catch {
        // Clipboard access needs a secure context; a plain HTTP panel does
        // not have one, so fall back to selecting the text.
        const ta = ui.el('textarea', { style: 'position:fixed;left:-9999px' });
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); ui.toast(`${text} copied`); }
        catch { ui.toast('Could not copy - select it manually', true); }
        ta.remove();
      }
    };
    return b;
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
        'Enter a domain to see the records required to send and receive mail here. '
        + 'If the panel hosts its zone, they can be added in one click.'));
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
    destroy: () => { recordsView = null; readinessCache.clear(); }
  };
})();
