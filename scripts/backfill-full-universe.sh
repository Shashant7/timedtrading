#!/usr/bin/env bash
# scripts/backfill-full-universe.sh
#
# Hydrates D1 ticker_candles for the full 215-ticker SECTOR_MAP universe
# (futures, crypto pairs, and TV-only symbols filtered out) across all
# 6 TFs (10, 15, 30, 60, 240, D) using the worker's batched backfill:
#
#   POST /timed/admin/alpaca-backfill?tf=<tf>&offset=N&limit=20&startDate=...&endDate=...&provider=<p>
#
# Batches of 20 tickers at a time keep each HTTP call under ~30s, well
# below any worker wall-time ceiling. Alpaca serves 10m; TwelveData
# serves 15/30/60/240/D.
#
# Usage:
#   TIMED_API_KEY=... scripts/backfill-full-universe.sh
#
# Env:
#   START_DATE (default 2025-07-01)
#   END_DATE   (default today, clamped)
#   BATCH_SIZE (default 20)

set -euo pipefail

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"
START_DATE="${START_DATE:-2025-07-01}"
TODAY="$(date -u '+%Y-%m-%d')"
END_DATE_RAW="${END_DATE:-2026-04-17}"
if [[ "$END_DATE_RAW" > "$TODAY" ]]; then
  END_DATE="$TODAY"
else
  END_DATE="$END_DATE_RAW"
fi
BATCH_SIZE="${BATCH_SIZE:-20}"

# TF sequence: Alpaca 10m first (fastest), then TD in order of bar density.
# Daily + 4H / Weekly / Monthly are smallest (~1-2 bars/day or less) so
# they run last. W and M aren't strictly needed by the Oct-slice replay
# (cron maintains them) but we include them in the one-time hydration
# so live + replay see the same data after a scope-wide refresh.
declare -a TFS=(10 15 30 60 240 D W M)

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

backfill_batch() {
  local tf="$1" offset="$2" provider="$3"
  local url="$API_BASE/timed/admin/alpaca-backfill?tf=$tf&offset=$offset&limit=$BATCH_SIZE&startDate=$START_DATE&endDate=$END_DATE&provider=$provider&key=$API_KEY"
  local attempt=1 rc=1
  while [[ "$attempt" -le 3 ]]; do
    local t0 t1
    t0=$(date -u +%s)
    local resp
    resp=$(curl -sS -m 900 -X POST "$url" -H "Content-Type: application/json" -d '{}' 2>&1) && rc=$? || rc=$?
    t1=$(date -u +%s)
    local elapsed=$((t1 - t0))
    if [[ "$rc" -eq 0 ]]; then
      local ok up err tickers
      ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null || echo "false")
      up=$(echo "$resp" | jq -r '.upserted // 0' 2>/dev/null || echo "?")
      err=$(echo "$resp" | jq -r '.errors // 0' 2>/dev/null || echo "?")
      tickers=$(echo "$resp" | jq -r '.tickers // 0' 2>/dev/null || echo "?")
      if [[ "$ok" == "true" ]]; then
        log "  tf=$tf offset=$offset provider=$provider tickers=$tickers upserted=$up errors=$err ${elapsed}s"
        return 0
      fi
    fi
    log "  WARN tf=$tf offset=$offset rc=$rc attempt=$attempt resp=$(echo "$resp" | head -c 300)"
    attempt=$((attempt + 1))
    sleep 15
  done
  log "  ERROR tf=$tf offset=$offset FAILED after 3 attempts"
  return 1
}

# Read the filtered universe from configs/backfill-universe-*.txt
UNIVERSE_FILE="configs/backfill-universe-2026-04-18.txt"
if [[ ! -f "$UNIVERSE_FILE" ]]; then
  echo "ERROR: universe file not found: $UNIVERSE_FILE" >&2
  exit 2
fi
TOTAL=$(wc -l < "$UNIVERSE_FILE" | tr -d ' ')

log "=== Full-universe backfill ==="
log "API_BASE=$API_BASE  START=$START_DATE  END=$END_DATE  BATCH=$BATCH_SIZE"
log "Universe: $TOTAL tickers  TFs: ${TFS[*]}"
log "Note: worker iterates SECTOR_MAP for offset/limit; universe file is informational only (filtering happens worker-side)."
log ""

FAILURES=0
START_TS=$(date -u +%s)

for tf in "${TFS[@]}"; do
  provider=$([[ "$tf" == "10" ]] && echo "alpaca" || echo "twelvedata")
  log ">>> TF=$tf provider=$provider"
  # Worker's SECTOR_MAP has 219 tickers; batches of BATCH_SIZE until exhausted.
  # We rely on the worker to return tickers=0 or matching tickers=count when offset exceeds the list.
  offset=0
  SECTOR_MAP_SIZE=219  # upper bound; worker clamps internally
  while [[ "$offset" -lt "$SECTOR_MAP_SIZE" ]]; do
    if ! backfill_batch "$tf" "$offset" "$provider"; then
      FAILURES=$((FAILURES + 1))
    fi
    offset=$((offset + BATCH_SIZE))
  done
  log ">>> TF=$tf done; failures so far=$FAILURES"
done

END_TS=$(date -u +%s)
log "=== Full-universe backfill complete. Failures: $FAILURES. Wall-clock: $((END_TS - START_TS))s ==="
exit "$FAILURES"
