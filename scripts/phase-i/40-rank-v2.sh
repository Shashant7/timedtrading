#!/usr/bin/env bash
# Phase-I STEP 4: Rank-V2 calibrated formula.
# Switches to the empirically-calibrated rank. Lowers floor from 90 -> 50 because
# V2 is centered at 50 (V1 was centered at 30 with bonuses pushing top-end to 100).
set -euo pipefail
API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    { "key": "deep_audit_rank_formula", "value": "v2" },
    { "key": "deep_audit_min_rank_floor", "value": "50" },
    { "key": "deep_audit_strict_rank_required", "value": "true" },
    { "key": "deep_audit_universe_adaptive_rank", "value": "false" },

    { "key": "deep_audit_regime_uptrend_short_rank_min", "value": "70" },
    { "key": "deep_audit_regime_downtrend_long_rank_min", "value": "70" },
    { "key": "deep_audit_regime_transitional_rank_min", "value": "55" }
  ]
}
JSON

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Phase-I rank-V2 ON"
curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD" | python3 -m json.tool
