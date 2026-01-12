#!/bin/bash
# Script to fetch Cloudflare Worker logs
# Requires: wrangler CLI installed and authenticated

echo "🔍 Fetching Cloudflare Worker logs..."
echo "=========================================="
echo ""

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "❌ Wrangler CLI not found. Installing..."
    echo ""
    echo "Please install wrangler first:"
    echo "  npm install -g wrangler"
    echo ""
    echo "Then authenticate:"
    echo "  wrangler login"
    echo ""
    exit 1
fi

# Check if authenticated
if ! wrangler whoami &> /dev/null; then
    echo "❌ Not authenticated. Please run: wrangler login"
    exit 1
fi

echo "📊 Fetching recent logs (last 100 lines)..."
echo ""

# Tail logs with filters for Discord alerts
cd "$(dirname "$0")/../worker" || exit 1

echo "=== Discord Alert Related Logs ==="
wrangler tail --format pretty 2>&1 | grep -E "(DISCORD|ALERT|corridor|enteredCorridor)" | head -100

echo ""
echo "=== All Recent Logs ==="
wrangler tail --format pretty 2>&1 | head -100

echo ""
echo "💡 Tip: To see live logs, run: wrangler tail"
echo "💡 To filter for specific ticker: wrangler tail | grep TICKER"
