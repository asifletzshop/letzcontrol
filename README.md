# ⚡ letzControl

A lightweight VPS & web-hosting control panel built with Node.js + Express.

![stack](https://img.shields.io/badge/node-%3E%3D18-339933) ![license](https://img.shields.io/badge/license-MIT-blue)

## Features

| Module | What it does |
|---|---|
| 📊 Dashboard | Live CPU / RAM / disk / network stats with charts (Socket.IO push) |
| 🌐 Websites | Virtual hosts on **Nginx, Apache and OpenLiteSpeed — all running at the same time**, per-site PHP version, one-click Let's Encrypt SSL |
| 🗄️ Databases | Create/drop MySQL/MariaDB databases + users (cPanel-style `user_` prefixes) |
| 🐘 PHP | Detects all installed PHP-FPM versions, view extensions, restart FPM, switch default CLI |
| 🐳 Docker | Containers & images: start/stop/restart/logs/remove |
| ⚙️ Services | Full systemd service control |
| 📁 Files | Browser-based file manager with editor & uploads |
| 💻 Terminal | Full web terminal (xterm.js + node-pty) |
| 👥 Users & Plans | Hosting users with plans limiting websites/databases |

## Web server architecture (all three at once)

```
            ┌────────────────────────────────────────────┐
Internet →  │ Nginx  :80/:443   (front-end + SSL)        │
            └───────┬───────────────────────┬────────────┘
                    │ direct (nginx sites)  │ proxy_pass
                    ▼                       ▼
              docroot files        Apache :8080  ·  OpenLiteSpeed :8088
```

Every website picks **one** backend:

- `nginx` → Nginx serves it directly (PHP via php-fpm socket)
- `apache` → Apache vhost on port **8080**, Nginx proxies 80/443 → 8080
- `openlitespeed` → OLS vhost on port **8088**, Nginx proxies 80/443 → 8088

OpenLiteSpeed virtual hosts are generated into `$SERVER_ROOT/conf/letzcontrol-vhosts.conf`
(single include file) + `conf/vhosts/<domain>/vhconf.conf`.

## 🧩 Setup Wizard (admin)

After logging in, open **Setup Wizard** in the sidebar. It detects what is already
installed and one-click installs the rest with live output:

Nginx → Apache (auto-moved to port 8080) → PHP 8.3-FPM → MariaDB (panel DB
access configured automatically via unix socket) → Certbot → OpenLiteSpeed
(port 8088) → Docker.

## Requirements

- Debian/Ubuntu VPS (systemd-based)
- Node.js ≥ 18
- **root** (the panel manages system services, vhosts and MySQL)
- Optional, per feature: `nginx`, `apache2`, `openlitespeed`, `phpX.Y-fpm`, `mysql-server`/`mariadb-server`, `docker`, `certbot`

## Installation (one line)

```bash
curl -fsSL https://raw.githubusercontent.com/asif-letz/letzcontrol/main/install.sh | sudo bash
```

Installing a fork instead:

```bash
curl -fsSL https://raw.githubusercontent.com/myuser/letzcontrol/main/install.sh | sudo bash
```

That is the whole thing. The installer:

- checks for Ubuntu/Debian + systemd and refuses to run without root
- installs **Node.js 22** if it is missing (Nodesource), and verifies `>= 18`
- installs `build-essential` + `python3` so the web terminal works
- downloads the panel to `/opt/letzcontrol` and runs `npm ci --omit=dev`
- creates and starts a **systemd** service that survives reboots
- opens the port in **ufw** / **firewalld** if a firewall is active
- prints the generated admin password at the end

Then open `http://your-server-ip:2087`.

**Re-running the same command is an upgrade** — it backs up `data/` and
`config.json` to `/root/letzcontrol-backup-<timestamp>/`, stops the service,
replaces the code, reinstalls dependencies and restarts. Your sites, mailboxes,
databases, users and the admin password are all preserved.

### Options

```bash
sudo bash install.sh --dir /srv/panel     # different install directory
sudo bash install.sh --port 8080          # different panel port
sudo bash install.sh --no-service         # no systemd (containers, chroots)
bash install.sh --help                    # full help
```

| Variable | Default | Meaning |
|---|---|---|
| `PANEL_VERSION` | `latest` | git tag/branch to install |
| `INSTALL_DIR` | `/opt/letzcontrol` | where the panel lives |
| `PANEL_PORT` | `2087` | panel listen port |
| `REPO_URL` / `TARBALL_URL` | the GitHub repo | change to install a fork |

Installing from a local checkout (no GitHub yet):

```bash
tar czf /tmp/letzcontrol.tar.gz --exclude=node_modules --exclude=data .
TARBALL_URL=file:///tmp/letzcontrol.tar.gz sudo bash install.sh
```

### Manual installation

<details>
<summary>If you prefer to do it by hand</summary>

```bash
cd /opt/letzcontrol
apt update && apt install -y build-essential python3
npm install --omit=dev
node server.js
```

On first start `config.json` is created and an **admin account with a random
password** is printed to the console and saved to
`data/ADMIN_CREDENTIALS.txt`. Log in and change it immediately.

To run it as a service:

```bash
cp letzcontrol.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now letzcontrol
```

</details>

### Put the panel itself behind Nginx (optional, recommended)

<details>
<summary>Reverse proxy + TLS</summary>

```nginx
server {
    listen 443 ssl;
    server_name panel.example.com;
    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:2087;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # needed for terminal/stats websockets
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

Then set `"host": "127.0.0.1"` in `config.json` so the panel is not exposed
directly on 2087.

</details>

## Configuration (`config.json`)

| Key | Default | Meaning |
|---|---|---|
| `port` / `host` | `2087` / `0.0.0.0` | Panel bind address (also editable in **Settings → Panel configuration**) |
| `sitesRoot` | `/var/www` | Docroots: `<sitesRoot>/<domain>/public` |
| `ports.apache` / `ports.openlitespeed` | `8080` / `8088` | Backend ports so all servers coexist |
| `mysql.*` | root@127.0.0.1 | Root DB credentials for the database manager |
| `certbotEmail` | `""` | Let's Encrypt contact email |
| `fileManagerRoots` | `["/"]` | Paths the file manager may access |

## Security notes ⚠️

- The panel **runs as root** and the web terminal gives a root shell. Protect it:
  use a strong admin password, keep the panel behind Nginx with SSL, and/or
  restrict access by IP or VPN.
- All API endpoints require an authenticated session; login is rate-limited
  (5 failures → 60 s lockout). Session cookies are `HttpOnly; SameSite=Lax`.
- Users with the `user` role only see/manage their own websites and databases
  and are capped by their plan.

## Development

```bash
npm install
npm run dev        # auto-reload
```

Project layout:

```
server.js            entry point
config.js/.json      configuration
lib/                 backend modules (auth, sites, databases, php, docker,
                     services, files, terminal, stats, users, db)
views/index.html     app shell (served only when authenticated)
public/              static assets (login page, css, js views)
data/                JSON database + admin credentials file (gitignored)
```

## License

MIT
