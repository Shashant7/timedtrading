#!/usr/bin/env bash
# Awaken Active Trader engine + refresh configs with the 60-day review
# findings (tasks/2026-06-12-never-stale-and-performance-review.md, Part 5).
#
# Pins the findings-driven knobs as explicit model_config rows so they are
# visible/auditable and survive any change to the in-code defaults. Every
# value here MATCHES the shipped code default — running this script changes
# NO behavior; it only makes the intent explicit in the config table.
#
# To revert any single lever, re-POST that key with the prior value
# (e.g. deep_audit_focus_suspend_tier_c=false to re-enable Tier-C).
#
# Usage:
#   TIMED_API_KEY=... bash scripts/awaken-engine-2026-06-13-activate.sh
#
# See: tasks/2026-06-12-never-stale-and-performance-review.md (Part 5)

set -euo pipefail
API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    { "_comment": "P1 — MFE giveback ratchet (#648). Pin the on-by-default ratchet so it is explicit in config. Validate the +$3k/60d counterfactual via equal-scope replay before tuning.", "key": "deep_audit_mfe_ratchet_enabled", "value": "true" },
    { "key": "deep_audit_mfe_ratchet_activation_pct", "value": "2.0" },
    { "key": "deep_audit_mfe_ratchet_lock_frac", "value": "0.40" },

    { "_comment": "P2c — dead-knob fix. The absolute floor clamp is now tunable; 60 lets the operator LOWER the conviction floor (previously impossible). Floors themselves UNCHANGED.", "key": "deep_audit_focus_floor_hard_min", "value": "60" },

    { "_comment": "P2a — suspend the Tier-C drain (25% WR / -$1,657) until the conviction signal discriminates. Set to false to re-enable.", "key": "deep_audit_focus_suspend_tier_c", "value": "true" },

    { "_comment": "P3 — fast-cut lane kill-switch + tunable Tier-1 window. Defaults preserve behavior; flip enabled=false (or widen the window) after the replay confirms the forfeited-continuation finding.", "key": "deep_audit_phase_i_fast_cut_enabled", "value": "true" },
    { "key": "deep_audit_phase_i_fast_cut_tier1_min_age_h", "value": "2" },
    { "key": "deep_audit_phase_i_fast_cut_tier1_max_age_h", "value": "4" },

    { "_comment": "R4 — short-book shadow mode (log-only). Collects [SHORT_SHADOW] evidence for 2 weeks before any live SHORT-gate relaxation. Never changes the entry decision.", "key": "deep_audit_short_shadow_enabled", "value": "true" },
    { "key": "deep_audit_short_shadow_require_defensive", "value": "true" },

    { "_comment": "R6 — investor execution discipline. (a) tranche: max 3 new positions/ET day; (c) auto-init floor = accumulate stage + score >= 65 (the TWLO fix); (b) execute reduce after 2 confirmed sessions at 30%; (d) DCA on accumulate inits.", "key": "deep_audit_investor_max_new_positions_per_day", "value": "3" },
    { "key": "deep_audit_investor_auto_init_require_accumulate", "value": "true" },
    { "key": "deep_audit_investor_auto_init_min_score", "value": "65" },
    { "key": "deep_audit_investor_reduce_trim_min_sessions", "value": "2" },
    { "key": "deep_audit_investor_reduce_trim_pct", "value": "0.30" },
    { "key": "deep_audit_investor_auto_dca_on_accumulate", "value": "true" },
    { "key": "deep_audit_investor_auto_dca_amount_pct", "value": "0.02" },
    { "key": "deep_audit_investor_auto_dca_frequency", "value": "monthly" }
  ]
}
JSON

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Awaken-engine config refresh (Part 5)"
curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD" | python3 -m json.tool
