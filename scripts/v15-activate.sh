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

    { "key": "deep_audit_focus_tier_a_floor", "value": "110" },
    { "key": "deep_audit_focus_tier_b_floor", "value": "80" },
    { "key": "deep_audit_focus_tier_c_floor", "value": "75" },
    { "key": "deep_audit_focus_min_entry_conviction", "value": "80" },
    { "key": "deep_audit_focus_stack_carveout_enabled", "value": "true" },
    { "key": "deep_audit_focus_stack_carveout_pct", "value": "5" },

    { "key": "deep_audit_ath_breakout_enabled", "value": "true" },
    { "key": "deep_audit_ath_breakout_max_pct_below_high", "value": "3.0" },
    { "key": "deep_audit_ath_breakout_tight_base_max_pct", "value": "5.0" },
    { "key": "deep_audit_ath_breakout_min_rvol", "value": "1.0" },
    { "key": "deep_audit_ath_breakout_min_rvol_etf", "value": "1.5" },
    { "key": "deep_audit_ath_breakout_require_follow_through", "value": "true" },

    { "key": "deep_audit_range_reversal_enabled", "value": "true" },
    { "key": "deep_audit_range_reversal_min_rvol", "value": "1.0" },
    { "key": "deep_audit_range_reversal_min_touches", "value": "2" },

    { "key": "deep_audit_gap_reversal_enabled", "value": "true" },
    { "key": "deep_audit_gap_reversal_min_rvol", "value": "1.2" },
    { "key": "deep_audit_gap_reversal_min_gap_pct", "value": "1.5" },

    { "key": "deep_audit_n_test_support_enabled", "value": "true" },
    { "key": "deep_audit_n_test_min_touches", "value": "3" },
    { "key": "deep_audit_n_test_min_rvol", "value": "1.0" },

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

    { "key": "deep_audit_min_trim_atr_mult", "value": "1.5" },
    { "key": "deep_audit_min_trim_pct", "value": "0.015" },

    { "key": "deep_audit_winner_protect_big_mfe_enabled", "value": "false" },
    { "key": "deep_audit_winner_protect_big_mfe_threshold_pct", "value": "15.0" },
    { "key": "deep_audit_winner_protect_big_mfe_lock_pct", "value": "0.60" },

    { "key": "deep_audit_late_day_entry_block_min", "value": "30" },

    { "key": "deep_audit_big_mfe_trim_enabled", "value": "false" },
    { "key": "deep_audit_big_mfe_trim_threshold_pct", "value": "15.0" },
    { "key": "deep_audit_big_mfe_trim_add_pct", "value": "0.25" },
    { "key": "deep_audit_big_mfe_trim_min_trimmed_pct", "value": "0.50" },

    { "key": "deep_audit_quality_block_enabled", "value": "false" },
    { "key": "deep_audit_quality_block_exempt_paths", "value": "tt_gap_reversal_long,tt_gap_reversal_short" },
    { "key": "deep_audit_quality_block_f1_ext_max", "value": "3.0" },
    { "key": "deep_audit_quality_block_f1_slope_min", "value": "1.5" },
    { "key": "deep_audit_quality_block_f1_paths", "value": "tt_pullback,tt_ath_breakout" },
    { "key": "deep_audit_quality_block_f2_enabled", "value": "false" },
    { "key": "deep_audit_quality_block_f2_rsi_d_min", "value": "63" },
    { "key": "deep_audit_quality_block_f2_rsi_d_max", "value": "69" },
    { "key": "deep_audit_quality_block_f2_rsi_h1_min", "value": "62" },
    { "key": "deep_audit_quality_block_f2_rsi_h1_max", "value": "68" },
    { "key": "deep_audit_quality_block_f3_slope_min", "value": "2.0" },
    { "key": "deep_audit_quality_block_f3_slope_max", "value": "3.0" },
    { "key": "deep_audit_quality_block_f4_enabled", "value": "true" },

    { "key": "deep_audit_phase_c_enabled", "value": "false" },
    { "key": "deep_audit_phase_c_w_rank", "value": "1.0" },
    { "key": "deep_audit_phase_c_w_conviction", "value": "0.5" },
    { "key": "deep_audit_phase_c_w_divergence", "value": "1.0" },
    { "key": "deep_audit_phase_c_w_pdz", "value": "1.0" },
    { "key": "deep_audit_phase_c_w_td", "value": "1.0" },
    { "key": "deep_audit_phase_c_w_personality", "value": "1.0" },
    { "key": "deep_audit_phase_c_w_rr", "value": "0.0" },
    { "key": "deep_audit_phase_c_fill_factor", "value": "0.20" },
    { "key": "deep_audit_phase_c_hard_cap_per_bar", "value": "8" },
    { "key": "deep_audit_phase_c_hard_cap_per_cycle", "value": "8" },
    { "key": "deep_audit_phase_c_quality_score_min", "value": "-20" },

    { "key": "deep_audit_adv_div_dead_money_enabled", "value": "false" },
    { "key": "deep_audit_adv_div_dead_money_min_hours", "value": "4" },
    { "key": "deep_audit_adv_div_dead_money_max_hours", "value": "8" },
    { "key": "deep_audit_adv_div_dead_money_mfe_floor_pct", "value": "1.0" },
    { "key": "deep_audit_adv_div_dead_money_exempt_paths", "value": "tt_gap_reversal_long,tt_gap_reversal_short" },

    { "key": "deep_audit_runner_protect_healthy_enabled", "value": "false" },

    { "key": "deep_audit_td9_fragile_be_lock_enabled", "value": "false" },
    { "key": "deep_audit_td9_fragile_tp1_tighten_enabled", "value": "false" },

    { "key": "deep_audit_stagnant_deferral_max_days", "value": "14" },
    { "key": "deep_audit_stagnant_low_mae_threshold_pct", "value": "0.75" },
    { "key": "deep_audit_stagnant_squeeze_deferral_enabled", "value": "true" },

    { "key": "deep_audit_eod_defer_on_cloud_hold", "value": "true" },
    { "key": "deep_audit_eod_low_mae_defer_pct", "value": "1.5" },

    { "key": "deep_audit_atr_week_618_defer_on_cloud_hold", "value": "true" },
    { "key": "deep_audit_atr_week_618_partial_trim_pct", "value": "0.30" },

    { "key": "deep_audit_max_daily_entries", "value": "999" }
  ]
}
JSON

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] V15 quality-over-quantity activation"
curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD" | python3 -m json.tool
