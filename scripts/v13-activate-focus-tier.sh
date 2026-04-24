#!/usr/bin/env bash
# V13 Focus Tier activation — flip conviction-score gating ON.
#
# Assumes the V12 killer-strategy base config is already active
# (scripts/v12-activate-killer-strategy.sh). This script only sets the
# NEW V13 DA keys on top. The ETF Precision Gate switches from
# rank-based (broken formula) to conviction-based.
#
# Usage:
#   TIMED_API_KEY=... bash scripts/v13-activate-focus-tier.sh
#
# See: tasks/v13-focus-tier-strategy-2026-04-24.md

set -euo pipefail
API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    { "key": "deep_audit_focus_tier_enabled", "value": "true" },
    { "key": "deep_audit_focus_tier_a_floor", "value": "75" },
    { "key": "deep_audit_focus_tier_b_floor", "value": "50" },
    { "key": "deep_audit_focus_tier_c_floor", "value": "45" },
    { "key": "deep_audit_focus_min_entry_conviction", "value": "45" },
    { "key": "deep_audit_etf_precision_min_conviction", "value": "70" },
    { "key": "deep_audit_focus_tier_a_winner_protect_mfe", "value": "2.5" },
    { "key": "deep_audit_focus_tier_a_risk_budget_mult", "value": "1.25" }
  ]
}
JSON

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] V13 Focus Tier ON"
curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD" | python3 -m json.tool
