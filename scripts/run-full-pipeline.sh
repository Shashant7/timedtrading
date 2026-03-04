#!/bin/bash
# Full pipeline: 450-day backfill → fresh reset → walk-forward validation
#
# Usage:
#   TWELVEDATA_API_KEY=your_key TIMED_API_KEY=your_key ./scripts/run-full-pipeline.sh
#   TWELVEDATA_API_KEY=your_key ./scripts/run-full-pipeline.sh 2025-07-01 2026-02-26
#
# Prerequisites:
#   - TWELVEDATA_API_KEY (required for backfill)
#   - TIMED_API_KEY (default: AwesomeSauce)
#   - Worker deployed with 10m/30m pagination

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# Load .env if present (TWELVEDATA_API_KEY, TIMED_API_KEY)
[[ -f .env ]] && set -a && source .env && set +a

if [[ -z "$TWELVEDATA_API_KEY" ]]; then
  echo "ERROR: TWELVEDATA_API_KEY not set. Export it before running."
  echo "  Example: TWELVEDATA_API_KEY=your_key ./scripts/run-full-pipeline.sh"
  exit 1
fi

export TIMED_API_KEY="${TIMED_API_KEY:-AwesomeSauce}"
export DATA_PROVIDER="${DATA_PROVIDER:-twelvedata}"

TEST_START="${1:-2025-07-01}"
TEST_END="${2:-$(date '+%Y-%m-%d')}"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Full Pipeline: Backfill 450d → Reset → Walk-Forward         ║"
echo "║  Test period: $TEST_START → $TEST_END"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Step 1: Full backfill (all TFs, 450 days, including 10m/30m pagination)
echo "═══ Step 1/2: Backfill all TFs for 450 days ═══"
"$SCRIPT_DIR/backfill-history.sh" --force
echo ""

# Step 2: Walk-forward (reset + backtest + calibration + report)
echo "═══ Step 2/2: Walk-Forward Validation (reset + replay + calibration) ═══"
"$SCRIPT_DIR/walk-forward.sh" "$TEST_START" "$TEST_END" --skip-onboard
echo ""

echo "═══ Pipeline Complete ═══"
