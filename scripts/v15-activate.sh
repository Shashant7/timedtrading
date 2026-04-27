#!/usr/bin/env bash
# V15 activation — quality-over-quantity tier floors + new signals.
#
# Layers on top of V12 killer-strategy + V13 focus-tier base. Sets:
#   - V15 P0.3 tier floors recalibrated for 0-160 conviction range
#   - ETF gate carve-outs (delivered via code, but DA-tunable)
#   - Disable rank>=95 gating (anti-predictive per V14 forensic)
#
# Run AFTER:
#   bash scripts/v12-activate-killer-strategy.sh
#   bash scripts/v13-activate-focus-tier.sh
#
# Usage:
#   TIMED_API_KEY=... bash scripts/v15-activate.sh
#
# See: tasks/v15-quality-over-quantity-plan-2026-04-25.md

set -euo pipefail
API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    { "key": "deep_audit_focus_tier_enabled", "value": "true" },

    { "key": "deep_audit_focus_tier_a_floor", "value": "90" },
    { "key": "deep_audit_focus_tier_b_floor", "value": "70" },
    { "key": "deep_audit_focus_tier_c_floor", "value": "65" },
    { "key": "deep_audit_focus_min_entry_conviction", "value": "70" },

    { "key": "deep_audit_v15_negative_veto_enabled", "value": "true" },
    { "key": "deep_audit_v15_veto_require_struct_break", "value": "true" },

    { "key": "deep_audit_index_etf_swing_min_score", "value": "65" },

    { "key": "deep_audit_etf_precision_gate_enabled", "value": "false" },

    { "key": "deep_audit_consensus_gate_enabled", "value": "true" },
    { "key": "deep_audit_consensus_min_signals", "value": "3" },

    { "key": "deep_audit_peak_lock_enabled", "value": "true" },
    { "key": "deep_audit_peak_lock_min_mfe_pct", "value": "2.0" },
    { "key": "deep_audit_peak_lock_giveback_ratio", "value": "0.40" },
    { "key": "deep_audit_peak_lock_e12_deep_break_pct", "value": "-1.0" },
    { "key": "deep_audit_peak_lock_e12_wick_tolerance_pct", "value": "-0.75" },
    { "key": "deep_audit_peak_lock_e12_persist_days", "value": "2" },
    { "key": "deep_audit_peak_lock_e5_stretch_threshold_pct", "value": "4.0" },
    { "key": "deep_audit_peak_lock_e5_test_threshold_pct", "value": "0.5" },
    { "key": "deep_audit_peak_lock_min_pnl_pct", "value": "1.5" },

    { "key": "deep_audit_cloud_hold_absolute_max_hold_h", "value": "504" },
    { "key": "deep_audit_cloud_hold_min_mfe_pct", "value": "3.0" },

    { "key": "deep_audit_default_trim_ratio", "value": "0.50" },
    { "key": "deep_audit_runner_mfe_trail_giveback_pct", "value": "1.50" },

    { "key": "deep_audit_stagnant_deferral_max_days", "value": "14" },
    { "key": "deep_audit_stagnant_low_mae_threshold_pct", "value": "0.75" },
    { "key": "deep_audit_stagnant_squeeze_deferral_enabled", "value": "true" },

    { "key": "deep_audit_eod_defer_on_cloud_hold", "value": "true" },
    { "key": "deep_audit_eod_low_mae_defer_pct", "value": "1.5" },

    { "key": "deep_audit_atr_week_618_defer_on_cloud_hold", "value": "true" },
    { "key": "deep_audit_atr_week_618_partial_trim_pct", "value": "0.30" }
  ]
}
JSON

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] V15 quality-over-quantity activation"
curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD" | python3 -m json.tool
