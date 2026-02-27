#!/bin/bash
# Smart historical candle backfill — checks gaps first, only fills what's missing
#
# Runs candle-gaps check before fetching. If data is complete, exits immediately
# (0 TwelveData credits). Only backfills tickers with gaps to conserve credits.
#
# Usage:
#   ./scripts/backfill-history.sh           # Smart: check first, backfill only gaps
#   ./scripts/backfill-history.sh --force    # Skip check, full backfill (burns credits)
#   DATA_PROVIDER=alpaca ./scripts/backfill-history.sh
#
# Prerequisites:
#   TWELVEDATA_API_KEY (or ALPACA credentials if using alpaca)
#   TIMED_API_KEY (default: AwesomeSauce)
#   Worker must be deployed (for gap check)

set -e

API_BASE="${WORKER_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:-AwesomeSauce}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# 450 days back (matches deepest TF lookback)
GAP_END=$(date "+%Y-%m-%d")
GAP_START=$(date -j -v-450d -f "%Y-%m-%d" "$GAP_END" "+%Y-%m-%d" 2>/dev/null || date -d "$GAP_END 450 days ago" "+%Y-%m-%d" 2>/dev/null || echo "2024-01-01")

FORCE=false
for arg in "$@"; do
  [[ "$arg" == "--force" ]] && FORCE=true
done

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Smart Historical Candle Backfill                     ║"
echo "║  Checks gaps first → only fills what's missing       ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

export DATA_PROVIDER="${DATA_PROVIDER:-twelvedata}"
export TIMED_API_KEY="$API_KEY"

if [[ "$FORCE" != "true" ]]; then
  echo "Step 1: Checking candle coverage ($GAP_START → $GAP_END)..."
  GAP_RESULT=$(curl -s -m 120 \
    "$API_BASE/timed/admin/candle-gaps?startDate=$GAP_START&endDate=$GAP_END&key=$API_KEY" 2>&1)
  ALL_CLEAR=$(echo "$GAP_RESULT" | jq -r '.allClear // false' 2>/dev/null || echo "false")
  GAP_COUNT=$(echo "$GAP_RESULT" | jq -r '.gapCount // 0' 2>/dev/null || echo "0")
  TICKERS_WITH_GAPS=$(echo "$GAP_RESULT" | jq -r '.tickersWithGaps // 0' 2>/dev/null || echo "0")

  if [[ "$ALL_CLEAR" == "true" ]]; then
    echo "  ✓ All data present — no gaps. Skipping backfill (0 credits)."
    echo ""
    echo "Done. Run backtests with ./scripts/full-backtest.sh"
    exit 0
  fi

  echo "  Found $GAP_COUNT gaps across $TICKERS_WITH_GAPS tickers. Backfilling only those..."
  echo ""

  TICKERS_NEEDED=$(echo "$GAP_RESULT" | jq -r '.tickersNeedingBackfill | join(",")' 2>/dev/null)
  if [[ -z "$TICKERS_NEEDED" ]]; then
    echo "  Could not parse ticker list. Use --force for full backfill."
    exit 1
  fi

  node scripts/alpaca-backfill.js --tickers "$TICKERS_NEEDED"
else
  echo "Force mode: skipping gap check, full backfill (uses ~1,400 credits)"
  echo ""
  node scripts/alpaca-backfill.js
fi

echo ""
echo "Done. Run backtests with ./scripts/full-backtest.sh"
