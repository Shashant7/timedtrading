#!/bin/bash
# Fast aggregation: calls the in-worker endpoint for each ticker with trail data.
# Usage: bash scripts/aggregate-all-facts.sh

WORKER="https://timed-trading-ingest.shashant.workers.dev"
KEY="AwesomeSauce"

echo "Fetching tickers with pending trail data..."
TICKERS=$(cd worker && npx wrangler d1 execute timed-trading-ledger --remote --env production --json \
  --command "SELECT DISTINCT ticker FROM timed_trail ORDER BY ticker" 2>/dev/null \
  | grep -v "npm warn" | python3 -c "
import json, sys
data = json.load(sys.stdin)
results = data[0]['results'] if isinstance(data, list) else data.get('results', [])
print(' '.join(r['ticker'] for r in results))
")

COUNT=$(echo $TICKERS | wc -w | tr -d ' ')
echo "Found $COUNT tickers to aggregate."
echo ""

I=0
for T in $TICKERS; do
  I=$((I + 1))
  printf "  [%d/%d] %-8s " "$I" "$COUNT" "$T"
  RESULT=$(curl -s -X POST "$WORKER/timed/admin/aggregate-facts?key=$KEY&ticker=$T" 2>/dev/null)
  ROWS=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"{d.get('trail_rows',0)} rows → {d.get('facts_inserted',0)} facts\")" 2>/dev/null || echo "error")
  echo "$ROWS"
done

echo ""
echo "Done!"
