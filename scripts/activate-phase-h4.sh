#!/usr/bin/env bash
# scripts/activate-phase-h4.sh
#
# Phase-H.4 "safe" refinements from v9/v10 trade-level audit. These are
# purely defensive additions — they block known loss patterns without
# changing entry logic in a way that could starve good trades.
#
# H.4.0 — Earnings-proximity entry block
#   Evidence: ORCL Jul 31 -5.17% (×2 runs), CDNS Jul 31 -3.24%,
#   AGYS Jul 21 -10.45% (v10). All entered same-day or next-day of
#   the ticker's earnings report.
#   Fix: block new entries when a ticker has an earnings event within
#   N hours (before or after).
#
# H.4.2 — Mid-trade regime-flip exit
#   Evidence: META SHORT 2026-04-07 -5.80% (v9), GOOGL LONG 2026-01-14
#   -3.91% (v9). Both entered before per-day SPY cycle label flipped
#   against their direction; held to hard stops.
#   Fix: if a trade is >= 24h old AND cycle has flipped against
#   direction AND pnl < 0, force exit.
#
# Deferred to Phase-H.4.1/.4.4 (those would ADD trades, wait for v10b
# baseline before relaxing rank gates):
#   - Direction-asymmetric rank floor (LONG ≥90, SHORT ≥60 in bear regime)
#   - Rank 100+ exhaustion penalty
#   - 48h momentum-ignition cut
#
# See: tasks/phase-h4-targeted-refinements-2026-04-21.md
#
# Usage:
#   TIMED_API_KEY=... scripts/activate-phase-h4.sh             # apply defaults
#   TIMED_API_KEY=... scripts/activate-phase-h4.sh --deactivate

set -euo pipefail

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

MODE="activate"
if [[ "${1:-}" == "--deactivate" ]]; then MODE="deactivate"; fi

if [[ "$MODE" == "activate" ]]; then
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_earnings_proximity_block_hours", "value": "48"},
    {"key": "deep_audit_mid_trade_regime_flip_exit_enabled", "value": "true"},
    {"key": "deep_audit_mid_trade_regime_flip_min_age_hours", "value": "24"}
  ]
}
JSON
else
  read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    {"key": "deep_audit_earnings_proximity_block_hours", "value": "0"},
    {"key": "deep_audit_mid_trade_regime_flip_exit_enabled", "value": "false"}
  ]
}
JSON
fi

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Phase-H.4 $MODE"
RESP=$(curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD")
echo "$RESP" | python3 -m json.tool
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
if [[ "$OK" != "True" ]]; then exit 1; fi
echo "OK. Deploy worker first; register fresh runs to pin these values."
