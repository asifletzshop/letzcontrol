#!/usr/bin/env bash
# =============================================================================
#  letzControl - one-line installer
#
#    curl -fsSL https://raw.githubusercontent.com/<owner>/letzcontrol/main/install.sh | bash
#
#  Installs the panel into /opt/letzcontrol and runs it as a systemd service.
#  Everything else (Nginx, Apache, OpenLiteSpeed, PHP, MariaDB, Docker,
#  mail) is left to the panel's own Setup Wizard, which detects what is already
#  installed and only installs what is missing.
#
#  Safe to re-run: an existing installation is upgraded in place and the
#  database, config and credentials are preserved.
# =============================================================================
set -euo pipefail

# ------------------------------- options ---------------------------------
PANEL_VERSION="${PANEL_VERSION:-latest}"
INSTALL_DIR="${INSTALL_DIR:-/opt/letzcontrol}"
PANEL_PORT="${PANEL_PORT:-2087}"
SERVICE_NAME="letzcontrol"
# Where the code lives. Both default to this repo; override to install a fork
# (e.g. REPO_URL=https://github.com/you/letzcontrol.git bash install.sh).
GITHUB_REPO="${GITHUB_REPO:-asifletzshop/letzcontrol}"
REPO_URL="${REPO_URL:-https://github.com/${GITHUB_REPO}.git}"
TARBALL_URL="${TARBALL_URL:-https://github.com/${GITHUB_REPO}/archive/refs/heads/main.tar.gz}"
DO_SERVICE=1
DO_FIREWALL=auto

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()   { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
step()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)        INSTALL_DIR="${2:?--dir needs a path}"; shift 2 ;;
    --port)       PANEL_PORT="${2:?--port needs a number}"; shift 2 ;;
    --no-service) DO_SERVICE=0; shift ;;
    --help|-h)
      cat <<'USAGE'
letzControl installer

  curl -fsSL <install.sh-url> | bash              # install / upgrade
  bash install.sh --dir /srv/panel --port 8080    # custom location

Options
  --dir PATH       install directory        (default /opt/letzcontrol)
  --port PORT      panel listen port        (default 2087)
  --no-service     do not create a systemd unit (also required on
                   systems without systemd, e.g. containers)
  --help           this text

Environment
  PANEL_VERSION      tag/branch to install        (default latest)
  INSTALL_DIR        install location             (default /opt/letzcontrol)
  PANEL_PORT         panel port                   (default 2087)
  GITHUB_REPO        owner/name of the repo       (default asifletzshop/letzcontrol)
  REPO_URL           full git URL        (default derived from GITHUB_REPO)
  TARBALL_URL        tarball URL fallback (default derived from GITHUB_REPO)

  Installing a fork:
    GITHUB_REPO=myuser/letzcontrol bash install.sh

Notes
  * Needs root: the panel manages services, vhosts and databases.
  * Re-running upgrades in place; data/ and config.json are kept.
  * The web terminal needs node-pty, which needs build-essential + python3.
    Without them the panel still runs, only the terminal is disabled.
USAGE
      exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# ----------------------------- environment -------------------------------
[ "$(id -u)" = "0" ] || die "must run as root (try: sudo bash)"
bold "letzControl installer"

if [ -r /etc/os-release ]; then . /etc/os-release; OS_ID="${ID:-}"; else OS_ID=""; fi
case "$OS_ID" in
  debian|ubuntu) ok "$PRETTY_NAME" ;;
  *) warn "$PRETTY_NAME is not Debian/Ubuntu - continuing, but the panel is only tested there" ;;
esac
if ! command -v systemctl >/dev/null 2>&1; then
  if [ "$DO_SERVICE" = "1" ]; then
    die "systemd not found. Install it, or re-run with --no-service to start the panel manually."
  fi
  warn "systemd not found - continuing without a service (start it manually)"
fi

EXISTING=0
[ -f "$INSTALL_DIR/server.js" ] && EXISTING=1
if [ "$EXISTING" = "1" ]; then
  step "Existing installation found in $INSTALL_DIR - this will upgrade it"
fi

# ------------------------------- node ------------------------------------
step "Node.js"
command -v node >/dev/null 2>&1 && ok "node $(node -v)" || warn "node not found - installing Node.js 22"

