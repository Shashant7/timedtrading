#!/bin/bash
# Setup script to install Wrangler and fetch logs

set -e

echo "🚀 Setting up Wrangler CLI for log fetching"
echo "=========================================="
echo ""

# Check if wrangler is already installed
if command -v wrangler &> /dev/null; then
    echo "✅ Wrangler is already installed"
    wrangler --version
    echo ""
else
    echo "📦 Installing Wrangler..."
    echo ""
    
    # Try Homebrew first (macOS)
    if command -v brew &> /dev/null; then
        echo "Using Homebrew to install Wrangler..."
        brew install cloudflare-wrangler
    # Try npm if available
    elif command -v npm &> /dev/null; then
        echo "Using npm to install Wrangler..."
        npm install -g wrangler
    # Try cargo if available
    elif command -v cargo &> /dev/null; then
        echo "Using cargo to install Wrangler..."
        cargo install wrangler
    else
        echo "❌ No package manager found!"
        echo ""
        echo "Please install Wrangler manually:"
        echo "  Option 1: Install Node.js from https://nodejs.org/, then: npm install -g wrangler"
        echo "  Option 2: Install Homebrew from https://brew.sh/, then: brew install cloudflare-wrangler"
        echo "  Option 3: Install Rust from https://rustup.rs/, then: cargo install wrangler"
        echo ""
        exit 1
    fi
    
    echo ""
    echo "✅ Wrangler installed successfully"
    wrangler --version
    echo ""
fi

# Check if authenticated
echo "🔐 Checking authentication..."
if wrangler whoami &> /dev/null; then
    echo "✅ Already authenticated"
    wrangler whoami
else
    echo "⚠️  Not authenticated. Please authenticate:"
    echo "   wrangler login"
    echo ""
    echo "This will open your browser to authenticate with Cloudflare."
    echo "Press Enter to continue with authentication, or Ctrl+C to cancel..."
    read -r
    wrangler login
fi

echo ""
echo "📊 Fetching logs..."
echo ""

cd "$(dirname "$0")/../worker" || exit 1

OUTPUT_FILE="../logs.txt"
LIMIT="${1:-200}"

echo "Fetching last $LIMIT log lines..."
echo "This may take 10-15 seconds..."
echo ""

# Fetch logs with timeout
timeout 20 wrangler tail timed-trading-ingest --format pretty 2>&1 | head -"$LIMIT" > "$OUTPUT_FILE" || {
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
    echo "  2. Check authentication: wrangler whoami"
    echo "  3. Try manually: wrangler tail timed-trading-ingest"
    exit 1
fi
