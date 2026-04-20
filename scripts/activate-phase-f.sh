#!/usr/bin/env bash
# scripts/activate-phase-f.sh
#
# Activates Phase-F SHORT-side fixes. Evidence from Phase-E.3 v5 Mar 2026
# block-chain (41,712 blocked bars, 9,887 short-related, 0 SHORT trades):
#
#   tt_d_ema_short_overextended: 4,194 blocks (price > 7% below D48 was
#     the PAY zone, not rejection zone — backwards)
#   tt_short_pullback_not_deep_enough: 2,552 blocks
#   ctx_short_daily_st_not_bear: 2,031 blocks (TSLA Mar 10 had bear_stack
#     + below D200 + declining D48 but stDirD=0)
#   tt_d_ema_short_flat_structure: 855 blocks
#
# Phase-F fixes:
#   F8: raise overextended threshold to 15% below D48 AND require D21 slope
#       turning up (capitulation bounce); flip flat_structure to reject
#       when D48 RISING (bull intact).
#   F9: bypass flat_structure when SPY bear-stacked.
#   F10: accept ticker's daily bear STRUCTURE as substitute for ST flag.
#   F11: SHORT cohort overlay (slope_max, extension_min, rsi_min per cohort)
#   F12: relax short pullback to 0-of-3 when BOTH SPY and ticker bear-stacked.
#
# Usage: TIMED_API_KEY=... scripts/activate-phase-f.sh [--deactivate]

set -euo pipefail
API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

MODE="activate"
if [[ "${1:-}" == "--deactivate" ]]; then MODE="deactivate"; fi

if [[ "$MODE" == "activate" ]]; then
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_d_ema_short_max_below_e48_pct", "value": "15.0"},
    {"key": "deep_audit_d_ema_short_capitulation_slope_pct", "value": "0.5"},
    {"key": "deep_audit_d_ema_short_max_e48_slope_pct", "value": "0.25"},
    {"key": "deep_audit_short_accept_structural_bear_substitute", "value": "true"},
    {"key": "deep_audit_cohort_short_slope_max_index_etf", "value": "-0.5"},
    {"key": "deep_audit_cohort_short_extension_min_index_etf", "value": "-1.0"},
    {"key": "deep_audit_cohort_short_rsi_min_index_etf", "value": "25"},
    {"key": "deep_audit_cohort_short_slope_max_megacap", "value": "-0.3"},
    {"key": "deep_audit_cohort_short_extension_min_megacap", "value": "-1.0"},
    {"key": "deep_audit_cohort_short_rsi_min_megacap", "value": "30"},
    {"key": "deep_audit_cohort_short_slope_max_industrial", "value": "-0.7"},
    {"key": "deep_audit_cohort_short_extension_min_industrial", "value": "-1.0"},
    {"key": "deep_audit_cohort_short_rsi_min_industrial", "value": "30"},
    {"key": "deep_audit_cohort_short_slope_max_speculative", "value": "-0.3"},
    {"key": "deep_audit_cohort_short_extension_min_speculative", "value": "-1.0"},
    {"key": "deep_audit_cohort_short_rsi_min_speculative", "value": "25"},
    {"key": "deep_audit_short_full_bear_relax_enabled", "value": "true"},
    {"key": "deep_audit_short_bypass_4h_depth_when_bear_structure", "value": "true"}
  ]
}
JSON
else
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_short_accept_structural_bear_substitute", "value": "false"},
    {"key": "deep_audit_short_full_bear_relax_enabled", "value": "false"},
    {"key": "deep_audit_d_ema_short_max_below_e48_pct", "value": "7.0"},
    {"key": "deep_audit_d_ema_short_max_e48_slope_pct", "value": "-0.25"}
  ]
}
JSON
fi

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Phase-F $MODE"
RESP=$(curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD")
echo "$RESP" | python3 -m json.tool
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
if [[ "$OK" != "True" ]]; then exit 1; fi
echo "OK. Deploy worker first; register fresh runs to pin these values."
