#!/bin/bash
set -euo pipefail

API_BASE="https://timed-trading-ingest.shashant.workers.dev"
API_KEY="AwesomeSauce"

PURGE=(SMCI HD SBUX LOW BKNG CMG ABNB W GRAB HON FDX LMT GD ADBE QCOM TXN AMAT WDAY DIS CMCSA VZ T LIN ECL SHW FCX NEM SLB EOG COP MPC PSX BAC WFC MS C COF MCO BLK SCHW TFC USB IBKR PYPL AMT PLD EQIX PSA WELL SPG O DLR VICI EXPI OPEN JNJ ABBV TMO DHR BMY REGN BIIB NEE DUK SO D AEP SRE EXC XEL WEC ES PEG ETR FE AEE BTBT ETHT GDXJ AAPU CRVS FIG IBRX ONDS SBET)

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Purging ${#PURGE[@]} tickers from D1                ║"
echo "╚══════════════════════════════════════════════════════╝"

total_deleted=0
count=0
for ticker in "${PURGE[@]}"; do
  count=$((count + 1))
  result=$(curl -s -m 60 "$API_BASE/timed/admin/purge-ticker-candles?key=$API_KEY&ticker=$ticker" -X POST 2>&1)
  deleted=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('deleted_candles',0))" 2>/dev/null || echo "?")
  total_deleted=$((total_deleted + ${deleted:-0}))
  printf "  [%2d/%d] %-6s: %s candles deleted\n" "$count" "${#PURGE[@]}" "$ticker" "$deleted"
done

echo ""
echo "Total candles purged: $total_deleted"
echo ""

echo "Cleaning KV keys..."
for ticker in "${PURGE[@]}"; do
  curl -s -m 10 "$API_BASE/timed/admin/purge-ticker-candles?key=$API_KEY&ticker=$ticker&kv=1" -X POST >/dev/null 2>&1 || true
done
echo "Done."
