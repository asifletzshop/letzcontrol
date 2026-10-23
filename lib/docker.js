'use strict';
/** Docker manager via dockerode (containers, images, logs, disk).
 *
 *  Admin-only, and every value that reaches the daemon is checked first: this
 *  process runs as root, so a container name or a bind path taken on trust is
 *  a root shell for whoever can reach the page. */
const express = require('express');
const path = require('path');
const fsp = require('fs').promises;
const { run } = require('./exec');
const { requireAdmin } = require('./auth');
/* Linking a website to a container means writing the same site record and the
 * same vhost the Sites page does, so it is done through lib/sites rather than
 * beside it - one place decides what a vhost looks like. */
const db = require('./db');
const config = require('../config');
const { checkLimit } = require('./users');
const {
  writeNginxVhost, reloadServers, nginxPaths, DOMAIN_RE
} = require('./sites');

const router = express.Router();

/* The Docker manager is an admin-only page - containers run privileged
 * workloads, so regular panel users never touch this API. */
router.use(requireAdmin);

let docker = null;
try {
  const Docker = require('dockerode');
  docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
} catch {
  console.warn('[letzControl] dockerode unavailable - Docker manager disabled');
}

const ID_RE = /^[a-zA-Z0-9_.:-]+$/;
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\/:@-]{0,199}$/;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const ENVKEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESTARTS = ['no', 'always', 'on-failure', 'unless-stopped'];

router.use(async (_req, res, next) => {
  if (!docker) return res.status(503).json({ error: 'Docker integration unavailable on this server' });
  try {
    await docker.ping();
    next();
  } catch {
    res.status(503).json({ error: 'Docker is not installed or the socket is not accessible' });
  }
});

/** The shape of a container as the page wants it. */
function containerRow(c) {
  return {
    id: c.Id.slice(0, 12),
    name: (c.Names[0] || '').replace(/^\//, ''),
    image: c.Image,
    state: c.State,
    status: c.Status,
    created: c.Created,
    /* Health, when the image declares one, is worth showing on its own: a
     * "running" container that is failing its health check is not working. */
    health: (c.State === 'running' && (c.Status || '').includes('('))
      ? (c.Status.match(/\(([^)]+)\)/) || [])[1] || null
      : null,
    ports: (c.Ports || [])
      .filter((p) => p.PublicPort)
      .map((p) => `${p.PublicPort}->${p.PrivatePort}/${p.Type}`)
      .join(', '),
    uptime: c.State === 'running' && c.StartedAt ? Date.parse(c.StartedAt) : null
  };
}

router.get('/info', async (_req, res, next) => {
  try {
    const info = await docker.info();
    res.json({
      info: {
        version: info.ServerVersion,
        containers: info.Containers,
        containersRunning: info.ContainersRunning,
        containersStopped: info.ContainersStopped,
        images: info.Images,
        driver: info.Driver,
        os: info.OperatingSystem,
        cpus: info.NCPU,
        memory: info.MemTotal,
        root: info.DockerRootDir
      }
    });
  } catch (e) { next(e); }
});

/* What the whole daemon is using, for the storage figures the page shows.
 * docker info reports a single LayersSize that counts layers twice when
 * images share them; system df is the honest number. */
router.get('/df', async (_req, res, next) => {
  try {
    const df = await docker.df();
    const sum = (rows, key) => (rows || []).reduce((a, r) => a + (Number(r[key]) || 0), 0);
    res.json({
      images: { count: (df.Images || []).length, size: sum(df.Images, 'Size') },
      containers: { count: (df.Containers || []).length, size: sum(df.Containers, 'SizeRw') },
      volumes: { count: (df.Volumes || []).length, size: sum(df.Volumes, 'UsageData', 0) },
      total: df.LayersSize || 0
    });
  } catch (e) { next(e); }
});

/* The website a container has been linked to, if it has one.
 *
 *  The link lives on the site record rather than as a field on the container,
 *  because the panel already knows how to render, secure, renew and delete
 *  sites, and a hostname pointing at an app should behave like every other
 *  hostname on the box. dockerName is what ties it to one container - a port
 *  number would not, since a second container could be given the same one. */
