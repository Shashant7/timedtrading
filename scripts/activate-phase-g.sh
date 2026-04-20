#!/usr/bin/env bash
# scripts/activate-phase-g.sh
#
# Activates Phase-G refinements derived from v6b Golden Gate probability
# analysis. Evidence source:
#   data/trade-analysis/phase-f-continuous-v6b/forensics/golden-gate/completion-matrix.md
#
# G.2 ATR Level TP Ladder (Day horizon, probability-weighted per cohort)
#     Uses existing ATR Levels emitted by computeATRLevels(). Cohort trim
#     % derived from conditional-probability matrix:
#       Day 0.382 -> 0.618: 79% fav (commit threshold)
#       Day 0.618 -> 1.0:   75% fav
#       Day 1.0 -> 1.618:   65% fav (runner band)
#     Cohort-specific allocations hard-coded in worker (index.js).
#     Also fires FULL EXIT at Week +0.618 since only 23% continue past.
#
# G.3 Early Dead-Money Flatten
#     Evidence: 38 'never_worked' trades with MFE<1% rode to -2.56% avg.
#     At 4h market-min, if MFE < +0.5% AND pnl <= -1%, flatten.
#
# G.4 Adverse Day -0.382 ATR Cut
#     Evidence: once price crosses -0.382 Day ATR adversely, 73% of the
#     time it continues to -0.618. Cut at -0.382 rather than waiting for
#     -0.618 or hard stop.
#
# Usage:
#   TIMED_API_KEY=... scripts/activate-phase-g.sh [--deactivate]

set -euo pipefail

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

MODE="activate"
if [[ "${1:-}" == "--deactivate" ]]; then MODE="deactivate"; fi

if [[ "$MODE" == "activate" ]]; then
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_atr_tp_ladder_enabled", "value": "true"},
    {"key": "deep_audit_atr_tp_ladder_week_exit_threshold", "value": "0.618"},
    {"key": "deep_audit_early_dead_money_enabled", "value": "true"},
    {"key": "deep_audit_early_dead_money_age_min", "value": "240"},
    {"key": "deep_audit_early_dead_money_mfe_max_pct", "value": "0.5"},
    {"key": "deep_audit_early_dead_money_pnl_max_pct", "value": "-1.0"},
    {"key": "deep_audit_atr_adverse_cut_enabled", "value": "true"},
    {"key": "deep_audit_atr_adverse_cut_threshold", "value": "-0.382"},
    {"key": "deep_audit_atr_adverse_cut_pnl_min_pct", "value": "-0.5"},
    {"key": "deep_audit_early_dead_money_respect_trend", "value": "true"},
    {"key": "deep_audit_atr_adverse_cut_respect_trend", "value": "true"},
    {"key": "deep_audit_atr_adverse_cut_hard_pnl_floor_pct", "value": "-2.0"}
  ]
}
JSON
else
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_atr_tp_ladder_enabled", "value": "false"},
    {"key": "deep_audit_early_dead_money_enabled", "value": "false"},
    {"key": "deep_audit_atr_adverse_cut_enabled", "value": "false"}
  ]
}
JSON
fi

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Phase-G $MODE"
RESP=$(curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD")
echo "$RESP" | python3 -m json.tool
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
if [[ "$OK" != "True" ]]; then exit 1; fi
echo "OK. Deploy worker first; register fresh runs to pin these values."
