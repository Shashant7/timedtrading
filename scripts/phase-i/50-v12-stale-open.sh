#!/usr/bin/env bash
# V12 (2026-04-23): Stale-OPEN position hardening.
#
# Fixes three bugs identified in V11 mid-run autopsy
# (tasks/v11-stale-open-positions-2026-04-23.md):
#   1. Force-close shield `pnlPct < 1.0` was too lenient — ITT +4.71% /
#      160d, BABA +1.26% / 160d drifted open forever because they were
#      "currently green". Replaced with a "currently breaking out"
#      predicate.
#   2. MFE/MAE never persisted for OPEN trades, silently disabling every
#      MFE-aware exit tier. Now flushed to D1 on each high-water change.
#   3. TP_HIT_TRIM runners had no time cap. Now flattened after 30
#      calendar days if they haven't resolved.
#
# Activate on top of Phase-I combined (W1+W2+W3):
#   bash scripts/phase-i/99-combined-w1-w2-w3.sh
#   bash scripts/phase-i/50-v12-stale-open.sh
set -euo pipefail
API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    { "key": "deep_audit_stale_position_force_close_days", "value": "45" },
    { "key": "deep_audit_stale_pnl_breakout_pct", "value": "2.0" },
    { "key": "deep_audit_stale_near_mfe_gap_pct", "value": "0.5" },
    { "key": "deep_audit_trim_runner_time_cap_days", "value": "30" },
    { "key": "deep_audit_mfe_persist_on_open", "value": "true" }
  ]
}
JSON

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] V12 stale-OPEN hardening ON"
curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD" | python3 -m json.tool
