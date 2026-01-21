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

# Coverage stats (D1-based)
echo "4. Ingestion Coverage (last 6h, 1m buckets):"
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/ingestion/stats?bucketMin=1" | python3 -m json.tool 2>/dev/null || curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/ingestion/stats?bucketMin=1"
echo ""
echo ""

# Watchlist coverage (D1-based)
echo "5. Watchlist Coverage (last 6h, per-ticker):"
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/watchlist/coverage?bucketMin=1" | python3 -m json.tool 2>/dev/null || curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/watchlist/coverage?bucketMin=1"
echo ""
echo ""

# Instructions
echo "=== Next Steps ==="
echo "1. Check Cloudflare Worker Logs for [INGEST...] messages"
echo "2. If no [INGEST REQUEST RECEIVED] logs, alerts aren't reaching the worker"
echo "3. If you see [INGEST AUTH FAILED], check API key"
echo "4. If you see [INGEST ERROR], check the error details"
echo "5. If /timed/ingestion/stats coveragePct is low, identify worst tickers via /timed/watchlist/coverage"
echo ""
echo "To view live logs: wrangler tail --format pretty"

