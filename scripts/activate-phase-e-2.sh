#!/usr/bin/env bash
# scripts/activate-phase-e-2.sh
#
# Activates Phase-E.2 management-side loss mitigation. Evidence from the
# Phase-E v3 5-month rerun (Jul-Nov 2025):
#   - max_loss: 10 fires, avg hold 53.3 h, avg pnl -2.60 %. Single worst:
#     MSFT 144h/-2.90 %, META 116h/-2.81 %, QQQ 72h/-3.13 %. We're too
#     slow to cut — the -3 % floor fires too late.
#   - PRE_EVENT_RECOVERY_EXIT: 14 fires, avg pnl -0.11 %. 14/14 clipped
#     at scratch. 13 held 20-166 h first.
#   - replay_end_close (runner): QQQ -10.37 %, XLY -7.08 %, QQQ -8.56 %
#     from Aug/Oct 2025. Trimmed runners bled past any reasonable cap.
#
# Fixes:
#   F1: time-scaled max_loss (ratchet floor as position ages)
#   F2: narrow PRE_EVENT_RECOVERY_EXIT macro window 24h->6h + skip in-profit
#   F3: runner drawdown cap at -2 % once first trim has happened
#   F4: dead-money detector (24h + MFE < +1 % + pnl <= -1 % -> flatten)
#
# Usage:
#   TIMED_API_KEY=... scripts/activate-phase-e-2.sh [--deactivate]

set -euo pipefail

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

MODE="activate"
if [[ "${1:-}" == "--deactivate" ]]; then
  MODE="deactivate"
fi

if [[ "$MODE" == "activate" ]]; then
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_time_scaled_max_loss_enabled", "value": "true"},
    {"key": "deep_audit_time_scaled_max_loss_4h_pct", "value": "-2.5"},
    {"key": "deep_audit_time_scaled_max_loss_12h_pct", "value": "-2.0"},
    {"key": "deep_audit_time_scaled_max_loss_24h_pct", "value": "-1.5"},
    {"key": "deep_audit_runner_drawdown_cap_enabled", "value": "true"},
    {"key": "deep_audit_runner_drawdown_cap_pct", "value": "-2.0"},
    {"key": "deep_audit_dead_money_exit_enabled", "value": "true"},
    {"key": "deep_audit_dead_money_age_market_min", "value": "1440"},
    {"key": "deep_audit_dead_money_mfe_max_pct", "value": "1.0"},
    {"key": "deep_audit_dead_money_pnl_max_pct", "value": "-1.0"},
    {"key": "deep_audit_pre_event_recovery_skip_if_profit_enabled", "value": "true"},
    {"key": "deep_audit_pre_event_recovery_skip_if_profit_min_pnl_pct", "value": "0.25"}
  ]
}
JSON
else
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_time_scaled_max_loss_enabled", "value": "false"},
    {"key": "deep_audit_runner_drawdown_cap_enabled", "value": "false"},
    {"key": "deep_audit_dead_money_exit_enabled", "value": "false"},
    {"key": "deep_audit_pre_event_recovery_skip_if_profit_enabled", "value": "false"}
  ]
}
JSON
fi

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Phase-E.2 $MODE"
RESP=$(curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")
echo "$RESP" | python3 -m json.tool

OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
if [[ "$OK" != "True" ]]; then
  echo "ERROR: activation failed" >&2
  exit 1
fi
echo "OK. Deploy worker first; then register fresh runs to pin these values."
