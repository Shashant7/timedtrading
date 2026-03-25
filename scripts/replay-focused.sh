#!/bin/bash
# Focused Replay — replay specific tickers over a narrow date range for validation.
# Unlike full-backtest.sh, this does NOT reset/clear existing state. It replays
# the specified tickers in isolation and saves a compact report.
#
# Usage:
#   ./scripts/replay-focused.sh --tickers "AAPL,TSLA,NVDA" --start 2025-10-01 --end 2025-10-31
#   ./scripts/replay-focused.sh --tickers "AAPL" --start 2025-10-01 --end 2025-10-31 --label "aapl-deep-dive"
#   ./scripts/replay-focused.sh --from-losses 20  # Auto-pick the 20 worst-performing tickers

set -e

API_BASE="https://timed-trading-ingest.shashant.workers.dev"
API_KEY="AwesomeSauce"
HOLIDAYS="2025-07-04 2025-09-01 2025-11-27 2025-12-25 2026-01-01 2026-01-19 2026-02-16 2026-05-25 2026-07-03 2026-09-07 2026-11-26 2026-12-25"

TICKERS=""
START_DATE=""
END_DATE=""
RUN_LABEL=""
INTERVAL_MIN=5
FROM_LOSSES=0
SKIP_BACKFILL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tickers) TICKERS="$2"; shift 2 ;;
    --start) START_DATE="$2"; shift 2 ;;
    --end) END_DATE="$2"; shift 2 ;;
    --label) RUN_LABEL="$2"; shift 2 ;;
    --interval) INTERVAL_MIN="$2"; shift 2 ;;
    --from-losses) FROM_LOSSES="$2"; shift 2 ;;
    --skip-backfill) SKIP_BACKFILL=1; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ "$FROM_LOSSES" -gt 0 ]]; then
  echo "Fetching top $FROM_LOSSES underperforming tickers from losing-trades-report..."
  LOSS_DATA=$(curl -s -m 30 "$API_BASE/timed/admin/losing-trades-report?key=$API_KEY" 2>&1)
  LOSS_TICKERS=$(echo "$LOSS_DATA" | jq -r --argjson n "$FROM_LOSSES" \
    '[.report[]? | select(.total_pnl < 0)] | sort_by(.total_pnl) | .[:$n] | map(.ticker) | join(",")' 2>/dev/null || echo "")
  if [[ -z "$LOSS_TICKERS" ]]; then
    echo "Could not extract losing tickers. Check the losing-trades-report endpoint."
    exit 1
  fi
  TICKERS="$LOSS_TICKERS"
  echo "  Selected: $TICKERS"
fi

if [[ -z "$TICKERS" ]]; then
  echo "ERROR: --tickers is required (or use --from-losses N)"
  exit 1
fi
if [[ -z "$START_DATE" ]]; then START_DATE="2025-07-01"; fi
if [[ -z "$END_DATE" ]]; then END_DATE=$(date '+%Y-%m-%d'); fi
if [[ -z "$RUN_LABEL" ]]; then
  SAFE_TICKERS=$(echo "$TICKERS" | tr ',' '-' | head -c 40)
  RUN_LABEL="focused-${SAFE_TICKERS}-${START_DATE}"
fi

SNAPSHOT_TS=$(date "+%Y%m%d-%H%M%S")
OUT_DIR="data/backtest-artifacts/focused-${RUN_LABEL}--${SNAPSHOT_TS}"
mkdir -p "$OUT_DIR"

REPLAY_LOCK=""

