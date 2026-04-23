#!/usr/bin/env bash
# Phase-I STEP 0: Baseline = v10b's active configuration.
# Deactivates ALL Phase-I workstreams, keeps Phase-H.3 + H.4 active as v10b had.
# Use this before each isolated workstream test to return to known state.

set -euo pipefail
API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    { "key": "deep_audit_rank_formula", "value": "v1" },
    { "key": "deep_audit_duplicate_open_block_enabled", "value": "false" },
    { "key": "deep_audit_reentry_throttle_hours", "value": "0" },
    { "key": "deep_audit_stale_position_force_close_days", "value": "0" },
    { "key": "deep_audit_short_requires_spy_downtrend", "value": "false" },
    { "key": "deep_audit_short_sector_strength_gate", "value": "false" },
    { "key": "deep_audit_max_loss_time_scaled_v2", "value": "false" },
    { "key": "deep_audit_universe_adaptive_rank", "value": "false" },
    { "key": "deep_audit_strict_rank_required", "value": "false" },
    { "key": "deep_audit_min_rank_floor", "value": "90" },

    { "key": "deep_audit_regime_adaptive_enabled", "value": "true" },
    { "key": "deep_audit_regime_uptrend_short_rank_min", "value": "98" },
    { "key": "deep_audit_regime_uptrend_short_cohorts", "value": "speculative" },
    { "key": "deep_audit_regime_downtrend_long_rank_min", "value": "98" },
    { "key": "deep_audit_regime_downtrend_long_require_4h_bull", "value": "true" },
    { "key": "deep_audit_regime_transitional_rank_min", "value": "92" },
    { "key": "deep_audit_consensus_gate_enabled", "value": "true" },
    { "key": "deep_audit_consensus_min_signals", "value": "3" },
    { "key": "deep_audit_consensus_volume_rvol_min", "value": "1.2" },

    { "key": "deep_audit_earnings_proximity_block_hours", "value": "48" },
    { "key": "deep_audit_mid_trade_regime_flip_exit_enabled", "value": "true" },
    { "key": "deep_audit_mid_trade_regime_flip_min_age_hours", "value": "24" }
  ]
}
JSON

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Phase-I baseline (v10b config)"
RESP=$(curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD")
echo "$RESP" | python3 -m json.tool
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
[[ "$OK" == "True" ]] || exit 1
echo "OK."
