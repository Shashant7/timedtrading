#!/bin/bash
# Populate ML training queue from existing timed_trail data

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY}"

if [ -z "$API_KEY" ]; then
  echo "❌ Error: TIMED_API_KEY environment variable not set"
  echo "Usage: TIMED_API_KEY=your_key ./scripts/ml-populate-queue.sh"
  exit 1
fi

echo "🔄 Populating ML Training Queue"
echo "================================"
echo ""
echo "This will queue your existing TradingView data for ML training."
echo ""

RESPONSE=$(curl -s -X POST \
  "${API_BASE}/timed/ml/backfill-queue?key=${API_KEY}&days=7" \
  -H "Content-Type: application/json")

QUEUED=$(echo "$RESPONSE" | grep -o '"queued":[0-9]*' | cut -d':' -f2)
PROCESSED=$(echo "$RESPONSE" | grep -o '"processed":[0-9]*' | cut -d':' -f2)

if [ -n "$QUEUED" ]; then
  echo "✅ Queued $QUEUED entries from $PROCESSED trail records"
  echo ""
  echo "⏱️  Data will be labelable 4-24 hours after each entry timestamp."
  echo ""
  echo "Next: Run training in a few hours:"
  echo "  TIMED_API_KEY=\$TIMED_API_KEY ./scripts/ml-backfill.sh"
else
  echo "⚠️  Response: $RESPONSE"
fi