cleanup() {
  if [[ -n "$REPLAY_LOCK" ]]; then
    curl -s -X DELETE "$API_BASE/timed/admin/replay-lock?key=$API_KEY" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Focused Replay"
echo "║  Tickers: $TICKERS"
echo "║  Range:   $START_DATE → $END_DATE"
echo "║  Interval: ${INTERVAL_MIN}m"
echo "║  Output:  $OUT_DIR"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# Step 1: Ensure candle data exists for these tickers
if [[ "$SKIP_BACKFILL" -eq 1 ]]; then
  echo "Step 1: Skipping backfill (--skip-backfill). Candle data assumed present in D1."
  echo ""
else
  echo "Step 1: Checking/backfilling candle data..."
  IFS=',' read -ra TICKER_ARR <<< "$TICKERS"
  BF_START=$(date -j -v-60d -f "%Y-%m-%d" "$START_DATE" "+%Y-%m-%d" 2>/dev/null || date -d "$START_DATE 60 days ago" "+%Y-%m-%d" 2>/dev/null || echo "$START_DATE")
  for t in "${TICKER_ARR[@]}"; do
    echo -n "  $t ... "
    BF_RES=$(curl -s -m 300 -X POST "$API_BASE/timed/admin/alpaca-backfill?startDate=$BF_START&endDate=$END_DATE&tf=all&ticker=$t&key=$API_KEY" 2>&1)
    UPSERTED=$(echo "$BF_RES" | jq -r '.upserted // 0' 2>/dev/null || echo "?")
    echo "ok (${UPSERTED} candles)"
    sleep 1
  done
  echo ""
fi

# Step 1.5: Acquire replay lock after backfill so the run_id belongs only to replay execution
echo "Step 1.5: Acquiring replay lock..."
REPLAY_LOCK=$(curl -s -X DELETE "$API_BASE/timed/admin/replay-lock?key=$API_KEY" >/dev/null 2>&1;   curl -s -X POST "$API_BASE/timed/admin/replay-lock?reason=focused_replay_${SNAPSHOT_TS}&key=$API_KEY" | jq -r '.lock // empty')
if [[ -z "$REPLAY_LOCK" ]]; then
  echo "ERROR: failed to acquire replay lock"
  exit 1
fi
echo "  lock: $REPLAY_LOCK"
echo ""

# Step 2: Replay each day (ticker-filtered)
echo "Step 2: Replaying..."
CURRENT_DATE="$START_DATE"
DAY_COUNT=0
TOTAL_SCORED=0
TOTAL_TRADES=0

while [[ "$CURRENT_DATE" < "$END_DATE" ]] || [[ "$CURRENT_DATE" == "$END_DATE" ]]; do
  DOW=$(date -j -f "%Y-%m-%d" "$CURRENT_DATE" "+%u" 2>/dev/null || date -d "$CURRENT_DATE" "+%u")
  if [[ "$DOW" -ge 6 ]] || [[ " $HOLIDAYS " == *" $CURRENT_DATE "* ]]; then
    CURRENT_DATE=$(date -j -v+1d -f "%Y-%m-%d" "$CURRENT_DATE" "+%Y-%m-%d" 2>/dev/null || date -d "$CURRENT_DATE + 1 day" "+%Y-%m-%d")
    continue
  fi

  DAY_COUNT=$((DAY_COUNT + 1))
  REPLAY_URL="$API_BASE/timed/admin/candle-replay?date=$CURRENT_DATE&tickers=$TICKERS&intervalMinutes=$INTERVAL_MIN&skipInvestor=1&key=$API_KEY"

  RESULT=""
  for retry in 1 2 3; do
    RESULT=$(curl -s -m 300 -X POST "$REPLAY_URL" 2>&1) || true
    if echo "$RESULT" | jq -e '.scored >= 0' >/dev/null 2>&1; then break; fi
    echo "  $CURRENT_DATE attempt $retry failed, retrying in 10s..."
    sleep 10
  done

  SCORED=$(echo "$RESULT" | jq -r '.scored // 0' 2>/dev/null || echo "0")
  TRADES=$(echo "$RESULT" | jq -r '.tradesCreated // 0' 2>/dev/null || echo "0")
  TOTAL_SCORED=$((TOTAL_SCORED + SCORED))
  TOTAL_TRADES=$((TOTAL_TRADES + TRADES))

  echo "  $CURRENT_DATE: scored=$SCORED trades=$TRADES"

  CURRENT_DATE=$(date -j -v+1d -f "%Y-%m-%d" "$CURRENT_DATE" "+%Y-%m-%d" 2>/dev/null || date -d "$CURRENT_DATE + 1 day" "+%Y-%m-%d")
  sleep 1
done
echo ""

# Step 3: Capture artifacts
echo "Step 3: Capturing artifacts..."
EXPORT_SUMMARY=$(node "$(dirname "$0")/export-focused-run-artifacts.js"   --run-id "$REPLAY_LOCK"   --out-dir "$OUT_DIR"   --tickers "$TICKERS"   --api-base "$API_BASE"   --api-key "$API_KEY")
echo "$EXPORT_SUMMARY"
ARCHIVED_TRADE_COUNT=$(echo "$EXPORT_SUMMARY" | jq -r '.trade_count // 0' 2>/dev/null || echo "0")
ARCHIVED_CLOSED_COUNT=$(echo "$EXPORT_SUMMARY" | jq -r '.closed_trade_count // 0' 2>/dev/null || echo "0")

cat > "$OUT_DIR/manifest.json" <<EOF
{
  "ok": true,
  "type": "focused_replay",
  "label": "$RUN_LABEL",
  "run_id": "$REPLAY_LOCK",
  "tickers": "$(echo "$TICKERS" | tr ',' '", "')",
  "start_date": "$START_DATE",
  "end_date": "$END_DATE",
  "interval_min": $INTERVAL_MIN,
  "days_processed": $DAY_COUNT,
  "total_scored": $TOTAL_SCORED,
  "created_trade_events": $TOTAL_TRADES,
  "archived_trade_count": $ARCHIVED_TRADE_COUNT,
  "archived_closed_trade_count": $ARCHIVED_CLOSED_COUNT,
  "captured_at": "$SNAPSHOT_TS"
}
EOF

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Focused Replay Complete"
echo "║  Days: $DAY_COUNT | Scored: $TOTAL_SCORED | Created: $TOTAL_TRADES | Archived: $ARCHIVED_TRADE_COUNT"
echo "║  Artifacts: $OUT_DIR"
echo "╚══════════════════════════════════════════════════════╝"

# Quick P&L summary for the targeted tickers
echo ""
echo "=== P&L Summary (targeted tickers) ==="
jq --arg tickers "$TICKERS" '
  ($tickers | split(",")) as $tList |
  [.trades[]? | select(.ticker as $t | $tList | index($t))] |
  {
    total_trades: length,
    wins: [.[] | select(.status == "WIN")] | length,
    losses: [.[] | select(.status == "LOSS")] | length,
    total_pnl: ([.[].pnl // 0] | add | . * 100 | floor / 100),
    avg_pnl_pct: (if length > 0 then ([.[].pnlPct // 0] | add / length | . * 100 | floor / 100) else 0 end),
    by_ticker: (group_by(.ticker) | map({
      ticker: .[0].ticker,
      trades: length,
      wins: ([.[] | select(.status == "WIN")] | length),
      pnl: ([.[].pnl // 0] | add | . * 100 | floor / 100)
    }))
  }
' "$OUT_DIR/trades.json" 2>/dev/null || echo "Could not parse trade data"
