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

Then open **`http://your-server-ip:2087`** and log in — or the same address
over **https** once a certificate is in place (see *Panel https*).

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

**From the panel:** *Advanced → Updates* compares the installed version with
the one in `package.json` on the repository's default branch and offers a
button to update in place. It is deliberately not automatic — this panel
runs as root with a web terminal, so silently replacing its own code on a
timer is a bad idea even when it is your own repository. A bad push would
take every install down at once, with nobody watching. So: detect, tell
you, let you press the button, and back up before touching anything.

An update from the panel backs up `config.json` and `data/` first, into
`data/backups/pre-update-<timestamp>.tar.gz`, and says so in the log. If
the backup fails, the update says that too and carries on without one — a
warning is better than a silent skip, because a silent skip leaves you
believing you have a copy.

`data/backups/` is excluded from its own archive. It was not at first, so
each backup contained every backup before it and the footprint doubled on
each update — 3.7M, 7.4M, 29M, 88M, 142M, 283M, 1.0G, 1.9G, 6.8G, 14G —
until a 58G disk filled and the panel could no longer write its own
`db.json`. The newest five archives are kept and older ones are removed
once the new one exists, so a failed tar can never cost the last good
copy. The payload is under 5K compressed; everything else was self-nesting.

**The version moves on every push.** This project ships by pushing to a
branch rather than by cutting releases, so a workflow bumps `package.json`,
commits it, tags it and publishes a release for it. That is what lets an
install know there is something new for it: without it the version would sit
still and every install would report itself up to date forever. Patch
releases by default — a panel update is something people apply from an
existing install, and a surprise major version is not a kindness. Run the
*Bump version* workflow by hand to choose minor or major.

---

## ✨ Features

| | Module | What it does |
|---|---|---|
| 📊 | **Dashboard** | Live CPU / RAM / disk / network via WebSocket push, key-service status |
| 🌐 | **Websites** | Virtual hosts on Nginx, Apache **and** OpenLiteSpeed simultaneously · per-site PHP version · free Let's Encrypt SSL · WordPress/npm/proxy backends |
| 🛰️ | **DNS** | Zones, A/AAAA/MX/TXT/CNAME records, DKIM hints, mail DNS presets |
| 🧭 | **WordPress** | Install, versions, plugins/themes, one-click admin, database browser |
| 📧 | **Mail** | Mailboxes grouped by domain, per-mailbox webmail links, self-service password change in Roundcube, per-domain mail readiness (MX · SPF · DKIM · DMARC), the outgoing queue, client settings and DNS records, and the webmail over https (`https://<domain>/webmail/` · `https://mail.<domain>/`) |
| 🗄️ | **Databases** | Create/drop MySQL/MariaDB databases and users, phpMyAdmin, import & download |
| 🐘 | **PHP** | All installed PHP-FPM versions, extensions, restart, default CLI switch |
| ⚙️ | **Services** | Full systemd control, curates the ~170 units down to the 15 that matter |
| 🖥️ | **Servers** | Per-server configure / tweak / enable / disable for Nginx, Apache, OpenLiteSpeed |
| 📁 | **Files** | Browser file manager, inline editor, **uploads with live per-file progress, speed and ETA** |
| 🐳 | **Docker** | CasaOS-style desktop (wallpaper, clock, widgets, dock, app tiles, Store), containers and images, link a site to an app, and **give a container this server's MariaDB and PHP-FPM** |
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
| `tls.cert` / `tls.key` | `""` | Serve https on the panel port too — see *Panel https* |
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

### Panel https

The panel can serve **https and plain HTTP from the same port**, so nothing
that already points at `http://…:2087` has to change. Point two paths in
`config.json` at a certificate and its key and the port starts answering https
as well:

```json
"tls": { "cert": "/etc/letsencrypt/panel-ip/fullchain.pem",
         "key":  "/etc/letsencrypt/panel-ip/privkey.pem" }
```

Each connection is sorted by its first byte, so a browser arriving over https
gets a real, trusted connection while a script, a probe or a bookmarked
`http://` address carries on exactly as before — a browser that typed `http://`
is quietly redirected to `https://`, and only while the certificate is actually
valid, because pointing everyone at a dead end helps nobody.

Which certificate to use depends on how you reach the panel:

| How you open it | Certificate |
|---|---|
| `https://1.2.3.4:2087` — by address | a short-lived Let's Encrypt certificate covering the **IP address itself**. Let's Encrypt only issues these for ~6 days, so acme.sh renews it daily |
| `https://panel.example.com` — by name | any name certificate; **Settings → Panel domain** will issue one for you |

