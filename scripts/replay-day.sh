#!/bin/bash
# Replay today's (or date's) timed_trail ingests in chronological order.
# Resets trades for the day, then processes each ingest as if it arrived live —
# Kanban classification + trade simulation. Result: lanes and trades reflect
# the day as if we had run from market open.
#
# Usage:
#   TIMED_API_KEY=your_key ./scripts/replay-day.sh
#   TIMED_API_KEY=your_key DATE=2025-02-02 ./scripts/replay-day.sh
#
set -e
API_BASE="${TIMED_API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:-}"
DATE="${DATE:-}"

if [ -z "$API_KEY" ]; then
  echo "Error: TIMED_API_KEY is required"
  echo "  TIMED_API_KEY=your_key ./scripts/replay-day.sh"
  exit 1
fi

QUERY="key=${API_KEY}"
[ -n "$DATE" ] && QUERY="${QUERY}&date=${DATE}"
CLEAN_SLATE="${CLEAN_SLATE:-1}"
[ "$CLEAN_SLATE" = "1" ] && QUERY="${QUERY}&cleanSlate=1"
[ -n "$BUCKET_MINUTES" ] && [ "$BUCKET_MINUTES" -gt 0 ] 2>/dev/null && QUERY="${QUERY}&bucketMinutes=${BUCKET_MINUTES}"

echo "Replaying day (date=${DATE:-today})..."
OFFSET=0
TOTAL_ROWS=0
TOTAL_TRADES=0
TOTAL_PURGED=0

while true; do
  RESP=$(curl -s -X POST "${API_BASE}/timed/admin/replay-day?${QUERY}&limit=50&offset=${OFFSET}")
  echo "$RESP" | jq .
  OK=$(echo "$RESP" | jq -r '.ok')
  if [ "$OK" != "true" ]; then
    echo "Stopping: response ok=$OK"
    exit 1
  fi
  ROWS=$(echo "$RESP" | jq -r '.rowsProcessed // 0')
  TRADES=$(echo "$RESP" | jq -r '.tradesCreated // 0')
  PURGED=$(echo "$RESP" | jq -r '.tradesPurged // 0')
  TOTAL_ROWS=$((TOTAL_ROWS + ROWS))
  TOTAL_TRADES=$((TOTAL_TRADES + TRADES))
  [ "$PURGED" -gt 0 ] 2>/dev/null && TOTAL_PURGED=$((TOTAL_PURGED + PURGED))
  HAS_MORE=$(echo "$RESP" | jq -r '.hasMore // false')
  NEXT=$(echo "$RESP" | jq -r '.nextOffset // empty')
  if [ "$HAS_MORE" != "true" ] || [ -z "$NEXT" ]; then
    break
  fi
  OFFSET=$NEXT
  echo "--- Batch done. Next offset: $OFFSET ---"
  sleep 0.5
done

echo ""
PURGED_MSG=""
[ "$TOTAL_PURGED" -gt 0 ] 2>/dev/null && PURGED_MSG=", trades purged: $TOTAL_PURGED"
echo "Done. Rows processed: $TOTAL_ROWS, trades created: $TOTAL_TRADES$PURGED_MSG"
echo ""
echo "Syncing to D1..."
curl -s -X POST "${API_BASE}/timed/admin/force-sync?key=${API_KEY}" | jq .
