#!/bin/bash
# Variant A: Intelligence-Driven Backtest
# Run this from the timedtrading root directory
# Usage: ./scripts/run-variant-a.sh

set -e
API_BASE="https://timed-trading-ingest.shashant.workers.dev"
API_KEY="AwesomeSauce"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  VARIANT A: Intelligence-Driven Backtest Pipeline"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ─── Step 1: Deploy worker (both envs) ────────────────────────────────
echo "Step 1: Deploying worker..."
cd worker
npx wrangler deploy 2>&1 | grep -E 'Published|ERROR|WARNING' || true
npx wrangler deploy --env production 2>&1 | grep -E 'Published|ERROR|WARNING' || true
cd ..
echo "  ✓ Worker deployed"
echo ""

# ─── Step 2: Verify VIX candles ────────────────────────────────────────
echo "Step 2: Verifying VIX daily candles in D1..."
VIX_CHECK=$(curl -s -m 30 "$API_BASE/timed/charts/candles?ticker=VIX&tf=D&limit=3&key=$API_KEY" 2>&1)
VIX_OK=$(echo "$VIX_CHECK" | jq -r '.ok // false' 2>/dev/null || echo "false")
VIX_COUNT=$(echo "$VIX_CHECK" | jq -r '.candles | length // 0' 2>/dev/null || echo "0")
if [[ "$VIX_OK" == "true" && "$VIX_COUNT" -gt 0 ]]; then
  echo "  ✓ VIX candles present (loaded from TV Exports VX1!)"
else
  echo "  WARNING: No VIX candles found. Replay will use static fallback."
  echo "  To fix: load VX1! CSV via wrangler d1 execute"
fi
echo ""

# ─── Step 3: Populate Variant A config ─────────────────────────────────
echo "Step 3: Writing Variant A config to model_config..."
CONFIG_RESULT=$(curl -s -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "updates": [
      {"key": "deep_audit_ticker_blacklist", "value": "[\"AMZN\",\"MDB\",\"CCJ\",\"META\",\"SANM\",\"ETN\"]", "description": "Intel-driven toxic tickers (0% WR cross-validated)"},
      {"key": "calibrated_rank_min", "value": "65", "description": "Raised from 0 — 26 low-rank losses cost -53.66%"},
      {"key": "deep_audit_short_min_rank", "value": "70", "description": "Raised — SHORT 47.4% WR needs higher bar"},
      {"key": "deep_audit_min_htf_score", "value": "0.4", "description": "Weak HTF bias <0.4 had 14.3% WR in Run 1"}
    ]
  }' 2>&1)
CONFIG_OK=$(echo "$CONFIG_RESULT" | jq -r '.ok // false' 2>/dev/null || echo "false")
echo "  Config write: ok=$CONFIG_OK"
if [[ "$CONFIG_OK" != "true" ]]; then
  echo "  ERROR: Config write failed. Aborting."
  echo "  Response: $(echo "$CONFIG_RESULT" | head -c 300)"
  exit 1
fi

# Verify config was written
echo "  Verifying config..."
VERIFY=$(curl -s "$API_BASE/timed/system/dashboard?key=$API_KEY" 2>&1 | jq -c '.applied_adaptations // "none"' 2>/dev/null || echo "unknown")
echo "  Applied adaptations: $VERIFY"
echo ""

# ─── Step 4: Run the backtest ──────────────────────────────────────────
echo "Step 4: Starting full backtest (this will take a while)..."
echo "  Date range: 2025-07-01 → 2026-03-11"
echo "  Label: variant-a-intel-driven"
echo "  Config: blacklist=[AMZN,MDB,CCJ,META,SANM,ETN], rank_min=65, short_rank=70, htf_score=0.4"
echo ""

./scripts/full-backtest.sh \
  --trader-only \
  --label="variant-a-intel-driven" \
  --desc="Intelligence-driven variant: blacklist toxic tickers, rank min 65, short rank 70, HTF score 0.4" \
  2025-07-01 2026-03-11 15

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  BACKTEST COMPLETE"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Sync to local DB:  ./scripts/sync-d1.sh"
echo "  2. Run intelligence:  node scripts/trade-intelligence.js --run-id <run_id> --json"
echo "  3. Classify trades in Trade Autopsy UI"
echo ""
