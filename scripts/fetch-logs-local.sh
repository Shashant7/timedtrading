#!/bin/bash
# Fetch logs using locally installed Wrangler

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WRANGLER="$PROJECT_ROOT/node_modules/.bin/wrangler"

if [ ! -f "$WRANGLER" ]; then
    echo "❌ Wrangler not found. Installing..."
    cd "$PROJECT_ROOT"
    npm install wrangler
fi

cd "$PROJECT_ROOT/worker" || exit 1

OUTPUT_FILE="../logs.txt"
LIMIT="${1:-200}"

echo "📊 Fetching Cloudflare Worker logs..."
echo "   Worker: timed-trading-ingest"
echo "   Output: $OUTPUT_FILE"
echo "   Limit: $LIMIT lines"
echo ""

# Check authentication
if ! "$WRANGLER" whoami &> /dev/null; then
    echo "⚠️  Not authenticated. Please authenticate:"
    echo "   cd worker && ../node_modules/.bin/wrangler login"
    echo ""
    echo "This will open your browser to authenticate with Cloudflare."
    exit 1
fi

echo "✅ Authenticated"
echo "   Fetching logs (this may take 10-15 seconds)..."
echo ""

# Fetch logs with timeout
timeout 20 "$WRANGLER" tail timed-trading-ingest --format pretty 2>&1 | head -"$LIMIT" > "$OUTPUT_FILE" || {
    echo "⚠️  Timeout or error occurred, but partial logs may have been saved"
}

if [ -s "$OUTPUT_FILE" ]; then
    LINE_COUNT=$(wc -l < "$OUTPUT_FILE" | tr -d ' ')
    echo "✅ Logs fetched successfully!"
    echo "   Saved to: $OUTPUT_FILE"
    echo "   Lines: $LINE_COUNT"
    echo ""
    echo "📋 Preview (first 20 lines):"
    echo "=========================================="
    head -20 "$OUTPUT_FILE"
    echo ""
    echo "💡 Next steps:"
    echo "   1. Analyze logs: node scripts/analyze-logs.js logs.txt"
    echo "   2. Filter for Discord: grep -i discord logs.txt"
    echo "   3. Filter for alerts: grep -i alert logs.txt"
else
    echo "❌ No logs were fetched"
    echo ""
    echo "Troubleshooting:"
    echo "  1. Make sure worker name is correct: timed-trading-ingest"
    echo "  2. Check authentication: cd worker && ../node_modules/.bin/wrangler whoami"
    echo "  3. Try manually: cd worker && ../node_modules/.bin/wrangler tail timed-trading-ingest"
    exit 1
fi
