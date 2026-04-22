#!/usr/bin/env bash
# Phase-I STEP 2: W2 SHORT selectivity.
# Requires SPY downtrend or sector-vs-SPY weakness for SHORTs.
set -euo pipefail
API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    { "key": "deep_audit_short_requires_spy_downtrend", "value": "true" },
    { "key": "deep_audit_short_spy_carveout_rank_min", "value": "95" },
    { "key": "deep_audit_short_spy_carveout_cohorts", "value": "speculative" },
    { "key": "deep_audit_short_sector_strength_gate", "value": "true" },
    { "key": "deep_audit_short_sector_strength_rank_min", "value": "98" }
  ]
}
JSON

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Phase-I W2 SHORT gates ON"
curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD" | python3 -m json.tool
