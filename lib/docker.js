'use strict';
/** Docker manager via dockerode (containers, images, logs, disk).
 *
 *  Admin-only, and every value that reaches the daemon is checked first: this
 *  process runs as root, so a container name or a bind path taken on trust is
 *  a root shell for whoever can reach the page. */
const express = require('express');
const { run } = require('./exec');
const { requireAdmin } = require('./auth');

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

router.get('/containers', async (_req, res, next) => {
  try {
    const list = await docker.listContainers({ all: true });
    res.json({ containers: list.map(containerRow) });
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

module.exports = { router };
