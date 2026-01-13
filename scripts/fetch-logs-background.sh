#!/bin/bash
# Fetch logs using background process with timeout

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WRANGLER="$PROJECT_ROOT/node_modules/.bin/wrangler"

cd "$PROJECT_ROOT/worker" || exit 1

OUTPUT_FILE="../logs.txt"
LIMIT="${1:-200}"

echo "📊 Fetching Cloudflare Worker logs..."
echo "   This will collect logs for 15 seconds..."
echo ""

# Start wrangler tail in background and capture output
"$WRANGLER" tail timed-trading-ingest --format pretty > "$OUTPUT_FILE" 2>&1 &
WRANGLER_PID=$!

# Wait for logs to accumulate (default 15 seconds, but can be overridden)
WAIT_TIME="${2:-15}"
echo "   Collecting logs for ${WAIT_TIME} seconds..."
sleep "$WAIT_TIME"

# Kill the wrangler process
kill $WRANGLER_PID 2>/dev/null || true
wait $WRANGLER_PID 2>/dev/null || true

if [ -s "$OUTPUT_FILE" ]; then
    # Limit to requested number of lines
    head -"$LIMIT" "$OUTPUT_FILE" > "${OUTPUT_FILE}.tmp" && mv "${OUTPUT_FILE}.tmp" "$OUTPUT_FILE"
    
    LINE_COUNT=$(wc -l < "$OUTPUT_FILE" | tr -d ' ')
    echo "✅ Logs fetched successfully!"
    echo "   Saved to: $OUTPUT_FILE"
    echo "   Lines: $LINE_COUNT"
    echo ""
    echo "📋 Preview (first 30 lines):"
    echo "=========================================="
    head -30 "$OUTPUT_FILE"
    echo ""
    if [ "$LINE_COUNT" -gt 30 ]; then
        echo "... (showing first 30 of $LINE_COUNT lines)"
    fi
    echo ""
    echo "💡 Next steps:"
    echo "   1. Analyze logs: node scripts/analyze-logs.js logs.txt"
    echo "   2. Filter for Discord: grep -i discord logs.txt | head -20"
    echo "   3. Filter for alerts: grep -i alert logs.txt | head -20"
else
    echo "⚠️  No logs received. This might mean:"
    echo "   - No recent activity"
    echo "   - Worker name might be incorrect"
    echo "   - Try waiting longer or check Cloudflare dashboard"
    exit 1
fi