if ! command -v node >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
  ok "node $(node -v)"
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "node $(node -v) is too old - Node 18 or newer is required"
ok "node $(node -v) satisfies >= 18"

# ------------------------- build tools (optional) ------------------------
# Only needed by node-pty for the web terminal. Treated as optional so the
# panel installs cleanly on a minimal image; the terminal reports itself as
# unavailable instead of breaking startup.
step "Build tools for the web terminal"
if command -v gcc >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
  ok "already present"
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq build-essential python3 >/dev/null 2>&1 \
    && ok "installed build-essential + python3" \
    || warn "could not install build tools - the panel will run, the web terminal will not"
fi

# ------------------------------ download ---------------------------------
step "Downloading letzControl ($PANEL_VERSION)"

BACKUP_DIR=""
if [ "$EXISTING" = "1" ]; then
  BACKUP_DIR="/root/letzcontrol-backup-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"
  for item in data config.json; do
    [ -e "$INSTALL_DIR/$item" ] && cp -a "$INSTALL_DIR/$item" "$BACKUP_DIR/" 2>/dev/null || true
  done
  ok "backed up data/ and config.json to $BACKUP_DIR"

  if [ "$DO_SERVICE" = "1" ] && systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    ok "stopped the running panel"
  fi
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() {
  # git clone when available (clean history), otherwise a tarball over HTTPS
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 --branch "$PANEL_VERSION" "$REPO_URL" "$TMP/src" >/dev/null 2>&1 && return 0
    git clone --depth 1 "$REPO_URL" "$TMP/src" >/dev/null 2>&1 && return 0
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$TARBALL_URL" -o "$TMP/src.tar.gz" && tar xzf "$TMP/src.tar.gz" -C "$TMP" && return 0
  fi
  return 1
}

if ! fetch; then
  die "could not download the panel.
   Checked: $REPO_URL and $TARBALL_URL
   If you are testing a local copy, run:  bash install.sh  from inside it,
   or set TARBALL_URL=/path/to/archive.tar.gz"
fi

# A GitHub tarball unpacks into <name>-<ref>/; normalise to a single dir.
SRC="$TMP/src"
[ -f "$SRC/package.json" ] || SRC="$(find "$TMP" -maxdepth 2 -name package.json -printf '%h\n' 2>/dev/null | head -1)"
[ -n "$SRC" ] && [ -f "$SRC/server.js" ] || die "downloaded archive does not look like letzControl"

VERSION=$(node -p "require('$SRC/package.json').version" 2>/dev/null || echo "?")
ok "letzControl v$VERSION"

# ------------------------------ install ----------------------------------
step "Installing to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
# Copy code only: never clobber data/ or config.json on an upgrade.
for item in server.js config.js package.json package-lock.json lib public views README.md; do
  [ -e "$SRC/$item" ] && cp -a "$SRC/$item" "$INSTALL_DIR/"
done
cp -a "$SRC/letzcontrol.service" "$INSTALL_DIR/" 2>/dev/null || true
ok "files copied"

cd "$INSTALL_DIR"
export DEBIAN_FRONTEND=noninteractive
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 \
    || die "npm install failed - check your internet connection"
else
  npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || die "npm install failed"
fi
ok "dependencies installed"
[ -d node_modules/node-pty ] && ok "web terminal available" || warn "node-pty missing - web terminal disabled"

# Port: honour an explicit --port, otherwise keep whatever config.json says.
# On a FIRST install config.json does not exist yet (the panel writes it on
# first boot), so create it here - otherwise --port is silently ignored and the
# panel comes up on the default instead of what the user asked for.
if [ -n "$PANEL_PORT" ]; then
  CUR=$(node -p "try{require('$INSTALL_DIR/config.json').port}catch(e){''}" 2>/dev/null || echo "")
  if [ "$CUR" != "$PANEL_PORT" ]; then
    node -e "
      const fs=require('fs'), f='$INSTALL_DIR/config.json';
      let c = {};
      try { c = JSON.parse(fs.readFileSync(f,'utf8')); } catch (e) {}
      c.port = $PANEL_PORT;
      fs.writeFileSync(f, JSON.stringify(c, null, 2));
    " || die "could not set the port in config.json"
    if [ -f config.json ]; then
      ok "port set to $PANEL_PORT (existing config.json updated)"
    else
      ok "port set to $PANEL_PORT (config.json created)"
    fi
  fi
fi

