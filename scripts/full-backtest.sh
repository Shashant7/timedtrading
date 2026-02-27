#!/bin/bash
# Full Candle-Based Backtest Script
# Usage: ./scripts/full-backtest.sh [start_date] [end_date] [ticker_batch_size]
#        ./scripts/full-backtest.sh --resume [--trader-only]
#        ./scripts/full-backtest.sh --trader-only 2025-07-01 2026-02-23 20
# Example: ./scripts/full-backtest.sh 2025-07-01 2026-02-23 15
# Resume: ./scripts/full-backtest.sh --resume
# Trader-only (faster, no investor/snapshots): add --trader-only
# Investor-only backfill (after trader-only): ./scripts/full-backtest.sh --investor-only 2025-07-01 2026-02-23
# Sequence (trader-only then investor-only): ./scripts/full-backtest.sh --sequence 2025-07-01 2026-02-23 20
# Interval: 4th arg defaults to 5 (minutes). We use 5 min for replay fidelity; 10 is optional for faster runs.
# Each day is processed in batch-by-batch requests (tickerBatch tickers per request) to stay
# within Cloudflare Worker CPU/wall-time limits. Investor replay runs on the last batch.
# Note: Backfill automatically detects candle gaps and only fills what's missing.

set -e

API_BASE="https://timed-trading-ingest.shashant.workers.dev"
API_KEY="AwesomeSauce"
CHECKPOINT_FILE="data/replay-checkpoint.txt"
HOLIDAYS="2025-07-04 2025-09-01 2025-11-27 2025-12-25 2026-01-01 2026-01-19 2026-02-16 2026-05-26 2026-07-03 2026-09-07 2026-11-26 2026-12-25"

RESUME=false
TRADER_ONLY=false
INVESTOR_ONLY=false
SEQUENCE=false
POSARGS=()
for arg in "$@"; do
  [[ "$arg" == "--resume" ]] && RESUME=true
  [[ "$arg" == "--trader-only" ]] && TRADER_ONLY=true
  [[ "$arg" == "--investor-only" ]] && INVESTOR_ONLY=true
  [[ "$arg" == "--sequence" ]] && SEQUENCE=true
  [[ "$arg" != --* ]] && POSARGS+=("$arg")
done
if $SEQUENCE; then TRADER_ONLY=true; fi

if $RESUME; then
  if [[ -f "$CHECKPOINT_FILE" ]]; then
    CHECKPOINT_DATE=$(cat "$CHECKPOINT_FILE" | head -1 | tr -d '[:space:]')
    CHECKPOINT_END=$(sed -n '2p' "$CHECKPOINT_FILE" | tr -d '[:space:]')
    CHECKPOINT_BATCH=$(sed -n '3p' "$CHECKPOINT_FILE" | tr -d '[:space:]')
    CHECKPOINT_INTERVAL=$(sed -n '4p' "$CHECKPOINT_FILE" | tr -d '[:space:]')
    START_DATE="${CHECKPOINT_DATE}"
    END_DATE="${CHECKPOINT_END:-$(date '+%Y-%m-%d')}"
    TICKER_BATCH="${CHECKPOINT_BATCH:-15}"
    INTERVAL_MIN="${CHECKPOINT_INTERVAL:-5}"
    echo "╔══════════════════════════════════════════════════════╗"
    echo "║  RESUMING Backtest from $START_DATE → $END_DATE"
    echo "║  Ticker batch: $TICKER_BATCH | Interval: ${INTERVAL_MIN}m"
    $TRADER_ONLY && echo "║  Mode: trader-only (investor/snapshots skipped)"
    echo "╚══════════════════════════════════════════════════════╝"
    echo ""
  else
    echo "ERROR: No checkpoint file found at $CHECKPOINT_FILE"
    echo "Run a fresh backtest first: ./scripts/full-backtest.sh 2025-07-01 2026-02-23 15"
    exit 1
  fi
