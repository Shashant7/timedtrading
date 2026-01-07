#!/bin/bash
# Quick script to check if TradingView alerts are being ingested

echo "=== Ingestion Status Check ==="
echo ""

# Check health
echo "1. Health Check:"
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/health" | python3 -m json.tool 2>/dev/null || curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/health"
echo ""
echo ""

# Check ticker count
echo "2. Ticker Count:"
TICKER_COUNT=$(curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/tickers" | python3 -c "import sys, json; data = json.load(sys.stdin); print(data.get('count', 0))" 2>/dev/null || echo "unknown")
echo "Total tickers: $TICKER_COUNT"
echo ""

# Show last 10 tickers
echo "3. Recent Tickers (last 10):"
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/tickers" | python3 -c "import sys, json; data = json.load(sys.stdin); print('\n'.join(data.get('tickers', [])[-10:]))" 2>/dev/null || echo "Could not fetch tickers"
echo ""
echo ""

# Instructions
echo "=== Next Steps ==="
echo "1. Check Cloudflare Worker Logs for [INGEST...] messages"
echo "2. If no [INGEST REQUEST RECEIVED] logs, alerts aren't reaching the worker"
echo "3. If you see [INGEST AUTH FAILED], check API key"
echo "4. If you see [INGEST ERROR], check the error details"
echo ""
echo "To view live logs: wrangler tail --format pretty"

