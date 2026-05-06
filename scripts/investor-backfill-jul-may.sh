#!/usr/bin/env bash
# Investor-mode backfill: walks Jul 2025 → May 2026, calls /timed/admin/investor-replay
# per trading day so the investor account_ledger + portfolio_snapshots seed matches
# the trader Phase C run. Then runs the seed step (P0.7.71) to also write a clean
# account_ledger from the resulting investor positions.

set -uo pipefail
API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:-${TIMED_TRADING_API_KEY}}"
START="${1:-2025-07-01}"
END="${2:-2026-05-04}"

# US market holidays in window (best-effort; matches scripts/full-backtest.sh)
HOLIDAYS="2025-07-04 2025-09-01 2025-11-27 2025-12-25 2026-01-01 2026-01-19 2026-02-16 2026-04-03"

echo "Investor backfill: $START → $END"
echo ""

CUR="$START"
COUNT=0
SKIPPED=0
ERR=0
while [[ "$CUR" < "$END" || "$CUR" == "$END" ]]; do
  # Skip weekends
  DOW=$(date -d "$CUR" "+%u")
  if [[ "$DOW" -ge 6 ]]; then
    CUR=$(date -d "$CUR + 1 day" "+%Y-%m-%d")
    continue
  fi
  # Skip holidays
  if [[ " $HOLIDAYS " == *" $CUR "* ]]; then
    CUR=$(date -d "$CUR + 1 day" "+%Y-%m-%d")
    continue
  fi

  RES=$(curl -sS -m 60 -X POST "$API_BASE/timed/admin/investor-replay?date=$CUR&key=$API_KEY" 2>&1)
  if echo "$RES" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('ok') else 1)" 2>/dev/null; then
    OPENED=$(echo "$RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('investor',{}).get('opened',0))")
    CLOSED=$(echo "$RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('investor',{}).get('closed',0))")
    if [[ "$OPENED" != "0" || "$CLOSED" != "0" ]]; then
      echo "  $CUR  +$OPENED open / -$CLOSED close"
    fi
    COUNT=$((COUNT + 1))
  else
    ERR_MSG=$(echo "$RES" | head -c 200)
    if [[ "$ERR_MSG" == *"no_day_state"* ]]; then
      SKIPPED=$((SKIPPED + 1))
    else
      echo "  $CUR  ERROR: $ERR_MSG"
      ERR=$((ERR + 1))
    fi
  fi

  CUR=$(date -d "$CUR + 1 day" "+%Y-%m-%d")
  sleep 0.3
done

echo ""
echo "Done: $COUNT days replayed, $SKIPPED skipped (no_day_state), $ERR errors"
