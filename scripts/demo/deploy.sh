#!/usr/bin/env bash
# Crackio's live demo on a small Linux host (an Ubuntu VPS works; no GPU needed). docs/DEMO.md has the whole story.
# Run it on the host, as root, from the app folder (scripts/demo/push.sh sends the code and runs it):
#
#   bash scripts/demo/deploy.sh                 env: COMFYUI_URL (optional), CRACKIO_DEMO_TOOLS, CRACKIO_REPO, TUNNEL_TOKEN
#
# It installs and builds Crackio in demo mode, then runs it (as its own unprivileged user) and a Cloudflare tunnel as
# systemd services, or supervisor/background processes where there's no systemd. Crackio listens on 127.0.0.1 only;
# the tunnel is the way in: a quick tunnel (a random *.trycloudflare.com address) by default, your named tunnel when
# TUNNEL_TOKEN is set. The GPUs come from the machines set up in the demo's own data folder (Local's settings), with
# COMFYUI_URL as an optional ComfyUI it also uses. That folder starts empty: no keys of yours, no settings.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOME_DIR="${CRACKIO_DEMO_HOME:-/opt/crackio-demo}"
ENV_FILE="$HOME_DIR/demo.env"
PORT="${CRACKIO_DEMO_PORT:-3299}"
STORE="$HOME_DIR/.pnpm-store"
RUN_AS=crackio

