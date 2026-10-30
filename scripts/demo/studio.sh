#!/usr/bin/env bash
# Private studios for the live demo (docs/DEMO.md): a Crackio process per access code, each with its own data folder, so
# Director, Cast, Product Studio, Storyboard and Connections work as they do at home and no code sees another's work.
# The studios share one full build (CRACKIO_DEMO_FULL=1) in $HOME_DIR/app-full. scripts/demo/router.mjs, on the public
# port, starts a studio when its visitor arrives, stops it when idle, keeps memory free (a line when it's full), and
# sends everyone without a studio to the shared demo. Run it on the host, as root:
#
#   bash scripts/demo/studio.sh setup                                  # once: the full build and the router
#   bash scripts/demo/studio.sh add --credits 300 --label judge1       # a new code with its own studio (shown once)
#   bash scripts/demo/studio.sh list | off <id> | rebuild              # rebuild: after new code arrives in app/
set -euo pipefail

HOME_DIR="${CRACKIO_DEMO_HOME:-/opt/crackio-demo}"
APP="$HOME_DIR/app"
FULL="$HOME_DIR/app-full"
MAP="$HOME_DIR/studios.json"
STORE="$HOME_DIR/.pnpm-store"
PORT="${CRACKIO_DEMO_PORT:-3299}"
RUN_AS=crackio
export PATH="/opt/node22/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
NODE_BIN="$(command -v node)"
say() { printf '\n== %s\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Run as root." >&2; exit 1; }

build_full() {
  say "Building the studios' full app"
  mkdir -p "$FULL"
  # The same code as the shared demo, its own build: node_modules and Next's cache stay for a faster build.
  tar -C "$APP" --exclude=./node_modules --exclude=./.next -cf - . | tar -C "$FULL" -xf -
  cd "$FULL"
  pnpm install --frozen-lockfile --store-dir "$STORE"
  ( set -a; . "$HOME_DIR/demo.env"; set +a
    export CRACKIO_DEMO_FULL=1 NEXT_PUBLIC_CRACKIO_DEMO_FULL=1 NEXT_TELEMETRY_DISABLED=1
    pnpm build )
  mkdir -p "$FULL/.next/cache"
  chown -R "$RUN_AS:$RUN_AS" "$FULL/.next/cache"
}

map_js() { "$NODE_BIN" -e "$1" "$MAP" "${@:2}"; }

case "${1:-}" in
  setup)
    [ -f "$HOME_DIR/demo.env" ] || { echo "Deploy the shared demo first (scripts/demo/push.sh)." >&2; exit 1; }
    [ -f "$MAP" ] || echo '{"studios":[]}' > "$MAP"
    chown root:"$RUN_AS" "$MAP"; chmod 640 "$MAP"
    mkdir -p "$HOME_DIR/studios"
    build_full
    REPO_URL="$(grep -E '^CRACKIO_REPO=' "$HOME_DIR/demo.env" | cut -d= -f2- || true)"
    cat > /etc/systemd/system/crackio-router.service <<EOF
[Unit]
Description=Crackio live demo router and private studios
After=network-online.target

