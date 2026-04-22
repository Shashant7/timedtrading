#!/usr/bin/env bash
# scripts/activate-phase-i.sh
#
# Phase-I activation — the full set of refinements designed from the
# v10b autopsy + v9-subset-vs-NEW-215 analysis.
#
# Workstream 1 (position lifecycle):
#   - deep_audit_duplicate_open_block_enabled=true
#   - deep_audit_reentry_throttle_hours=24
#   - deep_audit_stale_position_force_close_days=45
#
# Workstream 2 (SHORT selectivity):
#   - deep_audit_short_requires_spy_downtrend=true
#   - deep_audit_short_spy_carveout_rank_min=95
#   - deep_audit_short_spy_carveout_cohorts=speculative
#   - deep_audit_short_sector_strength_gate=true
#   - deep_audit_short_sector_strength_rank_min=98
#
# Workstream 3 (smart MLTS):
#   - deep_audit_max_loss_time_scaled_v2=true
#
# Workstream 4 (universe-adaptive rank floor):
#   - deep_audit_strict_rank_required=true
#   - deep_audit_universe_adaptive_rank=true
#   - deep_audit_universe_rank_reference=40
#   - deep_audit_universe_rank_bump_per_ref=3
#   - deep_audit_min_rank_floor=85           (effective=100 on 215T, =88 on 80T, =85 on 40T)
#
# Plus preserves Phase-H.3 + H.4 active gates.
#
# Usage:
#   TIMED_API_KEY=... scripts/activate-phase-i.sh             # activate
#   TIMED_API_KEY=... scripts/activate-phase-i.sh --deactivate  # disable

set -euo pipefail

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

MODE="activate"
if [[ "${1:-}" == "--deactivate" ]]; then MODE="deactivate"; fi

if [[ "$MODE" == "activate" ]]; then
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_duplicate_open_block_enabled", "value": "true"},
    {"key": "deep_audit_reentry_throttle_hours", "value": "24"},
    {"key": "deep_audit_stale_position_force_close_days", "value": "45"},

    {"key": "deep_audit_short_requires_spy_downtrend", "value": "true"},
    {"key": "deep_audit_short_spy_carveout_rank_min", "value": "95"},
    {"key": "deep_audit_short_spy_carveout_cohorts", "value": "speculative"},
    {"key": "deep_audit_short_sector_strength_gate", "value": "true"},
    {"key": "deep_audit_short_sector_strength_rank_min", "value": "98"},

    {"key": "deep_audit_max_loss_time_scaled_v2", "value": "true"},

    {"key": "deep_audit_strict_rank_required", "value": "true"},
    {"key": "deep_audit_universe_adaptive_rank", "value": "true"},
    {"key": "deep_audit_universe_rank_reference", "value": "40"},
    {"key": "deep_audit_universe_rank_bump_per_ref", "value": "3"},
    {"key": "deep_audit_min_rank_floor", "value": "85"},

    {"key": "deep_audit_regime_adaptive_enabled", "value": "true"},
    {"key": "deep_audit_regime_uptrend_short_rank_min", "value": "98"},
    {"key": "deep_audit_regime_uptrend_short_cohorts", "value": "speculative"},
    {"key": "deep_audit_regime_downtrend_long_rank_min", "value": "98"},
    {"key": "deep_audit_regime_downtrend_long_require_4h_bull", "value": "true"},
    {"key": "deep_audit_regime_transitional_rank_min", "value": "92"},
    {"key": "deep_audit_consensus_gate_enabled", "value": "true"},
    {"key": "deep_audit_consensus_min_signals", "value": "3"},
    {"key": "deep_audit_consensus_volume_rvol_min", "value": "1.2"},

    {"key": "deep_audit_earnings_proximity_block_hours", "value": "48"},
    {"key": "deep_audit_mid_trade_regime_flip_exit_enabled", "value": "true"},
    {"key": "deep_audit_mid_trade_regime_flip_min_age_hours", "value": "24"}
  ]
}
JSON
else
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_duplicate_open_block_enabled", "value": "false"},
    {"key": "deep_audit_reentry_throttle_hours", "value": "0"},
    {"key": "deep_audit_stale_position_force_close_days", "value": "0"},
    {"key": "deep_audit_short_requires_spy_downtrend", "value": "false"},
    {"key": "deep_audit_short_sector_strength_gate", "value": "false"},
    {"key": "deep_audit_max_loss_time_scaled_v2", "value": "false"},
    {"key": "deep_audit_universe_adaptive_rank", "value": "false"},
    {"key": "deep_audit_strict_rank_required", "value": "false"}
  ]
}
JSON
fi

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Phase-I $MODE"
RESP=$(curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD")
echo "$RESP" | python3 -m json.tool
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
if [[ "$OK" != "True" ]]; then exit 1; fi
echo "OK. Deploy worker first; register fresh runs to pin these values."
