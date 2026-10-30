#!/usr/bin/env bash
# Checks a running live demo from the outside (docs/DEMO.md): what's shut, what needs a code, and that two codes can't
# see each other's work. Spends at most a few credits; give it two codes made for testing.
#
#   bash scripts/demo/selftest.sh http://127.0.0.1:3299 CRK-AAAA-AAAA CRK-BBBB-BBBB
#   FULL=1 bash scripts/demo/selftest.sh …   for a full demo (CRACKIO_DEMO_FULL=1): its extra tools and Connections open;
#                                             Motion, installs, the relay, the lab and the old Storyboard stay shut
set -uo pipefail
FULL="${FULL:-0}"
BASE="${1:?usage: selftest.sh base-url code-a code-b}"
CODE_A="${2:?code a}"
CODE_B="${3:?code b}"
TMP="$(mktemp -d)"
JAR_A="$TMP/a.txt"; JAR_B="$TMP/b.txt"
pass=0; fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); printf '  ok    %s\n' "$1"; else fail=$((fail + 1)); printf '  FAIL  %s (wanted %s, got %s)\n' "$1" "$2" "$3"; fi
}
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
# curl built for Windows (Git Bash) can't read /tmp paths.
file() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }

echo "Shut in the demo (404):"
if [ "$FULL" = 1 ]; then
  SHUT=("POST /api/settings" "POST /api/local" "POST /api/local/setup" "GET /api/local/loras" "POST /api/local/workflow"
    "POST /api/comfy/relay" "GET /api/motion/projects" "POST /api/motion/projects" "GET /api/logins" "POST /api/siwc" "GET /api/accounts"
    "POST /api/lab/judge" "POST /api/lab/text" "PATCH /api/models" "GET /api/storyboards" "POST /api/storyboards" "GET /api/templates/originals"
    "GET /api/templates/trends" "POST /api/recast" "GET /api/media/templates/x.mp4" "GET /api/media/out/motion/x/y.png")
  LEFT_OUT=(/settings /local /comfy /tools/motion /auth/callback)
  OPEN=(/ /create /video /library /demo /director /cast /tools/product /tools/storyboard /settings/connections)
else
  SHUT=("GET /api/settings" "POST /api/settings" "GET /api/local/catalog" "POST /api/local" "POST /api/comfy/relay" "GET /api/motion/projects"
    "GET /api/logins" "POST /api/siwc" "GET /api/accounts" "POST /api/vision" "POST /api/lab/judge" "PATCH /api/models" "POST /api/director/world"
    "GET /api/storyboards" "GET /api/templates/originals" "GET /api/templates/trends" "POST /api/recast" "GET /api/cast" "POST /api/library/projects"
    "GET /api/media/templates/x.mp4" "GET /api/media/out/motion/x/y.png")
  LEFT_OUT=(/settings /settings/connections /local /comfy /director /tools/motion /tools/storyboard /cast /auth/callback)
  OPEN=(/ /create /video /library /demo)
fi
for route in "${SHUT[@]}"; do
  set -- $route
  check "$route" 404 "$(status -X "$1" "$BASE$2")"
done

echo "Pages left out show the demo page instead:"
for page in "${LEFT_OUT[@]}"; do
  check "GET $page" 1 "$(curl -s "$BASE$page" | grep -c 'Try Crackio live' | sed 's/[2-9]/1/')"
done
echo "Demo pages open (200):"
for page in "${OPEN[@]}"; do
  check "GET $page" 200 "$(status "$BASE$page")"
done
if [ "$FULL" = 1 ]; then
  echo "The full demo's own tools: the real page, reads answer, writes need a code:"
  for page in /director /cast /tools/product /tools/storyboard /settings/connections; do
    check "$page is the tool" 0 "$(curl -s "$BASE$page" | grep -c 'Try Crackio live')"
  done
  for route in "GET /api/settings" "GET /api/cast" "GET /api/storyboard/projects" "GET /api/serverless" "GET /api/local/catalog" "GET /api/vision"; do
    set -- $route
    check "$route" 200 "$(status -X "$1" "$BASE$2")"
  done
  for route in "PATCH /api/settings" "POST /api/director/world" "POST /api/storyboard/projects" "POST /api/serverless/endpoints" "POST /api/vision"; do
    set -- $route
    check "$route without a code" 401 "$(status -X "$1" -H 'Content-Type: application/json' -d '{}' "$BASE$2")"
  done
fi

echo "Without a code:"
check "POST /api/generations" 401 "$(status -X POST -H 'Content-Type: application/json' -d '{"tool":"create","prompt":"a red apple"}' "$BASE/api/generations")"
printf 'x' > "$TMP/x.png"
check "POST /api/uploads" 401 "$(status -X POST -F "file=@$(file "$TMP/x.png");type=image/png" "$BASE/api/uploads")"
check "a forged sign-in" 401 "$(status -X POST -H 'Cookie: crk_demo=abc.zzzzzzz.Zm9yZ2Vk' -H 'Content-Type: application/json' -d '{"tool":"create","prompt":"x"}' "$BASE/api/generations")"
check "a wrong code" 401 "$(status -X POST -H 'Content-Type: application/json' -d '{"code":"CRK-NOPE-NOPE"}' "$BASE/api/demo/session")"
check "GET /api/generations lists nothing" '{"items":[]}' "$(curl -s "$BASE/api/generations")"

echo "Signing in:"
check "code A" 200 "$(status -c "$JAR_A" -X POST -H 'Content-Type: application/json' -d "{\"code\":\"$CODE_A\"}" "$BASE/api/demo/session")"
check "code B" 200 "$(status -c "$JAR_B" -X POST -H 'Content-Type: application/json' -d "{\"code\":\"$CODE_B\"}" "$BASE/api/demo/session")"
credits() { curl -s -b "$1" "$BASE/api/demo/session" | sed -E 's/.*"credits":([0-9]+).*/\1/'; }
before="$(credits "$JAR_A")"

