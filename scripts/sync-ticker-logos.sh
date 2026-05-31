#!/usr/bin/env bash
# Sync ticker logos into KV (Finnhub profile2 → eodhd fallback).
# Requires TIMED_TRADING_API_KEY or admin session via X-TT-Admin-Key.
set -euo pipefail

API="${TIMED_API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
KEY="${TIMED_TRADING_API_KEY:?Set TIMED_TRADING_API_KEY}"
MAX="${1:-80}"

echo "Logo status before sync:"
curl -sS "${API}/timed/admin/logos/status?key=${KEY}" | python3 -m json.tool | head -20

echo ""
echo "Syncing up to ${MAX} missing logos..."
curl -sS -X POST "${API}/timed/admin/logos/sync?max=${MAX}" \
  -H "Content-Type: application/json" \
  -H "X-TT-Admin-Key: ${KEY}" \
  -d '{"only_missing":true}' | python3 -m json.tool

echo ""
echo "Sample AMZN logo (should be image/png):"
curl -sSI "${API}/timed/logo/AMZN.png" | head -8
