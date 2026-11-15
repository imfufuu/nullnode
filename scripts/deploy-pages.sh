#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# NullNode · publish the site to GitHub Pages
#
#   ./scripts/deploy-pages.sh                 push the current branch, enable
#                                             Pages (Actions source), deploy
#   ./scripts/deploy-pages.sh --no-push       deploy the branch as it is on origin
#   ./scripts/deploy-pages.sh --no-wait       fire the workflow and return
#
# Requires: gh (authenticated) — or just push and let .github/workflows/pages.yml
# run on its own. The workflow deploys whatever is on the branch it runs from,
# so no build step and no gh-pages branch are involved.
#
# Optional:
#   GITHUB_TOKEN   used by gh automatically; a classic PAT needs repo + workflow
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; A=$'\033[38;5;154m'; R=$'\033[31m'; X=$'\033[0m'
else B=""; DIM=""; A=""; R=""; X=""; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸ %s%s\n' "$A" "$*" "$X"; }
warn() { printf '%s! %s%s\n' "$R" "$*" "$X"; }
die()  { printf '%s✗ %s%s\n' "$R" "$*" "$X" >&2; exit 1; }

PUSH=1; WAIT=1
for arg in "$@"; do
  case "$arg" in
    --no-push) PUSH=0 ;;
    --no-wait) WAIT=0 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) die "unknown flag: $arg" ;;
  esac
done

command -v gh >/dev/null 2>&1 || die "GitHub CLI is required: https://cli.github.com"

step "Repository"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated — run: gh auth login"
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
OWNER=${REPO%%/*}
NAME=${REPO##*/}
say "  ${DIM}$REPO${X}"
say "  branch ${B}$BRANCH${X}"

# ---- local audit before anything leaves the machine ----------------------
if command -v node >/dev/null 2>&1; then
  step "Audit"
  node scripts/verify.mjs | sed 's/^/  /'
else
  warn "node not found — skipping the static audit"
fi

# ---- push ---------------------------------------------------------------
if [ "$PUSH" -eq 1 ]; then
  step "Pushing"
  git push -u origin "$BRANCH" 2>&1 | sed 's/^/  /'
else
  step "Skipping push"
fi

# ---- enable Pages (Actions source) --------------------------------------
step "GitHub Pages"
if gh api "repos/$REPO/pages" >/dev/null 2>&1; then
  say "  already enabled"
else
  if gh api -X POST "repos/$REPO/pages" -f build_type=workflow >/dev/null 2>&1; then
    say "  ${A}enabled${X} (build_type=workflow)"
  else
    warn "could not enable Pages with this token (needs the Pages permission)"
    cat <<TXT

  One click, then re-run this script:

    ${B}https://github.com/$REPO/settings/pages${X}
      Build and deployment → Source → ${B}GitHub Actions${X}

  Or use a token that may administer Pages:
    classic PAT scopes      repo, workflow
    fine-grained PAT        Contents: RW · Pages: RW · Workflows: RW · Administration: RW

TXT
  fi
fi

# ---- run the workflow ---------------------------------------------------
step "Deploying"
if ! gh workflow run pages.yml --ref "$BRANCH" >/dev/null 2>&1; then
  warn "could not dispatch the workflow (token may lack Actions:write)"
  say "  The workflow also runs on every push to main or arena/**, so the push"
  say "  above may already have started it:"
  say "  ${DIM}https://github.com/$REPO/actions/workflows/pages.yml${X}"
else
  say "  dispatched pages.yml on $BRANCH"
  if [ "$WAIT" -eq 1 ]; then
    sleep 4
    RUN_ID=$(gh run list --workflow pages.yml --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)
    if [ -n "${RUN_ID:-}" ]; then
      say "  run $RUN_ID — watching (ctrl-c is safe)"
      gh run watch "$RUN_ID" --exit-status >/dev/null 2>&1 || warn "the run did not finish green — check the link above"
    fi
  fi
fi

SITE="https://${OWNER}.github.io/${NAME}/"
cat <<TXT

${A}Site${X}
  ${B}$SITE${X}
  ${DIM}(first deploy takes 30–90 seconds; the url 404s until then)${X}

Wire the relay next:
  ./scripts/deploy-worker.sh --wire
  git push
TXT
