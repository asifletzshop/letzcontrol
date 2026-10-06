'use strict';
/** Promisified shell execution with sane limits. Never rejects. */
const { exec } = require('child_process');

function run(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : 0,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
        error: err ? (stderr || err.message).toString().trim() : ''
      });
    });
  });
}

module.exports = { run };
