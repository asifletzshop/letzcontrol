'use strict';
/** Docker manager via dockerode (containers, images, logs). */
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

router.use(async (_req, res, next) => {
  if (!docker) return res.status(503).json({ error: 'Docker integration unavailable on this server' });
  try {
    await docker.ping();
    next();
  } catch {
    res.status(503).json({ error: 'Docker is not installed or the socket is not accessible' });
  }
});

router.get('/info', async (_req, res, next) => {
  try {
    const info = await docker.info();
    res.json({
      info: {
        version: info.ServerVersion,
        containers: info.Containers,
        containersRunning: info.ContainersRunning,
        images: info.Images,
        driver: info.Driver,
        os: info.OperatingSystem
      }
    });
  } catch (e) { next(e); }
});

router.get('/containers', async (_req, res, next) => {
  try {
    const list = await docker.listContainers({ all: true });
    res.json({
      containers: list.map((c) => ({
        id: c.Id.slice(0, 12),
        name: (c.Names[0] || '').replace(/^\//, ''),
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports: (c.Ports || [])
          .filter((p) => p.PublicPort)
          .map((p) => `${p.PublicPort}->${p.PrivatePort}/${p.Type}`)
          .join(', '),
        created: c.Created
      }))
    });
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

module.exports = { router };
