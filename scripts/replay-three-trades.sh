#!/bin/bash
# Replay GE, CAT, BABA for July 1, 2025 to verify entry guards + CAT price fix.
# Usage: ./scripts/replay-three-trades.sh

set -e

API_BASE="${TIMED_API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:-AwesomeSauce}"
DATE="2025-07-01"
# Include SPY for regime context (market/sector regime gates)
TICKERS="SPY,GE,CAT,BABA"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Replay: $TICKERS on $DATE"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# 1. Acquire lock
echo "Step 1: Acquiring replay lock..."
LOCK=$(curl -s -m 30 -X POST "$API_BASE/timed/admin/replay-lock?reason=replay_three_trades&key=$API_KEY")
echo "$LOCK" | jq -c '{ok, lock}' 2>/dev/null || echo "$LOCK"
echo ""

# 2. Reset (clean slate for focused test)
echo "Step 2: Resetting ledger..."
RESET=$(curl -s -m 120 -X POST "$API_BASE/timed/admin/reset?resetLedger=1&key=$API_KEY")
echo "$RESET" | jq -c '{ok, kvCleared}' 2>/dev/null || echo "$RESET"
echo ""

# 3a. Replay June 30 first (build state for July 1)
echo "Step 3a: Replaying 2025-06-30 (build state)..."
curl -s -m 300 -X POST "$API_BASE/timed/admin/candle-replay?date=2025-06-30&tickers=$TICKERS&intervalMinutes=5&cleanSlate=1&traderOnly=1&key=$API_KEY" | jq -c '{ok, scored, tradesCreated}' 2>/dev/null || true
echo ""

# 3b. Replay July 1 (CAT should fire with prior state)
echo "Step 3b: Replaying $DATE (tickers=$TICKERS)..."
REPLAY=$(curl -s -m 300 -X POST "$API_BASE/timed/admin/candle-replay?date=$DATE&tickers=$TICKERS&intervalMinutes=5&traderOnly=1&key=$API_KEY")
echo "$REPLAY" | jq '{ok, scored, tradesCreated, totalTrades, errorsCount}' 2>/dev/null || echo "$REPLAY"
echo ""
echo "Block reasons (aggregate):"
echo "$REPLAY" | jq -r '.blockReasons // {} | to_entries[] | "  \(.key): \(.value)"' 2>/dev/null || true
echo ""
echo "Last snapshot (stage + block_reason + regime + fuel per ticker):"
echo "$REPLAY" | jq -r '.lastSnapshot // {} | to_entries[] | "  \(.key): stage=\(.value.kanban_stage) block=\(.value.block_reason // "none") primary_fuel=\(.value.primary_fuel // "n/a") block_fuel=\(.value.block_fuel_pct // "n/a") ema_regime=\(.value.ema_regime_daily // "n/a")"' 2>/dev/null || true
echo ""
echo "Process debug (gate state for enter-stage tickers):"
echo "$REPLAY" | jq '.processDebug // []' 2>/dev/null || true
echo ""

# 4. Close any open positions at day end
echo "Step 4: Closing open positions at $DATE market close..."
CLOSE=$(curl -s -m 60 -X POST "$API_BASE/timed/admin/close-replay-positions?date=$DATE&key=$API_KEY")
echo "$CLOSE" | jq -c '{ok, closed}' 2>/dev/null || echo "$CLOSE"
echo ""

# 5. Release lock
echo "Step 5: Releasing replay lock..."
UNLOCK=$(curl -s -m 30 -X DELETE "$API_BASE/timed/admin/replay-lock?key=$API_KEY")
echo "$UNLOCK" | jq -c '{ok, released}' 2>/dev/null || echo "$UNLOCK"
echo ""

# 6. Fetch losing trades report for comparison
echo "Step 6: Losing trades (if any)..."
node scripts/losing-trades-report.js 2>/dev/null | head -60 || echo "Run: node scripts/losing-trades-report.js"
echo ""
echo "Done. Check losing-trades-report for GE, CAT, BABA results."
