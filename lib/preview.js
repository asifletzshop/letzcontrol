'use strict';
/**
 * Website previews.
 *
 * The Websites view used to be a table: domain, backend, PHP, SSL, status,
 * actions. A site is a live thing with a homepage, and a table says nothing
 * about what it looks like - so the page is now a grid of cards, each with a
 * real screenshot of the site taken a moment ago.
 *
 * Chrome is installed by the Setup Wizard when it is present, so the panel
 * can take a headless screenshot of each site in ~1 second. The result is
 * cached and only re-taken when the operator asks - a dashboard reload
 * would otherwise fire one browser per site per refresh, and a customer
 * would not be able to use refreshes to pin the server.
 *
 * The screenshot goes through the site's own vhost (Chrome resolves the
 * domain to 127.0.0.1), so it shows exactly what a visitor would get -
 * including a 502 if the backend is down, which is the most useful thing a
 * preview can show.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('../config');
const { run } = require('./exec');
const db = require('./db');

const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/chrome',
  '/opt/google/chrome/chrome'
];
const PREVIEW_DIR = path.join(config.dataDir, 'previews');
const PREVIEW_TTL = 24 * 60 * 60 * 1000; // 24 hours
const PREVIEW_MAX = 8 * 1024 * 1024;
const SHOT_TIMEOUT = 20_000;

let chromePath = null;
function chrome() {
  if (chromePath === null) {
    chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p)) || null;
  }
  return chromePath;
}

/* Where a site is reachable from inside the panel's own process.
 *
 * The URL the visitor would use, but with the domain resolved to localhost:
 * the site's own vhost is what has to be photographed, and that lives on
 * this box. It also means the preview works for a site whose DNS does not
 * point here yet - which is most of them, right after they are created. */
function targetFor(site) {
  if (site.enabled === false) return null;
  const scheme = site.ssl ? 'https' : 'http';
  const port = site.ssl ? 443 : 80;
  return {
    url: `${scheme}://${site.domain}/`,
    port,
    host: site.domain
  };
}

/* Take one screenshot. Returns a buffer, or null on any failure. */
async function screenshot(site) {
  const c = chrome();
  if (!c) return null;
  const target = targetFor(site);
  if (!target) return null;
  const tmp = path.join('/tmp', `letz-prev-${process.pid}-${Date.now()}.png`);
  /* --host-resolver-rules sends the domain to this box, so the picture is
   * the site's own vhost and not whatever the public DNS happens to point
   * at. --ignore-certificate-errors is needed because the panel's own
   * certificates are issued for the domain, and a preview must not fail
   * over a certificate the panel itself installed. */
  const cmd = [
    `'${c}' --headless --disable-gpu --no-sandbox --disable-dev-shm-usage --disable-web-security --allow-insecure-localhost`,
    '--hide-scrollbars --ignore-certificate-errors --disable-features=VizDisplayCompositor --disable-web-security --allow-insecure-localhost',
    '--virtual-time-budget=60000 --timeout=120000 --run-all-compositor-stages-before-draw',
    `--host-resolver-rules='MAP ${target.host} 127.0.0.1:${target.port}'`,
    '--window-size=1280,720',
    `--screenshot='${tmp}'`,
    `'${target.url}'`
  ].join(' ');
  const r = await run(cmd, { timeout: SHOT_TIMEOUT });
  if (!r.ok) { try { fs.rmSync(tmp, { force: true }); } catch { /* */ } return null; }
  let buf;
  try { buf = fs.readFileSync(tmp); } catch (e) { return null; }
  try { fs.rmSync(tmp, { force: true }); } catch { /* */ }
  if (!buf.length || buf.length > PREVIEW_MAX) return null;
  if (buf.slice(0, 4).toString('binary') !== '\x89PNG') return null;
  return buf;
}

async function save(domain, buf) {
  try {
    await fsp.mkdir(PREVIEW_DIR, { recursive: true });
    const file = path.join(PREVIEW_DIR, `${domain}.png`);
    await fsp.writeFile(file, buf);
    return file;
  } catch (e) { return null; }
}

function read(domain) {
  const file = path.join(PREVIEW_DIR, `${domain}.png`);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs > PREVIEW_TTL) return null;
    return file;
  } catch (e) { return null; }
}

function isFresh(domain) {
  return !!read(domain);
}

/* One site at a time: a browser per site per refresh is what this is avoiding,
 * and firing them all at once on a busy box overruns the timeout. */
async function takeAll(sites, onProgress) {
  const out = {};
  for (let i = 0; i < sites.length; i += 1) {
    const site = sites[i];
    try {
      const buf = await screenshot(site);
      if (buf) {
        const file = await save(site.domain, buf);
        out[site.domain] = { ok: !!file, file };
      } else {
        out[site.domain] = { ok: false };
      }
    } catch (e) { out[site.domain] = { ok: false }; }
    if (onProgress) onProgress(i + 1, sites.length, site.domain);
  }
  return out;
}

/* Install a headless browser so the Websites view can show real screenshots.
 *
 * Ubuntu only ships Chromium as a snap, and a snap is not something a
 * hosting panel should put on a customer's VPS (it needs snapd, it mounts
 * its own filesystem, and it is awkward inside containers). Google's own
 * .deb package is a normal system package, so that is what gets installed.
 *
 * Only the browser and its dependencies - no extra repositories are added
 * and nothing else on the box is touched.
 */
async function installBrowser(log) {
  const say = (m) => { if (log) log(m); };
  const c = chrome();
  if (c) return { ok: true, browser: path.basename(c), already: true };

  const deb = '/tmp/letz-google-chrome.deb';
  say('Downloading Google Chrome...');
  const dl = await run(
    `curl -fsSL --retry 2 --max-time 300 -o '${deb}' ` +
    'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb',
    { timeout: 360_000 }
  );
  if (!dl.ok) {
    return { ok: false, error: `could not download Chrome: ${(dl.stdout + dl.stderr).trim() || dl.error}` };
  }
  say('Installing Chrome and its dependencies...');
  const ins = await run(
    `DEBIAN_FRONTEND=noninteractive apt-get install -y -qq '${deb}'`,
    { timeout: 900_000 }
  );
  try { fs.rmSync(deb, { force: true }); } catch { /* */ }
  if (!ins.ok) {
    return { ok: false, error: `could not install Chrome: ${(ins.stdout + ins.stderr).trim() || ins.error}` };
  }
  /* Re-detect: the cached value is still null. */
  chromePath = null;
  const now = chrome();
  if (!now) return { ok: false, error: 'Chrome was installed but could not be found' };
  say(`Chrome installed (${path.basename(now)}).`);
  return { ok: true, browser: path.basename(now), already: false };
}

module.exports = {
  chrome,
  targetFor,
  isFresh,
  read,
  takeAll,
  screenshot,
  installBrowser
};