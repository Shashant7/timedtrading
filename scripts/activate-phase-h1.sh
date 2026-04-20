#!/usr/bin/env bash
# scripts/activate-phase-h1.sh
#
# Phase-H.1 — Relax the over-eager Phase-G protective cuts.
#
# V7 backtest evidence (data/trade-analysis/phase-g-v7-1776708363/):
#   early_dead_money_flatten   28 trades, 0 wins, -39.8% sum PnL
#   atr_day_adverse_382_cut    24 trades, 5 wins, -12.5% sum PnL  (WR 20.8%)
#   max_loss_time_scaled       13 trades, 0 wins, -21.5% sum PnL
#   ---------------------------------------------------------------
#   Combined:                  65 trades, 5 wins, -73.8% sum PnL
#
# Sample of the "dead money" flattens that would have been winners:
#   LONG MSFT 2025-07-01: cut at -1.02% after 5h → MSFT +4% next 3 days
#   LONG CDNS 2025-07-11: cut at -0.85% after 69h → CDNS +8% next 2 weeks
#   LONG AAPL 2025-11-12: cut at -1.12% after 47h → AAPL +6% next week
#
# Current thresholds are too eager: they cut pullback-phase trades that
# would have recovered. This script loosens them with no code change
# and keeps the trend-integrity respect flags on so adverse trend-
# breaking moves still trigger cuts.
#
# Key changes vs Phase-G defaults:
#
#   Key                                         Phase-G   Phase-H.1    Rationale
#   deep_audit_early_dead_money_age_min         240       480          4h → 8h — let the thesis breathe
#   deep_audit_early_dead_money_mfe_max_pct     0.5       0.3          Lower MFE floor — a trade that has tagged +0.3% is alive
#   deep_audit_early_dead_money_pnl_max_pct    -1.0      -1.5          Wider pnl tolerance — pullbacks routinely dip to -1%
#   deep_audit_atr_adverse_cut_pnl_min_pct     -0.5      -1.0          Only cut on adverse ATR when pnl is meaningfully red
#
# Unchanged (keep — working as designed):
#   deep_audit_atr_tp_ladder_enabled           = true
#   deep_audit_atr_tp_ladder_week_exit_threshold = 0.618
#   deep_audit_early_dead_money_enabled        = true
#   deep_audit_atr_adverse_cut_enabled         = true
#   deep_audit_atr_adverse_cut_threshold       = -0.382
#   deep_audit_early_dead_money_respect_trend  = true  (code default)
#   deep_audit_atr_adverse_cut_respect_trend   = true  (code default)
#
# Usage:
#   TIMED_API_KEY=... scripts/activate-phase-h1.sh            # relax
#   TIMED_API_KEY=... scripts/activate-phase-h1.sh --revert   # restore Phase-G defaults

set -euo pipefail

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

MODE="relax"
if [[ "${1:-}" == "--revert" ]]; then MODE="revert"; fi

if [[ "$MODE" == "relax" ]]; then
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_early_dead_money_age_min", "value": "480"},
    {"key": "deep_audit_early_dead_money_mfe_max_pct", "value": "0.3"},
    {"key": "deep_audit_early_dead_money_pnl_max_pct", "value": "-1.5"},
    {"key": "deep_audit_atr_adverse_cut_pnl_min_pct", "value": "-1.0"}
  ]
}
JSON
else
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_early_dead_money_age_min", "value": "240"},
    {"key": "deep_audit_early_dead_money_mfe_max_pct", "value": "0.5"},
    {"key": "deep_audit_early_dead_money_pnl_max_pct", "value": "-1.0"},
    {"key": "deep_audit_atr_adverse_cut_pnl_min_pct", "value": "-0.5"}
  ]
}
JSON
fi

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Phase-H.1 $MODE"
RESP=$(curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD")
echo "$RESP" | python3 -m json.tool
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
if [[ "$OK" != "True" ]]; then exit 1; fi
echo "OK. Keys written to model_config. Register a fresh run to pin them."