echo "A's work stays A's:"
# A real 8×8 PNG, with no image tools needed (a tiny red square).
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX/AAD///9BHTQRAAAAC0lEQVQI12NgwA8AABAAAWRJ9IwAAAAASUVORK5CYII=' | base64 -d > "$TMP/pic.png"
up="$(curl -s -b "$JAR_A" -F "file=@$(file "$TMP/pic.png");type=image/png" "$BASE/api/uploads")"
url="$(printf '%s' "$up" | sed -nE 's/.*"url":"([^"]+)".*/\1/p')"
check "A uploads a picture" 1 "$([ -n "$url" ] && echo 1 || echo 0)"
if [ -n "$url" ]; then
  check "A sees it" 200 "$(status -b "$JAR_A" "$BASE$url")"
  check "B doesn't" 404 "$(status -b "$JAR_B" "$BASE$url")"
  check "no code doesn't" 404 "$(status "$BASE$url")"
fi
printf 'hello' > "$TMP/note.txt"
check "a text file is refused" 415 "$(status -b "$JAR_A" -F "file=@$(file "$TMP/note.txt");type=text/plain" "$BASE/api/uploads")"
check "a fake clip is refused" 415 "$(status -b "$JAR_A" -F "file=@$(file "$TMP/note.txt");type=video/mp4" "$BASE/api/uploads")"
check "path tricks" 404 "$(status -b "$JAR_A" "$BASE/api/media/uploads/..%2F..%2Fdemo%2Fcodes.json")"
check "path tricks 2" 404 "$(status -b "$JAR_A" "$BASE/api/media/out/..%2Fcrackio.db")"

gen="$(curl -s -b "$JAR_A" -X POST -H 'Content-Type: application/json' -d '{"tool":"create","prompt":"a red apple on a table","model":"auto","params":{"kind":"image","options":{"resolution":"draft"}}}' "$BASE/api/generations")"
id="$(printf '%s' "$gen" | sed -nE 's/.*"id":"([^"]+)".*/\1/p' | head -1)"
check "A starts a picture" 1 "$([ -n "$id" ] && echo 1 || echo 0)"
if [ -n "$id" ]; then
  check "B can't read it" 404 "$(status -b "$JAR_B" "$BASE/api/generations/$id")"
  check "B can't cancel it" 404 "$(status -b "$JAR_B" -X POST "$BASE/api/generations/$id/cancel")"
  check "B can't delete it" 404 "$(status -b "$JAR_B" -X DELETE "$BASE/api/generations/$id")"
  check "B's list doesn't have it" 0 "$(curl -s -b "$JAR_B" "$BASE/api/generations" | grep -c "$id")"
  check "B's Library doesn't have it" 0 "$(curl -s -b "$JAR_B" "$BASE/api/library" | grep -c "$id")"
  check "B can't ask for it by id" '{"items":[]}' "$(curl -s -b "$JAR_B" "$BASE/api/generations?ids=$id")"
  check "A sees it" 200 "$(status -b "$JAR_A" "$BASE/api/generations/$id")"
  check "A paid for it" 1 "$([ "$(credits "$JAR_A")" -lt "$before" ] && echo 1 || echo 0)"
  check "one job at a time" 429 "$(status -b "$JAR_A" -X POST -H 'Content-Type: application/json' -d '{"tool":"create","prompt":"a green pear","params":{"kind":"image","options":{"resolution":"draft"}}}' "$BASE/api/generations")"
  curl -s -o /dev/null -b "$JAR_A" -X POST "$BASE/api/generations/$id/cancel"
fi
check "a clip past the limit is refused" 400 "$(status -b "$JAR_B" -X POST -H 'Content-Type: application/json' -d '{"tool":"video","prompt":"waves","params":{"kind":"video","options":{"duration":30,"resolution":"720p"}}}' "$BASE/api/generations")"

# The demo's RunPod endpoint id never leaves the server: give it as ENDPOINT_ID (or have RUNPOD_ENDPOINT_ID set).
ENDPOINT_ID="${ENDPOINT_ID:-${RUNPOD_ENDPOINT_ID:-}}"
if [ -n "$ENDPOINT_ID" ]; then
  echo "No answer names the RunPod endpoint:"
  check "GET /api/local" 0 "$(curl -s "$BASE/api/local" | grep -c "$ENDPOINT_ID")"
  check "POST /api/local/eta" 0 "$(curl -s -X POST -H 'Content-Type: application/json' -d '{"model":"local:flux3-klein","kind":"image"}' "$BASE/api/local/eta" | grep -c "$ENDPOINT_ID")"
  check "GET /api/models" 0 "$(curl -s "$BASE/api/models" | grep -c "$ENDPOINT_ID")"
  if [ -n "${id:-}" ]; then
    check "A's picture" 0 "$(curl -s -b "$JAR_A" "$BASE/api/generations/$id" | grep -c "$ENDPOINT_ID")"
    check "A's recipe" 0 "$(curl -s -b "$JAR_A" "$BASE/api/generations/$id/recipe" | grep -c "$ENDPOINT_ID")"
  fi
  if [ "$FULL" = 1 ]; then
    check "GET /api/serverless" 0 "$(curl -s -b "$JAR_A" "$BASE/api/serverless" | grep -c "$ENDPOINT_ID")"
    check "GET /api/local/cloud" 0 "$(curl -s -b "$JAR_A" "$BASE/api/local/cloud" | grep -c "$ENDPOINT_ID")"
  fi
fi

rm -rf "$TMP"
echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
