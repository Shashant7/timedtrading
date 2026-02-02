#!/bin/bash
# Re-run Kanban classification and trade simulation for all tickers.
# Batches automatically to avoid Cloudflare subrequest limits (~15 tickers/call).
# By default resets trades for the reprocess window so entries are rebuilt from scratch.
#
# Usage:
#   TIMED_API_KEY=your_key ./scripts/reprocess-kanban.sh
#   TIMED_API_KEY=your_key ./scripts/reprocess-kanban.sh ticker=AAPL
#   RESET_TRADES=0 TIMED_API_KEY=... ./scripts/reprocess-kanban.sh   # keep existing trades
#   FROM=2025-02-01 TO=2025-02-02 TIMED_API_KEY=... ./scripts/reprocess-kanban.sh  # reset only trades in date range
#
set -e
API_BASE="${TIMED_API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:-}"
RESET_TRADES="${RESET_TRADES:-1}"

if [ -z "$API_KEY" ]; then
  echo "Error: TIMED_API_KEY is required"
  echo "  TIMED_API_KEY=your_key ./scripts/reprocess-kanban.sh"
  exit 1
fi

QUERY="key=${API_KEY}&resetTrades=${RESET_TRADES}"
[ -n "$FROM" ] && QUERY="${QUERY}&from=${FROM}"
[ -n "$TO" ] && QUERY="${QUERY}&to=${TO}"
if [ -n "$1" ]; then
  QUERY="${QUERY}&$1"
fi

echo "Reprocessing Kanban + trade sim (batched, resetTrades=${RESET_TRADES})..."
OFFSET=0
TOTAL_PROCESSED=0
TOTAL_TRADES=0
TOTAL_PURGED=0

while true; do
  RESP=$(curl -s -X POST "${API_BASE}/timed/admin/reprocess-kanban?${QUERY}&limit=15&offset=${OFFSET}")
  echo "$RESP" | jq .
  OK=$(echo "$RESP" | jq -r '.ok')
  if [ "$OK" != "true" ]; then
    echo "Stopping: response ok=$OK"
    exit 1
  fi
  PROCESSED=$(echo "$RESP" | jq -r '.tickersProcessed // 0')
  TRADES=$(echo "$RESP" | jq -r '.tradesCreated // 0')
  PURGED=$(echo "$RESP" | jq -r '.tradesPurged // 0')
  TOTAL_PROCESSED=$((TOTAL_PROCESSED + PROCESSED))
  TOTAL_TRADES=$((TOTAL_TRADES + TRADES))
  TOTAL_PURGED=$((TOTAL_PURGED + PURGED))
  HAS_MORE=$(echo "$RESP" | jq -r '.hasMore // false')
  NEXT=$(echo "$RESP" | jq -r '.nextOffset // empty')
  if [ "$HAS_MORE" != "true" ] || [ -z "$NEXT" ]; then
    break
  fi
  OFFSET=$NEXT
  echo "--- Batch done. Next offset: $OFFSET ---"
  sleep 1
done

echo ""
[ "$TOTAL_PURGED" -gt 0 ] 2>/dev/null && PURGED_MSG=", trades purged: $TOTAL_PURGED" || PURGED_MSG=""
echo "Done. Processed: $TOTAL_PROCESSED tickers, trades created: $TOTAL_TRADES$PURGED_MSG"
echo ""
echo "Syncing to D1..."
curl -s -X POST "${API_BASE}/timed/admin/force-sync?key=${API_KEY}" | jq .
