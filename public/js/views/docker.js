'use strict';
/* Docker view: what is running, what it is using, and the handful of things
 * an operator actually does to it - start, stop, restart, pause, read the
 * logs, look at what a container can see, pull an image, run one, reclaim the
 * disk. Admin-only, same as the API behind it. */
window.DockerView = (() => {
  let search = '';
  let runningOnly = false;
  let stats = {};          /* id -> the last one-shot reading */
  let statsAt = 0;
  let openMenu = null;     /* the ⋮ menu currently open, if any */

  /* Close the open tile menu, if any. Shared by every path that should
   * dismiss it: opening another, clicking a menu entry, clicking away. */
  function closeMenus() {
    if (!openMenu) return;
    openMenu.classList.remove('open');
    openMenu = null;
  }

  /* The daemon has no artwork for a container, so the common images keep
   * their mark and everything else gets its first letter on a hue picked
   * from the image name - the same image always lands on the same colour.
   * Matched against the repository part only (before any :tag), so
   * nginx:alpine reads as nginx and not as alpine. */
  const IMG_MARKS = [
    ['nginx', '🌐'], ['apache', '🪶'], ['httpd', '🪶'],
    ['postgres', '🐘'], ['mysql', '🐬'], ['mariadb', '🐬'], ['mongo', '🍃'],
    ['redis', '⚡'], ['memcache', '⚡'],
    ['ubuntu', '🐧'], ['debian', '🌀'],
    ['traefik', '🚦'], ['caddy', '🛡'], ['certbot', '📜'], ['acme', '📜'],
    ['grafana', '📈'], ['prometheus', '🔥'], ['portainer', '🚢'],
    ['wordpress', '📝'], ['nextcloud', '☁️'], ['jellyfin', '🎬'], ['plex', '🎬'],
    ['homeassistant', '🏠'], ['pihole', '🕳️'], ['vaultwarden', '🔐'], ['bitwarden', '🔐'],
    ['postfix', '📬'], ['dovecot', '📬'], ['mailu', '📬'], ['roundcube', '✉️'],
    ['phpmyadmin', '🗄️'], ['adminer', '🗄️'], ['docker', '🐳'], ['alpine', '🏔']
  ];

  function iconFor(image) {
    const repo = String(image || '').toLowerCase().split('/').pop().split(':')[0];
    for (const [k, mark] of IMG_MARKS) if (repo.includes(k)) return mark;
    let h = 0;
    for (const ch of String(image || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return (repo.match(/[a-z0-9]/i) || ['?'])[0].toUpperCase() + `|${h}`;
  }

  const ago = (ms) => {
    if (!ms) return '–';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  };

  const when = (ms) => (ms ? new Date(ms).toLocaleString() : '–');

  /* One number, the way the dashboard and the mail page show them. */
  function statCard(label, icon, tone, sub, value) {
    return ui.el('div', { class: `stat-card tone-${tone}` },
      ui.el('div', { class: 'stat-head' },
        ui.el('span', { class: 'stat-icon' }, icon),
        ui.el('div', { class: 'stat-label' }, label)),
      ui.el('div', { class: 'stat-value' }, value || '–'),
      ui.el('div', { class: 'stat-sub' }, sub || ''));
  }

  /* A button that shows it is working while it is: the actions here reach a
   * daemon that can take seconds, and a button that does nothing visible for
   * that long gets pressed again. */
  function busy(btn, label) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = label || '…';
    return () => { btn.disabled = false; btn.textContent = old; }
  }

  /* ---------------------------------------------------- details -------- */
  /* Everything the daemon knows about one container, plus what it is using
   * right now - the two questions that send an operator to `docker inspect`
   * and `docker stats`. Environment values that look like secrets are masked
   * by the API before they get here. */
  async function detailsModal(c) {
    const body = ui.el('div', {}, ui.el('div', { class: 'text-dim' }, 'Loading…'));
    const m = ui.modal({ title: c.name, wide: true, body });

    let d, s;
    try {
      [d, s] = await Promise.all([
        api.get(`/docker/containers/${c.id}/inspect`),
        api.get('/docker/stats')
      ]);
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(ui.el('div', { class: 'banner' }, e.message));
      return;
    }
    if (!m.el.isConnected) return;
    stats = Object.fromEntries((s.stats || []).map((x) => [x.id, x]));
    const st = stats[c.id];

    body.innerHTML = '';

    if (st) body.appendChild(ui.el('div', { class: 'hero-grid', style: 'margin-bottom:14px' },
      statCard('CPU', '⚙️', 'cyan', `${(st.cpu || 0).toFixed(1)}% of all cores`, `${(st.cpu || 0).toFixed(1)}%`),
      statCard('Memory', '🧠', 'violet',
        `${ui.fmtBytes(st.memUsed)} of ${ui.fmtBytes(st.memLimit)}`, `${(st.memPct || 0).toFixed(1)}%`),
      statCard('Network', '🔀', 'green', `↓ ${ui.fmtBytes(st.netRx)} · ↑ ${ui.fmtBytes(st.netTx)}`, `${st.pids} pid`),
      statCard('Disk I/O', '💾', 'amber', `read ${ui.fmtBytes(st.blkRead)} · wrote ${ui.fmtBytes(st.blkWrite)}`, 'since start')
    ));

    const row = (k, v) => ui.el('div', { class: 'kv-row' },
      ui.el('span', { class: 'kv-k' }, k), ui.el('span', { class: 'kv-v mono' }, v));

    body.appendChild(ui.el('div', { class: 'card', style: 'margin-bottom:12px' },
      ui.el('h3', {}, 'Container'),
      row('Image', d.image),
      d.command ? row('Command', d.command) : null,
      row('State', d.health ? `${d.state} (${d.health})` : d.state),
      row('Restart policy', d.restartPolicy),
      row('Network', d.networkMode || '–'),
      d.privileged ? row('Privileged', 'yes — this container is effectively root on the host') : null,
      row('Created', when(d.created)),
      d.started ? row('Started', `${when(d.started)} · ${ago(d.started)} ago`) : null,
      (d.ports || []).length ? row('Ports', d.ports.join(', ')) : null
    ));

    if ((d.mounts || []).length) {
      body.appendChild(ui.el('div', { class: 'card', style: 'margin-bottom:12px' },
        ui.el('h3', {}, 'Mounts'),
        ui.el('div', { class: 'kv-list' }, ...d.mounts.map((mnt) =>
          ui.el('div', { class: 'kv-row' },
            ui.el('span', { class: 'kv-v mono', style: 'flex:1' },
              `${mnt.source} → ${mnt.destination}`),
            ui.badge(mnt.rw ? 'rw' : 'ro', mnt.rw ? 'yellow' : 'gray'))))
      ));
    }

    body.appendChild(ui.el('div', { class: 'card' },
      ui.el('h3', {}, `Environment (${(d.env || []).length})`),
      (d.env || []).length
        ? ui.el('div', { class: 'kv-list' }, ...d.env.map((e) => row(e.key, e.value || ' ')))
        : ui.el('div', { class: 'text-dim' }, 'None set.')
    ));
  }

  /* ---------------------------------------------------- logs ----------- */
  function logsModal(c) {
    const pre = ui.el('pre', { class: 'pre-log' }, 'Loading…');
    const m = ui.modal({ title: `Logs · ${c.name}`, wide: true, body: pre });
    api.get(`/docker/containers/${c.id}/logs?tail=500`).then((r) => {
      pre.textContent = r.logs || '(no output)';
      /* Keep the newest lines in view: a container's log is read from the
       * bottom, not the top. */
      pre.scrollTop = pre.scrollHeight;
    }).catch((e) => { pre.textContent = e.message; });
    return m;
  }

  /* ---------------------------------------------------- run / pull ------ */
  /* A label wrapping its input is how every other form in the panel is built
   * (see the mailbox modal), and the stylesheet styles it that way. */
  const field = (label, input, hint) => ui.el('label', {}, label, input,
    hint ? ui.el('div', { class: 'text-dim', style: 'font-size:11.5px;margin-top:4px' }, hint) : null);

  const textInput = (ph, value) => ui.el('input', { type: 'text', placeholder: ph, value: value || '' });

  function runModal(root) {
    const image = textInput('nginx:alpine');
    const name = textInput('my-website');
    const command = textInput('sleep 3600', '');
    const ports = textInput('8080:80', '');
    const volumes = textInput('/var/www/site:/usr/share/nginx/html:ro', '');
    const env = ui.el('textarea', { rows: 3, placeholder: 'KEY=value, one per line' });
    const restart = ui.el('select', {},
      ...['unless-stopped', 'always', 'on-failure', 'no'].map((v) =>
        ui.el('option', { value: v }, v)));

    const start = ui.el('button', { class: 'btn btn-primary' }, 'Start container');
    const m = ui.modal({
      title: 'Run a container', wide: true,
      body: ui.el('div', {},
        ui.el('p', { class: 'text-dim', style: 'margin-top:0' },
          'The image is pulled if it is not already here. Ports and volumes are '
          + 'host-side: 8080:80 publishes container port 80 as 8080 on this server, '
          + 'and a volume is /host/path:/container/path, with :ro to keep it read-only.'),
        field('Image', image),
        field('Name', name, 'Letters, digits, dot, dash and underscore.'),
        field('Command', command, 'Optional: what to run instead of the image\'s own default — e.g. sleep 3600 to keep a shell image alive.'),
        field('Published ports', ports, 'Comma-separated host:container[/tcp|udp]. Leave empty to publish none.'),
        field('Volumes', volumes, 'Comma-separated /host:/container[:ro]. Absolute paths only.'),
        field('Environment', env, 'One KEY=value per line.'),
        field('Restart policy', restart),
        ui.el('div', { class: 'modal-actions' }, start)
      )
    });

    start.onclick = async () => {
      const done = busy(start, 'Starting…');
      try {
        const r = await api.post('/docker/containers', {
          image: image.value.trim(), name: name.value.trim(), command: command.value,
          ports: ports.value, volumes: volumes.value, env: env.value, restart: restart.value
        });
        ui.toast(`Started ${r.name || name.value}`);
        m.close();
        load(root);
      } catch (e) {
        ui.toast(e.message, true);
      } finally { done(); }
    };
  }

  function pullModal(root) {
    const image = textInput('nginx:alpine');
    const out = ui.el('pre', { class: 'pre-log', style: 'max-height:220px' }, '');
    const go = ui.el('button', { class: 'btn btn-primary' }, 'Pull');
    const m = ui.modal({
      title: 'Pull an image', wide: true,
      body: ui.el('div', {},
        field('Image', image, 'Anything the Docker Hub, or this server\'s own registry, will serve.'),
        ui.el('div', { class: 'modal-actions' }, go),
        out)
    });
    go.onclick = async () => {
      const name = image.value.trim();
      if (!name) return;
      const done = busy(go, 'Pulling…');
      out.textContent = 'Contacting the registry…';
      try {
        const r = await api.post('/docker/pull', { image: name });
        out.textContent = r.output || '(no output)';
        if (r.ok) { ui.toast(`Pulled ${name}`); load(root); }
        else ui.toast('The pull failed', true);
      } catch (e) {
        out.textContent = e.message;
        ui.toast(e.message, true);
      } finally { done(); }
    };
  }

  async function prune(root) {
    if (!(await ui.confirmBox(
      'Remove every stopped container, dangling image and unused network?\n'
      + 'Running containers and tagged images are untouched.', { okText: 'Reclaim space' }))) return;
    try {
      const r = await api.post('/docker/system/prune', {});
      ui.toast(`Reclaimed ${ui.fmtBytes(r.reclaimed)} — ${r.containers} container(s), ${r.images} image(s), ${r.networks} network(s)`);
      load(root);
    } catch (e) { ui.toast(e.message, true); }
  }

  /* ---------------------------------------------------- the page ------- */
  async function load(root) {
    root.innerHTML = '';
    let containers, images, info, df;
    try {
      [containers, images, info, df] = await Promise.all([
        api.get('/docker/containers'),
        api.get('/docker/images'),
        api.get('/docker/info'),
        api.get('/docker/df')
      ]);
    } catch (e) {
      root.appendChild(ui.el('div', { class: 'card empty' },
        ui.el('h3', {}, 'Docker is not available'),
        ui.el('p', {}, e.message),
        ui.el('a', { class: 'btn btn-primary', href: '#/setup' }, '🧩 Open Setup Wizard')));
      return;
    }

    /* One reading for every running container, so the rows can show what each
     * one is using without a request per row. */
    api.get('/docker/stats').then((s) => {
      if (!root.isConnected) return;
      stats = Object.fromEntries((s.stats || []).map((x) => [x.id, x]));
      statsAt = Date.now();
      render(root, containers, images, info.info, df);
    }).catch(() => { statsAt = 0; render(root, containers, images, info.info, df); });
  }

  function render(root, containers, images, info, df) {
    root.innerHTML = '';
    const list = containers.containers || [];
    const running = list.filter((c) => c.state === 'running').length;

    root.appendChild(ui.el('div', { class: 'toolbar' },
      ui.el('button', { class: 'btn btn-primary', onclick: () => runModal(root) }, '+ Run container'),
      ui.el('button', { class: 'btn', onclick: () => pullModal(root) }, '⬇ Pull image'),
      ui.el('button', { class: 'btn', onclick: () => prune(root) }, '🧹 Reclaim space'),
      ui.el('span', { class: 'spacer' }),
      ui.el('button', { class: 'btn', onclick: () => load(root) }, '↻ Refresh')
    ));

    root.appendChild(ui.el('div', { class: 'hero-grid', style: 'margin-bottom:16px' },
      statCard('Running', '📦', running ? 'green' : 'amber',
        `${list.length} container(s) on this server`, String(running)),
      statCard('Images', '🧰', 'cyan',
        `${ui.fmtBytes((df.images || {}).size)} on disk`, String((df.images || {}).count)),
      statCard('Disk used', '💾', 'violet',
        `containers ${ui.fmtBytes((df.containers || {}).size)} · volumes ${ui.fmtBytes(((df.volumes || {}).size) || 0)}`,
        ui.fmtBytes(df.total)),
      statCard('Docker', '🐳', 'amber', info.os || '', `v${info.version}`)
    ));

    /* ------------------------------- containers ------------------------ */
    const needle = search.trim().toLowerCase();
    const shown = list.filter((c) => {
      if (runningOnly && c.state !== 'running') return false;
      if (!needle) return true;
      return `${c.name} ${c.image} ${c.id} ${c.ports}`.toLowerCase().includes(needle);
    });

    const searchBox = ui.el('input', {
      type: 'search', placeholder: 'Search name, image, port…', value: search,
      oninput: (e) => { search = e.target.value; render(root, containers, images, info, df); }
    });
    const runToggle = ui.el('label', { class: 'checkbox-label' },
      ui.el('input', {
        type: 'checkbox', checked: runningOnly,
        onchange: (e) => { runningOnly = e.target.checked; render(root, containers, images, info, df); }
      }), ' running only');

    root.appendChild(ui.el('div', { class: 'card' },
      ui.el('h3', {}, `Containers (${list.length})`),
      ui.el('div', { class: 'toolbar', style: 'margin-bottom:10px' }, searchBox, runToggle,
        ui.el('span', { class: 'spacer' }),
        statsAt ? ui.el('span', { class: 'text-dim', style: 'font-size:11.5px' },
          `measured ${ago(statsAt)} ago`) : null),
      shown.length ? ui.el('div', { class: 'ctile-grid' },
        ...shown.map((c) => containerTile(root, c)),
        addTile(root))
        : ui.el('div', { class: 'empty' },
          list.length ? 'No container matches that.' : 'No containers yet. Run one from an image.')
    ));

    /* ------------------------------- images ---------------------------- */
    const imgs = images.images || [];
    root.appendChild(ui.el('div', { class: 'card', style: 'margin-top:16px' },
      ui.el('h3', {}, `Images (${imgs.length})`),
      imgs.length ? ui.el('div', { class: 'table-wrap' },
        ui.el('table', {},
          ui.el('thead', {}, ui.el('tr', {},
            ui.el('th', {}, 'Tags'), ui.el('th', {}, 'Size'),
            ui.el('th', {}, 'In use'), ui.el('th', {}, 'Created'), ui.el('th', {}, ''))),
          ui.el('tbody', {}, ...imgs.map((img) => imageRow(root, img)))))
        : ui.el('div', { class: 'empty' }, 'No images. Pull one to get started.')
    ));
  }

  /* One container as a CasaOS-style tile: icon with the state dot in its
   * corner, name, image, what it is doing - and a ⋮ in the corner holding
   * every action, so the grid stays a grid. Clicking the tile itself opens
   * the inspector, the way clicking an app in CasaOS opens the app. */
  function containerTile(root, c) {
    const s = stats[c.id];
    const mark = iconFor(c.image);
    const letter = mark.includes('|');
    const [glyph, hue] = letter ? mark.split('|') : [mark, null];

    const dotCls = c.state === 'running' ? 'ok' : c.state === 'paused' ? 'warn' : '';
    const icon = ui.el('div', {
      class: `ctile-icon${letter ? ' letter' : ''}`,
      style: letter ? `background:linear-gradient(135deg, hsl(${hue}, 60%, 46%), hsl(${hue}, 60%, 30%))` : ''
    }, letter ? glyph : mark, ui.el('span', { class: `ctile-dot ${dotCls}` }));

    /* Two short lines under the image: the state - named outright, because
     * that is the fact a tile exists to show - and, when there is a reading,
     * what it is using right now. */
    const stateLine = c.state === 'running'
      ? (c.uptime ? `running · up ${ago(c.uptime)}` : 'running')
      : (c.health ? `${c.state} · ${c.health}` : (c.status || c.state));
    const useLine = s
      ? `${(s.cpu || 0).toFixed(1)}% cpu · ${(s.memPct || 0).toFixed(1)}% mem`
      : null;

    const act = (action, label) => ui.el('button', {
      onclick: async (e) => {
        if (e.stopPropagation) e.stopPropagation();
        closeMenus();
        try {
          await api.post(`/docker/containers/${c.id}/action`, { action });
          ui.toast(`${action} requested`);
          load(root);
        } catch (err) { ui.toast(err.message, true); }
      }
    }, label);

    const menu = ui.el('div', { class: 'ctile-menu' },
      ui.el('button', {
        onclick: (e) => { if (e.stopPropagation) e.stopPropagation(); closeMenus(); detailsModal(c); }
      }, 'ℹ️ Details'),
      ui.el('button', {
        onclick: (e) => { if (e.stopPropagation) e.stopPropagation(); closeMenus(); logsModal(c); }
      }, '📋 Logs'),
      ui.el('div', { class: 'msep' }),
      ...(c.state === 'running'
        ? [act('pause', '⏸ Pause'), act('restart', '↻ Restart'), act('stop', '⏹ Stop')]
        : c.state === 'paused'
          ? [act('unpause', '▶ Unpause')]
          : [act('start', '▶ Start')]),
      ui.el('div', { class: 'msep' }),
      ui.el('button', {
        class: 'danger',
        onclick: async (e) => {
          if (e.stopPropagation) e.stopPropagation();
          closeMenus();
          if (!(await ui.confirmBox(`Remove ${c.name}? It is stopped and deleted.`, { okText: 'Remove' }))) return;
          try { await api.del(`/docker/containers/${c.id}`); ui.toast(`${c.name} removed`); load(root); }
          catch (err) { ui.toast(err.message, true); }
        }
      }, '🗑 Remove')
    );

    const more = ui.el('button', {
      class: 'ctile-more', title: 'Actions', 'aria-label': `Actions for ${c.name}`,
      onclick: (e) => {
        if (e.stopPropagation) e.stopPropagation();
        const wasOpen = menu.classList.contains('open');
        closeMenus();
        if (!wasOpen) { menu.classList.add('open'); openMenu = menu; }
      }
    }, '⋮');

    const tile = ui.el('div', {
      class: 'ctile', role: 'button', tabindex: '0',
      title: `${c.name} — ${c.image}${c.ports ? ` — ${c.ports}` : ''}`,
      onclick: () => detailsModal(c)
    }, more, icon,
      ui.el('div', { class: 'ctile-name' }, c.name),
      ui.el('div', { class: 'ctile-sub' }, c.image),
      ui.el('div', { class: 'ctile-meta' }, stateLine),
      useLine ? ui.el('div', { class: 'ctile-meta' }, useLine) : null,
      menu);
    return tile;
  }

  /* The CasaOS "+": a dashed tile at the end of the grid that runs a new
   * container, so the page's main verb is where the eye lands. */
  function addTile(root) {
    return ui.el('div', {
      class: 'ctile ctile-add', role: 'button', tabindex: '0', title: 'Run a container',
      onclick: () => runModal(root)
    }, ui.el('div', { class: 'plus' }, '+'),
      ui.el('div', { class: 'ctile-name' }, 'Run a container'));
  }

  function imageRow(root, img) {
    const tag = (img.tags && img.tags.length && img.tags[0] !== '<none>') ? img.tags[0] : img.id;
    return ui.el('tr', {},
      ui.el('td', { class: 'mono', style: 'font-size:12px' },
        ui.el('div', {}, tag),
        img.tags && img.tags.length > 1
          ? ui.el('div', { class: 'text-dim', style: 'font-size:11px' },
            `+${img.tags.length - 1} more tag(s)`) : null),
      ui.el('td', {}, ui.fmtBytes(img.size)),
      ui.el('td', {}, img.containers === null
        ? ui.el('span', { class: 'text-dim' }, '–')
        : ui.badge(img.containers > 0 ? `${img.containers} running` : 'unused',
          img.containers > 0 ? 'green' : 'gray')),
      ui.el('td', { class: 'text-dim', style: 'font-size:12px' }, when(img.created * 1000)),
      ui.el('td', { style: 'text-align:right' },
        ui.el('button', {
          class: 'btn btn-sm btn-danger',
          onclick: async () => {
            if (!(await ui.confirmBox(`Delete image ${tag}? Containers using it are unaffected.`,
              { okText: 'Delete' }))) return;
            try { await api.del(`/docker/images/${img.id}`); ui.toast('Image deleted'); load(root); }
            catch (e) { ui.toast(e.message, true); }
          }
        }, '🗑'))
    );
  }

  /* Clicking anywhere outside a tile's menu closes it. The ⋮ button and the
   * menu entries stopPropagation, so they do not trip this. */
  document.addEventListener('click', () => closeMenus());

  return { render: (root) => load(root) };
})();
