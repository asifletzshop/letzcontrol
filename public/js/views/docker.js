'use strict';
/* Docker view: containers, images, logs */
window.DockerView = (() => {
  async function load(root) {
    root.innerHTML = '';
    let containers, images, info;
    try {
      [containers, images, info] = await Promise.all([
        api.get('/docker/containers'),
        api.get('/docker/images'),
        api.get('/docker/info')
      ]);
    } catch (e) {
      root.appendChild(ui.el('div', { class: 'banner' }, e.message));
      return;
    }

    const i = info.info;
    root.appendChild(ui.el('div', { class: 'grid cols-4', style: 'margin-bottom:16px' },
      ui.el('div', { class: 'card' }, ui.el('h3', {}, 'Docker'), ui.el('div', { class: 'stat-value' }, `v${i.version}`), ui.el('div', { class: 'stat-sub' }, i.os)),
      ui.el('div', { class: 'card' }, ui.el('h3', {}, 'Running'), ui.el('div', { class: 'stat-value' }, String(i.containersRunning)), ui.el('div', { class: 'stat-sub' }, `${i.containers} total`)),
      ui.el('div', { class: 'card' }, ui.el('h3', {}, 'Images'), ui.el('div', { class: 'stat-value' }, String(i.images))),
      ui.el('div', { class: 'card' }, ui.el('h3', {}, 'Storage driver'), ui.el('div', { class: 'stat-value', style: 'font-size:20px' }, i.driver))
    ));

    const actionBtn = (id, action, label) => ui.el('button', {
      class: 'btn btn-sm',
      onclick: async () => {
        try { await api.post(`/docker/containers/${id}/action`, { action }); load(root); }
        catch (e) { ui.toast(e.message, true); }
      }
    }, label);

    const cRows = containers.containers.map((c) => ui.el('tr', {},
      ui.el('td', {}, ui.el('strong', {}, c.name), ui.el('div', { class: 'text-dim mono' }, c.id)),
      ui.el('td', { class: 'mono' }, c.image),
      ui.el('td', {}, c.state === 'running' ? ui.badge('running', 'green') : c.state === 'exited' ? ui.badge('exited', 'gray') : ui.badge(c.state, 'yellow'),
        ui.el('div', { class: 'text-dim', style: 'font-size:12px' }, c.status)),
      ui.el('td', { class: 'mono' }, c.ports || '–'),
      ui.el('td', {},
        c.state === 'running'
          ? ui.el('span', {}, actionBtn(c.id, 'stop', '⏹'), ' ', actionBtn(c.id, 'restart', '↻'), ' ')
          : ui.el('span', {}, actionBtn(c.id, 'start', '▶'), ' '),
        ui.el('button', {
          class: 'btn btn-sm', onclick: async () => {
            const r = await api.get(`/docker/containers/${c.id}/logs`);
            ui.modal({ title: `Logs: ${c.name}`, wide: true, body: ui.el('pre', { class: 'pre-log' }, r.logs || '(empty)') });
          }
        }, '📄 Logs'), ' ',
        ui.el('button', {
          class: 'btn btn-sm btn-danger', onclick: async () => {
            if (!(await ui.confirmBox(`Remove container ${c.name}?`, { okText: 'Remove' }))) return;
            try { await api.del(`/docker/containers/${c.id}`); load(root); }
            catch (e) { ui.toast(e.message, true); }
          }
        }, '🗑')
      )
    ));

    root.appendChild(ui.el('h3', {}, 'Containers'));
    root.appendChild(containers.containers.length
      ? ui.el('div', { class: 'table-wrap' },
          ui.el('table', {},
            ui.el('thead', {}, ui.el('tr', {}, ui.el('th', {}, 'Name'), ui.el('th', {}, 'Image'), ui.el('th', {}, 'State'), ui.el('th', {}, 'Ports'), ui.el('th', {}, 'Actions'))),
            ui.el('tbody', {}, ...cRows)))
      : ui.el('div', { class: 'card empty' }, 'No containers.'));

    const iRows = images.images.map((img) => ui.el('tr', {},
      ui.el('td', { class: 'mono' }, img.tags.join(', ')),
      ui.el('td', { class: 'mono text-dim' }, img.id),
      ui.el('td', {}, ui.fmtBytes(img.size)),
      ui.el('td', {}, ui.el('button', {
        class: 'btn btn-sm btn-danger', onclick: async () => {
          if (!(await ui.confirmBox(`Delete image ${img.tags[0]}?`, { okText: 'Delete' }))) return;
          try { await api.del(`/docker/images/${img.id}`); load(root); }
          catch (e) { ui.toast(e.message, true); }
        }
      }, '🗑'))
    ));

    root.appendChild(ui.el('h3', { style: 'margin-top:24px' }, 'Images'));
    root.appendChild(images.images.length
      ? ui.el('div', { class: 'table-wrap' },
          ui.el('table', {},
            ui.el('thead', {}, ui.el('tr', {}, ui.el('th', {}, 'Tags'), ui.el('th', {}, 'ID'), ui.el('th', {}, 'Size'), ui.el('th', {}, 'Actions'))),
            ui.el('tbody', {}, ...iRows)))
      : ui.el('div', { class: 'card empty' }, 'No images.'));
  }

  return { render: (root) => load(root) };
})();