An IP certificate, with [acme.sh](https://github.com/acmesh-official/acme.sh)
(the panel never drives it — it owns its own files and renewals):

```bash
acme.sh --issue --cert-profile shortlived --days 3 -d 1.2.3.4 --webroot /var/www/html
acme.sh --install-cert -d 1.2.3.4 --ecc \
  --fullchain-file /etc/letsencrypt/panel-ip/fullchain.pem \
  --key-file      /etc/letsencrypt/panel-ip/privkey.pem \
  --reloadcmd     'systemctl reload nginx'
```

The same two files also serve **https on the admin-tool ports** (*Admin-tool
ports over https*), and nginx does not re-read a certificate on its own — so
the `--reloadcmd` is what carries a renewal to it. The panel needs nothing: it
re-reads its own copy once a minute.

The files are re-read once a minute, so a renewal takes effect on its own — no
restart, no dropped session, and never a moment of serving a stale or
half-written certificate. If the files go missing or stop matching, the panel
keeps serving plain HTTP and says so in the log; the certificate is never
allowed to take the panel down with it.

### Admin-tool ports over https

The webmail (`:2088`) and phpMyAdmin (`:2089`) get **https on their own ports**
from the same certificate — it covers the server's address, and a certificate
is valid on every port at once, so this needs no second certificate and no
second renewal:

```
https://1.2.3.4:2088/    webmail
https://1.2.3.4:2089/    phpMyAdmin
```

Plain HTTP is **not** served on these ports once there is a certificate — that
is nginx rather than a choice. SSL is a property of the listening socket, so a
port is either one thing or the other, and a plain HTTP request to it comes
back as `400 The plain HTTP request was sent to HTTPS port`. The panel's own
port can do both because it is Node and reads the first byte of each
connection; nginx cannot.

That disturbs nothing the websites depend on: the webmail mounts proxy to the
port over **https**, which is what the panel writes for them
(`lib/sites.js`), and the allow-list covers the port and the mounts alike —
nginx checks it after the handshake, so an address that gets a 403 gets the
same 403 either way.

The panel puts both vhosts in step with `tls` on every start, and the Setup
Wizard does the same just after it writes them. Nothing is written until the
certificate files are really on disk — a vhost naming a certificate that has
gone stops nginx from starting, which takes every site on the box with it — and
if nginx ever refuses what was written, the file is put back exactly as it was.

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
- If it must be reachable, serve it over **https** (*Panel https*). A password
  typed into a login form on plain HTTP is readable by anything on the path,
  and this one is the root password of the machine by another name.
- The first admin password is written to `data/ADMIN_CREDENTIALS.txt` —
  **change it, then delete the file.**
- All API routes require an authenticated session. Cookies are
  `HttpOnly` + `SameSite=Lax`; login is rate-limited (5 failures → 60 s lockout
  per IP).
- Non-admin (`user` role) accounts are scoped to their own websites and
  databases, and capped by their plan.
- The webmail (`:2088`) and phpMyAdmin (`:2089`) are open to the whole
  internet and are scanned within minutes, so nginx restricts them to the
  addresses that administer the box; everyone else gets a 403. Both ports
  serve **https** only, and the list is checked after the handshake
  (*Admin-tool ports over https*). The list is
  in *Settings → Webmail & phpMyAdmin access*, which also shows the address
  the panel sees you arriving from and offers to add it — an operator's own
  address is often a dynamic one, and the only symptom of a stale list is a
  403 from a tool you are allowed to use.
- **The webmail is a service for the customer, not an administering tool**, so
  *Mail → Webmail over https* can open it to everyone with a mailbox while
  phpMyAdmin stays restricted — one choice, one vhost set, no way to open the
  database browser by accident. Two addresses are offered, and both are over
  TLS — as is the port itself — because a login form on plain HTTP is the thing
  to avoid:

  | | needs | where to click |
  |---|---|---|
  | `https://<domain>/webmail/` | the site already has a certificate | *Mount here* |
  | `https://mail.<domain>/` | an A record for `mail.<domain>` pointing here, then a certificate | *Set up* |

  *Set up* adds the A record itself when the panel hosts the domain's zone,
  writes the vhost, issues the certificate and wires up renewal; when it
  cannot (the name points somewhere else and the zone is elsewhere) it says
  which record to add rather than leaving half a setup behind. A vhost that
  names a certificate which is not on disk stops nginx from starting at all,
  so anything that does not get as far as a certificate is removed again.
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
npm run bump-version   # move the version in package.json (patch by default)
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