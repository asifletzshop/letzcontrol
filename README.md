# letzControl

A lightweight VPS & hosting control panel, built with Node.js. It manages
websites, DNS, mail, databases, PHP, Docker, cron jobs, users and more from a
single self-hosted dashboard — no cloud account required.

## Features

- 🌐 **Websites** — card grid with real previews, PHP version per site,
  visual php.ini editor, one-click SSL (Let's Encrypt), enable/disable, DNS
  zone auto-creation with mail records
- 🛰️ **DNS** — BIND9 zone management, auto-created zones and mail records
  when a site is created
- 📧 **Mail** — Postfix + Dovecot + OpenDKIM, mailboxes, webmail (Roundcube),
  SPF/DKIM/DMARC hints, queue management
- 🗄️ **Databases** — MariaDB/MySQL databases + phpMyAdmin
- 🐘 **PHP** — multiple versions (FPM/OpenLiteSpeed), per-site php.ini editor
- 🐳 **Docker** — container management from the panel
- ⏰ **Cron** — scheduled jobs
- 👥 **Users & Plans** — reseller-style plans with limits (sites, domains,
  mailboxes, disk, traffic, FTP, WordPress…)
- 🔧 **Settings** — panel port/domain/TLS, system time, NTP, backups
- ⬆️ **Updates** — one-click self-update straight from GitHub

## Requirements

- **Linux** (Ubuntu 22.04 recommended) with root access
- **Node.js 18+** and npm
- `curl` and `bash`

## Install

One line, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/asifletzshop/letzcontrol/main/install.sh | bash
```

This installs the panel into `/opt/letzcontrol` and registers it as a systemd
service. Everything else (Nginx, Apache, OpenLiteSpeed, PHP, MariaDB, Docker,
mail) is installed by the panel's own **Setup Wizard**, which detects what is
already present and installs only what is missing.

### Options

```bash
bash install.sh --dir /srv/panel --port 8080   # custom location / port
bash install.sh --no-service                    # no systemd (e.g. containers)
GITHUB_REPO=myuser/letzcontrol bash install.sh  # install a fork
```

Environment variables: `PANEL_VERSION`, `INSTALL_DIR`, `PANEL_PORT`,
`GITHUB_REPO`, `REPO_URL`, `TARBALL_URL`. See `install.sh --help`.

### Re-running

The installer is **safe to re-run**: an existing installation is upgraded in
place, and the database, config and credentials are preserved.

## First login

Open `http://<server>:2087` and log in with the admin credentials printed at
the end of the install. Run the **Setup Wizard** to install the hosting stack
(Nginx/PHP/MariaDB/mail), then start creating sites.

## Development

```bash
git clone git@github.com:asifletzshop/letzcontrol.git
cd letzcontrol
npm install
npm start          # runs server.js on port 2087
```

Tests:

```bash
npm test
```

## Structure

```
server.js            entry point + HTTP/API wiring
config.js            configuration (ports, paths, defaults)
lib/                 API modules (sites, dns, mail, databases, php, …)
public/              frontend (JS views + CSS)
views/               server-rendered shell pages
scripts/             bump-version and other tooling
install.sh           one-line installer
letzcontrol.service  systemd unit template
test/                automated tests
```

## License

MIT — see [LICENSE](LICENSE).
