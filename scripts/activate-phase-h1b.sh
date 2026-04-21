#!/usr/bin/env bash
# scripts/activate-phase-h1b.sh
#
# Phase-H.1b — Middle-ground relaxation.
#
# H.1a (first attempt) over-relaxed early_dead_money, so Aug 2025 chop
# produced 6 losers > -3% (vs 2 in v7) and avg_loss deepened -1.16% -> -1.80%
# in the Jul-Aug 29 window. Jul-only smoke looked great (+26% PnL) because
# July was trending and pullbacks recovered. August chop exposed the gap.
#
# Findings from v8 (Jul-Aug 29):
#   Loss bucket size:     v7        v8 (H.1a)
#     -1.5 to -0.5        10        6   (H.1a saved these — good)
#     -3 to -1.5          2         5   (H.1a let these bleed deeper — bad)
#     < -3                2         6   (H.1a let these ride to HARD_LOSS_CAP — very bad)
#
# H.1b threads the needle: keep the relaxations that saved winning pullbacks
# (adverse-cut pnl floor, MFE threshold) but tighten early_dead_money so
# Aug-style chop doesn't bleed to -3%+.
#
#   Key                                       v7      H.1a     H.1b      Rationale
#   deep_audit_early_dead_money_age_min       240     480      360       6h: catches chop earlier than 8h
#   deep_audit_early_dead_money_mfe_max_pct   0.5     0.3      0.3       keep — a tag of +0.3% is signal
#   deep_audit_early_dead_money_pnl_max_pct   -1.0    -1.5     -1.25     middle: give pullbacks breathing
#   deep_audit_atr_adverse_cut_pnl_min_pct    -0.5    -1.0     -1.0      keep — works
#
# The combination: after 6h if MFE <+0.3% AND pnl <= -1.25%, flatten.
# Trades with trend-integrity intact (state + 15m ST aligned) are still
# exempted via respect_trend flags.
#
# Usage:
#   TIMED_API_KEY=... scripts/activate-phase-h1b.sh             # apply H.1b
#   TIMED_API_KEY=... scripts/activate-phase-h1b.sh --h1a       # back to H.1a (first relaxation)
#   TIMED_API_KEY=... scripts/activate-phase-h1b.sh --revert    # back to Phase-G defaults

set -euo pipefail

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

MODE="h1b"
case "${1:-}" in
  --h1a)     MODE="h1a" ;;
  --revert)  MODE="revert" ;;
esac

case "$MODE" in
  h1b)
    read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_early_dead_money_age_min", "value": "360"},
    {"key": "deep_audit_early_dead_money_mfe_max_pct", "value": "0.3"},
    {"key": "deep_audit_early_dead_money_pnl_max_pct", "value": "-1.25"},
    {"key": "deep_audit_atr_adverse_cut_pnl_min_pct", "value": "-1.0"}
  ]
}
JSON
    ;;
  h1a)
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
    ;;
  revert)
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
    ;;
esac

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Phase-H.1 $MODE"
RESP=$(curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD")
echo "$RESP" | python3 -m json.tool
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
if [[ "$OK" != "True" ]]; then exit 1; fi
echo "OK. Keys written to model_config. Register a fresh run to pin them."
