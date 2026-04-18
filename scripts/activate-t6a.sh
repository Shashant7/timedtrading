#!/usr/bin/env bash
# scripts/activate-t6a.sh
#
# Activates T6A (Phase D first DA-key change) by writing three keys to
# `model_config`. T6A relaxes two entry gates for index ETFs
# (SPY/QQQ/IWM) only -- single-stock behaviour is unchanged.
#
# Per the Phase-C T6 diagnostic (data/trade-analysis/phase-d-t6-probe-2026-04-18/),
# SPY/QQQ/IWM reach kanban_stage=in_review with score=100 but are
# blocked ~100 pct of the time by:
#   - tt_pullback_not_deep_enough: requires 2-of-3 ST bearish flips.
#     Index ETFs in calm uptrends rarely satisfy 2-of-3.
#   - tt_pullback_non_prime_rank_selective: rank floor 90. SPY sits
#     at 87-88 at setup-stage moments.
#
# T6A (Variant A) scopes override to a small CSV of index ETFs:
#   deep_audit_pullback_min_bearish_count_index_etf_tickers = "SPY,QQQ,IWM"
#   deep_audit_pullback_min_bearish_count_index_etf = 1
#   deep_audit_pullback_non_prime_min_rank_index_etf = 85
#
# XLY and other sector ETFs are INTENTIONALLY not in the set: they
# trade enough like individual equities that the standard gates are
# appropriate.
#
# Usage:
#   TIMED_API_KEY=... scripts/activate-t6a.sh [--deactivate]
#
# Deactivate mode sets all three keys to empty strings.

set -euo pipefail

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

MODE="activate"
if [[ "${1:-}" == "--deactivate" ]]; then
  MODE="deactivate"
fi

if [[ "$MODE" == "activate" ]]; then
  TICKERS="SPY,QQQ,IWM"
  MIN_BEARISH="1"
  NON_PRIME_RANK="85"
  DESC_SUFFIX="T6A activated 2026-04-18 post-cleanup: SPY/QQQ/IWM only"
else
  TICKERS=""
  MIN_BEARISH=""
  NON_PRIME_RANK=""
  DESC_SUFFIX="T6A deactivated"
fi

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] T6A $MODE"
echo "  tickers: '$TICKERS'"
echo "  min_bearish_count: '$MIN_BEARISH'"
echo "  non_prime_min_rank: '$NON_PRIME_RANK'"

PAYLOAD=$(cat <<EOF
{
  "updates": [
    {"key": "deep_audit_pullback_min_bearish_count_index_etf_tickers", "value": "$TICKERS", "description": "T6A index-ETF pullback override list. $DESC_SUFFIX"},
    {"key": "deep_audit_pullback_min_bearish_count_index_etf", "value": "$MIN_BEARISH", "description": "T6A pullback 2-of-3 -> 1-of-3 ST bearish flip for index ETFs. $DESC_SUFFIX"},
    {"key": "deep_audit_pullback_non_prime_min_rank_index_etf", "value": "$NON_PRIME_RANK", "description": "T6A non-Prime rank floor 90 -> 85 for index ETFs. $DESC_SUFFIX"}
  ]
}
EOF
)

RESP=$(curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

echo "$RESP" | python3 -m json.tool

OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
if [[ "$OK" != "True" ]]; then
  echo "ERROR: activation failed" >&2
  exit 1
fi
echo "OK. Verify pickup by registering a fresh run and inspecting pinned config."