function linkFor(name) {
  return db.findOne('sites', (s) => s.backend === 'docker' && s.dockerName === name);
}

/** How a linked app is opened.
 *
 *  https only when the app is known to be told the real scheme, because a
 *  container that decides its own URLs from the request it saw keeps writing
 *  http:// asset links - which the browser then refuses on an https page, and
 *  the site renders as unstyled text. That is not something the proxy can fix,
 *  so the address handed out is the one that works. */
function linkUrl(site) {
  const https = site.ssl && (site.backend !== 'docker' || site.forceHttps === true);
  return `${https ? 'https' : 'http'}://${site.domain}/`;
}

router.get('/containers', async (_req, res, next) => {
  try {
    const list = await docker.listContainers({ all: true });
    res.json({
      containers: list.map((c) => {
        const row = containerRow(c);
        /* The tile's Open action is what people use, so the address it opens
         * is carried with the row rather than fetched separately - and only
         * once there is a certificate does it become https, otherwise the
         * link would be a scheme the vhost is not serving yet. */
        const site = linkFor(row.name);
        row.site = site
          ? {
            id: site.id,
            domain: site.domain,
            port: Number(site.appPort),
            ssl: !!site.ssl,
            forceHttps: !!site.forceHttps,
            url: linkUrl(site)
          }
          : null;
        return row;
      })
    });
  } catch (e) { next(e); }
});

/* One container, in detail: what it was created from, what it can see, and how
 * it is behaving right now. Environment values are masked when the name says
 * they are a secret - the detail modal is a screenshot away from being pasted
 * somewhere. */
const SECRETY = /PASS|SECRET|TOKEN|PRIVATE|API_?KEY|CREDENTIAL/i;

router.get('/containers/:id/inspect', async (req, res, next) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid container id' });
    const c = await docker.getContainer(req.params.id).inspect();
    const env = (c.Config.Env || []).map((line) => {
      const i = line.indexOf('=');
      const key = i < 0 ? line : line.slice(0, i);
      return { key, value: i < 0 ? '' : (SECRETY.test(key) ? '••••••••' : line.slice(i + 1)) };
    });
    res.json({
      id: c.Id.slice(0, 12),
      name: (c.Name || '').replace(/^\//, ''),
      image: c.Config.Image,
      command: (c.Config.Cmd || []).join(' '),
      created: Date.parse(c.Created),
      started: Date.parse(c.State.StartedAt) || null,
      state: c.State.Status,
      running: c.State.Running,
      health: c.State.Health ? c.State.Health.Status : null,
      restartPolicy: (c.HostConfig.RestartPolicy || {}).Name || 'no',
      networkMode: c.HostConfig.NetworkMode,
      privileged: !!c.HostConfig.Privileged,
      ports: Object.entries(c.NetworkSettings.Ports || {})
        .map(([k, v]) => `${k} -> ${((v || [])[0] || {}).HostPort || '–'}`),
      mounts: (c.Mounts || []).map((m) => ({
        type: m.Type, source: m.Source, destination: m.Destination, rw: m.RW
      })),
      env
    });
  } catch (e) { next(e); }
});

/* A one-shot reading for every running container. Streamed stats would be
 * live but never-ending; one sample on demand is what a page needs. */
