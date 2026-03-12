#!/bin/bash
# Variant C: Data-Driven Guards + Smart Runner from Variant B Analysis
#
# New guards based on 160-trade Variant B analysis:
# - DA-9:  RSI Floor (block LONG when 15m RSI < 45 — 21.4% WR zone)
# - DA-10: EMA Depth Floor (block when 15m depth < 5 — 36.4% WR zone)
# - Runner peak trailing stop (2% from post-trim peak — +54% PnL improvement)
# - Post-trim breakeven SL (secondary safety net)
# - Compression stall timer (43 trades held 24h+ with < 3% PnL)
# - SOFT FUSE defer (conservative: only when 1H depth >= 12 + 4H+D ST aligned)
#
# Inherits Variant B config and adds the new guards.
#
# Usage: caffeinate ./scripts/run-variant-c.sh

set -e
API_BASE="https://timed-trading-ingest.shashant.workers.dev"
API_KEY="AwesomeSauce"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  VARIANT C: Data-Driven Guards"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ─── Step 1: Deploy worker with new guard code ───────────────────────
echo "Step 1: Deploying worker (DA-9, DA-10, runner peak trail, stall timer, fuse defer)..."
cd worker
npx wrangler deploy 2>&1 | grep -E 'Published|ERROR|WARNING' || true
npx wrangler deploy --env production 2>&1 | grep -E 'Published|ERROR|WARNING' || true
cd ..
echo "  Done deploying"
echo ""

# ─── Step 2: Verify VIX candles ──────────────────────────────────────
echo "Step 2: Verifying VIX candles..."
VIX_CHECK=$(curl -s -m 30 "$API_BASE/timed/charts/candles?ticker=VIX&tf=D&limit=3&key=$API_KEY" 2>&1)
VIX_COUNT=$(echo "$VIX_CHECK" | jq -r '.candles | length // 0' 2>/dev/null || echo "0")
if [[ "$VIX_COUNT" -gt 0 ]]; then
  echo "  VIX candles present ($VIX_COUNT recent)"
else
  echo "  WARNING: No VIX candles found. Replay will use static fallback."
fi
echo ""

# ─── Step 3: Write Variant C config ──────────────────────────────────
echo "Step 3: Writing Variant C config to model_config..."

# Carry over Variant B foundation + add new data-driven guards
CONFIG_RESULT=$(curl -s -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "updates": [
      {"key": "deep_audit_opening_noise_end_minute", "value": "15", "description": "DA-6: Block entries in first 15 min after open"},
      {"key": "deep_audit_min_1h_bias", "value": "0.25", "description": "DA-7: Require 1H bias >= 0.25"},
      {"key": "deep_audit_min_4h_bias", "value": "0.25", "description": "DA-7: Require 4H bias >= 0.25"},
      {"key": "deep_audit_ltf_momentum_min_bias", "value": "-0.5", "description": "DA-8: Block LONG when LTF bias < -0.5"},
      {"key": "deep_audit_ltf_momentum_min_rsi", "value": "35", "description": "DA-8: Block LONG when LTF RSI < 35"},
      {"key": "deep_audit_ltf_rsi_floor", "value": "45", "description": "DA-9: Block LONG when 15m RSI < 45 (21.4% WR zone)"},
      {"key": "deep_audit_min_ltf_ema_depth", "value": "5", "description": "DA-10: Block when 15m EMA depth < 5 (36.4% WR zone)"},
      {"key": "deep_audit_runner_trail_pct", "value": "2.0", "description": "Post-trim trailing stop: 2% from peak (+54% PnL improvement in sim)"},
      {"key": "deep_audit_post_trim_breakeven", "value": "1", "description": "Post-trim SL floors at breakeven (secondary safety net)"},
      {"key": "deep_audit_stall_max_hours", "value": "48", "description": "Stall timer: tighten SL after 48h of no progress"},
      {"key": "deep_audit_stall_breakeven_pnl_pct", "value": "1.5", "description": "Stall timer: fires when PnL < 1.5%"},
      {"key": "deep_audit_soft_fuse_defer_min_1h_depth", "value": "12", "description": "Defer soft fuse when 1H depth >= 12 + HTF ST aligned"},
      {"key": "deep_audit_loss_cooldown_hours", "value": "12", "description": "12h cooldown after loss on same ticker"}
    ]
  }' 2>&1)

CONFIG_OK=$(echo "$CONFIG_RESULT" | jq -r '.ok // false' 2>/dev/null || echo "false")
echo "  Config write: ok=$CONFIG_OK"
if [[ "$CONFIG_OK" != "true" ]]; then
  echo "  ERROR: Config write failed. Aborting."
  echo "  Response: $(echo "$CONFIG_RESULT" | head -c 500)"
  exit 1
fi
echo ""

# ─── Step 4: Run the backtest ─────────────────────────────────────────
echo "Step 4: Starting full backtest..."
echo "  Date range: 2025-07-01 -> 2026-03-11"
echo "  Label: variant-c-data-driven-guards"
echo "  New guards: RSI floor 45, depth floor 5, 2% peak trail, stall 48h, fuse defer depth 12"
echo ""

./scripts/full-backtest.sh \
  --trader-only \
  --label="variant-c-data-driven-guards" \
  --desc="Data-driven guards from Variant B analysis: RSI floor 45, depth floor 5, 2% peak trailing stop, post-trim BE, 48h stall timer, soft fuse defer at 1H depth 12" \
  2025-07-01 2026-03-11 15

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  VARIANT C BACKTEST COMPLETE"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Review trades in Trade Autopsy UI"
echo "  2. Run analysis: node scripts/variant-b-analysis.js --run-id <run_id>"
echo "  3. Compare with Variant B baseline (160 trades, 51.2% WR)"
echo ""
