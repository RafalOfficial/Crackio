#!/usr/bin/env bash
# Sends this checkout's committed code to the demo box and deploys it there (docs/DEMO.md). Only what git tracks goes:
# never data/, keys or local settings.
#
#   scripts/demo/push.sh root@<host> <ssh-port> [git ref]      (env: COMFYUI_URL, CRACKIO_DEMO_TOOLS, CRACKIO_REPO, TUNNEL_TOKEN)
set -euo pipefail
HOST="${1:?usage: push.sh user@host ssh-port [ref]}"
PORT="${2:?usage: push.sh user@host ssh-port [ref]}"
REF="${3:-HEAD}"
APP=/opt/crackio-demo/app

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
echo "Sending $(git rev-parse --short "$REF") to $HOST"
# Tracked folders are replaced, so files deleted in git don't linger; node_modules and .next stay for a faster build.
ssh -p "$PORT" "$HOST" "mkdir -p $APP && cd $APP && rm -rf src public scripts workflows docs comfyui"
git archive --format=tar "$REF" | ssh -p "$PORT" "$HOST" "tar -x -C $APP"
ssh -p "$PORT" "$HOST" "cd $APP && COMFYUI_URL='${COMFYUI_URL:-}' CRACKIO_DEMO_TOOLS='${CRACKIO_DEMO_TOOLS:-}' CRACKIO_REPO='${CRACKIO_REPO:-}' TUNNEL_TOKEN='${TUNNEL_TOKEN:-}' bash scripts/demo/deploy.sh"
