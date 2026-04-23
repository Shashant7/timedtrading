#!/usr/bin/env bash
# V12 micro-smoke harness. Runs a tight ticker/date window to validate
# one DA-gated fix in isolation against V11 baseline.
#
# Usage:
#   TIMED_API_KEY=... bash scripts/v12-smoke.sh <smoke-name> <start-date> <end-date> <tickers-csv>
#
# Example:
#   bash scripts/v12-smoke.sh p1-march-fast-cut 2026-03-02 2026-03-26 \
#     "GE,GEV,CSX,CW,GLD,STX"
#
# The caller is expected to have already activated the DA keys they want
# to test (via scripts/v12-activate-killer-strategy.sh or per-fix scripts).
set -euo pipefail
API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

NAME="${1:?smoke-name required}"
START="${2:?start-date required YYYY-MM-DD}"
END="${3:?end-date required YYYY-MM-DD}"
TICKERS="${4:?comma-separated tickers required}"

RUN_ID="smoke-${NAME}-$(date +%s)"
echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] V12 smoke: $NAME"
echo "  run_id=$RUN_ID"
echo "  range=$START..$END"
echo "  tickers=$TICKERS"

# Reset to clean slate for this run
curl -sS -m 30 -X POST \
  "$API_BASE/timed/admin/reset?resetLedger=1&replayOnly=1&key=$API_KEY" \
  | python3 -m json.tool | head -10

# Use continuous-slice for reliability
exec bash scripts/continuous-slice.sh \
  --start="$START" --end="$END" \
  --run-id="$RUN_ID" \
  --tickers="$TICKERS" \
  --watchdog-seconds=420