[Service]
User=$RUN_AS
Environment=ROUTER_PORT=$PORT ROUTER_SHARED_PORT=$((PORT + 1)) ROUTER_HOME=$HOME_DIR ROUTER_APP=$FULL
Environment=CRACKIO_REPO=${REPO_URL:-https://github.com/RafalOfficial/Crackio}
ExecStart=$NODE_BIN $APP/scripts/demo/router.mjs
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
    # The router takes the public port (the tunnel's target); the shared demo moves one up.
    sed -i -E "s/-p $PORT\$/-p $((PORT + 1))/" /etc/systemd/system/crackio-demo.service
    systemctl daemon-reload
    systemctl restart crackio-demo
    systemctl enable crackio-router >/dev/null 2>&1
    systemctl restart crackio-router
    say "Router on :$PORT, shared demo on :$((PORT + 1))"
    ;;
  add)
    shift
    CREDITS=300; LABEL=studio
    while [ $# -gt 0 ]; do case "$1" in --credits) CREDITS="$2"; shift 2;; --label) LABEL="$2"; shift 2;; *) shift;; esac; done
    [ -d "$FULL/.next" ] || { echo "Run setup first." >&2; exit 1; }
    ID="$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    LAST="$(map_js 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).studios; console.log(Math.max(0, ...s.map((x) => x.port)))')"
    SPORT=$(( LAST > PORT + 1 ? LAST + 1 : PORT + 2 ))
    DIR="$HOME_DIR/studios/$ID"
    mkdir -p "$DIR/data/serverless"
    ( umask 027
      grep -v -E '^(CRACKIO_DATA_DIR|CRACKIO_DEMO_FULL|CRACKIO_DEMO_SECRET)=' "$HOME_DIR/demo.env"
      # Its own sign-in secret: a studio's sign-in means nothing to any other.
      echo "CRACKIO_DEMO_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
      echo "CRACKIO_DATA_DIR=$DIR/data"
      echo "CRACKIO_DEMO_FULL=1" ) > "$DIR/env"
    chown root:"$RUN_AS" "$DIR/env"; chmod 640 "$DIR/env"
    # What the demo's GPU holds, so a new studio needn't ask RunPod again.
    cp "$HOME_DIR"/data/serverless/*.json "$DIR/data/serverless/" 2>/dev/null || true
    OUT="$( set -a; . "$DIR/env"; set +a; cd "$FULL"; "$NODE_BIN" scripts/demo/codes.mjs add --credits "$CREDITS" --label "$LABEL" )"
    CODE="$(printf '%s' "$OUT" | grep -oE 'CRK-[A-Z0-9]{4}-[A-Z0-9]{4}' | head -1)"
    [ -n "$CODE" ] || { echo "$OUT" >&2; exit 1; }
    chown -R "$RUN_AS:$RUN_AS" "$DIR/data"
    map_js '
      const fs = require("fs"); const [map, id, port, code, label] = process.argv.slice(1);
      const m = JSON.parse(fs.readFileSync(map, "utf8"));
      const hash = require("crypto").createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
      m.studios.push({ id, port: Number(port), code: hash, label });
      fs.writeFileSync(map + ".tmp", JSON.stringify(m, null, 2)); fs.renameSync(map + ".tmp", map);
    ' "$ID" "$SPORT" "$CODE" "$LABEL"
    chown root:"$RUN_AS" "$MAP"; chmod 640 "$MAP"
    echo "$CODE  $CREDITS credits  ($LABEL, studio $ID on :$SPORT)"
    echo "Shown once: copy it now."
    ;;
  list)
    [ -f "$MAP" ] || { echo "No studios yet."; exit 0; }
    map_js '
      const { execSync } = require("child_process");
      for (const s of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).studios) {
        let up = "asleep"; try { execSync(`pgrep -f "next start -H 127.0.0.1 -p ${s.port}$"`); up = "running"; } catch {}
        console.log(`${s.id}  :${s.port}  ${up.padEnd(8)} ${s.label}`);
      }'
    ;;
  off)
    ID="${2:?studio id}"
    map_js '
      const fs = require("fs"); const [map, id] = process.argv.slice(1);
      const m = JSON.parse(fs.readFileSync(map, "utf8")); m.studios = m.studios.filter((s) => s.id !== id);
      fs.writeFileSync(map + ".tmp", JSON.stringify(m, null, 2)); fs.renameSync(map + ".tmp", map);
    ' "$ID"
    # A running one stops by itself once idle; its code no longer opens it.
    echo "Studio $ID is off (its data stays in $HOME_DIR/studios/$ID until you delete it)."
    ;;
  rebuild)
    build_full
    # Restarting the router stops the running studios; each starts again on its visitor's next click.
    systemctl restart crackio-router
    echo "Rebuilt."
    ;;
  *)
    echo "Usage: studio.sh setup | add --credits N --label name | list | off <id> | rebuild" >&2
    exit 1
    ;;
esac
