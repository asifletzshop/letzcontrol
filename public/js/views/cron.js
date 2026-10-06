'use strict';
/* Cron Jobs: create / edit / enable / delete tagged root-crontab entries (admin) */
window.CronView = (() => {
  let rootEl = null;

  const PRESETS = [
    ['Custom…', ''],
    ['Every minute', '* * * * *'],
    ['Every 5 minutes', '*/5 * * * *'],
    ['Every 15 minutes', '*/15 * * * *'],
    ['Hourly (on the hour)', '0 * * * *'],
    ['Daily at 02:00', '0 2 * * *'],
    ['Daily at midnight', '0 0 * * *'],
    ['Weekly — Monday 03:00', '0 3 * * 1'],
    ['Monthly — 1st, 04:00', '0 4 1 * *'],
    ['On boot (@reboot)', '@reboot']
  ];

  async function load() {
    if (!rootEl) return;
    const { jobs } = await api.get('/cron');
    rootEl.innerHTML = '';

    const newBtn = ui.el('button', { class: 'btn btn-primary' }, '＋ New cron job');
    newBtn.onclick = () => jobModal(null);

    rootEl.append(
      ui.el('div', { class: 'toolbar' }, newBtn,
        ui.el('span', { class: 'text-dim', style: 'font-size:12.5px' },
          'Jobs run as root on the main server crontab')),
      jobs.length ? renderTable(jobs) : ui.el('div', { class: 'card empty' },
        ui.el('div', { style: 'font-size:34px; margin-bottom:8px' }, '⏰'),
        ui.el('div', {}, 'No cron jobs yet — create your first scheduled task.'),
        (() => { const b = ui.el('button', { class: 'btn btn-primary', style: 'margin-top:14px' }, '＋ New cron job'); b.onclick = () => jobModal(null); return b; })())
    );
  }

  function renderTable(jobs) {
    const tbody = ui.el('tbody', {});
    for (const j of jobs) {
      const toggleBtn = ui.el('button', { class: 'btn btn-sm', title: j.enabled ? 'Disable' : 'Enable' },
        j.enabled ? '⏸' : '▶');
      toggleBtn.onclick = async () => {
        try { await api.post(`/cron/${j.id}/toggle`); await load(); ui.toast(j.enabled ? 'Job disabled' : 'Job enabled'); }
        catch (e) { ui.toast(e.message, true); }
      };
      const editBtn = ui.el('button', { class: 'btn btn-sm', title: 'Edit' }, '✏️');
      editBtn.onclick = () => jobModal(j);
      const delBtn = ui.el('button', { class: 'btn btn-sm btn-danger', title: 'Delete' }, '🗑');
      delBtn.onclick = async () => {
        if (!(await ui.confirmBox(`Delete cron job "${j.label || j.command}"?`))) return;
        try { await api.del(`/cron/${j.id}`); await load(); ui.toast('Job deleted'); }
        catch (e) { ui.toast(e.message, true); }
      };

      tbody.appendChild(ui.el('tr', {},
        ui.el('td', {}, ui.el('code', {}, j.schedule)),
        ui.el('td', { style: 'max-width:420px; overflow:hidden; text-overflow:ellipsis' , title: j.command }, ui.el('code', {}, j.command)),
        ui.el('td', { class: 'text-dim' }, j.label || '—'),
        ui.el('td', {}, ui.badge(j.enabled ? 'Enabled' : 'Disabled', j.enabled ? 'green' : 'gray')),
        ui.el('td', { style: 'white-space:nowrap' }, ' ', toggleBtn, ' ', editBtn, ' ', delBtn)
      ));
    }
    return ui.el('div', { class: 'table-wrap' },
      ui.el('table', {},
        ui.el('thead', {}, ui.el('tr', {},
          ui.el('th', {}, 'Schedule'), ui.el('th', {}, 'Command'), ui.el('th', {}, 'Label'),
          ui.el('th', {}, 'Status'), ui.el('th', {}, 'Actions'))),
        tbody));
  }

  function jobModal(existing) {
    const scheduleIn = ui.el('input', { type: 'text', value: existing ? existing.schedule : '0 2 * * *', placeholder: '0 2 * * *  or  @reboot', spellcheck: 'false' });
    const presetSel = ui.el('select', {},
      ...PRESETS.map(([label, val]) => {
        const o = ui.el('option', { value: val }, label);
        if (existing && val === existing.schedule) o.selected = true;
        return o;
      }));
    if (existing && !PRESETS.some(([, v]) => v === existing.schedule)) presetSel.value = '';
    presetSel.onchange = () => { if (presetSel.value) scheduleIn.value = presetSel.value; };

    const cmdIn = ui.el('textarea', { rows: '3', placeholder: '/usr/local/bin/backup.sh --quiet', spellcheck: 'false' });
    cmdIn.value = existing ? existing.command : '';
    const labelIn = ui.el('input', { type: 'text', value: existing ? existing.label : '', placeholder: 'Nightly backup (optional)' });

    const preview = ui.el('div', { class: 'mono text-dim', style: 'margin-top:4px; word-break:break-all' });
    const renderPreview = () => {
      preview.textContent = `${scheduleIn.value.trim() || '?'} ${cmdIn.value.trim() || '?'} # letzcontrol:<id>`;
    };
    scheduleIn.oninput = renderPreview;
    cmdIn.oninput = renderPreview;
    renderPreview();

    const body = ui.el('div', {},
      ui.el('label', {}, 'Preset', presetSel),
      ui.el('label', {}, 'Schedule (cron expression)', scheduleIn),
      ui.el('label', {}, 'Command', cmdIn),
      ui.el('label', {}, 'Label', labelIn),
      ui.el('div', { class: 'banner info', style: 'margin:0 0 14px' },
        ui.el('div', { style: 'font-size:12px' }, 'Preview:'), preview)
    );

    const m = ui.modal({ title: existing ? 'Edit cron job' : 'New cron job', body });
    const save = ui.el('button', { class: 'btn btn-primary' }, existing ? 'Save changes' : 'Create job');
    const cancel = ui.el('button', { class: 'btn' }, 'Cancel');
    cancel.onclick = m.close;
    save.onclick = async () => {
      const payload = { schedule: scheduleIn.value, command: cmdIn.value, label: labelIn.value };
      try {
        if (existing) await api.put(`/cron/${existing.id}`, payload);
        else await api.post('/cron', payload);
        m.close();
        await load();
        ui.toast(existing ? 'Job updated' : 'Job created');
      } catch (e) { ui.toast(e.message, true); }
    };
    body.appendChild(ui.el('div', { class: 'modal-actions' }, cancel, save));
  }

  async function render(root) {
    rootEl = root;
    try { await load(); }
    catch (e) {
      root.appendChild(ui.el('div', { class: 'banner' }, `Failed to load cron jobs: ${e.message}`));
    }
  }

  function destroy() { rootEl = null; }

  return { render, destroy };
})();
