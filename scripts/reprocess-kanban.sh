#!/bin/bash
# Re-run Kanban classification and trade simulation for all tickers.
# Batches automatically to avoid Cloudflare subrequest limits (~15 tickers/call).
#
# Usage:
#   TIMED_API_KEY=your_key ./scripts/reprocess-kanban.sh
#   TIMED_API_KEY=your_key ./scripts/reprocess-kanban.sh ticker=AAPL
#
set -e
API_BASE="${TIMED_API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:-}"

if [ -z "$API_KEY" ]; then
  echo "Error: TIMED_API_KEY is required"
  echo "  TIMED_API_KEY=your_key ./scripts/reprocess-kanban.sh"
  exit 1
fi

QUERY="key=${API_KEY}"
if [ -n "$1" ]; then
  QUERY="${QUERY}&$1"
fi

echo "Reprocessing Kanban + trade sim (batched)..."
OFFSET=0
TOTAL_PROCESSED=0
TOTAL_TRADES=0

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
  TOTAL_PROCESSED=$((TOTAL_PROCESSED + PROCESSED))
  TOTAL_TRADES=$((TOTAL_TRADES + TRADES))
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
echo "Done. Processed: $TOTAL_PROCESSED tickers, trades created: $TOTAL_TRADES"
echo ""
echo "Syncing to D1..."
curl -s -X POST "${API_BASE}/timed/admin/force-sync?key=${API_KEY}" | jq .
