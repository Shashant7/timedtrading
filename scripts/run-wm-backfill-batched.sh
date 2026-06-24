#!/usr/bin/env bash
# Batched W/M candle backfill — replaces stuck wm-bootstrap waitUntil jobs.
# Usage: TIMED_TRADING_API_KEY=... ./scripts/run-wm-backfill-batched.sh

set -euo pipefail

BASE="${TIMED_WORKER_URL:-https://timed-trading-ingest.shashant.workers.dev}"
KEY="${TIMED_TRADING_API_KEY:?TIMED_TRADING_API_KEY required}"
BATCH=30
LOG="${WM_BACKFILL_LOG:-/tmp/wm-backfill-batched.log}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

backfill_batch() {
  local tf="$1" since="$2" offset="$3"
  local url="${BASE}/timed/admin/alpaca-backfill?key=${KEY}&tf=${tf}&sinceDays=${since}&include_user=1&limit=${BATCH}&offset=${offset}"
  log "POST tf=${tf} sinceDays=${since} offset=${offset} limit=${BATCH}"
  local RESP
  RESP=$(curl -sS -X POST "$url" -H "Content-Type: application/json" -d '{}')
  log "  -> $(printf '%s' "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print('ok=%s upserted=%s tickers=%s errors=%s' % (d.get('ok'), d.get('upserted'), d.get('tickers'), d.get('errors')))" 2>/dev/null || printf '%s' "$RESP")"
  printf '%s' "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d.get('ok') else 1)" || return 1
}

onboard_ticker() {
  local sym="$1"
  log "Onboard ${sym} (full backfill + score)"
  curl -sS -X POST "${BASE}/timed/admin/onboard?key=${KEY}&ticker=${sym}" \
    -H "Content-Type: application/json" -d '{}' | tee -a "$LOG"
  echo | tee -a "$LOG"
}

gap_backfill() {
  local sym="$1" tf since
  for pair in "W 1100" "M 1825"; do
    tf=${pair%% *}
    since=${pair##* }
    log "Gap ticker ${sym} tf=${tf} sinceDays=${since}"
    curl -sS -X POST "${BASE}/timed/admin/alpaca-backfill?key=${KEY}&tf=${tf}&sinceDays=${since}&ticker=${sym}" \
      -H "Content-Type: application/json" -d '{}' \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print('  ok=%s upserted=%s perTf=%s' % (d.get('ok'), d.get('upserted'), d.get('perTf')))" \
      | tee -a "$LOG"
    sleep 2
  done
}

: > "$LOG"
log "=== W/M batched backfill start ==="

# ECHO has zero candles — full onboard
onboard_ticker "ECHO" || log "WARN ECHO onboard failed"

# Priority gap tickers (partial / under floor W or M)
GAP_TICKERS=(
  SPCX GRNI GRNJ OKLO RBRK ALAB GLXY CRWV SNDK GRNY ETHA TEM TLN
  SRAD LUNR SMR GEV QXO CRDO RDDT
)

for sym in "${GAP_TICKERS[@]}"; do
  gap_backfill "$sym" || log "WARN gap backfill failed for ${sym}"
done

# Full universe — W then M in batches
SECTOR_SIZE="${SECTOR_SIZE:-291}"
for offset in $(seq 0 "$BATCH" "$((SECTOR_SIZE - 1))"); do
  backfill_batch "W" 1100 "$offset" || log "WARN W batch offset=${offset} failed"
  sleep 3
done

for offset in $(seq 0 "$BATCH" "$((SECTOR_SIZE - 1))"); do
  backfill_batch "M" 1825 "$offset" || log "WARN M batch offset=${offset} failed"
  sleep 3
done

log "=== W/M batched backfill complete ==="
