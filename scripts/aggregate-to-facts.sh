#!/bin/bash
# Aggregate timed_trail to trail_5m_facts using wrangler
# Usage: ./scripts/aggregate-to-facts.sh [ticker]

set -e
cd "$(dirname "$0")/.."

DB_NAME="timed-trading-ledger"

echo "═══════════════════════════════════════════════════════════════"
echo "  AGGREGATE TRAIL DATA TO 5-MINUTE FACTS"
echo "═══════════════════════════════════════════════════════════════"

# Get tickers
if [ -n "$1" ]; then
  TICKERS="$1"
  echo "Processing single ticker: $TICKERS"
else
  echo "Fetching all tickers..."
  TICKERS=$(cd worker && npx wrangler d1 execute $DB_NAME --remote --json --command "SELECT DISTINCT ticker FROM timed_trail ORDER BY ticker" 2>/dev/null | jq -r '.[0].results[].ticker')
  TICKER_COUNT=$(echo "$TICKERS" | wc -l | tr -d ' ')
  echo "Found $TICKER_COUNT tickers"
fi

# Process each ticker
TOTAL_ROWS=0
TOTAL_FACTS=0
COUNT=0

for TICKER in $TICKERS; do
  COUNT=$((COUNT + 1))
  echo ""
  echo "[$COUNT] Processing $TICKER..."
  
  # Insert aggregated data directly using SQL aggregation
  # This uses D1's SQL capabilities to do the aggregation in-database
  SQL="INSERT OR REPLACE INTO trail_5m_facts 
    (ticker, bucket_ts, price_open, price_high, price_low, price_close,
     htf_score_avg, htf_score_min, htf_score_max,
     ltf_score_avg, ltf_score_min, ltf_score_max,
     state, rank, completion, phase_pct,
     had_squeeze_release, had_ema_cross, had_st_flip, had_momentum_elite, had_flip_watch,
     kanban_stage_start, kanban_stage_end, kanban_changed,
     sample_count, created_at)
  SELECT 
    ticker,
    (ts / 300000) * 300000 as bucket_ts,
    (SELECT price FROM timed_trail t2 WHERE t2.ticker = t1.ticker AND (t2.ts / 300000) * 300000 = (t1.ts / 300000) * 300000 ORDER BY t2.ts ASC LIMIT 1) as price_open,
    MAX(price) as price_high,
    MIN(price) as price_low,
    (SELECT price FROM timed_trail t2 WHERE t2.ticker = t1.ticker AND (t2.ts / 300000) * 300000 = (t1.ts / 300000) * 300000 ORDER BY t2.ts DESC LIMIT 1) as price_close,
    AVG(htf_score) as htf_score_avg,
    MIN(htf_score) as htf_score_min,
    MAX(htf_score) as htf_score_max,
    AVG(ltf_score) as ltf_score_avg,
    MIN(ltf_score) as ltf_score_min,
    MAX(ltf_score) as ltf_score_max,
    (SELECT state FROM timed_trail t2 WHERE t2.ticker = t1.ticker AND (t2.ts / 300000) * 300000 = (t1.ts / 300000) * 300000 ORDER BY t2.ts DESC LIMIT 1) as state,
    (SELECT rank FROM timed_trail t2 WHERE t2.ticker = t1.ticker AND (t2.ts / 300000) * 300000 = (t1.ts / 300000) * 300000 ORDER BY t2.ts DESC LIMIT 1) as rank,
    (SELECT completion FROM timed_trail t2 WHERE t2.ticker = t1.ticker AND (t2.ts / 300000) * 300000 = (t1.ts / 300000) * 300000 ORDER BY t2.ts DESC LIMIT 1) as completion,
    (SELECT phase_pct FROM timed_trail t2 WHERE t2.ticker = t1.ticker AND (t2.ts / 300000) * 300000 = (t1.ts / 300000) * 300000 ORDER BY t2.ts DESC LIMIT 1) as phase_pct,
    0, 0, 0, 0, 0,
    NULL, NULL, 0,
    COUNT(*) as sample_count,
    strftime('%s', 'now') * 1000 as created_at
  FROM timed_trail t1
  WHERE ticker = '$TICKER'
  GROUP BY ticker, (ts / 300000) * 300000"
  
  # Execute with wrangler
  RESULT=$(cd worker && npx wrangler d1 execute $DB_NAME --remote --json --command "$SQL" 2>/dev/null || echo '[]')
  
  # Get counts
  ROWS=$(cd worker && npx wrangler d1 execute $DB_NAME --remote --json --command "SELECT COUNT(*) as cnt FROM timed_trail WHERE ticker = '$TICKER'" 2>/dev/null | jq -r '.[0].results[0].cnt // 0')
  FACTS=$(cd worker && npx wrangler d1 execute $DB_NAME --remote --json --command "SELECT COUNT(*) as cnt FROM trail_5m_facts WHERE ticker = '$TICKER'" 2>/dev/null | jq -r '.[0].results[0].cnt // 0')
  
  echo "  ✓ $TICKER: $ROWS rows → $FACTS facts"
  
  TOTAL_ROWS=$((TOTAL_ROWS + ROWS))
  TOTAL_FACTS=$((TOTAL_FACTS + FACTS))
done

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  AGGREGATION COMPLETE"
echo "═══════════════════════════════════════════════════════════════"
echo "Total rows processed: $TOTAL_ROWS"
echo "Total facts created: $TOTAL_FACTS"
if [ $TOTAL_ROWS -gt 0 ]; then
  RATIO=$(echo "scale=1; $TOTAL_FACTS * 100 / $TOTAL_ROWS" | bc)
  echo "Compression ratio: $RATIO%"
fi
