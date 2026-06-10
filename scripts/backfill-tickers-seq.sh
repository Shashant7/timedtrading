#!/usr/bin/env bash
# Sequential backfill + score for tickers missing coverage.
set -euo pipefail

BASE="${WORKER_URL:-https://timed-trading-ingest.shashant.workers.dev}"
KEY="${TIMED_API_KEY:-${TIMED_TRADING_API_KEY:-}}"
if [[ -z "$KEY" ]]; then
  echo "Set TIMED_API_KEY (worker secret) before running." >&2
  exit 1
fi
AUTH_HEADER="X-API-Key: ${KEY}"

TICKERS=(
  ADBE AG ALAB CIEN DDOG ENPH ESNC FTNT LEU LUNR MRVL NET OKLO OKTA RBRK SEDG SMCI SMR SNOW TEAM TENB WULF ZS
)

poll_backfill_done() {
  local ticker="$1"
  for _ in $(seq 1 90); do
    sleep 3
    local phase
    phase=$(curl -s "${BASE}/timed/admin/backfill-status" -H "${AUTH_HEADER}" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('status') or {}).get('phase') or '')" 2>/dev/null || echo "")
    if [[ -z "$phase" || "$phase" == "done" ]]; then
      return 0
    fi
    echo "  … ${ticker} backfill phase=${phase}"
  done
  echo "  WARN: ${ticker} backfill poll timed out" >&2
  return 1
}

score_ticker() {
  local ticker="$1"
  curl -s -X POST "${BASE}/timed/admin/onboard?ticker=${ticker}&skipBackfill=1" \
    -H "${AUTH_HEADER}" | python3 -c "import json,sys; d=json.load(sys.stdin); r=(d.get('results') or [{}])[0]; print('ok' if d.get('ok') and (r.get('ok', d.get('ok'))) else (r.get('error') or d.get('error') or 'fail'))"
}

for ticker in "${TICKERS[@]}"; do
  echo "=== ${ticker} — backfill start ==="
  res=$(curl -s -X POST "${BASE}/timed/admin/alpaca-backfill?tf=all&ticker=${ticker}" \
    -H "${AUTH_HEADER}")
  ok=$(echo "$res" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null || echo "False")
  if [[ "$ok" != "True" ]]; then
    echo "  FAIL backfill trigger: $res"
    continue
  fi
  poll_backfill_done "$ticker" || true
  echo "  ${ticker} — scoring"
  score_out=$(score_ticker "$ticker")
  echo "  ${ticker} — score result: ${score_out}"
  # Quick quality check via ingestion row if available
  q=$(curl -s "${BASE}/timed/admin/ingestion-status" -H "${AUTH_HEADER}" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rows=d.get('tickers') or []
for r in rows:
  if str(r.get('ticker','')).upper()=='${ticker}':
    print(r.get('quality', r.get('pct', 0)))
    break
" 2>/dev/null || echo "?")
  echo "  ${ticker} — quality after run: ${q}%"
  echo ""
done

echo "All tickers processed."