else
  START_DATE="${POSARGS[0]:-2025-07-01}"
  END_DATE="${POSARGS[1]:-$(date '+%Y-%m-%d')}"
  TICKER_BATCH="${POSARGS[2]:-15}"
  INTERVAL_MIN="${POSARGS[3]:-5}"
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║  Candle-Based Backtest: $START_DATE → $END_DATE"
  echo "║  Ticker batch: $TICKER_BATCH | Interval: ${INTERVAL_MIN}m"
  $TRADER_ONLY && echo "║  Mode: trader-only (investor/snapshots skipped)"
  $SEQUENCE && echo "║  Mode: sequence (trader-only then investor-only)"
  echo "╚══════════════════════════════════════════════════════╝"
  echo ""
fi

# ─── Investor-only only: no lock/reset/backfill/replay, just investor-replay per day ─
if $INVESTOR_ONLY && ! $SEQUENCE; then
  START_DATE="${POSARGS[0]:-2025-07-01}"
  END_DATE="${POSARGS[1]:-2026-02-23}"
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║  Investor-only backfill: $START_DATE → $END_DATE"
  echo "╚══════════════════════════════════════════════════════╝"
  echo ""
  INV_CURRENT="$START_DATE"
  INV_DAY_COUNT=0
  while [[ "$INV_CURRENT" < "$END_DATE" ]] || [[ "$INV_CURRENT" == "$END_DATE" ]]; do
    DW=$(date -j -f "%Y-%m-%d" "$INV_CURRENT" "+%u" 2>/dev/null || date -d "$INV_CURRENT" "+%u")
    if [[ "$DW" -ge 6 ]]; then
      INV_CURRENT=$(date -j -v+1d -f "%Y-%m-%d" "$INV_CURRENT" "+%Y-%m-%d" 2>/dev/null || date -d "$INV_CURRENT + 1 day" "+%Y-%m-%d")
      continue
    fi
    if [[ " $HOLIDAYS " == *" $INV_CURRENT "* ]]; then
      INV_CURRENT=$(date -j -v+1d -f "%Y-%m-%d" "$INV_CURRENT" "+%Y-%m-%d" 2>/dev/null || date -d "$INV_CURRENT + 1 day" "+%Y-%m-%d")
      continue
    fi
    INV_RESULT=$(curl -s -m 120 -X POST "$API_BASE/timed/admin/investor-replay?date=$INV_CURRENT&key=$API_KEY" 2>&1)
    if ! echo "$INV_RESULT" | jq -e '.ok' >/dev/null 2>&1; then
      echo "ERROR: investor-replay failed for $INV_CURRENT: $(echo "$INV_RESULT" | head -c 300)"
      exit 1
    fi
    INV_DAY_COUNT=$((INV_DAY_COUNT + 1))
    echo "  $INV_CURRENT: ok"
    INV_CURRENT=$(date -j -v+1d -f "%Y-%m-%d" "$INV_CURRENT" "+%Y-%m-%d" 2>/dev/null || date -d "$INV_CURRENT + 1 day" "+%Y-%m-%d")
    sleep 1
  done
  echo ""
  echo "Investor-only backfill complete ($INV_DAY_COUNT days)."
  exit 0
fi

# ─── Step 0: Acquire replay lock ─────────────────────────────────────────────
echo "Step 0: Acquiring replay lock..."
LOCK_RESULT=$(curl -s -m 30 -X POST "$API_BASE/timed/admin/replay-lock?reason=backtest_${START_DATE}_${END_DATE}&key=$API_KEY")
echo "Lock: $(echo "$LOCK_RESULT" | jq -c '{ok, lock}' 2>/dev/null || echo "$LOCK_RESULT")"
echo ""

if $RESUME; then
  echo "Step 1: SKIPPED (resuming from checkpoint $START_DATE)"
  echo ""
  echo "Step 1.5: SKIPPED (backfill already complete)"
  echo ""
