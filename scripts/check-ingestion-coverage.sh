#!/bin/bash
set -euo pipefail

# One-command ingestion + watchlist coverage check.
#
# Usage:
#   ./scripts/check-ingestion-coverage.sh
#   API_BASE=https://... ./scripts/check-ingestion-coverage.sh
#   ./scripts/check-ingestion-coverage.sh 6h 5 0.90
#
# Args:
#   $1 window (default 6h)  - supports Nh (hours) or Nd (days)
#   $2 bucketMin (default 5)
#   $3 threshold (default 0.90)

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
WINDOW="${1:-6h}"
BUCKET_MIN="${2:-1}"
THRESHOLD="${3:-0.90}"

parse_window_ms() {
  local w="$1"
  if [[ "$w" =~ ^([0-9]+)h$ ]]; then
    echo $(( ${BASH_REMATCH[1]} * 60 * 60 * 1000 ))
    return
  fi
  if [[ "$w" =~ ^([0-9]+)d$ ]]; then
    echo $(( ${BASH_REMATCH[1]} * 24 * 60 * 60 * 1000 ))
    return
  fi
  echo "0"
}

NOW_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
WIN_MS="$(parse_window_ms "$WINDOW")"
if [[ "$WIN_MS" == "0" ]]; then
  echo "Bad window: $WINDOW (use like 6h or 1d)"
  exit 1
fi
SINCE_MS="$(( NOW_MS - WIN_MS ))"

echo "=== Ingestion Coverage Check ==="
echo "API: $API_BASE"
echo "Window: $WINDOW  (since=$SINCE_MS until=$NOW_MS)"
echo "Bucket: ${BUCKET_MIN}m  Threshold: ${THRESHOLD}"
echo ""

echo "1) Overall coverage (/timed/ingestion/stats)"
curl -s "$API_BASE/timed/ingestion/stats?since=$SINCE_MS&until=$NOW_MS&bucketMin=$BUCKET_MIN&threshold=$THRESHOLD" || true
echo ""
echo ""

echo "2) Worst tickers (/timed/watchlist/coverage)"
curl -s "$API_BASE/timed/watchlist/coverage?since=$SINCE_MS&until=$NOW_MS&bucketMin=$BUCKET_MIN&threshold=$THRESHOLD" || true
echo ""

