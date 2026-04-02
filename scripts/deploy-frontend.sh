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
echo "▸ [1/3] Building Pages frontend output..."
npm run build:frontend

echo "▸ [2/3] Embedding compiled simulation-dashboard into worker bundle..."
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

check_fresh react-app/index-react.source.html        react-app-dist/index-react.html
check_fresh react-app/shared-right-rail.js           react-app-dist/shared-right-rail.compiled.js
check_fresh react-app/simulation-dashboard.html      react-app-dist/simulation-dashboard.html
check_fresh react-app/tailwind.input.css             react-app-dist/tailwind.generated.css
check_fresh react-app-dist/simulation-dashboard.html worker/dashboard-html.js

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "✗ Aborting: stale or missing compiled files detected above."
  echo "  Fix the build step that failed and re-run."
  exit 1
fi

# ── 3. Deploy to Cloudflare Pages ────────────────────────────────────────────
echo ""
echo "▸ [3/3] Deploying react-app-dist/ to Cloudflare Pages..."
npx wrangler pages deploy react-app-dist --project-name=timedtrading --branch=main --commit-dirty=true

echo ""
echo "╔═══════════════════════════════════════════════════╗"
echo "║          ✓ Frontend deployed successfully         ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""
