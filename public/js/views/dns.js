'use strict';
/* DNS view: BIND9 zones + records editor */
window.DnsView = (() => {
  let view = { mode: 'zones' }; // { mode:'zones' } | { mode:'zone', zone }
  let pendingDomain = null; // set via forDomain(): open this site's zone on next render

  async function load(root, me) {
    root.innerHTML = '';
    let data;
    try {
      data = await api.get('/dns/zones');
    } catch (e) {
      root.appendChild(ui.el('div', { class: 'banner' }, e.message));
      root.appendChild(ui.el('button', {
        class: 'btn btn-primary',
        onclick: () => { location.hash = '#/setup'; }
      }, '🧩 Open Setup Wizard'));
      return;
    }

    // Arrived from a website's 🛰 DNS button: jump straight to that
    // website's own zone (records editor), not the list of every zone.
    if (view.focus) {
      const f = view.focus;
      const zone = data.zones.find((z) => z.domain === f)
        || data.zones.find((z) => z.domain.endsWith('.' + f));
      if (zone) {
        view = { mode: 'zone', zone };
        return zoneView(root, me, zone, data);
      }
    }

    if (view.mode === 'zone') {
      const zone = data.zones.find((z) => z.id === view.zone.id);
      if (zone) return zoneView(root, me, zone, data);
      view = { mode: 'zones' };
    }

    root.appendChild(ui.el('div', { class: 'toolbar' },
      ui.el('button', { class: 'btn btn-primary', onclick: () => newZoneModal(root, me, data) }, '+ New DNS Zone'),
      ui.el('span', { class: 'spacer' }),
      ui.el('button', { class: 'btn', onclick: () => load(root, me) }, '↻ Refresh')
    ));

    root.appendChild(ui.el('div', { class: 'card', style: 'margin-bottom:16px' },
      ui.el('h3', {}, 'How to point a domain at this DNS server'),
      ui.el('div', { class: 'text-dim', style: 'line-height:1.7' },
        ui.el('div', {}, '1. At your registrar, create a glue record: ', ui.el('code', {}, `ns1.<domain> → ${data.serverIp}`)),
        ui.el('div', {}, '2. Then set the domain\'s Nameservers (NS) to ', ui.el('code', {}, 'ns1.<domain>'), '.'),
        ui.el('div', {}, 'Or, when using your existing DNS provider, just add an A record ', ui.el('code', {}, '@ → ' + data.serverIp), ' pointing here.')
      )
    ));

    if (view.focus) {
      const f = view.focus;
      root.appendChild(ui.el('div', { class: 'banner' },
        `No DNS zone exists for this website (${f}) yet. `,
        ui.el('button', {
          class: 'btn btn-primary', style: 'margin-left:8px',
          onclick: () => newZoneModal(root, me, data, f)
        }, '+ Create zone for it')
      ));
    }

    if (!data.zones.length) {
      root.appendChild(ui.el('div', { class: 'card empty' },
        'No DNS zones yet. Create one below, or use the 🛰 DNS button next to a website.'));
      return;
    }

    const rows = data.zones.map((z) => ui.el('tr', {},
      ui.el('td', {}, ui.el('strong', {}, z.domain)),
      ui.el('td', {}, String(z.records.length)),
      me.role === 'admin' ? ui.el('td', { class: 'text-dim' }, z.owner) : null,
      ui.el('td', { class: 'text-dim' }, new Date(z.createdAt).toLocaleDateString()),
      ui.el('td', {},
        ui.el('button', {
          class: 'btn btn-sm', onclick: () => { view = { mode: 'zone', zone: z }; load(root, me); }
        }, '📋 Records'), ' ',
        ui.el('button', {
          class: 'btn btn-sm btn-danger', onclick: async () => {
            if (!(await ui.confirmBox(`Delete DNS zone ${z.domain}?`, { okText: 'Delete zone' }))) return;
            try { await api.del(`/dns/zones/${z.id}`); ui.toast('Zone deleted'); view = { mode: 'zones' }; load(root, me); }
            catch (e) { ui.toast(e.message, true); }
          }
        }, '🗑')
      )
    )).filter(Boolean);

    root.appendChild(ui.el('div', { class: 'table-wrap' },
      ui.el('table', {},
        ui.el('thead', {}, ui.el('tr', {},
          ui.el('th', {}, 'Domain'), ui.el('th', {}, 'Records'),
          me.role === 'admin' ? ui.el('th', {}, 'Owner') : null,
          ui.el('th', {}, 'Created'), ui.el('th', {}, 'Actions'))),
        ui.el('tbody', {}, ...rows))));
  }

  function newZoneModal(root, me, data, preset) {
    const body = ui.el('div', {});
    const input = ui.el('input', { type: 'text', id: 'zone-domain', placeholder: 'example.com' });
    if (preset) input.value = preset;
    if (data.availableSites.length) input.setAttribute('list', 'zone-sites');
    const dl = ui.el('datalist', { id: 'zone-sites' });
    for (const d of data.availableSites) dl.appendChild(ui.el('option', { value: d }));
    body.appendChild(ui.el('label', {}, 'Domain', input, dl));
    body.appendChild(ui.el('p', { class: 'text-dim' },
      'Default records: NS ns1.<domain>, A @ / www / ns1 → ', data.serverIp));

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const create = ui.el('button', { class: 'btn btn-primary' }, 'Create zone');
    actions.append(cancel, create);
    body.appendChild(actions);
    const m = ui.modal({ title: 'New DNS Zone', body });
    cancel.onclick = m.close;
    create.onclick = async () => {
      create.disabled = true;
      try {
        const r = await api.post('/dns/zones', { domain: input.value });
        m.close();
        ui.toast(`Zone ${r.zone.domain} created`);
        view = { mode: 'zone', zone: r.zone };
        load(root, me);
      } catch (e) { ui.toast(e.message, true); create.disabled = false; }
    };
  }

  function zoneView(root, me, zone, data) {
    root.appendChild(ui.el('div', { class: 'toolbar' },
      ui.el('button', { class: 'btn', onclick: () => { view = { mode: 'zones' }; load(root, me); } }, '⬅ All zones'),
      ui.el('span', { class: 'spacer' }),
      ui.el('button', { class: 'btn', onclick: () => load(root, me) }, '↻ Refresh')
    ));

    root.appendChild(ui.el('div', { class: 'card', style: 'margin-bottom:16px' },
      ui.el('h3', {}, `Zone: ${zone.domain}`),
      ui.el('div', { class: 'text-dim' },
        `Nameserver: ns1.${zone.domain} → ${data.serverIp} (set as NS at your registrar, with a glue A record)`)
    ));

    /* ---- records table ---- */
    const rows = zone.records.map((r) => ui.el('tr', {},
      ui.el('td', {}, ui.badge(r.type, r.type === 'A' || r.type === 'AAAA' ? 'green' : r.type === 'MX' ? 'yellow' : 'blue')),
      ui.el('td', { class: 'mono' }, r.name),
      ui.el('td', { class: 'mono', style: 'white-space:normal;word-break:break-all' },
        r.type === 'MX' ? `${r.priority || 10} ` : '', r.value),
      ui.el('td', {}, String(r.ttl || 3600)),
      ui.el('td', {},
        ui.el('button', { class: 'btn btn-sm', onclick: () => recordModal(root, me, zone, data, r) }, '✏'), ' ',
        ui.el('button', {
          class: 'btn btn-sm btn-danger', onclick: async () => {
            try {
              await api.del(`/dns/zones/${zone.id}/records/${r.id}`);
              ui.toast('Record deleted');
              view = { mode: 'zone', zone: { ...zone, id: zone.id } };
              load(root, me);
            } catch (e) { ui.toast(e.message, true); }
          }
        }, '🗑')
      )
    )).filter(Boolean);

    root.appendChild(ui.el('div', { class: 'table-wrap' },
      ui.el('table', {},
        ui.el('thead', {}, ui.el('tr', {},
          ui.el('th', {}, 'Type'), ui.el('th', {}, 'Name'), ui.el('th', {}, 'Value'),
          ui.el('th', {}, 'TTL'), ui.el('th', {}, 'Actions'))),
        ui.el('tbody', {}, ...rows))));

    root.appendChild(ui.el('div', { class: 'toolbar', style: 'margin-top:16px' },
      ui.el('button', {
        class: 'btn btn-primary',
        onclick: () => recordModal(root, me, zone, data, null)
      }, '+ Add record')
    ));
  }

  function recordModal(root, me, zone, data, existing) {
    const body = ui.el('div', {});
    const typeSel = ui.el('select', { id: 'rec-type' });
    for (const t of ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'CAA']) {
      typeSel.appendChild(ui.el('option', { value: t }, t));
    }
    const nameIn = ui.el('input', { type: 'text', id: 'rec-name', placeholder: '@ or www' });
    const valueIn = ui.el('input', { type: 'text', id: 'rec-value', placeholder: data.serverIp });
    const ttlIn = ui.el('input', { type: 'number', id: 'rec-ttl', value: '3600', min: '60', max: '86400' });
    const prioWrap = ui.el('label', { id: 'rec-prio-wrap' }, 'Priority (MX)',
      ui.el('input', { type: 'number', id: 'rec-prio', value: '10', min: '0', max: '65535' }));

    if (existing) {
      typeSel.value = existing.type;
      nameIn.value = existing.name;
      valueIn.value = existing.value;
      ttlIn.value = existing.ttl || 3600;
      prioWrap.querySelector('input').value = existing.priority || 10;
    }
    const syncPrio = () => { prioWrap.style.display = typeSel.value === 'MX' ? 'block' : 'none'; };
    typeSel.onchange = syncPrio;
    syncPrio();

    body.appendChild(ui.el('label', {}, 'Type', typeSel));
    body.appendChild(ui.el('label', {}, 'Name (@ = zone root, or a subdomain like www / mail)', nameIn));
    body.appendChild(ui.el('label', {}, 'Value', valueIn));
    body.appendChild(ui.el('label', {}, 'TTL (seconds)', ttlIn));
    body.appendChild(prioWrap);

    const actions = ui.el('div', { class: 'modal-actions' });
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    const ok = ui.el('button', { class: 'btn btn-primary' }, existing ? 'Save record' : 'Add record');
    actions.append(cancel, ok);
    body.appendChild(actions);
    const m = ui.modal({ title: existing ? 'Edit record' : `Add record to ${zone.domain}`, body });
    cancel.onclick = m.close;
    ok.onclick = async () => {
      const payload = {
        type: typeSel.value,
        name: nameIn.value,
        value: valueIn.value,
        ttl: ttlIn.value,
        priority: prioWrap.querySelector('input').value
      };
      try {
        if (existing) await api.put(`/dns/zones/${zone.id}/records/${existing.id}`, payload);
        else await api.post(`/dns/zones/${zone.id}/records`, payload);
        m.close();
        ui.toast(existing ? 'Record updated' : 'Record added');
        load(root, me);
      } catch (e) { ui.toast(e.message, true); }
    };
  }

  return {
    /* Call before navigating to #/dns: open this website's zone directly */
    forDomain: (domain) => { pendingDomain = domain; },
    render: (root, me) => {
      view = { mode: 'zones' };
      if (pendingDomain) {
        view.focus = pendingDomain;
        pendingDomain = null;
      }
      return load(root, me);
    },
    destroy: () => { view = { mode: 'zones' }; pendingDomain = null; }
  };
})();
