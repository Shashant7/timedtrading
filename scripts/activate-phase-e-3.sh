#!/usr/bin/env bash
# scripts/activate-phase-e-3.sh
#
# Activates Phase-E.3 cohort-aware entry thresholds. Evidence from the
# Phase-E.2 v4 pattern-mining analysis (150 trades / 8 months):
#
#   Cohort          WR    Avg PnL   Key observation
#   Index ETF       75%   +0.85%    10 flat-slope entries = scratch
#   Mega-Cap Tech   69%   +1.10%    Overbought RSI GREEN (87% WR)
#   Industrial      59%   +1.37%    Neutral RSI TOXIC (25% WR)
#   Speculative     65%   +2.57%    Extended+parabolic best (+6.6% avg)
#   Sector ETF      67%   -0.98%    Only negative cohort → PAUSE
#
# Per-cohort thresholds codified via DA keys. Defaults conservative.
#
# Usage:
#   TIMED_API_KEY=... scripts/activate-phase-e-3.sh [--deactivate]

set -euo pipefail
API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

MODE="activate"
if [[ "${1:-}" == "--deactivate" ]]; then MODE="deactivate"; fi

if [[ "$MODE" == "activate" ]]; then
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_cohort_overlay_enabled", "value": "true"},
    {"key": "deep_audit_cohort_index_etf_tickers", "value": "SPY,QQQ,IWM"},
    {"key": "deep_audit_cohort_megacap_tickers", "value": "AAPL,MSFT,GOOGL,AMZN,META,NVDA,TSLA"},
    {"key": "deep_audit_cohort_industrial_tickers", "value": "ETN,FIX,IESC,MTZ,PH,SWK"},
    {"key": "deep_audit_cohort_speculative_tickers", "value": "AGQ,GRNY,RIOT,SGI"},
    {"key": "deep_audit_cohort_sector_etf_tickers", "value": "XLY"},
    {"key": "deep_audit_cohort_sector_etf_pause_enabled", "value": "true"},
    {"key": "deep_audit_cohort_slope_min_index_etf", "value": "0.5"},
    {"key": "deep_audit_cohort_extension_max_index_etf", "value": "5.0"},
    {"key": "deep_audit_cohort_rsi_max_index_etf", "value": "75"},
    {"key": "deep_audit_cohort_slope_min_megacap", "value": "0.3"},
    {"key": "deep_audit_cohort_extension_max_megacap", "value": "8.0"},
    {"key": "deep_audit_cohort_slope_min_industrial", "value": "0.7"},
    {"key": "deep_audit_cohort_extension_max_industrial", "value": "8.0"},
    {"key": "deep_audit_cohort_rsi_neutral_block_industrial", "value": "55"},
    {"key": "deep_audit_cohort_slope_min_speculative", "value": "0.3"},
    {"key": "deep_audit_cohort_extension_max_speculative", "value": "99.0"}
  ]
}
JSON
else
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_cohort_overlay_enabled", "value": "false"},
    {"key": "deep_audit_cohort_sector_etf_pause_enabled", "value": "false"}
  ]
}
JSON
fi

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Phase-E.3 $MODE"
RESP=$(curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")
echo "$RESP" | python3 -m json.tool
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
if [[ "$OK" != "True" ]]; then exit 1; fi
echo "OK. Deploy worker first; register fresh runs to pin these values."