# ------------------------------ systemd ---------------------------------
# systemd being installed is not the same as systemd being PID 1 (containers,
# chroots, WSL). Enabling the service there fails with an opaque
# "Failed to connect to bus" - detect it and say something useful instead.
SYSTEMD_USABLE=1
if [ "$(ps -p 1 -o comm= 2>/dev/null)" != "systemd" ]; then
  SYSTEMD_USABLE=0
fi

if [ "$DO_SERVICE" = "1" ] && [ "$SYSTEMD_USABLE" = "0" ]; then
  step "systemd service"
  warn "systemd is not running as PID 1 (container or chroot?)"
  warn "installing the files only - start the panel with:"
  printf '      cd %s && node server.js\n' "$INSTALL_DIR"
fi

if [ "$DO_SERVICE" = "1" ] && [ "$SYSTEMD_USABLE" = "1" ]; then
  step "systemd service"
  cat > "/etc/systemd/system/$SERVICE_NAME.service" <<UNIT
[Unit]
Description=letzControl - VPS & hosting control panel
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$(command -v node) $INSTALL_DIR/server.js
Restart=always
RestartSec=3
User=root
Environment=NODE_ENV=production
StandardOutput=append:/var/log/letzcontrol.log
StandardError=append:/var/log/letzcontrol.log

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
  systemctl restart "$SERVICE_NAME"
  sleep 3
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "$SERVICE_NAME is running"
  else
    journalctl -u "$SERVICE_NAME" -n 15 --no-pager >&2 || true
    die "the panel failed to start - see the log above"
  fi
fi

# The admin password is only generated while the panel boots - ensureAdmin()
# writes data/ADMIN_CREDENTIALS.txt and nothing else does. So whenever we are
# NOT handing the panel to systemd (no --service, or systemd that is not PID 1,
# which is every container, chroot and WSL), it would otherwise never run and
# the installer would end by telling the user to go read a log file for a
# password that had not even been generated yet.
#
# Boot it here in the background purely to generate and surface that password,
# then stop it again. The summary below already says how to run it properly.
BOOT_PID=""
BOOT_LOG=$(mktemp /tmp/.letz-boot.XXXXXX.log)
if ! { [ "$DO_SERVICE" = "1" ] && [ "$SYSTEMD_USABLE" = "1" ]; }; then
  node server.js >"$BOOT_LOG" 2>&1 &
  BOOT_PID=$!
fi

# ------------------------------ firewall --------------------------------
step "Firewall"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  if ufw status | grep -q "$PANEL_PORT"; then
    ok "ufw already allows $PANEL_PORT"
  else
    ufw allow "$PANEL_PORT/tcp" >/dev/null 2>&1 && ok "ufw: opened $PANEL_PORT" || warn "ufw: could not open $PANEL_PORT"
  fi
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PANEL_PORT/tcp" >/dev/null 2>&1 \
    && firewall-cmd --reload >/dev/null 2>&1 && ok "firewalld: opened $PANEL_PORT" || warn "firewalld: could not open $PANEL_PORT"
else
  ok "no local firewall detected"
fi

# ------------------------------ summary ---------------------------------
if [ "$DO_SERVICE" = "1" ] && [ "$SYSTEMD_USABLE" = "1" ]; then
  HOW="  Start/stop:  systemctl $SERVICE_NAME {start|stop|restart|status}"
else
  HOW="  Start:        cd $INSTALL_DIR && node server.js"
fi
printf '%s\n' "$HOW" > /tmp/.letz-how

# Same "||''" trap as the dataDir lookup above: a config.json with no port key
# makes this print "undefined", and the summary would then tell the user to open
# http://<ip>:undefined.
PORT=$(node -p "try{require('$INSTALL_DIR/config.json').port||$PANEL_PORT}catch(e){$PANEL_PORT}" 2>/dev/null || echo "$PANEL_PORT")
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$IP" ] || IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo "your-server-ip")

step "Installed"
printf '  Panel   \033[1;36mhttp://%s:%s\033[0m\n' "$IP" "$PORT"
if [ "$DO_SERVICE" = "1" ] && [ "$SYSTEMD_USABLE" = "1" ]; then
  printf '  Logs    \033[36mjournalctl -u %s -f\033[0m\n' "$SERVICE_NAME"
else
  printf '  Logs    \033[36m/var/log/letzcontrol.log\033[0m\n'