say() { printf '\n== %s\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Run as root." >&2; exit 1; }

# --- Node 22+, pnpm and cloudflared ----------------------------------------------------------------------------------
[ -s /opt/nvm/nvm.sh ] && . /opt/nvm/nvm.sh
[ -x /opt/node22/bin/node ] && export PATH="/opt/node22/bin:$PATH"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  say "Installing Node 22"
  ARCH="$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')"
  TARBALL="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -oE "node-v22\.[0-9]+\.[0-9]+-linux-$ARCH\.tar\.xz" | head -1)"
  mkdir -p /opt/node22
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$TARBALL" | tar -xJ -C /opt/node22 --strip-components=1
  export PATH="/opt/node22/bin:$PATH"
fi
NODE_BIN="$(command -v node)"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
command -v pnpm >/dev/null || corepack enable >/dev/null 2>&1 || npm install -g "pnpm@11.15.1"

CLOUDFLARED="${CLOUDFLARED:-$(command -v cloudflared || true)}"
if [ -z "$CLOUDFLARED" ]; then
  say "Installing cloudflared"
  ARCH="$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')"
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH" -o /usr/local/bin/cloudflared
  chmod +x /usr/local/bin/cloudflared
  CLOUDFLARED=/usr/local/bin/cloudflared
fi

# --- The demo's settings, made once ---------------------------------------------------------------------------------
mkdir -p "$HOME_DIR"
if [ ! -f "$ENV_FILE" ]; then
  say "Writing $ENV_FILE (a new sign-in secret)"
  ( umask 077
    {
      echo "CRACKIO_DEMO=1"
      echo "CRACKIO_DEMO_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
      echo "CRACKIO_DATA_DIR=${CRACKIO_DATA_DIR:-$HOME_DIR/data}"
      [ -n "${COMFYUI_URL:-}" ] && echo "COMFYUI_URL=$COMFYUI_URL"
      echo "CRACKIO_DEMO_TOOLS=${CRACKIO_DEMO_TOOLS:-}"
      echo "CRACKIO_REPO=${CRACKIO_REPO:-https://github.com/RafalOfficial/Crackio}"
      echo "CRACKIO_CONCURRENCY=${CRACKIO_CONCURRENCY:-2}"
      echo "TUNNEL_TOKEN=${TUNNEL_TOKEN:-}"
    } > "$ENV_FILE"
  )
fi
set -a; . "$ENV_FILE"; set +a
mkdir -p "$CRACKIO_DATA_DIR"
# A demo's data must never hold a real install's keys or settings.
if [ -f "$CRACKIO_DATA_DIR/settings.json" ] && grep -qE '"(fal|xai|openai|comfy)"\s*:\s*"[^"]+' "$CRACKIO_DATA_DIR/settings.json"; then
  echo "Refusing: $CRACKIO_DATA_DIR/settings.json holds provider API keys. The demo's data folder must start empty." >&2
  exit 1
fi

# --- Install and build ----------------------------------------------------------------------------------------------
cd "$APP_DIR"
say "Installing packages"
pnpm install --frozen-lockfile --store-dir "$STORE"
say "Building (demo mode)"
NEXT_TELEMETRY_DISABLED=1 pnpm build
pnpm store prune --store-dir "$STORE" >/dev/null 2>&1 || true

# The app runs as its own user: it can write only its data folder and Next's cache.
id "$RUN_AS" >/dev/null 2>&1 || useradd --system --home-dir "$HOME_DIR" --shell /usr/sbin/nologin "$RUN_AS"
mkdir -p "$APP_DIR/.next/cache"
chown -R "$RUN_AS:$RUN_AS" "$CRACKIO_DATA_DIR" "$APP_DIR/.next/cache"
chown root:"$RUN_AS" "$ENV_FILE"; chmod 640 "$ENV_FILE"

# --- Run it ----------------------------------------------------------------------------------------------------------
# With private studios (scripts/demo/studio.sh) the router holds the public port and the shared demo sits one above it.
APP_PORT="$PORT"; [ -f /etc/systemd/system/crackio-router.service ] && APP_PORT=$((PORT + 1))
APP_CMD="$NODE_BIN $APP_DIR/node_modules/next/dist/bin/next start -H 127.0.0.1 -p $APP_PORT"
if [ -n "${TUNNEL_TOKEN:-}" ]; then TUNNEL_CMD="$CLOUDFLARED tunnel --no-autoupdate run --token $TUNNEL_TOKEN"
else TUNNEL_CMD="$CLOUDFLARED tunnel --no-autoupdate --url http://127.0.0.1:$PORT"; fi

if [ "$(cat /proc/1/comm 2>/dev/null)" = systemd ]; then
  cat > /etc/systemd/system/crackio-demo.service <<EOF
[Unit]
Description=Crackio live demo
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_AS
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=HOME=$CRACKIO_DATA_DIR
ExecStart=$APP_CMD
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
  TUNNEL_UNIT=/etc/systemd/system/crackio-tunnel.service
  cat > "$TUNNEL_UNIT.new" <<EOF
[Unit]
Description=Crackio live demo tunnel
After=crackio-demo.service

[Service]
DynamicUser=true
ExecStart=$TUNNEL_CMD
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  # The tunnel restarts only when its command changed, so a redeploy keeps a quick tunnel's address.
  TUNNEL_CHANGED=""
  if cmp -s "$TUNNEL_UNIT.new" "$TUNNEL_UNIT"; then rm -f "$TUNNEL_UNIT.new"; else mv "$TUNNEL_UNIT.new" "$TUNNEL_UNIT"; TUNNEL_CHANGED=1; fi
  systemctl daemon-reload
  systemctl enable crackio-demo crackio-tunnel >/dev/null 2>&1
  systemctl restart crackio-demo
  if [ -n "$TUNNEL_CHANGED" ] || ! systemctl is-active --quiet crackio-tunnel; then systemctl restart crackio-tunnel; fi
  # Private studios run the same code from their own full build: the router and the studios follow every deploy.
  if [ -f /etc/systemd/system/crackio-router.service ]; then systemctl restart crackio-router; fi
  if [ -f "$HOME_DIR/studios.json" ]; then bash "$APP_DIR/scripts/demo/studio.sh" rebuild; fi
  tunnel_log() { journalctl -u crackio-tunnel --no-pager -n 2000 2>/dev/null; }
elif command -v supervisorctl >/dev/null && [ -d /etc/supervisor/conf.d ]; then
  for name in crackio-demo crackio-tunnel; do
    cmd="$APP_CMD"; user="user=$RUN_AS"
    [ "$name" = crackio-tunnel ] && { cmd="$TUNNEL_CMD"; user=""; }
    cat > "/etc/supervisor/conf.d/$name.conf" <<EOF
[program:$name]
command=/bin/bash -c 'set -a; . $ENV_FILE; set +a; cd $APP_DIR; exec $cmd'
$user
autostart=true
autorestart=true
stdout_logfile=/var/log/$name.log
redirect_stderr=true
EOF
  done
  supervisorctl reread >/dev/null
  supervisorctl update >/dev/null
  supervisorctl restart crackio-demo crackio-tunnel >/dev/null
  tunnel_log() { cat /var/log/crackio-tunnel.log 2>/dev/null; }
else
  say "No systemd or supervisor: starting both in the background (they won't come back after a reboot)"
  ( cd "$APP_DIR" && setsid nohup runuser -u "$RUN_AS" -- env $(grep -v '^#' "$ENV_FILE" | xargs) $APP_CMD >"$HOME_DIR/app.log" 2>&1 & )
  ( setsid nohup $TUNNEL_CMD >"$HOME_DIR/tunnel.log" 2>&1 & )
  tunnel_log() { cat "$HOME_DIR/tunnel.log" 2>/dev/null; }
fi

say "Waiting for Crackio on 127.0.0.1:$PORT"
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/demo/session" && break
  sleep 2
done
curl -fsS "http://127.0.0.1:$PORT/api/demo/session" && echo
if [ -z "${TUNNEL_TOKEN:-}" ]; then
  URL=""
  for _ in $(seq 1 30); do
    URL="$(tunnel_log | grep -ohE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
    [ -n "$URL" ] && break
    sleep 2
  done
  echo "Tunnel: ${URL:-not up yet; check the crackio-tunnel log}"
fi
echo "Codes: cd $APP_DIR && set -a && . $ENV_FILE && set +a && node scripts/demo/codes.mjs add --credits 300 --label pub --count 10"
