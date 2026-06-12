#!/usr/bin/env bash
# Operator audit: scoring, freshness, investor, feeds, cron tombstones.
set -euo pipefail
BASE="${BASE:-https://timed-trading-ingest.shashant.workers.dev}"
FEED="${FEED:-https://tt-feed.shashant.workers.dev}"
KEY="${TIMED_TRADING_API_KEY:?TIMED_TRADING_API_KEY required}"

echo "=== Timed Trading system audit $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

echo ""
echo "--- /timed/health ---"
curl -sS "$BASE/timed/health" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('ok', d.get('ok'), 'pricesAgeSec', d.get('pricesAgeSec'))
print('scoring: core', d.get('scoringCore'), 'minutesSinceScoring', d.get('minutesSinceScoring'))
f=d.get('freshness') or {}
print('freshness: fresh', f.get('fresh'), 'aging', f.get('aging'), 'stale', f.get('stale'), 'slo_ok', f.get('slo_ok'))
for x in (f.get('stale_tickers') or [])[:15]:
    print('  STALE', x.get('ticker'), x.get('stale_tfs'), 'worst', x.get('worst'))
cf=d.get('cronFailures') or {}
if cf.get('count'):
    print('cronFailures', cf.get('count'), cf.get('ops'))
"

echo ""
echo "--- tt-feed /feed/health ---"
curl -sS "$FEED/feed/health" | python3 -c "
import json,sys; d=json.load(sys.stdin)
print('ok', d.get('ok'), 'prices_age_sec', d.get('prices_age_sec'), 'tickers', d.get('ticker_count'), 'source', d.get('source'))
"

echo ""
echo "--- /timed/admin/system-health ---"
curl -sS "$BASE/timed/admin/system-health?key=$KEY" | python3 -c "
import json,sys; d=json.load(sys.stdin)
print('overall', d.get('overall'))
for k,v in (d.get('checks') or {}).items():
    print(' ', k, v)
"

echo ""
echo "--- investor compute (dry run) ---"
curl -sS -X POST "$BASE/timed/investor/compute?key=$KEY" -H "Content-Type: application/json" -d '{}' | python3 -c "
import json,sys; d=json.load(sys.stdin)
ss=d.get('skipped_stale_candles') or {}
sn=d.get('skipped_no_price') or {}
print('scored', d.get('tickers'), 'skipped_stale', ss.get('count'), 'skipped_no_price', sn.get('count'))
if ss.get('tickers'):
    print('stale tickers:', ss.get('tickers'))
elif ss.get('first10'):
    print('stale first10:', ss.get('first10'))
print('topAccumulate:', [x.get('ticker') for x in (d.get('topAccumulate') or [])[:8]])
"

echo ""
echo "--- investor scores summary ---"
curl -sS "$BASE/timed/investor/scores?key=$KEY" | python3 -c "
import json,sys; d=json.load(sys.stdin)
from collections import Counter
e=d.get('tickers') or []
print('count', len(e))
print('stages', dict(Counter(x.get('stage') for x in e)))
"

echo ""
echo "--- cron tombstones (failing only) ---"
curl -sS "$BASE/timed/admin/cron-status?key=$KEY" | python3 -c "
import json,sys; d=json.load(sys.stdin)
fail=[x for x in (d.get('ops') or []) if x.get('status')=='FAILING']
print('failing', len(fail))
for x in fail[:20]:
    print(' ', x.get('op'), '-', (x.get('error') or '')[:100])
"

echo ""
echo "=== audit complete ==="
