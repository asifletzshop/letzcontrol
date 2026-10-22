'use strict';
/**
 * The webmail mount a site gets under its own domain
 * (https://<site>/webmail/) is written by lib/sites.js, and it is the path
 * every customer actually uses to read their mail - so a change to it is
 * discovered by a customer rather than by a test.
 *
 * The line that matters is the proxy target. The webmail port only answers
 * https (nginx cannot serve both protocols from one port), so a plain-HTTP
 * proxy_pass here comes back as 400 "the plain HTTP request was sent to
 * HTTPS port" on every site at once. That is exactly what happened, so it is
 * pinned here.
 *
 * Run with: npm test
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config');
const sites = require('../lib/sites');

/** Render one site's nginx vhost into a scratch directory and return it. */
async function render(site) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letzvhost-'));
  const saved = { ...config.nginx };
  config.nginx = { ...config.nginx, confDir: dir };
  try {
    await sites.writeNginxVhost(site);
    return fs.readFileSync(path.join(dir, 'sites-available', `${site.domain}.conf`), 'utf8');
  } finally {
    config.nginx = saved;
  }
}

const phpSite = (over = {}) => ({
  domain: 'example.com', backend: 'nginx', phpVersion: '8.3',
  webmail: true, ssl: true, port: 3001, status: 'active', ...over
});

test('the mount proxies to the webmail port over https', async () => {
  const text = await render(phpSite());
  assert.match(text, /location \/webmail\/ \{/);
  assert.match(text, /proxy_pass https:\/\/127\.0\.0\.1:2088\//,
    'the webmail port speaks https only, so the proxy must too');
  assert.doesNotMatch(text, /proxy_pass http:\/\/127\.0\.0\.1:2088\//);
});

test('the bare /webmail redirects to the trailing-slash form', async () => {
  const text = await render(phpSite());
  assert.match(text, /location = \/webmail \{ return 301 \/webmail\/; \}/);
});

test('the mount carries the allow-list while the webmail is not public', async () => {
  const saved = config.webmailPublic;
  config.webmailPublic = false;
  try {
    const text = await render(phpSite());
    const mount = text.slice(text.indexOf('location /webmail/'));
    assert.match(mount, /include snippets\/admins-allow\.conf;/);
  } finally {
    config.webmailPublic = saved;
  }
});

test('no mount at all when the site has no webmail', async () => {
  const text = await render(phpSite({ webmail: false }));
  assert.doesNotMatch(text, /location \/webmail\//);
});
