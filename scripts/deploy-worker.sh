#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# NullNode · deploy the signalling relay to Cloudflare
#
#   ./scripts/deploy-worker.sh              deploy, print the worker url
#   ./scripts/deploy-worker.sh --wire       deploy, then write the url into index.html
#   ./scripts/deploy-worker.sh --dry-run    build only, no upload
#
# Requires:
#   CLOUDFLARE_API_TOKEN   token with  Account → Workers Scripts:Edit
#                                    and  Account → Account Settings:Read
#   CLOUDFLARE_ACCOUNT_ID  the 32-char account id from the dashboard
#   (optional) CLOUDFLARE_WORKER_NAME  defaults to nullnode-relay
#
# Nothing is stored by the script except .deploy/worker-url.txt (git-ignored).
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ---- pretty output --------------------------------------------------------
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; A=$'\033[38;5;154m'; R=$'\033[31m'; X=$'\033[0m'
else
  B=""; DIM=""; A=""; R=""; X=""
fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸ %s%s\n' "$A" "$*" "$X"; }
die()  { printf '%s✗ %s%s\n' "$R" "$*" "$X" >&2; exit 1; }

# ---- optional env file ----------------------------------------------------
for f in deploy.env .env; do
  if [ -f "$ROOT/$f" ]; then
    # shellcheck disable=SC1090
    set -a; . "$ROOT/$f"; set +a
    say "${DIM}loaded $f${X}"
  fi
done

WIRE=0; DRY=0
for arg in "$@"; do
  case "$arg" in
    --wire) WIRE=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown flag: $arg" ;;
  esac
done

WORKER_NAME="${CLOUDFLARE_WORKER_NAME:-nullnode-relay}"

# ---- credentials ----------------------------------------------------------
step "Checking credentials"
missing=0
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  say "${R}missing${X} CLOUDFLARE_API_TOKEN"
  missing=1
fi
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  say "${R}missing${X} CLOUDFLARE_ACCOUNT_ID"
  missing=1
fi
if [ "$missing" -eq 1 ]; then
  cat <<TXT

Create both in about 40 seconds:
  1. dash.cloudflare.com → My Profile → API Tokens → Create Token
     Use the template "Edit Cloudflare Workers", or a custom token with:
       Account · Workers Scripts · Edit
       Account · Account Settings · Read
  2. The account id sits in the right-hand column of any zone's overview page,
     or in the dashboard url: dash.cloudflare.com/<ACCOUNT_ID>

Then either export them or copy deploy.env.example to deploy.env:

  export CLOUDFLARE_API_TOKEN="..."
  export CLOUDFLARE_ACCOUNT_ID="..."
  ./scripts/deploy-worker.sh

Full detail: docs/CREDENTIALS.md
TXT
  exit 1
fi
say "  token      ${DIM}${CLOUDFLARE_API_TOKEN:0:6}…${CLOUDFLARE_API_TOKEN: -4}${X}"
say "  account    ${DIM}$CLOUDFLARE_ACCOUNT_ID${X}"
say "  worker     ${DIM}$WORKER_NAME${X}"

# ---- toolchain ------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node 18+ is required (https://nodejs.org)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "node 18+ is required, found $(node -v)"

step "Deploying worker"
cd "$ROOT/worker"
if [ ! -d node_modules ]; then
  say "${DIM}installing wrangler (one time)…${X}"
  npm install --no-audit --no-fund >/dev/null 2>&1 || die "npm install failed"
fi

DEPLOY_ARGS=(deploy --name "$WORKER_NAME")
[ "$DRY" -eq 1 ] && DEPLOY_ARGS+=(--dry-run --outdir .wrangler/tmp)

set +e
out=$(CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
      CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" \
      npx --no-install wrangler "${DEPLOY_ARGS[@]}" 2>&1)
code=$?
set -e
printf '%s\n' "$out" | sed 's/^/  /'

if [ $code -ne 0 ]; then
  if printf '%s' "$out" | grep -qi "Authentication error\|10000\|not authorized"; then
    die "Cloudflare rejected the token. It needs Workers Scripts:Edit on this account."
  fi
  die "wrangler deploy failed (exit $code)"
fi

[ "$DRY" -eq 1 ] && { say "\n${A}dry run complete — nothing uploaded${X}"; exit 0; }

URL=$(printf '%s\n' "$out" | grep -Eo 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -n1 || true)
if [ -z "$URL" ]; then
  URL="https://${WORKER_NAME}.<your-subdomain>.workers.dev"
  say "\n${DIM}could not read the url from wrangler output — check the dashboard${X}"
fi

mkdir -p "$ROOT/.deploy"
printf '%s\n' "$URL" > "$ROOT/.deploy/worker-url.txt"

step "Verifying"
if printf '%s' "$URL" | grep -q '<your-subdomain>'; then
  say "  skipped (unknown url)"
else
  sleep 2
  if curl -fsS --max-time 10 "$URL/health" >/dev/null 2>&1; then
    say "  ${A}health ok${X}  $URL/health"
  else
    say "  ${DIM}health check inconclusive — new workers take a few seconds to propagate${X}"
  fi
fi

# ---- optionally wire the client ------------------------------------------
if [ "$WIRE" -eq 1 ] && ! printf '%s' "$URL" | grep -q '<your-subdomain>'; then
  step "Wiring the client"
  python3 - "$URL" <<'PY'
import re, sys, pathlib
url = sys.argv[1]
p = pathlib.Path('index.html')
s = p.read_text()
s2, n = re.subn(r'<meta name="nullnode-relay" content="[^"]*">',
                '<meta name="nullnode-relay" content="%s">' % url, s)
p.write_text(s2)
print('  meta updated' if n else '  meta tag not found')
PY
  git add index.html 2>/dev/null || true
  git commit -m "relay: point the client at $URL" >/dev/null 2>&1 || say "  ${DIM}nothing to commit${X}"
fi

cat <<TXT

${A}Relay live.${X}
  ${B}$URL${X}

Next:
  ${DIM}1.${X} open NullNode → room panel → sliders icon → paste the url → Save
  ${DIM}2.${X} or bake it into the page:  ./scripts/deploy-worker.sh --wire && git push
  ${DIM}3.${X} redeploy the pages site so visitors pick it up

Smoke test the relay from anywhere:
  node scripts/smoke-test.mjs $URL
TXT
