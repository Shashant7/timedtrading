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

    { "key": "deep_audit_focus_tier_a_floor", "value": "95" },
    { "key": "deep_audit_focus_tier_b_floor", "value": "65" },
    { "key": "deep_audit_focus_tier_c_floor", "value": "65" },
    { "key": "deep_audit_focus_min_entry_conviction", "value": "65" },

    { "key": "deep_audit_etf_precision_gate_enabled", "value": "false" },

    { "key": "deep_audit_consensus_gate_enabled", "value": "true" },
    { "key": "deep_audit_consensus_min_signals", "value": "3" }
  ]
}
JSON

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] V15 quality-over-quantity activation"
curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD" | python3 -m json.tool
