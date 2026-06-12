#!/usr/bin/env bash
# Emergency universe heal: backfill critical intraday TFs, rescore, investor compute.
set -euo pipefail
BASE="${BASE:-https://timed-trading-ingest.shashant.workers.dev}"
KEY="${TIMED_TRADING_API_KEY:?TIMED_TRADING_API_KEY required}"
BATCH=40
OFFSETS=(0 40 80 120 160 200 240)

echo "[heal] Starting freshness universe heal at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

for TF in 10 15 30 60 D; do
  for OFF in "${OFFSETS[@]}"; do
    echo "[heal] backfill tf=$TF offset=$OFF"
    curl -sS -X POST "$BASE/timed/admin/alpaca-backfill?key=$KEY&tf=$TF&sinceDays=5&include_user=1&limit=$BATCH&offset=$OFF" \
      -H "Content-Type: application/json" -d '{}' \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print('  ok=', d.get('ok'), 'upserted=', d.get('upserted'), 'errors=', d.get('errors'), 'tickers=', d.get('tickers'))"
    sleep 1
  done
done

echo "[heal] rescoring universe (all=1, limit=40 batches)"
OFF=0
while true; do
  RESP=$(curl -sS -X POST "$BASE/timed/admin/rescore-stale?key=$KEY&all=1&limit=40&offset=$OFF&dedupe=0&snapshot=0" \
    -H "Content-Type: application/json" -d '{}')
  echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print('  offset', d.get('offset'), 'rescored', d.get('rescored'), 'failed', d.get('failed'), 'remaining', d.get('remaining'))"
  REMAIN=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('remaining',0))")
  OFF=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('next_offset',0))")
  if [ "${REMAIN:-0}" -le 0 ]; then break; fi
  sleep 2
done

echo "[heal] final snapshot rebuild + investor compute"
curl -sS -X POST "$BASE/timed/admin/rescore-stale?key=$KEY&all=1&limit=1&offset=0&dedupe=0&snapshot=1" \
  -H "Content-Type: application/json" -d '{}' >/dev/null || true
curl -sS -X POST "$BASE/timed/investor/compute?key=$KEY" \
  -H "Content-Type: application/json" -d '{}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('investor tickers=', d.get('tickers'), 'skipped_stale=', (d.get('skipped_stale_candles') or {}).get('count'), 'topAccumulate=', len(d.get('topAccumulate') or []))"

curl -sS "$BASE/timed/health" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); f=d.get('freshness',{}); print('[heal] health fresh=', f.get('fresh'), 'stale=', f.get('stale'), 'slo_ok=', f.get('slo_ok'))"

echo "[heal] Done at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
