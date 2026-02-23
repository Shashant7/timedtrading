#!/bin/bash
# Full Candle-Based Backtest Script
# Usage: ./scripts/full-backtest.sh [start_date] [end_date] [ticker_batch_size]
# Example: ./scripts/full-backtest.sh 2025-07-01 2026-02-23 15

set -e

API_BASE="https://timed-trading-ingest.shashant.workers.dev"
API_KEY="AwesomeSauce"
START_DATE="${1:-2025-07-01}"
END_DATE="${2:-$(date '+%Y-%m-%d')}"
TICKER_BATCH="${3:-15}"
INTERVAL_MIN=5

HOLIDAYS="2025-07-04 2025-09-01 2025-11-27 2025-12-25 2026-01-01 2026-01-19 2026-02-16 2026-05-26 2026-07-03 2026-09-07 2026-11-26 2026-12-25"

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Candle-Based Backtest: $START_DATE → $END_DATE"
echo "║  Ticker batch: $TICKER_BATCH | Interval: ${INTERVAL_MIN}m"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ─── Step 0: Acquire replay lock ─────────────────────────────────────────────
echo "Step 0: Acquiring replay lock..."
LOCK_RESULT=$(curl -s -m 30 -X POST "$API_BASE/timed/admin/replay-lock?reason=backtest_${START_DATE}_${END_DATE}&key=$API_KEY")
echo "Lock: $(echo "$LOCK_RESULT" | jq -c '{ok, lock}' 2>/dev/null || echo "$LOCK_RESULT")"
echo ""

# ─── Step 1: Full reset ──────────────────────────────────────────────────────
echo "Step 1: Resetting all trade state (D1 + KV)..."
RESET_RESULT=$(curl -s -m 300 -X POST "$API_BASE/timed/admin/reset?resetLedger=1&key=$API_KEY")
echo "Reset: $(echo "$RESET_RESULT" | jq -c '{ok, kvCleared}' 2>/dev/null || echo "$RESET_RESULT")"
echo ""

TOTAL_TICKERS=$(curl -s "$API_BASE/timed/admin/alpaca-status?key=$API_KEY" | jq -r '.total_tickers // 200' 2>/dev/null || echo "200")
echo "Total tickers in universe: $TOTAL_TICKERS"
echo ""

# ─── Step 1.5: Backfill candle data from Alpaca ─────────────────────────────
# Strategy: 3 tickers at a time, synchronous (handler awaits result).
# Each call runs all 8 TFs for 3 tickers. Curl timeout=600s (10 min).
START_EPOCH=$(date -j -f "%Y-%m-%d" "$START_DATE" "+%s" 2>/dev/null || date -d "$START_DATE" "+%s")
NOW_EPOCH=$(date "+%s")
SINCE_DAYS=$(( (NOW_EPOCH - START_EPOCH) / 86400 + 60 ))
BF_BATCH=3

echo "Step 1.5: Backfilling candle data from Alpaca (sinceDays=$SINCE_DAYS)..."
echo "  $TOTAL_TICKERS tickers × 8 TFs, $BF_BATCH tickers per call (synchronous)"
echo ""

BF_OFFSET=0
BF_ROUND=0
BF_TOTAL_UPSERTED=0
BF_TOTAL_ERRORS=0
BF_START_TS=$(date +%s)

while [ "$BF_OFFSET" -lt "$TOTAL_TICKERS" ]; do
  BF_ROUND=$((BF_ROUND + 1))
  REMAINING=$((TOTAL_TICKERS - BF_OFFSET))
  THIS_BATCH=$(( REMAINING < BF_BATCH ? REMAINING : BF_BATCH ))

  echo -n "  [$BF_ROUND] offset=$BF_OFFSET ($THIS_BATCH tickers)... "

  BF_RESULT=$(curl -s -m 600 -X POST \
    "$API_BASE/timed/admin/alpaca-backfill?sinceDays=$SINCE_DAYS&tf=all&offset=$BF_OFFSET&limit=$THIS_BATCH&key=$API_KEY" 2>&1)
  BF_OK=$(echo "$BF_RESULT" | jq -r '.ok // false' 2>/dev/null || echo "false")
  UPSERTED=$(echo "$BF_RESULT" | jq -r '.upserted // 0' 2>/dev/null || echo "0")
  BF_ERRS=$(echo "$BF_RESULT" | jq -r '.errors // 0' 2>/dev/null || echo "0")

  BF_TOTAL_UPSERTED=$((BF_TOTAL_UPSERTED + UPSERTED))
  BF_TOTAL_ERRORS=$((BF_TOTAL_ERRORS + BF_ERRS))
  ELAPSED=$(( $(date +%s) - BF_START_TS ))
  PCTDONE=$(( (BF_OFFSET + THIS_BATCH) * 100 / TOTAL_TICKERS ))

  if [[ "$BF_OK" == "true" ]]; then
    echo "done (${UPSERTED} candles, ${BF_ERRS}err) [${PCTDONE}% | ${ELAPSED}s]"
  else
    echo "ERROR: $(echo "$BF_RESULT" | head -c 300) [${ELAPSED}s]"
  fi

  BF_OFFSET=$((BF_OFFSET + BF_BATCH))
  sleep 2
