'use strict';
/* A single, explicit job state machine used by every long-running panel task:
 * the Setup Wizard, in-place Updates, Node app installs, and Addons.
 *
 * Previously each module had its own ad-hoc `let job = null` with inline
 * transitions scattered across start/success/failure paths. Now there is one
 * machine with explicit states and transitions.
 *
 * States (all explicit fields on the object):
 *   null              - no job has ever run (job === null)
 *   running           - job.running === true,  job.ok === null
 *   finished (ok)     - job.running === false, job.ok === true
 *   finished (error)  - job.running === false, job.ok === false, job.error set
 *
 * Transitions (all go through Job methods, never set inline):
 *   start()   -> running
 *   finish()  -> finished (ok or error), running=false, finishedAt set
 *
 * The log is capped so a long-running job cannot grow memory without bound.
 */
const MAX_LOG = 300_000;

class Job {
  constructor(opts = {}) {
    this.running = true;
    this.ok = null;
    this.error = '';
    this.log = '';
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.current = '';
    this.total = 0;
    this.done = 0;
    this.domain = '';
    Object.assign(this, opts);
  }

  /** What the API exposes - safe to JSON-serialize to the frontend. */
  public() {
    if (!this) return { running: false, log: '' };
    return {
      running: this.running,
      ok: this.ok,
      error: this.error || '',
      log: this.log,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      current: this.current || '',
      total: this.total,
      done: this.done,
      domain: this.domain || ''
    };
  }

  append(text) {
    if (!this) return;
    const chunk = text.endsWith('\n') ? text : `${text}\n`;
    this.log = (this.log + chunk).slice(-MAX_LOG);
  }

  /** Explicit terminal transition. Call once at the end of every job path. */
  finish({ ok, error } = {}) {
    this.running = false;
    this.ok = ok === true;
    this.error = error || '';
    this.finishedAt = Date.now();
    this.current = this.ok ? 'finished' : (error ? 'finished with errors' : 'finished');
  }
}

/** Guard for routes that start a job: returns {status, error} when one is
 * already running, otherwise null so the caller proceeds. */
function guard(job) {
  if (job && job.running) return { status: 409, error: 'A job is already running' };
  return null;
}

/** Spawn a command, appending its output to the job log. Resolves with the
 * exit code (0 = success). Never throws - spawn errors are logged and resolved
 * as code 1 so the caller decides whether to fail. */
function stream(job, cmd, cwd, opts = {}) {
  if (!job) throw new Error('no job');
  const { spawn } = require('child_process');
  job.append(`$ ${cmd}\n`);
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      cwd,
      env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
      ...opts
    });
    child.stdout.on('data', (d) => job.append(d.toString()));
    child.stderr.on('data', (d) => job.append(d.toString()));
    child.on('close', (code) => {
      if (code !== 0) job.append(`[exit ${code}]\n`);
      resolve(code);
    });
    child.on('error', (e) => {
      job.append(`[could not run: ${e.message}]\n`);
      resolve(1);
    });
  });
}

module.exports = { Job, MAX_LOG, guard, stream };
