#!/bin/bash
# Double-click to start Crackio on a Mac. The first time, right-click it and choose Open.
cd "$(dirname "$0")" || exit 1
PORT="${CRACKIO_PORT:-3211}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

fail() {
  echo ""
  echo "  $1"
  read -r -p "  Press Enter to close this window." _
  exit 1
}

echo ""
echo "  Crackio"
echo "  -------"
echo ""

# 1. Node.js 22.13 or newer.
if ! command -v node >/dev/null 2>&1; then
  open "https://nodejs.org/en/download"
  fail "Crackio needs Node.js, version 22.13 or newer. The download page is open: install Node.js, then double-click this file again."
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  open "https://nodejs.org/en/download"
  fail "Your Node.js is $(node -v), and Crackio needs 22.13 or newer. The download page is open: install the newest one, then double-click this file again."
fi
echo "  Node.js $(node -v) found."

# 2. pnpm, through Corepack, which comes with Node.js; npx when Corepack isn't there.
if command -v corepack >/dev/null 2>&1; then PNPM=(corepack pnpm); else PNPM=(npx --yes pnpm@11.15.1); fi

# 3. Packages.
echo "  Installing what Crackio needs. The first time takes a few minutes..."
"${PNPM[@]}" install || fail "Installing didn't work. Check your internet connection and try again."

# 4. Build, only when the code changed.
if node scripts/launch/needs-build.mjs; then
  echo "  Building Crackio. A few minutes, only after an update..."
  "${PNPM[@]}" build || fail "The build didn't work. Copy the messages above into an issue on GitHub."
else
  echo "  Crackio is already built."
fi

# 5. Start, and open the browser once Crackio answers.
echo ""
echo "  Starting Crackio at http://localhost:$PORT"
echo "  Your browser opens by itself. Keep this window open while you use Crackio: closing it stops Crackio."
echo ""
node scripts/launch/open-when-ready.mjs "http://localhost:$PORT" &
"${PNPM[@]}" start -p "$PORT"
echo ""
read -r -p "  Crackio stopped. Press Enter to close this window." _
