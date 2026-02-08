#!/bin/bash
# Aggregate all tickers from timed_trail to trail_5m_facts
# Run from timedtrading directory

set -e
cd "$(dirname "$0")/../worker"

DB_NAME="timed-trading-ledger"

echo "═══════════════════════════════════════════════════════════════"
echo "  AGGREGATE ALL TICKERS TO 5-MINUTE FACTS"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Get all distinct tickers
echo "Fetching ticker list..."
TICKERS=$(npx wrangler d1 execute $DB_NAME --remote --json --command "SELECT DISTINCT ticker FROM timed_trail ORDER BY ticker" 2>/dev/null | jq -r '.[0].results[].ticker')

TICKER_COUNT=$(echo "$TICKERS" | wc -l | tr -d ' ')
echo "Found $TICKER_COUNT tickers to process"
echo ""

# Track progress
PROCESSED=0
FAILED=0
START_TIME=$(date +%s)

for TICKER in $TICKERS; do
  PROCESSED=$((PROCESSED + 1))
  echo -n "[$PROCESSED/$TICKER_COUNT] $TICKER... "
  
  # Run aggregation INSERT...SELECT
  RESULT=$(npx wrangler d1 execute $DB_NAME --remote --json --command "
INSERT OR REPLACE INTO trail_5m_facts 
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
  MIN(price) as price_open,
  MAX(price) as price_high,
  MIN(price) as price_low,
  MAX(price) as price_close,
  ROUND(AVG(htf_score), 2) as htf_score_avg,
  MIN(htf_score) as htf_score_min,
  MAX(htf_score) as htf_score_max,
  ROUND(AVG(ltf_score), 2) as ltf_score_avg,
  MIN(ltf_score) as ltf_score_min,
  MAX(ltf_score) as ltf_score_max,
  MAX(state) as state,
  MAX(rank) as rank,
  MAX(completion) as completion,
  MAX(phase_pct) as phase_pct,
  0, 0, 0, 0, 0,
  NULL, NULL, 0,
  COUNT(*) as sample_count,
  strftime('%s', 'now') * 1000 as created_at
FROM timed_trail 
WHERE ticker = '$TICKER'
GROUP BY ticker, (ts / 300000) * 300000" 2>/dev/null)

  if [ $? -eq 0 ]; then
    CHANGES=$(echo "$RESULT" | jq -r '.[0].meta.changes // 0')
    echo "✓ ($CHANGES buckets)"
  else
    echo "✗ FAILED"
    FAILED=$((FAILED + 1))
  fi
done

# Final stats
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
ELAPSED_MIN=$((ELAPSED / 60))
ELAPSED_SEC=$((ELAPSED % 60))

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  AGGREGATION COMPLETE"
echo "═══════════════════════════════════════════════════════════════"
echo "Elapsed time: ${ELAPSED_MIN}m ${ELAPSED_SEC}s"
echo "Tickers processed: $((PROCESSED - FAILED))/$TICKER_COUNT"
echo "Failed: $FAILED"

# Show final counts
echo ""
echo "Final row counts:"
npx wrangler d1 execute $DB_NAME --remote --json --command "
SELECT 
  (SELECT COUNT(*) FROM timed_trail) as raw_rows,
  (SELECT COUNT(*) FROM trail_5m_facts) as fact_rows" 2>/dev/null | jq -r '.[0].results[] | "  Raw rows: \(.raw_rows)\n  Fact rows: \(.fact_rows)"'
