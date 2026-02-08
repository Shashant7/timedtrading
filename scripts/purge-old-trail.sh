#!/bin/bash
# Purge old timed_trail rows in batches
# Usage: ./scripts/purge-old-trail.sh [hours_to_keep]

set -e
cd "$(dirname "$0")/../worker"

DB_NAME="timed-trading-ledger"
HOURS_TO_KEEP=${1:-48}
BATCH_SIZE=2000
SLEEP_BETWEEN=3

CUTOFF=$(($(date +%s) * 1000 - HOURS_TO_KEEP * 60 * 60 * 1000))

echo "═══════════════════════════════════════════════════════════════"
echo "  PURGE OLD TRAIL DATA"
echo "═══════════════════════════════════════════════════════════════"
echo "Keeping data newer than: $HOURS_TO_KEEP hours"
echo "Cutoff timestamp: $CUTOFF"
echo "Batch size: $BATCH_SIZE"
echo ""

# Get count of rows to delete
echo "Counting rows to delete..."
TO_DELETE=$(npx wrangler d1 execute $DB_NAME --remote --json --command "SELECT COUNT(*) as cnt FROM timed_trail WHERE ts < $CUTOFF" 2>/dev/null | jq -r '.[0].results[0].cnt // 0')
echo "Rows to delete: $TO_DELETE"
echo ""

if [ "$TO_DELETE" -eq 0 ]; then
  echo "No rows to delete. Done."
  exit 0
fi

# Calculate batches
BATCHES=$(( (TO_DELETE + BATCH_SIZE - 1) / BATCH_SIZE ))
echo "Will process in $BATCHES batches"
echo ""

TOTAL_DELETED=0
BATCH=0

while true; do
  BATCH=$((BATCH + 1))
  echo -n "[$BATCH/$BATCHES] Deleting up to $BATCH_SIZE rows... "
  
  # Try the delete with retry logic
  for ATTEMPT in 1 2 3; do
    RESULT=$(npx wrangler d1 execute $DB_NAME --remote --json --command "DELETE FROM timed_trail WHERE ts < $CUTOFF LIMIT $BATCH_SIZE" 2>/dev/null || echo '{"error": true}')
    
    if echo "$RESULT" | grep -q '"error"'; then
      echo -n "(retry $ATTEMPT) "
      sleep $((SLEEP_BETWEEN * ATTEMPT))
    else
      break
    fi
  done
  
  CHANGES=$(echo "$RESULT" | jq -r '.[0].meta.changes // 0' 2>/dev/null || echo "0")
  TOTAL_DELETED=$((TOTAL_DELETED + CHANGES))
  
  echo "deleted $CHANGES (total: $TOTAL_DELETED)"
  
  if [ "$CHANGES" -eq 0 ]; then
    echo ""
    echo "No more rows to delete."
    break
  fi
  
  # Sleep between batches to avoid overloading
  sleep $SLEEP_BETWEEN
done

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  PURGE COMPLETE"
echo "═══════════════════════════════════════════════════════════════"
echo "Total rows deleted: $TOTAL_DELETED"

# Show final stats
echo ""
echo "Final table stats:"
npx wrangler d1 execute $DB_NAME --remote --json --command "
SELECT 
  (SELECT COUNT(*) FROM timed_trail) as trail_rows,
  (SELECT COUNT(*) FROM trail_5m_facts) as fact_rows" 2>/dev/null | jq -r '.[0].results[] | "  timed_trail: \(.trail_rows) rows\n  trail_5m_facts: \(.fact_rows) rows"'
