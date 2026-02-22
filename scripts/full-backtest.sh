#!/bin/bash
# Full Candle-Based Backtest Script
# Generates scoring snapshots from Alpaca historical candle data, no trail/webhook dependency.
# Usage: ./scripts/full-backtest.sh [start_date] [end_date] [ticker_batch_size]
# Example: ./scripts/full-backtest.sh 2026-01-13 2026-02-07
# Example: ./scripts/full-backtest.sh 2026-01-13 2026-02-07 20

set -e

API_BASE="https://timed-trading-ingest.shashant.workers.dev"
API_KEY="AwesomeSauce"
START_DATE="${1:-2026-01-13}"
END_DATE="${2:-2026-02-07}"
TICKER_BATCH="${3:-15}"
INTERVAL_MIN=5

echo "=== Candle-Based Backtest: $START_DATE to $END_DATE ==="
echo "Ticker batch: $TICKER_BATCH | Interval: ${INTERVAL_MIN}m"
echo ""

# Step 1: Reset trades (cleanSlate on first batch of first day)
echo "Step 1: Resetting trades..."
RESET_RESULT=$(curl -s -m 300 -X POST "$API_BASE/timed/admin/reset?resetTrades=1&key=$API_KEY")
echo "Reset: $(echo "$RESET_RESULT" | jq -c '{ok, kvCleared}' 2>/dev/null || echo "$RESET_RESULT")"
echo ""

# Get total ticker count
TOTAL_TICKERS=$(curl -s "$API_BASE/timed/admin/alpaca-status?key=$API_KEY" | jq -r '.total_tickers // 200' 2>/dev/null || echo "200")
echo "Total tickers in universe: $TOTAL_TICKERS"
echo ""

# Step 2: Process each trading day
CURRENT_DATE="$START_DATE"
TOTAL_TRADES=0
TOTAL_SCORED=0
DAY_COUNT=0
IS_FIRST_BATCH=true

while [[ "$CURRENT_DATE" < "$END_DATE" ]] || [[ "$CURRENT_DATE" == "$END_DATE" ]]; do
  # Skip weekends
  DAY_OF_WEEK=$(date -j -f "%Y-%m-%d" "$CURRENT_DATE" "+%u" 2>/dev/null || date -d "$CURRENT_DATE" "+%u")
  if [[ "$DAY_OF_WEEK" -ge 6 ]]; then
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
    # cleanSlate only on the very first API call
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
    
    DAY_SCORED=$((DAY_SCORED + SCORED))
    DAY_TRADES=$((DAY_TRADES + TRADES))
    
    echo "  offset=$TICKER_OFFSET: scored=$SCORED trades=$TRADES d1=$D1_STATE errors=$ERRS (total=$TOTAL_TR) $STAGES"
    
    if [[ "$MORE" == "true" ]] && [[ "$NEXT_OFFSET" != "null" ]]; then
      TICKER_OFFSET=$NEXT_OFFSET
    else
      HAS_MORE=false
    fi
    
    # Small delay to avoid rate limiting
    sleep 1
  done
  
  TOTAL_TRADES=$((TOTAL_TRADES + DAY_TRADES))
  TOTAL_SCORED=$((TOTAL_SCORED + DAY_SCORED))
  
  echo "  Day complete: scored=$DAY_SCORED trades=$DAY_TRADES"
  echo ""
  
  # Move to next day
  CURRENT_DATE=$(date -j -v+1d -f "%Y-%m-%d" "$CURRENT_DATE" "+%Y-%m-%d" 2>/dev/null || date -d "$CURRENT_DATE + 1 day" "+%Y-%m-%d")
done

echo "=== Backtest Complete ==="
echo "Days processed: $DAY_COUNT"
echo "Total scored: $TOTAL_SCORED"
echo "Total trades: $TOTAL_TRADES"
echo ""

# Step 3: Get final statistics
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
