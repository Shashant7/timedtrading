#!/usr/bin/env bash
set -euo pipefail

# Exports key D1 tables to a local SQLite database for offline analysis.
# Usage: ./scripts/export-d1.sh [output.db] [--calibration-only] [--since YYYY-MM-DD]
#
# --calibration-only: Limit ticker_candles to tf IN ('D','5','60') and last 400 days
# --since YYYY-MM-DD: Limit ticker_candles to ts >= that date (UTC). All TFs. Less data.
#   e.g. --since 2025-06-01 → all TFs from June 2025 to now (~8.5 months)
# Requires: wrangler CLI authenticated, sqlite3

CALIBRATION_ONLY=false
SINCE_DATE=""
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$ROOT_DIR/data/timed-local.db"

i=1
while [ $i -le $# ]; do
  arg="${!i}"
  if [ "$arg" = "--calibration-only" ]; then
    CALIBRATION_ONLY=true
  elif [ "$arg" = "--since" ]; then
    next=$((i+1))
    [ $next -le $# ] && SINCE_DATE="${!next}" && i=$next
  elif [ -n "$arg" ] && [ "${arg#--}" = "$arg" ]; then
    OUT="$arg"
  fi
  i=$((i+1))
done

# Optional: resolve SINCE to epoch ms (UTC)
SINCE_MS=""
if [ -n "$SINCE_DATE" ]; then
  SINCE_MS=$(python3 -c "
from datetime import datetime, timezone
d = datetime.strptime('$SINCE_DATE', '%Y-%m-%d').replace(tzinfo=timezone.utc)
print(int(d.timestamp() * 1000))
" 2>/dev/null || echo "")
  [ -z "$SINCE_MS" ] && echo "Warning: invalid --since date '$SINCE_DATE', ignoring" && SINCE_DATE=""
fi

WORKER_DIR="$ROOT_DIR/worker"
mkdir -p "$(dirname "$OUT")"
# Create DB file immediately so path exists even if first table batch fails
sqlite3 "$OUT" "SELECT 1;" 2>/dev/null || true
export OUT

DB_NAME="timed-trading-ledger"
ENV_FLAG="--env production"

TABLES=(
  ticker_candles
  trades
  direction_accuracy
  trail_5m_facts
  calibration_moves
  calibration_trade_autopsy
  calibration_report
  calibration_profiles
  model_config
  path_performance
  account_ledger
)

echo "╔══════════════════════════════════════════════════════╗"
echo "║  D1 → Local SQLite Export                           ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "  Output: $OUT"
echo "  Tables: ${#TABLES[@]}"
[ -n "$SINCE_MS" ] && echo "  ticker_candles: from $SINCE_DATE (all TFs)${CALIBRATION_ONLY:+ , tf D/5/60 only}"
[ -z "$SINCE_MS" ] && [ "$CALIBRATION_ONLY" = "true" ] && echo "  ticker_candles: last 400d, tf D/5/60 only"
echo ""

query_d1() {
  local sql="$1"
  local escaped="${sql//\"/\\\"}"
  cd "$WORKER_DIR" && npx wrangler d1 execute "$DB_NAME" --remote $ENV_FLAG --json --command "$escaped" 2>/dev/null
}

# Get schema for each table
for table in "${TABLES[@]}"; do
  echo "── Exporting: $table"

  # Get row count (filtered for ticker_candles when --calibration-only or --since)
  if [ "$table" = "ticker_candles" ]; then
    if [ -n "$SINCE_MS" ]; then
      if [ "$CALIBRATION_ONLY" = "true" ]; then
        count_json=$(query_d1 "SELECT COUNT(*) as cnt FROM ticker_candles WHERE tf IN ('D','5','60') AND ts >= $SINCE_MS" 2>/dev/null || echo '[]')
      else
        count_json=$(query_d1 "SELECT COUNT(*) as cnt FROM ticker_candles WHERE ts >= $SINCE_MS" 2>/dev/null || echo '[]')
      fi
    elif [ "$CALIBRATION_ONLY" = "true" ]; then
      CUTOFF_MS=$(( ($(date +%s) - 400*86400) * 1000 ))
      count_json=$(query_d1 "SELECT COUNT(*) as cnt FROM ticker_candles WHERE tf IN ('D','5','60') AND ts >= $CUTOFF_MS" 2>/dev/null || echo '[]')
    else
      count_json=$(query_d1 "SELECT COUNT(*) as cnt FROM $table" 2>/dev/null || echo '[]')
    fi
  else
    count_json=$(query_d1 "SELECT COUNT(*) as cnt FROM $table" 2>/dev/null || echo '[]')
  fi
  count=$(echo "$count_json" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  if isinstance(d, list) and d and 'results' in d[0]:
    print(d[0]['results'][0]['cnt'])
  else:
    print(0)
except:
  print(0)
" 2>/dev/null || echo "0")
  echo "   Rows: $count"

  if [ "$count" = "0" ]; then
    echo "   (empty, skipping)"
    continue
  fi

  PAGE_SIZE=5000
  OFFSET=0
  FIRST=1
  if [ "$table" = "ticker_candles" ] && [ "$CALIBRATION_ONLY" = "true" ] && [ -z "$SINCE_MS" ]; then
    CUTOFF_MS=$(( ($(date +%s) - 400*86400) * 1000 ))
  fi

  while true; do
    if [ "$table" = "ticker_candles" ]; then
      if [ -n "$SINCE_MS" ]; then
        if [ "$CALIBRATION_ONLY" = "true" ]; then
          json=$(query_d1 "SELECT * FROM ticker_candles WHERE tf IN ('D','5','60') AND ts >= $SINCE_MS ORDER BY ticker, tf, ts LIMIT $PAGE_SIZE OFFSET $OFFSET" 2>/dev/null || echo '[]')
        else
          json=$(query_d1 "SELECT * FROM ticker_candles WHERE ts >= $SINCE_MS ORDER BY ticker, tf, ts LIMIT $PAGE_SIZE OFFSET $OFFSET" 2>/dev/null || echo '[]')
        fi
      elif [ "$CALIBRATION_ONLY" = "true" ]; then
        json=$(query_d1 "SELECT * FROM ticker_candles WHERE tf IN ('D','5','60') AND ts >= $CUTOFF_MS ORDER BY ticker, tf, ts LIMIT $PAGE_SIZE OFFSET $OFFSET" 2>/dev/null || echo '[]')
      else
        json=$(query_d1 "SELECT * FROM $table LIMIT $PAGE_SIZE OFFSET $OFFSET" 2>/dev/null || echo '[]')
      fi
    else
      json=$(query_d1 "SELECT * FROM $table LIMIT $PAGE_SIZE OFFSET $OFFSET" 2>/dev/null || echo '[]')
    fi

    python3 -c "
import sys, json, sqlite3, os

raw = sys.stdin.read()
try:
    d = json.loads(raw)
    if isinstance(d, list) and d and 'results' in d[0]:
        rows = d[0]['results']
    elif isinstance(d, dict) and 'results' in d:
        rows = d['results']
    else:
        rows = []
except:
    rows = []

if not rows:
    sys.exit(1)

db_path = os.environ.get('OUT', 'data/timed-local.db')
table = '''$table'''
first_page = $FIRST

conn = sqlite3.connect(db_path)
cur = conn.cursor()

if first_page:
    cur.execute(f'DROP TABLE IF EXISTS {table}')
    cols = list(rows[0].keys())
    col_defs = ', '.join(f'\"{c}\" TEXT' for c in cols)
    cur.execute(f'CREATE TABLE {table} ({col_defs})')

cols = list(rows[0].keys())
placeholders = ', '.join(['?'] * len(cols))
col_names = ', '.join(f'\"{c}\"' for c in cols)

for row in rows:
    vals = [str(row.get(c, '')) if row.get(c) is not None else None for c in cols]
    cur.execute(f'INSERT INTO {table} ({col_names}) VALUES ({placeholders})', vals)

conn.commit()
conn.close()
print(len(rows))
" <<< "$json"

    inserted=$?
    rows_this_page=$(python3 -c "
import sys, json
raw = sys.stdin.read()
try:
    d = json.loads(raw)
    if isinstance(d, list) and d and 'results' in d[0]:
        print(len(d[0]['results']))
    else:
        print(0)
except:
    print(0)
" <<< "$json" 2>/dev/null || echo "0")

    OFFSET=$((OFFSET + PAGE_SIZE))
    FIRST=0

    if [ "$rows_this_page" -lt "$PAGE_SIZE" ]; then
      break
    fi

    echo -ne "   Exported $OFFSET rows...\r"
  done

  echo "   Done ($table)"
done

echo ""
echo "╚══════════════════════════════════════════════════════╝"
echo "  Export complete: $OUT"
echo "  Size: $(du -h "$OUT" | cut -f1)"
echo ""
echo "  Usage: sqlite3 $OUT"
echo "    sqlite> SELECT COUNT(*) FROM ticker_candles;"
echo "    sqlite> SELECT ticker, COUNT(*) FROM trades GROUP BY ticker;"
