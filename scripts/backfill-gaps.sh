#!/bin/bash
set -euo pipefail

API_BASE="https://timed-trading-ingest.shashant.workers.dev"
API_KEY="AwesomeSauce"
SINCE_DAYS=450

TICKERS=(AAPU BTBT CRVS ES ETHT FDX FIG GDXJ GRAB IBKR IBRX ONDS OPEN PYPL QCOM SBET USO VIXY W WDAY)
TFS=(D W M 240 60 30 15 10)

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Targeted Backfill: ${#TICKERS[@]} tickers × ${#TFS[@]} TFs    ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

total_upserted=0
total_errors=0
done_count=0
total=$((${#TICKERS[@]} * ${#TFS[@]}))

for ticker in "${TICKERS[@]}"; do
  echo "── $ticker ──"
  for tf in "${TFS[@]}"; do
    done_count=$((done_count + 1))
    result=$(curl -s -m 120 \
      "$API_BASE/timed/admin/alpaca-backfill?key=$API_KEY&ticker=$ticker&tf=$tf&sinceDays=$SINCE_DAYS" \
      -X POST 2>&1)

    ups=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('upserted',0))" 2>/dev/null || echo "?")
    errs=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('errors',0))" 2>/dev/null || echo "?")

    if [[ "$ups" =~ ^[0-9]+$ ]]; then
      total_upserted=$((total_upserted + ups))
    fi
    if [[ "$errs" =~ ^[0-9]+$ ]]; then
      total_errors=$((total_errors + errs))
    fi

    pct=$((done_count * 100 / total))
    printf "  [%3d%%] %-4s: +%-6s err=%-4s\n" "$pct" "$tf" "$ups" "$errs"
    sleep 1
  done
  echo ""
done

echo "════════════════════════════════════════════════════════"
echo "  Backfill complete: upserted=$total_upserted errors=$total_errors"
echo "════════════════════════════════════════════════════════"
echo ""
echo "Verifying gaps..."
curl -s -m 30 "$API_BASE/timed/admin/candle-gaps?key=$API_KEY&startDate=2025-07-01&endDate=2026-03-16" 2>&1 | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('Total tickers:', d.get('totalTickers'))
print('All clear:', d.get('allClear'))
print('Gaps remaining:', d.get('gapCount'))
need = d.get('tickersNeedingBackfill', [])
if need: print('Still need backfill:', sorted(need))
else: print('All tickers fully backfilled!')
"
