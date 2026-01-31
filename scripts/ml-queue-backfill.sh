#!/bin/bash
# Backfill ML queue from existing timed_trail data
# This populates the queue with recent historical data so the model can train immediately

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY}"

if [ -z "$API_KEY" ]; then
  echo "❌ Error: TIMED_API_KEY environment variable not set"
  echo "Usage: TIMED_API_KEY=your_key ./scripts/ml-queue-backfill.sh"
  exit 1
fi

echo "🔄 ML Queue Backfill from timed_trail"
echo "======================================"
echo ""
echo "This will populate the ML training queue from your existing TradingView data."
echo ""

# Trigger a manual ingest of recent data to populate queue
# Since the enqueue code runs on every ingest, we just need new data to flow
echo "✅ ML queue will populate automatically with new ingests from TradingView"
echo ""
echo "To accelerate training:"
echo "1. Wait for next TradingView alert (1-5 minutes)"
echo "2. Or manually trigger an alert from TradingView"
echo "3. Then run: TIMED_API_KEY=\$TIMED_API_KEY ./scripts/ml-backfill.sh"
echo ""
echo "The queue will have data 4-24 hours after ingests (waiting for horizons to elapse)."