fi
[ -n "$BACKUP_DIR" ] && printf '  Backup  \033[36m%s\033[0m\n' "$BACKUP_DIR"
echo
echo "  Credentials:"

# The panel writes its generated admin password on first start; surface it
# rather than making the user go hunting for it. The file only appears once
# the service is actually up, so wait for it (it may already exist on an
# upgrade, which is exactly the case where nothing new is printed).
# Ask the panel's own config for its data directory rather than assuming it
# sits beside the code. The ||'' matters: config.json without a dataDir key
# makes require().dataDir evaluate to undefined without throwing, so the catch
# never runs and node -p prints the string "undefined" - which then becomes the
# path and the credentials file is never found. That is the whole bug.
CREDS_DIR=$(node -p "try{require('$INSTALL_DIR/config.json').dataDir||''}catch(e){''}" 2>/dev/null || echo "")
[ -n "$CREDS_DIR" ] || CREDS_DIR="$INSTALL_DIR/data"
CREDS="$CREDS_DIR/ADMIN_CREDENTIALS.txt"
CREDS_WAS_NEW=0
if [ ! -f "$CREDS" ]; then
  CREDS_WAS_NEW=1
  for _ in $(seq 1 20); do [ -f "$CREDS" ] && break; sleep 1; done
fi

if [ -f "$CREDS" ]; then
  USER_NAME=$(sed -n 's/^username: //p' "$CREDS" | head -1)
  USER_PASS=$(sed -n 's/^password: //p' "$CREDS" | head -1)
  if [ "$CREDS_WAS_NEW" = "1" ]; then
    printf '    username  \033[1;37m%s\033[0m\n' "$USER_NAME"
    printf '    password  \033[1;37m%s\033[0m\n' "$USER_PASS"
    echo
    echo -e "  \033[33mChange this password immediately after logging in.\033[0m"
    warn "delete $CREDS once you have changed it"
  else
    # An upgrade prints no password either, which reads exactly like the bug
    # this section was fixed for. Say plainly that nothing was generated and
    # where the old one still is, instead of leaving it to guesswork.
    echo "  Unchanged - this is an upgrade, so no new password was generated."
    echo "  Your existing admin account still applies."
    echo "    still the original? it is in $CREDS"
    echo "    changed it and lost it? reset it with the panel's own helper:"
    printf '      cd %s && npm run reset-password\n' "$INSTALL_DIR"
  fi
else
  # Two very different causes land here, and the old message covered both with
  # one unhelpful line. Say which one it is.
  if grep -qs "panel listening on" "$BOOT_LOG" 2>/dev/null \
     || { [ "$DO_SERVICE" = "1" ] && [ "$SYSTEMD_USABLE" = "1" ] && systemctl is-active --quiet "$SERVICE_NAME"; }; then
    warn "the panel is running but wrote no credentials file."
    warn "that means an admin account already exists - most likely you upgraded"
    warn "and already changed the password, so no new one was generated."
  else
    warn "the panel did not start, so no password was generated. Its output:"
    [ -s "$BOOT_LOG" ] && sed 's/^/      /' "$BOOT_LOG" | tail -n 12
    if [ "$SYSTEMD_USABLE" = "1" ] && [ "$DO_SERVICE" = "1" ]; then
      printf '      journalctl -u %s | grep -A3 "Admin account"\n' "$SERVICE_NAME"
    else
      printf '      cd %s && node server.js\n' "$INSTALL_DIR"
    fi
  fi
fi

# The panel was only booted to mint a password; hand the box back the way it was.
if [ -n "$BOOT_PID" ]; then
  kill "$BOOT_PID" 2>/dev/null || true
  wait "$BOOT_PID" 2>/dev/null || true
  rm -f "$BOOT_LOG"
fi

cat <<NEXT

$(sed 's/^/  /' /tmp/.letz-how)

  Next steps
    1. Open the panel and change the admin password.
    2. Sidebar -> Setup Wizard: install Nginx / PHP / MariaDB / OpenLiteSpeed.
    3. Websites -> Add Website, then SSL for free Let's Encrypt.

  Security note
    The panel runs as root and its web terminal is a root shell. Anyone who
    logs in owns the machine - use a long password and never expose $PORT
    without a firewall or an SSH tunnel.

NEXT
rm -f /tmp/.letz-how