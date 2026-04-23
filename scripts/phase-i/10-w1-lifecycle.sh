#!/usr/bin/env bash
# Phase-I STEP 1: W1 Position-Lifecycle guards.
# Adds duplicate-open block + re-entry throttle + stale-position close.
# Does NOT touch entry rank / SHORT gates / exit rules.
set -euo pipefail
API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    { "key": "deep_audit_duplicate_open_block_enabled", "value": "true" },
    { "key": "deep_audit_reentry_throttle_hours", "value": "24" },
    { "key": "deep_audit_stale_position_force_close_days", "value": "45" }
  ]
}
JSON

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Phase-I W1 Lifecycle guards ON"
curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD" | python3 -m json.tool
