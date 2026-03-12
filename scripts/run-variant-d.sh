#!/bin/bash
# Variant D: Full Guard Suite + 3-Tier Portfolio-% Position Sizing
#
# Inherits all Variant C guards:
# - DA-6:  Opening noise (15 min)
# - DA-7:  HTF bias floors (1H >= 0.25, 4H >= 0.25)
# - DA-8:  LTF momentum (bias >= -0.5, RSI >= 35)
# - DA-9:  RSI floor (15m RSI < 45 blocks LONG)
# - DA-10: EMA depth floor (15m depth < 5 blocks)
# - Runner peak trailing stop (2% from post-trim peak)
# - Post-trim breakeven SL (secondary safety net)
# - Compression stall timer (48h, 1.5% PnL threshold)
# - Soft fuse defer (1H depth >= 12 + HTF ST aligned)
# - Loss cooldown (12h per ticker)
#
# New in Variant D:
# - 3-Tier portfolio-% position sizing:
#   TT Prime 1.0%, TT Confirmed 0.5%, TT Speculative 0.25%
# - Descriptive setup names (TT Confirmed Long, etc.)
# - Tier/setup recorded to D1 for post-run analysis
# - MAX_NOTIONAL replaced with 20% account cap
# - Post-trim hybrid exit guard:
#   - Tighter 1.25% trail after first trim (pre-runner phase)
#   - Stale runner timer: 10 bars without new high → snap SL tight
#   - Momentum fade: 2+ bearish signals → lock 30% of move
#
# Usage: caffeinate ./scripts/run-variant-d.sh

set -e
API_BASE="https://timed-trading-ingest.shashant.workers.dev"
API_KEY="AwesomeSauce"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  VARIANT D: Full Guards + 3-Tier Portfolio-% Sizing"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ─── Step 1: Verify worker is deployed ────────────────────────────────
echo "Step 1: Verifying worker deployment..."
HEALTH=$(curl -s -m 15 "$API_BASE/timed/admin/grade-config?key=$API_KEY" 2>&1)
HEALTH_OK=$(echo "$HEALTH" | jq -r '.ok // false' 2>/dev/null || echo "false")
if [[ "$HEALTH_OK" == "true" ]]; then
  echo "  Worker healthy — grade-config endpoint responding"
  echo "  Current tier map: $(echo "$HEALTH" | jq -c '.tierRiskMap' 2>/dev/null)"
else
  echo "  WARNING: grade-config endpoint not responding. Worker may need deploy."
  echo "  Response: $(echo "$HEALTH" | head -c 300)"
fi
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

# ─── Step 3: Write Variant D config ──────────────────────────────────
echo "Step 3: Writing Variant D config to model_config..."

CONFIG_RESULT=$(curl -s -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "updates": [
      {"key": "deep_audit_opening_noise_end_minute", "value": "15", "description": "DA-6: Block entries in first 15 min after open"},
      {"key": "deep_audit_min_1h_bias", "value": "0.25", "description": "DA-7: Require 1H bias >= 0.25"},
      {"key": "deep_audit_min_4h_bias", "value": "0.25", "description": "DA-7: Require 4H bias >= 0.25"},
      {"key": "deep_audit_ltf_momentum_min_bias", "value": "-0.5", "description": "DA-8: Block LONG when LTF bias < -0.5"},
      {"key": "deep_audit_ltf_momentum_min_rsi", "value": "35", "description": "DA-8: Block LONG when LTF RSI < 35"},
      {"key": "deep_audit_ltf_rsi_floor", "value": "45", "description": "DA-9: Block LONG when 15m RSI < 45"},
      {"key": "deep_audit_min_ltf_ema_depth", "value": "5", "description": "DA-10: Block when 15m EMA depth < 5"},
      {"key": "deep_audit_runner_trail_pct", "value": "2.0", "description": "Post-trim trailing stop: 2% from peak"},
      {"key": "deep_audit_post_trim_breakeven", "value": "1", "description": "Post-trim SL floors at breakeven"},
      {"key": "deep_audit_stall_max_hours", "value": "48", "description": "Stall timer: tighten SL after 48h of no progress"},
      {"key": "deep_audit_stall_breakeven_pnl_pct", "value": "1.5", "description": "Stall timer: fires when PnL < 1.5%"},
      {"key": "deep_audit_soft_fuse_defer_min_1h_depth", "value": "12", "description": "Defer soft fuse when 1H depth >= 12 + HTF ST aligned"},
      {"key": "deep_audit_loss_cooldown_hours", "value": "12", "description": "12h cooldown after loss on same ticker"},
      {"key": "tier_risk_map", "value": "{\"Prime\":0.010,\"Confirmed\":0.005,\"Speculative\":0.0025}", "description": "3-Tier portfolio-% sizing: Prime 1%, Confirmed 0.5%, Speculative 0.25%"},
      {"key": "deep_audit_post_trim_trail_pct", "value": "1.25", "description": "Tighter trail after first trim: 1.25% from peak (pre-runner phase)"},
      {"key": "deep_audit_stale_runner_bars", "value": "10", "description": "Stale runner: exit when no new high for 10 bars (~2.5h)"},
      {"key": "deep_audit_momentum_fade_exit", "value": "1", "description": "Momentum fade: tighten SL when 2+ bearish signals converge post-trim"}
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
echo "  Date range: 2025-07-01 -> 2026-03-12"
echo "  Label: variant-d-tiered-sizing"
echo "  Guards: all Variant C guards"
echo "  New: 3-tier portfolio-% sizing + post-trim hybrid exit guard"
echo ""

./scripts/full-backtest.sh \
  --trader-only \
  --label="variant-d-tiered-sizing" \
  --desc="Full guard suite (DA-6 thru DA-10) + 3-tier portfolio-% sizing + post-trim hybrid exit guard (tight trail 1.25%, stale runner 10 bars, momentum fade)" \
  2025-07-01 2026-03-12 15

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  VARIANT D BACKTEST COMPLETE"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Review trades in Trade Autopsy UI"
echo "  2. Check tier distribution in System Intelligence > Trade Grading tab"
echo "  3. Compare with Variant B baseline (160 trades, 51.2% WR)"
echo "  4. Analyze: which tiers win? which TT setups perform?"
echo ""
