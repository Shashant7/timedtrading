#!/usr/bin/env bash
# scripts/activate-phase-h3.sh
#
# Phase-H.3 — Entry Discipline + Regime-Adaptive Strategy.
#
# Three-layer entry gate stack derived from the cross-backtest analysis
# that exposed E.3 as our peak (68.8% WR / +214% PnL, 109 selective LONGs),
# with monotonic WR regression through Phase-F (SHORT activation) and
# Phase-G (looser cuts). H.3 restores E.3-level selectivity while keeping
# Phase-F's SHORT capability — but only when the macro backdrop agrees.
#
# Layer 1 — Rank floor (setup quality)
#   Only take rank>=90 setups. E.3 had 94% of trades at rank>=80; v7 had
#   32 sub-rank-70 trades at breakeven WR that diluted the edge.
#
# Layer 2 — Regime-adaptive strategy (macro backdrop)
#   Don't fight the tape. In "uptrend" months, block SHORTs unless ticker
#   is speculative AND rank>=98. In "downtrend" months, block LONGs unless
#   4H ST is bullish AND rank>=98. Transitional months bump rank floor.
#   Motivating case: Apr 2026 backdrop = "uptrend". v7 took 22 SHORTs.
#   All lost (WR 22.7%, -33% PnL).
#
# Layer 3 — Multi-signal consensus gate
#   Setup must be corroborated by >=3 of 5 signals:
#     (1) Trend alignment (2 of 3 HTF ST)
#     (2) RSI momentum (30m + 1H on direction side of 50)
#     (3) Volume (30m or 1H rvol >= 1.2)
#     (4) Sector rating (OW for LONG, UW for SHORT)
#     (5) Phase 15-75% sweet spot
#
# All layers are DA-key gated — can disable any one independently.
#
# Usage:
#   TIMED_API_KEY=... scripts/activate-phase-h3.sh             # activate all layers
#   TIMED_API_KEY=... scripts/activate-phase-h3.sh --deactivate  # disable all layers

set -euo pipefail

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

MODE="activate"
if [[ "${1:-}" == "--deactivate" ]]; then MODE="deactivate"; fi

if [[ "$MODE" == "activate" ]]; then
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_min_rank_floor", "value": "90"},
    {"key": "deep_audit_regime_adaptive_enabled", "value": "true"},
    {"key": "deep_audit_regime_uptrend_short_rank_min", "value": "98"},
    {"key": "deep_audit_regime_uptrend_short_cohorts", "value": "speculative"},
    {"key": "deep_audit_regime_downtrend_long_rank_min", "value": "98"},
    {"key": "deep_audit_regime_downtrend_long_require_4h_bull", "value": "true"},
    {"key": "deep_audit_regime_transitional_rank_min", "value": "92"},
    {"key": "deep_audit_consensus_gate_enabled", "value": "true"},
    {"key": "deep_audit_consensus_min_signals", "value": "3"},
    {"key": "deep_audit_consensus_volume_rvol_min", "value": "1.2"}
  ]
}
JSON
else
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_min_rank_floor", "value": "0"},
    {"key": "deep_audit_regime_adaptive_enabled", "value": "false"},
    {"key": "deep_audit_consensus_gate_enabled", "value": "false"}
  ]
}
JSON
fi

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Phase-H.3 $MODE"
RESP=$(curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD")
echo "$RESP" | python3 -m json.tool
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
if [[ "$OK" != "True" ]]; then exit 1; fi
echo "OK. Deploy worker first; register fresh runs to pin these values."
