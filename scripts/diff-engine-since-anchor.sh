#!/usr/bin/env bash
# Summarize worker/engine changes since the Phase C anchor deploy commit.
# Output: data/trade-analysis/phase-c-slice-2025-07-v1/engine-diff-since-anchor.md
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANCHOR_COMMIT="${ANCHOR_COMMIT:-1d7d8d3}"
OUT="${OUT:-$REPO_ROOT/data/trade-analysis/phase-c-slice-2025-07-v1/engine-diff-since-anchor.md}"
PATHS=(
  worker/pipeline/tt-core-entry.js
  worker/pipeline/index-etf-model.js
  worker/phase-c-setup-admission.js
  worker/phase-c-exit-doctrine.js
  worker/replay-candle-batches.js
  worker/pipeline/entry-selector.js
)

mkdir -p "$(dirname "$OUT")"
{
  echo "# Engine diff since Phase C anchor"
  echo ""
  echo "| Field | Value |"
  echo "|---|---|"
  echo "| Anchor deploy commit | \`${ANCHOR_COMMIT}\` |"
  echo "| HEAD | \`$(git -C "$REPO_ROOT" rev-parse --short HEAD)\` |"
  echo "| Generated | $(date -u '+%Y-%m-%dT%H:%M:%SZ') |"
  echo ""
  echo "## Commits touching entry/admission paths"
  echo ""
  git -C "$REPO_ROOT" log --oneline "${ANCHOR_COMMIT}..HEAD" -- "${PATHS[@]}" | head -40 || true
  echo ""
  echo "## File stats (${ANCHOR_COMMIT}..HEAD)"
  echo ""
  git -C "$REPO_ROOT" diff --stat "${ANCHOR_COMMIT}..HEAD" -- "${PATHS[@]}" || true
  echo ""
  echo "## Notable path keywords added since anchor (grep HEAD vs anchor)"
  echo ""
  for kw in tt_ath_breakout index_model_stock_path index_etf_swing tape_capitulation setup_demotion; do
    ac=$(git -C "$REPO_ROOT" show "${ANCHOR_COMMIT}:worker/pipeline/tt-core-entry.js" 2>/dev/null | grep -c "$kw" || echo 0)
    hd=$(grep -c "$kw" "$REPO_ROOT/worker/pipeline/tt-core-entry.js" 2>/dev/null || echo 0)
    echo "- \`${kw}\`: anchor=${ac}  HEAD=${hd}"
  done
  echo ""
  echo "_Re-run: ANCHOR_COMMIT=${ANCHOR_COMMIT} scripts/diff-engine-since-anchor.sh_"
} > "$OUT"

echo "$OUT"
