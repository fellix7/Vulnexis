#!/usr/bin/env bash
# Start Vulnexis on your machine (macOS / Linux).
#   ./demo/start.sh            live data (needs internet), http://localhost:8787
#   ./demo/start.sh --offline  saved snapshots only (bundled sample + demo data work without internet)
set -euo pipefail
cd "$(dirname "$0")/.."

need_major=22
have=$(node -p 'process.versions.node' 2>/dev/null || echo 0)
if [ "${have%%.*}" -lt "$need_major" ]; then
  echo "Vulnexis needs Node.js $need_major or newer (found: $have). Install it from https://nodejs.org" >&2
  exit 1
fi

[ -d node_modules ] || npm install --no-audit --no-fund
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env. Add GEMINI_API_KEY=... to it to turn on the AI code check (free key: https://aistudio.google.com/apikey)."
fi

npm run build

port=$(grep -E '^PORT=' .env | cut -d= -f2); port=${port:-8787}
ip=$( (ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}') || true)
echo
echo "Vulnexis is starting:"
echo "  this computer:  http://localhost:$port"
[ -n "$ip" ] && echo "  your phone (same Wi-Fi):  http://$ip:$port"
echo "Stop with Ctrl+C."
echo

if [ "${1:-}" = "--offline" ]; then export OFFLINE=1; fi
exec npm start