router.get('/stats', async (_req, res, next) => {
  try {
    const list = await docker.listContainers();
    const rows = await Promise.all(list.map(async (c) => {
      try {
        const s = await docker.getContainer(c.Id).stats({ stream: false });
        const cpu = s.cpu_stats || {};
        const precpu = s.precpu_stats || {};
        const mem = s.memory_stats || {};
        const used = Number(mem.usage) || 0;
        const limit = Number(mem.limit) || 0;
        const cpuDelta = Number((cpu.cpu_usage || {}).total_usage || 0)
          - Number((precpu.cpu_usage || {}).total_usage || 0);
        const sysDelta = Number((cpu.system_cpu_usage || 0)) - Number((precpu.system_cpu_usage || 0));
        const perCpu = ((cpu.cpu_usage || {}).percpu_usage || []).length || cpu.OnlineCPUs || 1;
        const net = Object.values(s.networks || {}).reduce((a, n) => ({
          rx: a.rx + (Number(n.rx_bytes) || 0), tx: a.tx + (Number(n.tx_bytes) || 0)
        }), { rx: 0, tx: 0 });
        const blkio = (s.blkio_stats && s.blkio_stats.io_service_bytes_recursive) || [];
        const io = (op) => blkio.filter((b) => b.op === op).reduce((a, b) => a + (Number(b.value) || 0), 0);
        return {
          id: c.Id.slice(0, 12),
          name: (c.Names[0] || '').replace(/^\//, ''),
          cpu: sysDelta > 0 ? (cpuDelta / sysDelta) * perCpu * 100 : 0,
          mem, memUsed: used, memLimit: limit,
          memPct: limit > 0 ? (used / limit) * 100 : 0,
          netRx: net.rx, netTx: net.tx,
          blkRead: io('Read'), blkWrite: io('Write'),
          pids: (s.pids_stats || {}).current || 0
        };
      } catch {
        /* A container that exits between the listing and the reading is not
         * an error worth failing the page over. */
        return null;
      }
    }));
    res.json({ stats: rows.filter(Boolean) });
  } catch (e) { next(e); }
});

router.post('/containers/:id/action', async (req, res, next) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid container id' });
    const action = String((req.body || {}).action || '');
    if (!['start', 'stop', 'restart', 'kill', 'pause', 'unpause'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }
    await docker.getContainer(req.params.id)[action]();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/containers/:id/logs', async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid container id' });
  const tail = Math.min(2000, Math.max(10, parseInt(req.query.tail, 10) || 200));
  const r = await run(`docker logs --tail ${tail} ${req.params.id} 2>&1`);
  res.json({ ok: r.ok, logs: r.stdout + r.stderr });
});

router.delete('/containers/:id', async (req, res, next) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid container id' });
    await docker.getContainer(req.params.id).remove({ force: true });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/images', async (_req, res, next) => {
  try {
    const list = await docker.listImages();
    res.json({
      images: list.map((i) => ({
        id: i.Id.replace(/^sha256:/, '').slice(0, 12),
        tags: i.RepoTags || ['<none>'],
        size: i.Size,
        shared: i.SharedSize || 0,
        containers: i.Containers === undefined ? null : i.Containers,
        created: i.Created
      }))
    });
  } catch (e) { next(e); }
});