done

BF_ELAPSED=$(( $(date +%s) - BF_START_TS ))
echo ""
echo "  Backfill complete: ${BF_TOTAL_UPSERTED} total candles, ${BF_TOTAL_ERRORS} errors (${BF_ELAPSED}s)"
echo ""

# ─── Step 2: Process each trading day ────────────────────────────────────────
CURRENT_DATE="$START_DATE"
TOTAL_TRADES=0
TOTAL_SCORED=0
DAY_COUNT=0
SKIP_COUNT=0
IS_FIRST_BATCH=true

while [[ "$CURRENT_DATE" < "$END_DATE" ]] || [[ "$CURRENT_DATE" == "$END_DATE" ]]; do
  DAY_OF_WEEK=$(date -j -f "%Y-%m-%d" "$CURRENT_DATE" "+%u" 2>/dev/null || date -d "$CURRENT_DATE" "+%u")
  if [[ "$DAY_OF_WEEK" -ge 6 ]]; then
    CURRENT_DATE=$(date -j -v+1d -f "%Y-%m-%d" "$CURRENT_DATE" "+%Y-%m-%d" 2>/dev/null || date -d "$CURRENT_DATE + 1 day" "+%Y-%m-%d")
    continue
  fi

  if [[ " $HOLIDAYS " == *" $CURRENT_DATE "* ]]; then
    SKIP_COUNT=$((SKIP_COUNT + 1))
    CURRENT_DATE=$(date -j -v+1d -f "%Y-%m-%d" "$CURRENT_DATE" "+%Y-%m-%d" 2>/dev/null || date -d "$CURRENT_DATE + 1 day" "+%Y-%m-%d")
    continue
  fi

  echo "=== Processing $CURRENT_DATE ==="
  DAY_COUNT=$((DAY_COUNT + 1))
  DAY_TRADES=0
  DAY_SCORED=0

  TICKER_OFFSET=0
  HAS_MORE=true

  while $HAS_MORE; do
    CLEAN_PARAM=""
    if $IS_FIRST_BATCH; then
      CLEAN_PARAM="&cleanSlate=1"
      IS_FIRST_BATCH=false
    fi

    RESULT=$(curl -s -m 600 -X POST \
      "$API_BASE/timed/admin/candle-replay?date=$CURRENT_DATE&tickerOffset=$TICKER_OFFSET&tickerBatch=$TICKER_BATCH&intervalMinutes=$INTERVAL_MIN&key=$API_KEY${CLEAN_PARAM}" 2>&1)

    SCORED=$(echo "$RESULT" | jq -r '.scored // 0' 2>/dev/null || echo "0")
    TRADES=$(echo "$RESULT" | jq -r '.tradesCreated // 0' 2>/dev/null || echo "0")
    MORE=$(echo "$RESULT" | jq -r '.hasMore // false' 2>/dev/null || echo "false")
    NEXT_OFFSET=$(echo "$RESULT" | jq -r '.nextTickerOffset // "null"' 2>/dev/null || echo "null")
    ERRS=$(echo "$RESULT" | jq -r '.errorsCount // 0' 2>/dev/null || echo "0")
    TOTAL_TR=$(echo "$RESULT" | jq -r '.totalTrades // 0' 2>/dev/null || echo "0")
    D1_STATE=$(echo "$RESULT" | jq -r '.d1StateWritten // 0' 2>/dev/null || echo "0")
    STAGES=$(echo "$RESULT" | jq -c '.stageCounts // {}' 2>/dev/null || echo "{}")
    BLOCKS=$(echo "$RESULT" | jq -c '.blockReasons // {}' 2>/dev/null || echo "{}")

    DAY_SCORED=$((DAY_SCORED + SCORED))
    DAY_TRADES=$((DAY_TRADES + TRADES))

    echo "  offset=$TICKER_OFFSET: scored=$SCORED trades=$TRADES d1=$D1_STATE errors=$ERRS (total=$TOTAL_TR) $STAGES"

    if [[ "$DAY_COUNT" -le 3 ]] && [[ "$TICKER_OFFSET" -eq 0 ]] && [[ "$BLOCKS" != "{}" ]]; then
      echo "    blockReasons: $BLOCKS"
    fi

    if [[ "$MORE" == "true" ]] && [[ "$NEXT_OFFSET" != "null" ]]; then
      TICKER_OFFSET=$NEXT_OFFSET
    else
      HAS_MORE=false
    fi

    sleep 1
  done

  TOTAL_TRADES=$((TOTAL_TRADES + DAY_TRADES))
  TOTAL_SCORED=$((TOTAL_SCORED + DAY_SCORED))

  echo "  Day complete: scored=$DAY_SCORED trades=$DAY_TRADES"
  echo ""

  CURRENT_DATE=$(date -j -v+1d -f "%Y-%m-%d" "$CURRENT_DATE" "+%Y-%m-%d" 2>/dev/null || date -d "$CURRENT_DATE + 1 day" "+%Y-%m-%d")
