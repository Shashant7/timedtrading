#!/usr/bin/env bash
# Paginated deep-5m backfill for the live universe (~2 months), batched.
set -u
BASE="${BASE:-https://timed-trading-ingest.shashant.workers.dev}"
KEY="$TIMED_TRADING_API_KEY"
# Two windows to clear the ~5000-bar/call cap and reach ~2 months.
WINS=("2026-04-15:2026-05-15" "2026-05-15:2026-06-16")
TOTAL=300
for off in $(seq 0 20 $TOTAL); do
  for w in "${WINS[@]}"; do
    sd="${w%%:*}"; ed="${w##*:}"
    r=$(curl -s -X POST "$BASE/timed/admin/alpaca-backfill?tf=5&provider=twelvedata&include_user=1&startDate=$sd&endDate=$ed&limit=20&offset=$off&key=$KEY")
    u=$(echo "$r" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log((j.tickers||0)+'t/'+(j.upserted||0)+'u')}catch(e){console.log('ERR '+s.slice(0,60))}})")
    echo "offset=$off win=$sd..$ed -> $u"
    sleep 1
  done
done
echo "DONE-5M-BACKFILL"
