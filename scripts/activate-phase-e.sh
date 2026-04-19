#!/usr/bin/env bash
# scripts/activate-phase-e.sh
#
# Activates the three Phase-E daily-structure-aware gates and the
# index-ETF swing trigger by writing their DA keys to model_config.
#
# Phase E (2026-04-19) adds:
#   1. tt_index_etf_swing_trigger — Daily-Brief-aligned swing entry for
#      SPY/QQQ/IWM that fires when D21/D48/D200 are stacked, price sits
#      in a healthy +1..+7% extension band above D48, and e21_slope_5d
#      is between +0.3 and +3.0 %.
#   2. tt_d_ema_overextended universal gate — rejects LONG when
#      pct_above_e48 > +7 %, e21_slope_5d > +3.5 % (parabolic), or
#      e48_slope_10d < +0.25 % (flat structure pullback fakeout).
#      Mirror rejections for SHORT.
#   3. SPY-regime-activated SHORT relaxation — when SPY is below D200
#      or bear-stacked, relaxes tt_short_pullback_not_deep_enough from
#      2-of-3 to 1-of-3 bullish-count AND allows ctx_short_daily_st_not_bear
#      when the ticker's daily ST is neutral (not explicitly bullish).
#
# Usage:
#   TIMED_API_KEY=... scripts/activate-phase-e.sh [--deactivate]

set -euo pipefail

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

MODE="activate"
if [[ "${1:-}" == "--deactivate" ]]; then
  MODE="deactivate"
fi

if [[ "$MODE" == "activate" ]]; then
  # All tunable defaults. These are conservative based on the 10-month
  # Phase-D synthesis; re-tune only after a full 10-month rerun.
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_index_etf_swing_enabled", "value": "true"},
    {"key": "deep_audit_index_etf_swing_tickers", "value": "SPY,QQQ,IWM"},
    {"key": "deep_audit_index_etf_swing_min_score", "value": "92"},
    {"key": "deep_audit_index_etf_swing_pct_above_e48_min", "value": "0.5"},
    {"key": "deep_audit_index_etf_swing_pct_above_e48_max", "value": "7.0"},
    {"key": "deep_audit_index_etf_swing_pct_below_e48_min", "value": "0.5"},
    {"key": "deep_audit_index_etf_swing_pct_below_e48_max", "value": "7.0"},
    {"key": "deep_audit_index_etf_swing_e21_slope_min", "value": "0.2"},
    {"key": "deep_audit_index_etf_swing_e21_slope_max", "value": "3.0"},
    {"key": "deep_audit_index_etf_swing_rvol_min", "value": "0.5"},
    {"key": "deep_audit_d_ema_overextension_gate_enabled", "value": "true"},
    {"key": "deep_audit_d_ema_long_max_above_e48_pct", "value": "7.0"},
    {"key": "deep_audit_d_ema_long_max_e21_slope_pct", "value": "3.5"},
    {"key": "deep_audit_d_ema_long_min_e48_slope_pct", "value": "0.25"},
    {"key": "deep_audit_d_ema_short_max_below_e48_pct", "value": "7.0"},
    {"key": "deep_audit_d_ema_short_max_e21_slope_pct", "value": "-3.5"},
    {"key": "deep_audit_d_ema_short_max_e48_slope_pct", "value": "-0.25"},
    {"key": "deep_audit_short_spy_regime_relax_enabled", "value": "true"},
    {"key": "deep_audit_short_allow_neutral_daily_st_when_spy_bear", "value": "true"}
  ]
}
JSON
else
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_index_etf_swing_enabled", "value": "false"},
    {"key": "deep_audit_d_ema_overextension_gate_enabled", "value": "false"},
    {"key": "deep_audit_short_spy_regime_relax_enabled", "value": "false"},
    {"key": "deep_audit_short_allow_neutral_daily_st_when_spy_bear", "value": "false"}
  ]
}
JSON
fi

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Phase-E $MODE"
RESP=$(curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")
echo "$RESP" | python3 -m json.tool

OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
if [[ "$OK" != "True" ]]; then
  echo "ERROR: activation failed" >&2
  exit 1
fi
echo "OK. Deploy the Phase-E worker first; then register a fresh run to pin these values."