else
  # ─── Step 1: Full reset ────────────────────────────────────────────────────
  echo "Step 1: Resetting all trade state (D1 + KV)..."
  RESET_RESULT=$(curl -s -m 300 -X POST "$API_BASE/timed/admin/reset?resetLedger=1&key=$API_KEY")
  echo "Reset: $(echo "$RESET_RESULT" | jq -c '{ok, kvCleared}' 2>/dev/null || echo "$RESET_RESULT")"
  echo ""

  TOTAL_TICKERS=$(curl -s "$API_BASE/timed/admin/alpaca-status?key=$API_KEY" | jq -r '.total_tickers // 200' 2>/dev/null || echo "200")
  echo "Total tickers in universe: $TOTAL_TICKERS"
  echo ""

  # ─── Step 1.5: Backfill candle data ─────────────────────────────────────────
  # Backfill from 60 days before start (EMA/indicator warm-up) through end date
  BF_START_DATE=$(date -j -v-60d -f "%Y-%m-%d" "$START_DATE" "+%Y-%m-%d" 2>/dev/null || date -d "$START_DATE 60 days ago" "+%Y-%m-%d" 2>/dev/null || echo "$START_DATE")
  BF_BATCH=3

  echo "Step 1.5: Checking candle coverage (gap detection, range $BF_START_DATE → $END_DATE)..."
  GAP_RESULT=$(curl -s -m 120 \
    "$API_BASE/timed/admin/candle-gaps?startDate=$BF_START_DATE&endDate=$END_DATE&key=$API_KEY" 2>&1)
  GAP_OK=$(echo "$GAP_RESULT" | jq -r '.ok // false' 2>/dev/null || echo "false")
  ALL_CLEAR=$(echo "$GAP_RESULT" | jq -r '.allClear // false' 2>/dev/null || echo "false")
  TICKERS_WITH_GAPS=$(echo "$GAP_RESULT" | jq -r '.tickersWithGaps // 0' 2>/dev/null || echo "0")
  GAP_COUNT=$(echo "$GAP_RESULT" | jq -r '.gapCount // 0' 2>/dev/null || echo "0")

  if [[ "$GAP_OK" != "true" ]]; then
    echo "  WARNING: Gap check failed ($(echo "$GAP_RESULT" | head -c 200))"
    echo "  Falling back to full backfill..."
    ALL_CLEAR="false"
    TICKERS_WITH_GAPS="$TOTAL_TICKERS"
  fi

  if [[ "$ALL_CLEAR" == "true" ]]; then
    echo "  All candles present — no gaps detected. Skipping backfill."
    echo ""
  else
    BACKFILL_TICKERS=$(echo "$GAP_RESULT" | jq -r '.tickersNeedingBackfill[]' 2>/dev/null || echo "")
    BACKFILL_COUNT=$(echo "$BACKFILL_TICKERS" | grep -c . 2>/dev/null || echo "$TICKERS_WITH_GAPS")

    echo "  Found $GAP_COUNT gaps across $TICKERS_WITH_GAPS tickers. Backfilling..."
    echo ""

    BF_ROUND=0
    BF_TOTAL_UPSERTED=0
    BF_TOTAL_ERRORS=0
    BF_START_TS=$(date +%s)

    if [[ -n "$BACKFILL_TICKERS" ]]; then
      # Targeted backfill: only tickers with gaps, 3 at a time
      TICKER_ARRAY=()
      while IFS= read -r t; do
        [[ -n "$t" ]] && TICKER_ARRAY+=("$t")
      done <<< "$BACKFILL_TICKERS"

      BF_IDX=0
      while [ "$BF_IDX" -lt "${#TICKER_ARRAY[@]}" ]; do
        BF_ROUND=$((BF_ROUND + 1))
        BATCH_TICKERS=""
        BATCH_END=$((BF_IDX + BF_BATCH))
        while [ "$BF_IDX" -lt "$BATCH_END" ] && [ "$BF_IDX" -lt "${#TICKER_ARRAY[@]}" ]; do
          [[ -n "$BATCH_TICKERS" ]] && BATCH_TICKERS="${BATCH_TICKERS},"
          BATCH_TICKERS="${BATCH_TICKERS}${TICKER_ARRAY[$BF_IDX]}"
          BF_IDX=$((BF_IDX + 1))
        done

        echo -n "  [$BF_ROUND] $BATCH_TICKERS ... "

        # Backfill each ticker in the batch individually
        BATCH_UPSERTED=0
        BATCH_ERRS=0
        IFS=',' read -ra BTICKERS <<< "$BATCH_TICKERS"
        for BF_TICKER in "${BTICKERS[@]}"; do
          BF_RESULT=$(curl -s -m 600 -X POST \
            "$API_BASE/timed/admin/alpaca-backfill?startDate=$BF_START_DATE&endDate=$END_DATE&tf=all&ticker=$BF_TICKER&key=$API_KEY" 2>&1)
          UPSERTED=$(echo "$BF_RESULT" | jq -r '.upserted // 0' 2>/dev/null || echo "0")
          BF_ERR=$(echo "$BF_RESULT" | jq -r '.errors // 0' 2>/dev/null || echo "0")
          BATCH_UPSERTED=$((BATCH_UPSERTED + UPSERTED))
          BATCH_ERRS=$((BATCH_ERRS + BF_ERR))
        done

        BF_TOTAL_UPSERTED=$((BF_TOTAL_UPSERTED + BATCH_UPSERTED))
        BF_TOTAL_ERRORS=$((BF_TOTAL_ERRORS + BATCH_ERRS))
        ELAPSED=$(( $(date +%s) - BF_START_TS ))
        PCTDONE=$(( BF_IDX * 100 / ${#TICKER_ARRAY[@]} ))
        echo "done (${BATCH_UPSERTED} candles, ${BATCH_ERRS}err) [${PCTDONE}% | ${ELAPSED}s]"

        sleep 2
      done
    else
      # Fallback: full universe backfill (gap check returned no ticker list)
      BF_OFFSET=0
      while [ "$BF_OFFSET" -lt "$TOTAL_TICKERS" ]; do
        BF_ROUND=$((BF_ROUND + 1))
        REMAINING=$((TOTAL_TICKERS - BF_OFFSET))
        THIS_BATCH=$(( REMAINING < BF_BATCH ? REMAINING : BF_BATCH ))

        echo -n "  [$BF_ROUND] offset=$BF_OFFSET ($THIS_BATCH tickers)... "

        BF_RESULT=$(curl -s -m 600 -X POST \
          "$API_BASE/timed/admin/alpaca-backfill?startDate=$BF_START_DATE&endDate=$END_DATE&tf=all&offset=$BF_OFFSET&limit=$THIS_BATCH&key=$API_KEY" 2>&1)
        BF_OK_INNER=$(echo "$BF_RESULT" | jq -r '.ok // false' 2>/dev/null || echo "false")
        UPSERTED=$(echo "$BF_RESULT" | jq -r '.upserted // 0' 2>/dev/null || echo "0")
        BF_ERRS=$(echo "$BF_RESULT" | jq -r '.errors // 0' 2>/dev/null || echo "0")

        BF_TOTAL_UPSERTED=$((BF_TOTAL_UPSERTED + UPSERTED))
        BF_TOTAL_ERRORS=$((BF_TOTAL_ERRORS + BF_ERRS))
        ELAPSED=$(( $(date +%s) - BF_START_TS ))
        PCTDONE=$(( (BF_OFFSET + THIS_BATCH) * 100 / TOTAL_TICKERS ))

        if [[ "$BF_OK_INNER" == "true" ]]; then
          echo "done (${UPSERTED} candles, ${BF_ERRS}err) [${PCTDONE}% | ${ELAPSED}s]"
        else
          echo "ERROR: $(echo "$BF_RESULT" | head -c 300) [${ELAPSED}s]"
        fi

        BF_OFFSET=$((BF_OFFSET + BF_BATCH))
        sleep 2
      done
    fi

    BF_ELAPSED=$(( $(date +%s) - BF_START_TS ))
    echo ""
    echo "  Backfill complete: ${BF_TOTAL_UPSERTED} total candles, ${BF_TOTAL_ERRORS} errors (${BF_ELAPSED}s)"
    echo ""
  fi
fi

# ─── Step 2: Process each trading day ────────────────────────────────────────
CURRENT_DATE="$START_DATE"
TOTAL_TRADES=0
TOTAL_SCORED=0
DAY_COUNT=0
SKIP_COUNT=0
IS_FIRST_BATCH=true
if $RESUME; then IS_FIRST_BATCH=false; fi

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
  DAY_D1=0
  DAY_ERRS=0
  DAY_TOTAL_TR=0

  CLEAN_PARAM=""
  if $IS_FIRST_BATCH; then
    CLEAN_PARAM="&cleanSlate=1"
    IS_FIRST_BATCH=false
  fi
  SKIP_INV=""
  $TRADER_ONLY && SKIP_INV="&skipInvestor=1"

  # Process day in batches (avoids Cloudflare Worker CPU/wall-time limits on large DBs)
  BATCH_OFFSET=0
  BATCH_NUM=0
  while true; do
    BATCH_NUM=$((BATCH_NUM + 1))
    REPLAY_URL="$API_BASE/timed/admin/candle-replay?date=$CURRENT_DATE&tickerOffset=$BATCH_OFFSET&tickerBatch=$TICKER_BATCH&intervalMinutes=$INTERVAL_MIN&key=$API_KEY${CLEAN_PARAM}${SKIP_INV}"
    CLEAN_PARAM=""

    RESULT=""
    for retry in 1 2 3 4 5; do
      RESULT=$(curl -s -m 300 -X POST "$REPLAY_URL" 2>&1) || true
      if echo "$RESULT" | jq -e '.scored >= 0' >/dev/null 2>&1; then
        break
      fi
      echo "  batch $BATCH_NUM attempt $retry failed, retrying in 15s..."
      sleep 15
    done
    if ! echo "$RESULT" | jq -e '.scored >= 0' >/dev/null 2>&1; then
      echo "ERROR: candle-replay failed after 5 attempts on $CURRENT_DATE batch $BATCH_NUM (offset=$BATCH_OFFSET)."
      echo "  Last response: $(echo "$RESULT" | head -c 300)"
      exit 1
    fi

    B_SCORED=$(echo "$RESULT" | jq -r '.scored // 0' 2>/dev/null || echo "0")
    B_TRADES=$(echo "$RESULT" | jq -r '.tradesCreated // 0' 2>/dev/null || echo "0")
    B_ERRS=$(echo "$RESULT" | jq -r '.errorsCount // 0' 2>/dev/null || echo "0")
    B_TOTAL_TR=$(echo "$RESULT" | jq -r '.totalTrades // 0' 2>/dev/null || echo "0")
    B_D1=$(echo "$RESULT" | jq -r '.d1StateWritten // 0' 2>/dev/null || echo "0")
    B_HAS_MORE=$(echo "$RESULT" | jq -r '.hasMore // false' 2>/dev/null || echo "false")
    B_NEXT_OFFSET=$(echo "$RESULT" | jq -r '.nextTickerOffset // 0' 2>/dev/null || echo "0")
    B_TICKERS=$(echo "$RESULT" | jq -r '.tickersProcessed // 0' 2>/dev/null || echo "0")

    DAY_SCORED=$((DAY_SCORED + B_SCORED))
    DAY_TRADES=$((DAY_TRADES + B_TRADES))
    DAY_D1=$((DAY_D1 + B_D1))
    DAY_ERRS=$((DAY_ERRS + B_ERRS))
    DAY_TOTAL_TR=$B_TOTAL_TR

    echo "  batch $BATCH_NUM: ${B_TICKERS}tk scored=$B_SCORED trades=$B_TRADES d1=$B_D1 err=$B_ERRS"

    if [[ "$B_HAS_MORE" != "true" ]]; then
      break
    fi
    BATCH_OFFSET=$B_NEXT_OFFSET
    sleep 2
  done

  TOTAL_TRADES=$((TOTAL_TRADES + DAY_TRADES))
  TOTAL_SCORED=$((TOTAL_SCORED + DAY_SCORED))

  echo "  Day complete: scored=$DAY_SCORED trades=$DAY_TRADES total=$DAY_TOTAL_TR errors=$DAY_ERRS ($BATCH_NUM batches)"
  echo ""

  NEXT_DATE=$(date -j -v+1d -f "%Y-%m-%d" "$CURRENT_DATE" "+%Y-%m-%d" 2>/dev/null || date -d "$CURRENT_DATE + 1 day" "+%Y-%m-%d")
  mkdir -p "$(dirname "$CHECKPOINT_FILE")"
  printf '%s\n%s\n%s\n%s\n' "$NEXT_DATE" "$END_DATE" "$TICKER_BATCH" "$INTERVAL_MIN" > "$CHECKPOINT_FILE"

  CURRENT_DATE="$NEXT_DATE"
done

# ─── Phase 2 (sequence): investor-only backfill for same date range ─
if $SEQUENCE; then
  echo "=== Phase 2: Investor-only backfill ($START_DATE → $END_DATE) ==="
  INV_CURRENT="$START_DATE"
  INV_DAY_COUNT=0
  while [[ "$INV_CURRENT" < "$END_DATE" ]] || [[ "$INV_CURRENT" == "$END_DATE" ]]; do
    DW=$(date -j -f "%Y-%m-%d" "$INV_CURRENT" "+%u" 2>/dev/null || date -d "$INV_CURRENT" "+%u")
    if [[ "$DW" -ge 6 ]]; then
      INV_CURRENT=$(date -j -v+1d -f "%Y-%m-%d" "$INV_CURRENT" "+%Y-%m-%d" 2>/dev/null || date -d "$INV_CURRENT + 1 day" "+%Y-%m-%d")
      continue
    fi
    if [[ " $HOLIDAYS " == *" $INV_CURRENT "* ]]; then
      INV_CURRENT=$(date -j -v+1d -f "%Y-%m-%d" "$INV_CURRENT" "+%Y-%m-%d" 2>/dev/null || date -d "$INV_CURRENT + 1 day" "+%Y-%m-%d")
      continue
    fi
    INV_RESULT=$(curl -s -m 120 -X POST "$API_BASE/timed/admin/investor-replay?date=$INV_CURRENT&key=$API_KEY" 2>&1)
    if ! echo "$INV_RESULT" | jq -e '.ok' >/dev/null 2>&1; then
      echo "ERROR: investor-replay failed for $INV_CURRENT: $(echo "$INV_RESULT" | head -c 300)"
      exit 1
    fi
    INV_DAY_COUNT=$((INV_DAY_COUNT + 1))
    echo "  $INV_CURRENT: ok"
    INV_CURRENT=$(date -j -v+1d -f "%Y-%m-%d" "$INV_CURRENT" "+%Y-%m-%d" 2>/dev/null || date -d "$INV_CURRENT + 1 day" "+%Y-%m-%d")
    sleep 1
  done
  echo "  Investor backfill: $INV_DAY_COUNT days"
  echo ""
fi

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

rm -f "$CHECKPOINT_FILE"
echo "=== All done (checkpoint cleared) ==="