router.delete('/images/:id', async (req, res, next) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid image id' });
    await docker.getImage(req.params.id).remove({ force: true });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Pull an image.
 *
 *  A pull is the one operation here that can take minutes, so it is run
 *  synchronously with a hard timeout and the daemon's own progress returned,
 *  rather than left as a job nothing ever collects. */
router.post('/pull', async (req, res, next) => {
  try {
    const image = String((req.body || {}).image || '').trim();
    if (!IMAGE_RE.test(image)) return res.status(400).json({ error: 'Invalid image name' });
    const r = await run(`docker pull ${image}`, { timeout: 600_000 });
    res.json({ ok: r.ok, output: (r.stdout + r.stderr).trim().slice(-8000) });
  } catch (e) { next(e); }
});

/** Reclaim space: stopped containers, dangling images, unused networks. */
router.post('/system/prune', async (req, res, next) => {
  try {
    const r = await docker.pruneContainers();
    const images = await docker.pruneImages();
    const networks = await docker.pruneNetworks();
    res.json({
      ok: true,
      containers: r.ContainersDeleted ? r.ContainersDeleted.length : 0,
      images: images.ImagesDeleted ? images.ImagesDeleted.length : 0,
      networks: networks.NetworksDeleted ? networks.NetworksDeleted.length : 0,
      reclaimed: (r.SpaceReclaimed || 0) + (images.SpaceReclaimed || 0)
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------- volumes / networks --- */
/* The two other things a CasaOS-style page shows next to the apps: what is
 * stored, and what the containers are attached to. Neither is derived from
 * the container listing - both are asked of the daemon directly. */
router.get('/volumes', async (_req, res, next) => {
  try {
    const [vols, df] = await Promise.all([docker.listVolumes(), docker.df()]);
    const usage = new Map((df.Volumes || []).map((v) => [v.Name, v.UsageData || {}]));
    res.json({
      volumes: (vols.Volumes || []).map((v) => ({
        name: v.Name,
        driver: v.Driver,
        mountpoint: v.Mountpoint,
        created: v.CreatedAt ? Date.parse(v.CreatedAt) : null,
        labels: Object.keys(v.Labels || {}),
        scope: v.Scope,
        size: Number((usage.get(v.Name) || {}).Size) || 0,
        refCount: Number((usage.get(v.Name) || {}).RefCount) || 0
      }))
    });
  } catch (e) { next(e); }
});

router.get('/networks', async (_req, res, next) => {
  try {
    const nets = await docker.listNetworks();
    res.json({
      networks: (nets || []).map((n) => ({
        id: (n.Id || '').slice(0, 12),
        name: n.Name,
        driver: n.Driver,
        scope: n.Scope,
        internal: !!n.Internal,
        attachable: !!n.Attachable,
        gateway: (((n.IPAM || {}).Config || [])[0] || {}).Subnet || null,
        /* How many containers hang off it - the one number that decides
         * whether a network is worth looking at. */
        containers: Object.keys(n.Containers || {}).length
      }))
    });
  } catch (e) { next(e); }
});

/* --------------------------------------------------------- terminal ----- */
/* A shell inside one container, as a single command and its output rather
 * than a socket: this panel already has a real web shell for the host, and
 * an interactive PTY is a stream nobody ever collects. The command is run
 * through the container's own `sh -c`, quoted whole, so nothing in it can
 * reach the host shell - and the container must be running. */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

router.post('/containers/:id/exec', async (req, res, next) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid container id' });
    const command = String((req.body || {}).command || '').trim();
    if (!command || command.length > 500 || !/^[\x20-\x7e]+$/.test(command)) {
      return res.status(400).json({ error: 'Invalid command' });
    }
    const info = await docker.getContainer(req.params.id).inspect();
    if (!info.State.Running) return res.status(400).json({ error: 'The container is not running' });
    const r = await run(`docker exec ${req.params.id} sh -c ${shq(command)}`, { timeout: 30_000 });
    res.json({
      ok: r.ok,
      code: r.code,
      output: (r.stdout + r.stderr).trim().slice(-20_000) || '(no output)'
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------- compose rendering ---- */
/* The "installer source" of an app, the way CasaOS shows it: a docker-compose
 * file you could paste somewhere else and get the same container back. Built
 * from the live inspect, and secret-looking environment values are masked on
 * the way out - this is a screen away from being pasted into a ticket. */
const yq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

router.get('/containers/:id/compose', async (req, res, next) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid container id' });
    const c = await docker.getContainer(req.params.id).inspect();
    const name = (c.Name || '').replace(/^\//, '');
    const host = c.HostConfig || {};
    const L = [];

    L.push('# Generated by letzControl from the running container.');
    L.push('# Paste this next to a docker-compose.yml to keep the same shape.');
    L.push('services:');
    L.push(`  ${name}:`);
    L.push(`    container_name: ${yq(name)}`);
    L.push(`    image: ${yq(c.Config.Image)}`);
    if ((c.Config.Cmd || []).length) L.push(`    command: ${(c.Config.Cmd || []).map(yq).join(' ')}`);
    if (c.Config.Entrypoint && c.Config.Entrypoint.length) {
      L.push(`    entrypoint: ${(c.Config.Entrypoint || []).map(yq).join(' ')}`);
    }
    const policy = (host.RestartPolicy || {}).Name || 'no';
    L.push(`    restart: ${policy}`);

    /* one "ports:" key, however many mappings there are */
    const portRows = Object.entries(host.PortBindings || {})
      .filter(([, binds]) => (binds || []).length);
    if (portRows.length) {
      L.push('    ports:');
      portRows.forEach(([container, binds]) => {
        (binds || []).forEach((b) => {
          const [cPort, proto] = container.split('/');
          L.push(`      - ${yq(`${b.HostPort || ''}:${cPort}/${proto || 'tcp'}`)}`);
        });
      });
    }

    const env = (c.Config.Env || []).map((line) => {
      const i = line.indexOf('=');
      const key = i < 0 ? line : line.slice(0, i);
      return i < 0 ? line : `${key}=${SECRETY.test(key) ? '••••••••' : line.slice(i + 1)}`;
    });
    if (env.length) {
      L.push('    environment:');
      env.forEach((e) => L.push(`      - ${yq(e)}`));
    }

    const bindsOut = (c.Mounts || [])
      .filter((m) => m.Type === 'bind' || m.Type === 'volume')
      .map((m) => (m.Type === 'bind'
        ? `${m.Source}:${m.Destination}${m.RW ? '' : ':ro'}`
        : `${m.Name}:${m.Destination}${m.RW ? '' : ':ro'}`));
    if (bindsOut.length) {
      L.push('    volumes:');
      bindsOut.forEach((v) => L.push(`      - ${yq(v)}`));
    }

    if (host.NetworkMode && host.NetworkMode !== 'default') L.push(`    network_mode: ${yq(host.NetworkMode)}`);
    if (host.Privileged) L.push('    privileged: true');
    if (host.Memory) L.push(`    mem_limit: ${yq(host.Memory)}`);
    if (host.CpuShares) L.push(`    cpu_shares: ${host.CpuShares}`);

    res.json({ ok: true, name, compose: L.join('\n') + '\n' });
  } catch (e) { next(e); }
});

/** Is this image already on the box?
 *
 *  Asked rather than assumed, because the answer decides whether starting a
 *  container needs a download first. A missing image is a plain 404 from the
 *  daemon, which is an ordinary state and not an error worth reporting - so
 *  the failure is swallowed and only the boolean kept. */
async function haveImage(image) {
  try { await docker.getImage(image).inspect(); return true; } catch { return false; }
}

/** Start a container from an image.
 *
 *  Every field is checked against what it is about to become: a bind mount is
 *  a path on this machine, so only absolute paths that stay put are accepted,
 *  and a name that is not a name is refused before it reaches the daemon. */
router.post('/containers', async (req, res, next) => {
  try {
    const b = req.body || {};
    const image = String(b.image || '').trim();
    const name = String(b.name || '').trim();
    if (!IMAGE_RE.test(image)) return res.status(400).json({ error: 'Invalid image name' });
    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid container name' });
    const existing = await docker.listContainers({ all: true });
    if (existing.some((c) => (c.Names || []).includes(`/${name}`))) {
      return res.status(400).json({ error: `A container called ${name} already exists` });
    }

    /* host:container[/proto] - the host side must be a port number, so a value
     * that looks like a path or a flag never gets near the command line. */
    const portBindings = {};
    for (const raw of String(b.ports || '').split(',')) {
      const p = raw.trim();
      if (!p) continue;
      const m = p.match(/^(\d{1,5})(?:-(\d{1,5}))?:([0-9]{1,5})(?:\/(tcp|udp))?$/);
      if (!m) return res.status(400).json({ error: `Invalid port mapping: ${p}` });
      const key = `${m[3]}/${m[4] || 'tcp'}`;
      (portBindings[key] = portBindings[key] || [])
        .push({ HostPort: m[2] ? `${m[1]}-${m[2]}` : m[1] });
    }

    /* /host/path:/container/path[:ro] - an absolute host path, or nothing.
     * Anything relative, or containing .., could be pointed anywhere. */
    const binds = [];
    for (const raw of String(b.volumes || '').split(',')) {
      const v = raw.trim();
      if (!v) continue;
      const parts = v.split(':');
      if (parts.length < 2 || parts.length > 3) {
        return res.status(400).json({ error: `Invalid volume: ${v}` });
      }
      const [host, dest, mode] = parts;
      if (!host.startsWith('/') || host.includes('..') || dest.includes('..')) {
        return res.status(400).json({ error: `Volume paths must be absolute: ${v}` });
      }
      if (mode && !/^(ro|rw|z|Z)(,(ro|rw|z|Z))*$/.test(mode)) {
        return res.status(400).json({ error: `Invalid volume mode: ${mode}` });
      }
      binds.push(v);
    }

    const env = [];
    for (const raw of String(b.env || '').split('\n')) {
      const e = raw.trim();
      if (!e) continue;
      const i = e.indexOf('=');
      if (i < 1 || !ENVKEY_RE.test(e.slice(0, i))) {
        return res.status(400).json({ error: `Invalid environment line: ${e}` });
      }
      env.push(e);
    }

    const restart = RESTARTS.includes(b.restart) ? b.restart : 'unless-stopped';

    /* An optional command to run instead of the image's own. It is handed to
     * the daemon as an argv array, never through a shell, so there is nothing
     * to quote or escape - but it must be text the daemon will accept. */
    let cmd;
    if (String(b.command || '').trim()) {
      cmd = String(b.command).trim().split(/\s+/);
      if (cmd.length > 256 || cmd.some((w) => !/^[\x20-\x7e]+$/.test(w))) {
        return res.status(400).json({ error: 'Invalid command' });
      }
    }

    /* Everything the caller can get wrong is checked before this point, so a
     * bad port or a bad volume is reported in milliseconds instead of after a
     * download that was never needed. The pull is last because it is the slow
     * one.
     *
     * It has to happen at all: the run form promises "the image is pulled if
     * it is not already here", and createContainer is answered by the daemon
     * with 404 "No such image" when the tag is not local. Nothing about the
     * container is wrong in that case, but the message talks only about
     * containers, so an install from the Store - where the images are by
     * definition not here yet - read as a failure nobody could act on. The
     * image name has already been matched against IMAGE_RE, so it is safe as
     * an argument here, exactly as it is in /pull. */
    if (!(await haveImage(image))) {
      const pulled = await run(`docker pull ${image}`, { timeout: 600_000 });
      if (!pulled.ok) {
        const why = (pulled.stdout + pulled.stderr).trim().slice(-400);
        return res.status(404).json({ error: `Could not pull ${image}: ${why}` });
      }
    }

    const container = await docker.createContainer({
      Image: image,
      name,
      Env: env,
      Cmd: cmd,
      HostConfig: {
        PortBindings: portBindings,
        Binds: binds,
        RestartPolicy: { Name: restart }
      }
    });
    await container.start();
    res.json({ ok: true, id: container.id.slice(0, 12), name });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------ linked websites -- */
/* Give an app a name instead of a port.
 *
 *  A published port is only reachable by typing an address and a number into a
 *  browser, which is not something anyone hands to somebody else. Linking a
 *  website puts nginx in front of it - the normal ports, a certificate, and a
 *  name that can be given out. The app becomes an ordinary site record, so it
 *  is rendered, renewed and deleted by the code that already does all of that
 *  for every other hostname on the box. */

/** Take a linked website away again: the vhost, then the record. */
async function unlinkSite(site, deleteFiles) {
  const p = nginxPaths(site);
  await fsp.rm(p.enabled, { force: true });
  await fsp.rm(p.avail, { force: true });
  db.remove('sites', site.id);
  const results = [];
  await reloadServers(['nginx'], results);
  /* Only ever our own directory, and only when asked: unlike a hosted site
   * this one never held anything, so it is removed by default from the panel's
   * unlink - but the flag exists so both ways in behave the same. */
  if (deleteFiles && site.docroot) await fsp.rm(site.docroot, { recursive: true, force: true });
  return results;
}

router.post('/containers/:id/link', async (req, res, next) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid container id' });
    const c = await docker.getContainer(req.params.id).inspect();
    const name = (c.Name || '').replace(/^\//, '');
    const body = req.body || {};

    const domain = String(body.domain || '').toLowerCase().trim();
    if (!DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'Invalid domain name' });

    /* The ports it publishes, taken from the daemon rather than from the page.
     * The answer becomes nginx config, and a port this container does not serve
     * would leave visitors looking at a blank page behind a hostname that looks
     * perfectly correct, which is a hard bug to see from the panel. */
    const ports = [...new Set(Object.values((c.NetworkSettings || {}).Ports || {})
      .flat()
      .map((h) => Number(h && h.HostPort))
      .filter((p) => Number.isInteger(p) && p > 0))];
    if (!ports.length) {
      return res.status(400).json({
        error: `${name} publishes no ports, so no website could reach it`
      });
    }
    const asked = Number(body.port);
    const explicit = body.port !== undefined && body.port !== '';
    if (explicit && !ports.includes(asked)) {
      return res.status(400).json({
        error: `${name} does not publish port ${asked}. It publishes ${ports.join(', ')}.`
      });
    }
    const port = ports.includes(asked) ? asked : ports[0];

    const already = linkFor(name);
    if (already && already.domain === domain) {
      /* Re-linking the same name is how the https choice gets changed, so this
       * is an edit rather than a no-op when it differs. */
      const wantHttps = body.forceHttps === true;
      if (!!already.forceHttps === wantHttps) {
        return res.json({ ok: true, site: already, url: linkUrl(already), results: [], unchanged: true });
      }
      db.update('sites', already.id, { forceHttps: wantHttps });
      const updated = db.get('sites', already.id);
      const results = [];
      try {
        await writeNginxVhost(updated);
        await reloadServers(['nginx'], results);
      } catch (e) {
        db.update('sites', already.id, { forceHttps: !wantHttps });
        return res.status(500).json({ error: `Could not rewrite the vhost: ${e.message}` });
      }
      return res.json({ ok: true, site: updated, url: linkUrl(updated), results });
    }
    if (already) {
      return res.status(409).json({ error: `${name} is already linked to ${already.domain}. Unlink it first.` });
    }
    if (db.findOne('sites', (s) => s.domain === domain)) {
      return res.status(409).json({ error: `The website ${domain} already exists.` });
    }
    const limit = checkLimit(req.user, 'sites');
    if (!limit.ok) return res.status(403).json({ error: limit.error });

    const docroot = path.join(config.sitesRoot, domain);
    try {
      await fsp.mkdir(path.join(docroot, 'public'), { recursive: true });
      await fsp.mkdir(path.join(docroot, 'logs'), { recursive: true });
    } catch (e) {
      return res.status(500).json({ error: `Could not create docroot: ${e.message}` });
    }

    const site = db.insert('sites', {
      domain,
      backend: 'docker',
      appPort: port,
      dockerName: name,
      phpVersion: null,
      www: true,
      docroot,
      ssl: false,
      /* Off unless asked for. A container that is not told the real scheme
       * writes http:// URLs into an https page and the browser blocks them,
       * so redirecting to https is only right for an app that understands
       * X-Forwarded-Proto - Portainer, Grafana, most purpose-built apps. */
      forceHttps: body.forceHttps === true,
      enabled: true,
      ownerId: req.user.id
    });

    /* Written, tested, and rolled back if nginx disagrees.
     *
     * A vhost that is wrong but left on disk is not a feature that does not
     * work, it is a server that refuses to start on the next reload or reboot
     * and takes every other site down with it. So the configuration is tested * before it is trusted, and if nginx refuses it the file and the record both
     * go away and the error is returned - rather than a link being reported as
     * working while nothing is listening for it. */
    const results = [];
    try {
      await writeNginxVhost(site);
      await reloadServers(['nginx'], results);
    } catch (e) {
      await unlinkSite(site, false);
      return res.status(500).json({ error: `Could not write the vhost: ${e.message}` });
    }
    const failed = results.find((r) => r.server === 'nginx' && !r.ok);
    if (failed) {
      await unlinkSite(site, false);
      return res.status(500).json({ error: `nginx rejected the configuration: ${failed.output}` });
    }

    res.status(201).json({ ok: true, site, results, ports, url: linkUrl(site) });
  } catch (e) { next(e); }
});

router.delete('/containers/:id/link', async (req, res, next) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid container id' });
    const c = await docker.getContainer(req.params.id).inspect();
    const name = (c.Name || '').replace(/^\//, '');
    const site = linkFor(name);
    if (!site) return res.status(404).json({ error: `${name} has no linked website` });
    const results = await unlinkSite(site, req.query.deleteFiles === 'true');
    res.json({ ok: true, results });
  } catch (e) { next(e); }
});

module.exports = { router };
