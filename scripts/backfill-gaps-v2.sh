#!/bin/bash
set -euo pipefail

API_BASE="https://timed-trading-ingest.shashant.workers.dev"
API_KEY="AwesomeSauce"

TICKERS=(USO VIXY)
TFS=(D W M 240 60 30 15 10)

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Backfilling gaps: ${TICKERS[*]}                     ║"
echo "╚══════════════════════════════════════════════════════╝"

for ticker in "${TICKERS[@]}"; do
  echo "── $ticker ──"
  for tf in "${TFS[@]}"; do
    result=$(curl -s -m 120 \
      "$API_BASE/timed/admin/alpaca-backfill?key=$API_KEY&ticker=$ticker&tf=$tf&sinceDays=1100" \
      -X POST 2>&1)
    ups=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('upserted',0))" 2>/dev/null || echo "?")
    errs=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('errors',0))" 2>/dev/null || echo "?")
    printf "  %-4s: +%-6s err=%-4s\n" "$tf" "$ups" "$errs"
    sleep 1
  done
  echo ""
done

echo "Verifying..."
curl -s -m 30 "$API_BASE/timed/admin/candle-gaps?key=$API_KEY&startDate=2025-07-01&endDate=2026-03-16" 2>&1 | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('Total:', d.get('totalTickers'), '| All clear:', d.get('allClear'), '| Gaps:', d.get('gapCount'))
need = d.get('tickersNeedingBackfill', [])
if need: print('Still need:', sorted(need))
else: print('All tickers fully backfilled!')
"
