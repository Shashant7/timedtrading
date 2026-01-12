#!/bin/bash
# Simple script to fetch logs - tries multiple methods

set -e

WORKER_NAME="timed-trading-ingest"
OUTPUT_FILE="${1:-logs.txt}"
LIMIT="${2:-100}"

echo "🔍 Fetching Cloudflare Worker logs..."
echo "   Worker: $WORKER_NAME"
echo "   Output: $OUTPUT_FILE"
echo "   Limit: $LIMIT lines"
echo ""

# Method 1: Try wrangler CLI
if command -v wrangler &> /dev/null; then
    echo "✅ Using Wrangler CLI..."
    cd "$(dirname "$0")/../worker" || exit 1
    
    # Check if authenticated
    if wrangler whoami &> /dev/null; then
        echo "   Fetching logs (this may take a few seconds)..."
        timeout 15 wrangler tail "$WORKER_NAME" --format pretty 2>&1 | head -"$LIMIT" > "../$OUTPUT_FILE" || true
        
        if [ -s "../$OUTPUT_FILE" ]; then
            echo "✅ Logs saved to $OUTPUT_FILE"
            echo ""
            echo "📊 Preview (first 20 lines):"
            echo "=========================================="
            head -20 "../$OUTPUT_FILE"
            echo ""
            echo "💡 Analyze with: node scripts/analyze-logs.js $OUTPUT_FILE"
            exit 0
        else
            echo "⚠️  No logs received. Trying alternative method..."
        fi
    else
        echo "⚠️  Not authenticated. Run: wrangler login"
    fi
else
    echo "⚠️  Wrangler CLI not found"
fi

# Method 2: Instructions for manual fetch
echo ""
echo "📋 Alternative: Fetch logs manually"
echo "=========================================="
echo ""
echo "Option A: Cloudflare Dashboard"
echo "  1. Go to: https://dash.cloudflare.com"
echo "  2. Navigate to: Workers & Pages > $WORKER_NAME"
echo "  3. Click: Logs tab"
echo "  4. Filter for: DISCORD, ALERT, corridor"
echo "  5. Copy logs and save to: $OUTPUT_FILE"
echo ""
echo "Option B: Install Wrangler CLI"
echo "  1. Install: npm install -g wrangler"
echo "  2. Authenticate: wrangler login"
echo "  3. Run this script again"
echo ""
echo "Option C: Use Node script"
echo "  node scripts/fetch-logs-api.js --output $OUTPUT_FILE"
echo ""

exit 1
