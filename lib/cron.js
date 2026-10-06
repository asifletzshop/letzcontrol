'use strict';
/**
 * Cron job manager: schedules stored in the root crontab, each line tagged
 * with `# letzcontrol:<id>` so panel-managed entries are recognisable and
 * any foreign crontab content is preserved untouched.
 *
 *   enabled:  0 2 * * * /usr/local/bin/task.sh # letzcontrol:ab12... my label
 *   disabled: # 0 2 * * * /usr/local/bin/task.sh # letzcontrol:ab12... my label
 */
const express = require('express');
const crypto = require('crypto');
const { run } = require('./exec');

const router = express.Router();

const MARK = ' # letzcontrol:';
const ID_RE = /^[0-9a-f]{16}$/;
const LABEL_RE = /[^A-Za-z0-9 _.\-]/g;
const TOKEN_RE = /^[A-Za-z0-9*,/\-]+$/;
const MACRO_RE = /^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)$/;
const CMD_MAX = 1000;

const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const adminOnly = (req, res, next) =>
  req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });

router.use(adminOnly);

/* ---------------- tools ---------------- */
let toolsChecked = false;
async function ensureTools() {
  if (toolsChecked) return true;
  const probe = await run('command -v crontab');
  if (!probe.ok) {
    await run('apt-get install -y cron', { timeout: 120_000 });
    await run('systemctl enable --now cron');
  }
  toolsChecked = (await run('command -v crontab')).ok;
  return toolsChecked;
}

/* ---------------- crontab io ---------------- */
async function readLines() {
  if (!(await ensureTools())) throw new Error('crontab is not available (the cron package is missing)');
  const r = await run('crontab -l');
  if (r.ok) return r.stdout.split('\n');
  if (/no crontab/i.test(r.stderr)) return [];
  throw new Error(r.error || 'crontab -l failed');
}

let writeChain = Promise.resolve();
function writeLines(lines) {
  const text = lines.join('\n').replace(/\n*$/, '\n');
  const task = writeChain.then(async () => {
    if (!text.trim()) {
      await run('crontab -r 2>/dev/null || true');
      return { ok: true };
    }
    const r = await run(`printf '%s' ${q(text)} | crontab -`);
    if (!r.ok) throw new Error(r.error || 'crontab write failed');
    return { ok: true };
  });
  writeChain = task.catch(() => {});
  return task;
}

/* ---------------- parsing ---------------- */
function parseLine(line) {
  let disabled = false;
  let body = line;
  if (/^#\s?/.test(line)) {
    disabled = true;
    body = line.replace(/^#\s?/, '');
  }
  const idx = body.lastIndexOf(MARK);
  if (idx === -1) return null;
  const head = body.slice(0, idx).trim();
  const tail = body.slice(idx + MARK.length).trim();
  const m = /^([0-9a-f]{16})(?:\s+(.*))?$/.exec(tail);
  if (!m || !head) return null;
  const sp = head.split(/\s+/);
  let schedule, command;
  if (sp[0].startsWith('@')) {
    schedule = sp[0];
    command = sp.slice(1).join(' ');
  } else if (sp.length >= 6) {
    schedule = sp.slice(0, 5).join(' ');
    command = sp.slice(5).join(' ');
  } else {
    return null;
  }
  return { id: m[1], schedule, command, label: (m[2] || '').trim(), enabled: !disabled };
}

function validate({ schedule, command, label }) {
  const sch = String(schedule || '').trim().replace(/\s+/g, ' ');
  const cmd = String(command || '').trim();
  const lab = String(label || '').replace(LABEL_RE, '').slice(0, 60).trim();

  if (!cmd) return { error: 'Command is required' };
  if (cmd.length > CMD_MAX) return { error: `Command too long (max ${CMD_MAX})` };
  if (/[\r\n]/.test(cmd)) return { error: 'Command must be a single line' };

  if (sch.startsWith('@')) {
    if (!MACRO_RE.test(sch)) return { error: 'Unknown schedule macro (use @reboot, @daily, @hourly, @weekly, @monthly, @yearly)' };
  } else {
    const sp = sch.split(' ');
    if (sp.length !== 5) return { error: 'Schedule must have 5 fields (minute hour day month weekday) or an @macro' };
    for (const f of sp) {
      if (!TOKEN_RE.test(f)) return { error: `Invalid schedule field: ${f}` };
      if (f.length > 40) return { error: 'Schedule field too long' };
    }
  }
  /* the marker + id must stay the last thing on the line */
  if (cmd.includes(MARK)) return { error: 'Command contains a reserved marker' };
  return { schedule: sch, command: cmd, label: lab };
}

function buildLine(job) {
  const lab = job.label ? ` ${job.label}` : '';
  const line = `${job.schedule} ${job.command}${MARK}${job.id}${lab}`;
  return job.enabled === false ? `# ${line}` : line;
}

/* ---------------- routes ---------------- */
router.get('/', async (_req, res, next) => {
  try {
    await ensureTools();
    const jobs = (await readLines()).map(parseLine).filter(Boolean);
    res.json({ jobs });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const v = validate(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const job = { id: crypto.randomBytes(8).toString('hex'), ...v, enabled: true };
    const lines = await readLines();
    lines.push(buildLine(job));
    await writeLines(lines);
    res.json({ job });
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'Bad id' });
    const v = validate(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const lines = await readLines();
    let found = false;
    const out = lines.map((l) => {
      const p = parseLine(l);
      if (!p || p.id !== id) return l;
      found = true;
      return buildLine({ ...p, ...v });
    });
    if (!found) return res.status(404).json({ error: 'Job not found' });
    await writeLines(out);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/:id/toggle', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'Bad id' });
    const lines = await readLines();
    let found = false;
    const out = lines.map((l) => {
      const p = parseLine(l);
      if (!p || p.id !== id) return l;
      found = true;
      p.enabled = !p.enabled;
      return buildLine(p);
    });
    if (!found) return res.status(404).json({ error: 'Job not found' });
    await writeLines(out);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'Bad id' });
    const lines = await readLines();
    const out = lines.filter((l) => {
      const p = parseLine(l);
      return !p || p.id !== id;
    });
    if (out.length === lines.length) return res.status(404).json({ error: 'Job not found' });
    await writeLines(out);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = { router };
