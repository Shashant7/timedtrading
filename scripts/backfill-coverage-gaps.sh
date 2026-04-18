#!/usr/bin/env bash
# scripts/backfill-coverage-gaps.sh
#
# Drives POST /timed/admin/alpaca-backfill against the deployed worker to
# backfill the candle gaps identified by scripts/audit-candle-coverage.js.
#
# Design:
#   - 10m TF is backfilled via ?provider=alpaca (Alpaca is the source of
#     truth for 10m; TwelveData's aggregated 5m->10m was silently corrupting
#     intraday bundles).
#   - 15m, 30m, 60m, 240 (4H), D are backfilled via ?provider=twelvedata.
#   - Each backfill is scoped to one ticker + one TF with an explicit
#     startDate + endDate so we don't stress the rate limits.
#   - Retries once on network failure.
#
# Usage:
#   TIMED_API_KEY=... scripts/backfill-coverage-gaps.sh
#
# Env:
#   API_BASE (default https://timed-trading-ingest.shashant.workers.dev)
#   START_DATE (default 2025-07-01)
#   END_DATE   (default the max of today and 2026-04-17; we cap at today)

set -euo pipefail

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"
START_DATE="${START_DATE:-2025-07-01}"
TODAY="$(date -u '+%Y-%m-%d')"
END_DATE_RAW="${END_DATE:-2026-04-17}"
# Cap end at today
if [[ "$END_DATE_RAW" > "$TODAY" ]]; then
  END_DATE="$TODAY"
else
  END_DATE="$END_DATE_RAW"
fi

TIER1=(SPY QQQ IWM AAPL MSFT GOOGL AMZN META NVDA TSLA)
TIER2=(AGQ CDNS ETN FIX GRNY HUBS IESC MTZ ON PH RIOT SGI SWK XLY)
UNIVERSE=("${TIER1[@]}" "${TIER2[@]}")

# TFs in order: 10m (Alpaca), then TwelveData for the rest. Do high-priority
# TFs first (smaller-grain / most bars first) so ordering matches the audit
# priority.
declare -a TF_ORDER=(10 15 30 60 240 D)

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

backfill_one() {
  local ticker="$1" tf="$2" provider="$3"
  local url="$API_BASE/timed/admin/alpaca-backfill?tf=$tf&ticker=$ticker&startDate=$START_DATE&endDate=$END_DATE&provider=$provider&key=$API_KEY"
  local attempt=1 rc=1
  while [[ "$attempt" -le 2 ]]; do
    local t0 t1
    t0=$(date -u +%s)
    local resp
    resp=$(curl -sS -m 600 -X POST "$url" -H "Content-Type: application/json" -d '{}' 2>&1) && rc=$? || rc=$?
    t1=$(date -u +%s)
    local elapsed=$((t1 - t0))
    if [[ "$rc" -eq 0 ]]; then
      local ok up err
      ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null || echo "false")
      up=$(echo "$resp" | jq -r '.upserted // 0' 2>/dev/null || echo "?")
      err=$(echo "$resp" | jq -r '.errors // 0' 2>/dev/null || echo "?")
      if [[ "$ok" == "true" ]]; then
        log "  $ticker tf=$tf provider=$provider ok upserted=$up errors=$err ${elapsed}s"
        return 0
      fi
    fi
    log "  WARN $ticker tf=$tf provider=$provider rc=$rc attempt=$attempt resp=$(echo "$resp" | head -c 300)"
    attempt=$((attempt + 1))
    sleep 10
  done
  log "  ERROR $ticker tf=$tf provider=$provider FAILED after 2 attempts"
  return 1
}

log "=== Backfill coverage gaps ==="
log "API_BASE=$API_BASE  START=$START_DATE  END=$END_DATE"
log "Universe: ${#UNIVERSE[@]} tickers  TFs: ${TF_ORDER[*]}"

FAILURES=0
for tf in "${TF_ORDER[@]}"; do
  provider=$([[ "$tf" == "10" ]] && echo "alpaca" || echo "twelvedata")
  log ">>> TF=$tf provider=$provider"
  for ticker in "${UNIVERSE[@]}"; do
    if ! backfill_one "$ticker" "$tf" "$provider"; then
      FAILURES=$((FAILURES + 1))
    fi
    # TwelveData rate-limit courtesy spacing.
    # Alpaca is snappier; shorter spacing OK.
    if [[ "$provider" == "twelvedata" ]]; then
      sleep 9
    else
      sleep 2
    fi
  done
  log ">>> TF=$tf provider=$provider done; failures so far=$FAILURES"
done

log "=== Backfill complete. Total failures: $FAILURES ==="
exit "$FAILURES"
