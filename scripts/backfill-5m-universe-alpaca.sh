#!/usr/bin/env bash
set -u
BASE="${BASE:-https://timed-trading-ingest.shashant.workers.dev}"
KEY="$TIMED_TRADING_API_KEY"
WINS=("2026-04-15:2026-05-08" "2026-05-08:2026-05-29" "2026-05-29:2026-06-16")
for off in $(seq 0 20 280); do
  for w in "${WINS[@]}"; do
    sd="${w%%:*}"; ed="${w##*:}"
    r=$(curl -s -X POST "$BASE/timed/admin/alpaca-backfill?tf=5&provider=alpaca&include_user=1&startDate=$sd&endDate=$ed&limit=20&offset=$off&key=$KEY")
    u=$(echo "$r" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log((j.tickers||0)+'t/'+(j.upserted||0)+'u')}catch(e){console.log('ERR '+s.slice(0,50))}})")
    echo "off=$off $sd..$ed -> $u"; sleep 1
  done
done
echo "DONE-5M-ALPACA"
