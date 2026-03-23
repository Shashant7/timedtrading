#!/bin/bash
# Comprehensive ticker-by-ticker, TF-by-TF backfill for the full universe.
# Goes through every TF in backtest order, batching 8 tickers at a time.
# Skips tickers known to be unsupported (futures, SPX).
#
# Usage: ./scripts/backfill-full-universe.sh [sinceDays]
#        ./scripts/backfill-full-universe.sh 450    # ~15 months back (default)
#        ./scripts/backfill-full-universe.sh 700    # ~2 years back

set -euo pipefail

API_BASE="${WORKER_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:-AwesomeSauce}"
SINCE_DAYS="${1:-450}"
BATCH_SIZE=8
SLEEP_BETWEEN=2

# Timeframes in priority order (critical for backtest first)
TFS=("D" "W" "M" "240" "60" "30" "15" "10")

# Unsupported tickers (futures + SPX — no TwelveData/Alpaca data)
SKIP="BRK-B CL1! ES1! GC1! NQ1! SI1! VX1! SPX"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Full Universe Backfill — ticker by ticker, TF by TF        ║"
echo "║  Since: ${SINCE_DAYS} days | Batch: ${BATCH_SIZE} tickers   ║"
echo "║  TFs: ${TFS[*]}                                             ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Total tickers in SECTOR_MAP (hardcoded, matches worker/index.js)
TOTAL=304
echo "Universe size: $TOTAL tickers"
echo "Skipping: $SKIP"
echo ""

grand_upserted=0
grand_errors=0
grand_skipped=0

for tf in "${TFS[@]}"; do
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  TF=$tf — backfilling $TOTAL tickers (batch=$BATCH_SIZE)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  tf_upserted=0
  tf_errors=0
  tf_batches=0

  for ((offset=0; offset<TOTAL; offset+=BATCH_SIZE)); do
    tf_batches=$((tf_batches + 1))
    result=$(curl -s -m 120 \
      "$API_BASE/timed/admin/alpaca-backfill?key=$API_KEY&tf=$tf&sinceDays=$SINCE_DAYS&offset=$offset&limit=$BATCH_SIZE" \
      -X POST 2>&1)

    ups=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('upserted',0))" 2>/dev/null || echo "0")
    errs=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('errors',0))" 2>/dev/null || echo "0")

    tf_upserted=$((tf_upserted + ups))
    tf_errors=$((tf_errors + errs))

    # Progress indicator
    pct=$(( (offset + BATCH_SIZE) * 100 / TOTAL ))
    [[ $pct -gt 100 ]] && pct=100
    printf "  [%3d%%] Batch %2d (offset=%3d): +%-6d err=%-4d\n" "$pct" "$tf_batches" "$offset" "$ups" "$errs"

    sleep $SLEEP_BETWEEN
  done

  grand_upserted=$((grand_upserted + tf_upserted))
  grand_errors=$((grand_errors + tf_errors))
  echo "  ── TF=$tf done: upserted=$tf_upserted errors=$tf_errors ($tf_batches batches)"
  echo ""
done

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  COMPLETE                                                    ║"
echo "║  Total upserted: $grand_upserted                            ║"
echo "║  Total errors:   $grand_errors                               ║"
echo "║  TFs covered:    ${TFS[*]}                                   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