done

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Backtest Complete"
echo "║  Days processed: $DAY_COUNT (skipped $SKIP_COUNT holidays)"
echo "║  Total scored: $TOTAL_SCORED"
echo "║  Total trades: $TOTAL_TRADES"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ─── Step 2b: Close open positions if end date is in the past ────────────────
TODAY_KEY=$(date "+%Y-%m-%d")
if [[ "$END_DATE" < "$TODAY_KEY" ]]; then
  echo "=== Closing open positions at replay end ($END_DATE) ==="
  CLOSE_RESULT=$(curl -s -m 120 -X POST "$API_BASE/timed/admin/close-replay-positions?date=$END_DATE&key=$API_KEY" 2>&1)
  CLOSED_COUNT=$(echo "$CLOSE_RESULT" | jq -r '.closed // 0' 2>/dev/null || echo "0")
  echo "Closed $CLOSED_COUNT open positions at $END_DATE market close"
else
  echo "=== End date is today ($END_DATE) — keeping open positions as-is ==="
fi
echo ""

# ─── Step 3: Final statistics ────────────────────────────────────────────────
echo "=== Trade Statistics ==="
TRADES_DATA=$(curl -s "$API_BASE/timed/trades?source=kv&key=$API_KEY" 2>&1)

echo "$TRADES_DATA" | jq '{
  totalTrades: (.trades | length),
  byDirection: (.trades | group_by(.direction) | map({direction: .[0].direction, count: length})),
  byStatus: (.trades | group_by(.status) | map({status: .[0].status, count: length})),
  openCount: ([.trades[] | select(.status == "OPEN")] | length)
}' 2>/dev/null || echo "Could not parse trade data"

echo ""
echo "=== P&L Statistics ==="
echo "$TRADES_DATA" | jq '{
  wins: ([.trades[] | select(.status == "WIN")] | length),
  losses: ([.trades[] | select(.status == "LOSS")] | length),
  avgWinPct: (([.trades[] | select(.status == "WIN") | .pnlPct] | if length > 0 then (add / length) else 0 end) | . * 100 | floor / 100),
  avgLossPct: (([.trades[] | select(.status == "LOSS") | .pnlPct] | if length > 0 then (add / length) else 0 end) | . * 100 | floor / 100),
  totalRealizedPnlPct: (([.trades[] | select(.status == "WIN" or .status == "LOSS") | .pnlPct] | add) // 0 | . * 100 | floor / 100)
}' 2>/dev/null || echo "Could not parse P&L data"

# ─── Step 4: Release replay lock ─────────────────────────────────────────────
echo ""
echo "=== Releasing replay lock ==="
UNLOCK_RESULT=$(curl -s -m 30 -X DELETE "$API_BASE/timed/admin/replay-lock?key=$API_KEY")
echo "Unlock: $(echo "$UNLOCK_RESULT" | jq -c '{ok, released}' 2>/dev/null || echo "$UNLOCK_RESULT")"
echo ""
echo "=== All done ==="
