#!/usr/bin/env bash
# Replay + analysis for today: AAPL, AMD, AMZN, BE, GOLD.
# Requires TIMED_API_KEY. Optional: DATE=YYYY-MM-DD, OUTPUT=path.
#
# Usage:
#   TIMED_API_KEY=your_key ./scripts/replay-analyze-today.sh
#   TIMED_API_KEY=your_key OUTPUT=docs/REPLAY_ANALYSIS_TODAY.md ./scripts/replay-analyze-today.sh
set -e
API_KEY="${TIMED_API_KEY:-}"
if [ -z "$API_KEY" ]; then
  echo "Error: TIMED_API_KEY is required"
  echo "  TIMED_API_KEY=your_key ./scripts/replay-analyze-today.sh"
  exit 1
fi
DATE="${DATE:-}"  # default: script uses today (UTC)
TICKERS="${TICKERS:-AAPL,AMD,AMZN,BE,GOLD}"
OUTPUT="${OUTPUT:-}"
if [ -n "$OUTPUT" ]; then
  DATE="$DATE" TICKERS="$TICKERS" TIMED_API_KEY="$API_KEY" node scripts/replay-analyze-day.js > "$OUTPUT"
  echo "Report written to $OUTPUT"
else
  DATE="$DATE" TICKERS="$TICKERS" TIMED_API_KEY="$API_KEY" node scripts/replay-analyze-day.js
fi
