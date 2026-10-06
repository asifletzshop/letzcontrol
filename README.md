# ⚡ letzControl

**A self-hosted VPS & web-hosting control panel for Debian/Ubuntu.**

Run **Nginx, Apache and OpenLiteSpeed at the same time**, and manage websites,
SSL, databases, PHP, mail, DNS, Docker, cron, files and hosting users from one
dashboard. Installs with a single command.

[![node](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Debian%2FUbuntu-lightgrey)](https://www.debian.org)
[![stars](https://img.shields.io/github/stars/asifletzshop/letzcontrol?style=social)](https://github.com/asifletzshop/letzcontrol/stargazers)

---

## 🚀 Install

```bash
curl -fsSL https://raw.githubusercontent.com/asifletzshop/letzcontrol/main/install.sh | sudo bash
```

That is the whole install. It detects your OS, installs Node.js if needed, sets
up a systemd service, opens the firewall port and prints your admin password.

Then open **`http://your-server-ip:2087`** and log in.

<details>
<summary>Installing a fork, a custom path or port</summary>

```bash
# a fork
GITHUB_REPO=myuser/letzcontrol bash install.sh

# custom location / port / no systemd (containers)
sudo bash install.sh --dir /srv/panel
sudo bash install.sh --port 8080
sudo bash install.sh --no-service

bash install.sh --help      # all options
```

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_REPO` | `asifletzshop/letzcontrol` | repo to install from |
| `PANEL_VERSION` | `latest` | tag or branch |
| `INSTALL_DIR` | `/opt/letzcontrol` | where the panel lives |
| `PANEL_PORT` | `2087` | panel listen port |

</details>

<details>
<summary>Manual installation</summary>

```bash
git clone https://github.com/asifletzshop/letzcontrol.git /opt/letzcontrol
cd /opt/letzcontrol
apt update && apt install -y build-essential python3
npm install --omit=dev
node server.js
```

On first start, `config.json` is created and an **admin account with a random
password** is printed to the terminal and saved to `data/ADMIN_CREDENTIALS.txt`.
To run it as a service:

```bash
cp letzcontrol.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now letzcontrol
```

</details>

### Upgrading

Re-run the install command. It backs up `data/` and `config.json` to
`/root/letzcontrol-backup-<timestamp>/`, replaces the code and restarts.
Your sites, mailboxes, databases, users and admin password are preserved.

---

## ✨ Features

| | Module | What it does |
|---|---|---|
| 📊 | **Dashboard** | Live CPU / RAM / disk / network via WebSocket push, key-service status |
| 🌐 | **Websites** | Virtual hosts on Nginx, Apache **and** OpenLiteSpeed simultaneously · per-site PHP version · free Let's Encrypt SSL · WordPress/npm/proxy backends |
| 🛰️ | **DNS** | Zones, A/AAAA/MX/TXT/CNAME records, DKIM hints, mail DNS presets |
| 🧭 | **WordPress** | Install, versions, plugins/themes, one-click admin, database browser |
| 📧 | **Mail** | Mailboxes with per-mailbox webmail links, self-service password change in Roundcube, DKIM, DNS records |
| 🗄️ | **Databases** | Create/drop MySQL/MariaDB databases and users, phpMyAdmin, import & download |
| 🐘 | **PHP** | All installed PHP-FPM versions, extensions, restart, default CLI switch |
| ⚙️ | **Services** | Full systemd control, curates the ~170 units down to the 15 that matter |
| 🖥️ | **Servers** | Per-server configure / tweak / enable / disable for Nginx, Apache, OpenLiteSpeed |
| 📁 | **Files** | Browser file manager, inline editor, **uploads with live per-file progress, speed and ETA** |
| 🐳 | **Docker** | Containers and images: start, stop, logs, remove |
| ⏰ | **Cron** | Visual crontab editor plus WordPress cron events |
| 🧱 | **Addons** | Redis, Varnish, webmail, mail, antivirus, certbot, Docker, cron, Node.js, Perl, FTP, phpMyAdmin, BIND9 |
| 💻 | **Terminal** | Full web terminal (xterm.js + node-pty) |
| 👥 | **Users & Plans** | Hosting users with plan limits on sites/databases |
| 🔧 | **Settings** | Panel domain + SSL, panel port, server timezone, panel config, data backup/restore, active sessions, system info |
| 🧩 | **Setup Wizard** | Detects what is installed and one-click installs the rest |

---

## 🏗️ How the web servers fit together

```
              ┌──────────────────────────────────────────────┐
  Internet →  │  Nginx   :80 / :443     (front-end + SSL)     │
              └───────┬────────────────────────┬─────────────┘
                      │ direct                 │ proxy_pass
                      ▼                        ▼
                docroot files        Apache :8080 · OpenLiteSpeed :8088
```

Each website picks **one** backend:

- `nginx` — Nginx serves it directly, PHP via the `phpX.Y-fpm` socket
- `apache` — Apache vhost on **:8080**, Nginx proxies 80/443 → 8080
- `openlitespeed` — OLS vhost on **:8088**, Nginx proxies 80/443 → 8088
- `node` — for an app the panel only fronts (proxy to its own port)

Because the backends live on their own ports, **all three can run at the same
time** without fighting over 80/443.

---

## 🧩 Setup Wizard

After logging in, open **Setup Wizard**. It detects what is already present and
installs only what is missing, with live output:

`nginx → apache → php → mariadb → certbot → bind9 → openlitespeed → docker → nodejs → redis → mail → webmail → phpmyadmin`

---

## 📋 Requirements

- **Debian or Ubuntu**, systemd-based
- **root** — the panel manages services, vhosts and databases
- Everything else is installed by the wizard: `nginx`, `apache2`,
  `openlitespeed`, `phpX.Y-fpm`, `mariadb-server`, `certbot`, `docker`,
  `redis`, `bind9`, mail stack
- Node.js ≥ 18 is required; the installer adds it if missing

---

## ⚙️ Configuration

`config.json` is created on first run (see `config.example.json`). Most values
can also be changed from **Settings → Panel configuration** without editing
files.

| Key | Default | Meaning |
|---|---|---|
| `port` / `host` | `2087` / `0.0.0.0` | Panel bind address — change it in Settings, not here |
| `sitesRoot` | `/var/www` | Docroots: `<sitesRoot>/<domain>/public` |
| `ports.apache` / `ports.openlitespeed` | `8080` / `8088` | Backend ports so all servers coexist |
| `mysql.*` | root @ `127.0.0.1` | Root DB credentials for the database manager |
| `certbotEmail` | `""` | Let's Encrypt contact address |
| `fileManagerRoots` | `["/"]` | Paths the file manager may browse |
| `sessionSecret` | auto-generated | Signs session cookies — never commit it |

---

## 🔗 Panel address, port and clock

Three settings that change how the panel itself is reached.

### Panel domain

**Settings → Panel domain** points a real hostname at the panel. The panel
writes an Nginx vhost (`/etc/nginx/sites-enabled/letzcontrol-panel.conf`) that
proxies to the panel port, and can issue a Let's Encrypt certificate for it.

Point the domain's **A record at this server first** — the panel checks, and
tells you when it does not resolve here yet. It refuses a name that is already
a website in the panel, so the Websites module can never overwrite it. SSL
needs port 80 reachable and the record in place.

### Panel port

**Settings → Panel port** moves the panel to another port and moves the
firewall rule with it. Ports belonging to the hosting stack (80, 443, 8080,
8088, 3001, 2088, 2089, 3306 and the mail ports) are refused.

Changing the port restarts the panel, and a port that cannot be bound would
otherwise lock you out of the only tool that could fix it. So there are two
independent recoveries, both automatic:

- the panel records the working port before the change, and puts it straight
  back if the bind fails
- a `systemd-run` watchdog restores it if the process never gets far enough to
  notice

The vhost from **Panel domain** is rewritten to follow the new port.

### Server time

**Settings → Server time** sets the system timezone from the OS zone list, and
has switches for NTP and an immediate re-sync. Note that PHP keeps its own
`date.timezone`, which you change under **PHP**, not here.

---

## 🔒 Security

**Read this before exposing the panel.**

- The panel **runs as root** and its web terminal gives a **root shell**.
  Anyone who logs in owns the machine.
- Keep it behind a firewall, an SSH tunnel or a private network. Do not leave
  `:2087` open to the internet on a machine you care about.
- The first admin password is written to `data/ADMIN_CREDENTIALS.txt` —
  **change it, then delete the file.**
- All API routes require an authenticated session. Cookies are
  `HttpOnly` + `SameSite=Lax`; login is rate-limited (5 failures → 60 s lockout
  per IP).
- Non-admin (`user` role) accounts are scoped to their own websites and
  databases, and capped by their plan.
- Put the panel behind Nginx with TLS and set `"host": "127.0.0.1"` so it is not
  reachable directly.

<details>
<summary>Example: panel behind Nginx + TLS</summary>

```nginx
server {
    listen 443 ssl;
    server_name panel.example.com;
    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:2087;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # needed for terminal + stats websockets
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

</details>

---

## 🛠️ Development

```bash
npm install
npm run dev        # auto-reload
npm start          # production
```

```
server.js          entry point
config.js/.json    configuration loader (+ config.example.json)
install.sh         one-line installer
letzcontrol.service  systemd unit
lib/               backend modules (auth, sites, databases, php, docker,
                   services, files, terminal, stats, mail, dns, wordpress,
                   addons, servers, cron, settings, setup, users, db)
views/index.html   app shell
public/            static assets (login page, css, js views)
data/              JSON database + first-run credentials (gitignored)
```

Stack: Node.js, Express, Socket.IO, mysql2, bcrypt, systeminformation,
multer, node-pty (optional), xterm.js. No build step and no framework — plain
ES modules in the browser.

---

## 📄 License

MIT — see [LICENSE](LICENSE).