#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-frontend.sh — Build all frontend source files, verify freshness,
# and deploy to Cloudflare Pages in one step.
#
# Usage:  bash scripts/deploy-frontend.sh
#   or:   npm run deploy:frontend
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

echo ""
echo "╔═══════════════════════════════════════════════════╗"
echo "║         Frontend Build & Deploy Pipeline          ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""

# ── 1. Build ─────────────────────────────────────────────────────────────────
echo "▸ [1/4] Building index-react (JSX → compiled JS + HTML)..."
npm run build:analysis

echo "▸ [2/4] Building shared-right-rail (JSX → compiled JS)..."
npm run build:rail

echo "▸ [3/4] Embedding simulation-dashboard into worker bundle..."
node scripts/embed-dashboard.js

# ── 2. Freshness guard ───────────────────────────────────────────────────────
echo ""
echo "▸ Freshness check..."
fail=0
check_fresh() {
  local src="$1" compiled="$2"
  if [ ! -f "$compiled" ]; then
    echo "  ✗ MISSING: $compiled (expected from $src)"
    fail=1
  elif [ "$src" -nt "$compiled" ]; then
    echo "  ✗ STALE:   $compiled is older than $src"
    fail=1
  else
    echo "  ✓ OK:      $compiled"
  fi
}

check_fresh react-app/index-react.source.html       react-app/index-react.html
check_fresh react-app/shared-right-rail.js           react-app/shared-right-rail.compiled.js
check_fresh react-app/simulation-dashboard.html      worker/dashboard-html.js

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "✗ Aborting: stale or missing compiled files detected above."
  echo "  Fix the build step that failed and re-run."
  exit 1
fi

# ── 3. Deploy to Cloudflare Pages ────────────────────────────────────────────
echo ""
echo "▸ [4/4] Deploying react-app/ to Cloudflare Pages..."
npx wrangler pages deploy react-app --project-name=timedtrading --branch=main --commit-dirty=true

echo ""
echo "╔═══════════════════════════════════════════════════╗"
echo "║          ✓ Frontend deployed successfully         ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""
