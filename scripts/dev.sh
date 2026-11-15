#!/usr/bin/env bash
# Local development: static site on :8080, relay on :8787, both hot.
#   ./scripts/dev.sh
# Open http://localhost:8080 — the page is served with the relay baked in, so
# relay mode works out of the box on one origin (no CORS, no ?relay= juggling).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -t 1 ]; then A=$'\033[38;5;154m'; DIM=$'\033[2m'; X=$'\033[0m'; else A=""; DIM=""; X=""; fi
cleanup() { [ -n "${RELAY_PID:-}" ] && kill "$RELAY_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if [ ! -d worker/node_modules ]; then
  echo "${DIM}installing worker deps…${X}"
  (cd worker && npm install --no-audit --no-fund >/dev/null)
fi

(cd worker && npx wrangler dev --local --port 8787 --ip 0.0.0.0) &
RELAY_PID=$!
sleep 3

echo
echo "${A}site${X}   http://localhost:8080/            ${DIM}(relay url injected automatically)${X}"
echo "${A}relay${X}  http://127.0.0.1:8787/health     ${DIM}(also proxied at :8080/relay)${X}"
echo "${DIM}ctrl-c stops both${X}"
echo
exec node scripts/preview-server.mjs
