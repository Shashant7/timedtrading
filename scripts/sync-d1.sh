#!/usr/bin/env bash
set -euo pipefail

# Delta-sync from Cloudflare D1 to local SQLite. Only fetches rows newer than last sync.
# Usage: ./scripts/sync-d1.sh [output.db]
# Requires: wrangler CLI authenticated, sqlite3, python3. Run export-d1.sh once first.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKER_DIR="$ROOT_DIR/worker"
OUT="${1:-$ROOT_DIR/data/timed-local.db}"
mkdir -p "$(dirname "$OUT")"

DB_NAME="timed-trading-ledger"
ENV_FLAG="--env production"

if [[ ! -f "$OUT" ]]; then
  echo "Local DB not found: $OUT"
  echo "Run ./scripts/export-d1.sh first for initial full export."
  exit 1
fi

query_d1() {
  local sql="$1"
  local escaped="${sql//\"/\\\"}"
  cd "$WORKER_DIR" && npx wrangler d1 execute "$DB_NAME" --remote $ENV_FLAG --json --command "$escaped" 2>/dev/null
}

# Ensure _sync_meta exists
sqlite3 "$OUT" "CREATE TABLE IF NOT EXISTS _sync_meta (table_name TEXT PRIMARY KEY, last_ts INTEGER NOT NULL DEFAULT 0, last_sync_at INTEGER NOT NULL DEFAULT 0);"

echo "╔══════════════════════════════════════════════════════╗"
echo "║  D1 → Local SQLite Delta Sync                      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo "  Output: $OUT"
echo ""

# Delta-sync config: table_name | timestamp_column | key_columns (comma-sep for upsert)
# key_columns used to DELETE then INSERT for upsert (no UNIQUE required)
sync_ticker_candles() {
  local last_ts
  last_ts=$(sqlite3 "$OUT" "SELECT COALESCE(MAX(CAST(last_ts AS INTEGER)), 0) FROM _sync_meta WHERE table_name='ticker_candles';" 2>/dev/null || echo "0")
  echo "── ticker_candles (since ts=$last_ts)"
  local json
  json=$(query_d1 "SELECT * FROM ticker_candles WHERE ts > $last_ts ORDER BY ts LIMIT 10000") || true
  echo "$json" | python3 -c "
import sys, json, sqlite3
raw = sys.stdin.read()
try:
    d = json.loads(raw)
    rows = d[0]['results'] if isinstance(d, list) and d and 'results' in d[0] else (d.get('results') or [])
except: rows = []
if not rows:
    print('   Fetched: 0 rows')
    sys.exit(0)
db = '$OUT'
conn = sqlite3.connect(db)
cur = conn.cursor()
cols = list(rows[0].keys())
max_ts = 0
ph = ','.join(['?']*len(cols))
col_names = ','.join('\"'+c+'\"' for c in cols)
for r in rows:
    ts = int(r.get('ts') or 0)
    if ts > max_ts: max_ts = ts
    cur.execute('DELETE FROM ticker_candles WHERE ticker=? AND tf=? AND ts=?', (r.get('ticker'), r.get('tf'), ts))
    cur.execute('INSERT INTO ticker_candles ('+col_names+') VALUES ('+ph+')', [str(r.get(c)) if r.get(c) is not None else None for c in cols])
conn.commit()
cur.execute('INSERT OR REPLACE INTO _sync_meta (table_name, last_ts, last_sync_at) VALUES (?,?,?)', ('ticker_candles', max_ts, int(__import__('time').time()*1000)))
conn.commit()
conn.close()
print('   Fetched:', len(rows), 'rows')
" 2>/dev/null || true
}

sync_trail_5m_facts() {
  local last_ts
  last_ts=$(sqlite3 "$OUT" "SELECT COALESCE(MAX(CAST(last_ts AS INTEGER)), 0) FROM _sync_meta WHERE table_name='trail_5m_facts';" 2>/dev/null || echo "0")
  echo "── trail_5m_facts (since bucket_ts=$last_ts)"
  local json
  json=$(query_d1 "SELECT * FROM trail_5m_facts WHERE bucket_ts > $last_ts ORDER BY bucket_ts LIMIT 10000") || true
  echo "$json" | python3 -c "
import sys, json, sqlite3
raw = sys.stdin.read()
try:
    d = json.loads(raw)
    rows = d[0]['results'] if isinstance(d, list) and d and 'results' in d[0] else (d.get('results') or [])
except: rows = []
if not rows:
    print('   Fetched: 0 rows')
    sys.exit(0)
db = '$OUT'
conn = sqlite3.connect(db)
cur = conn.cursor()
cols = ['ticker','bucket_ts','price_open','price_high','price_low','price_close','htf_score_avg','ltf_score_avg','state','rank','completion','phase_pct','had_squeeze_release','had_ema_cross','had_st_flip','had_momentum_elite','had_flip_watch','sample_count','created_at']
cur.execute('CREATE TABLE IF NOT EXISTS trail_5m_facts (ticker TEXT, bucket_ts INTEGER, price_open REAL, price_high REAL, price_low REAL, price_close REAL, htf_score_avg REAL, ltf_score_avg REAL, state TEXT, rank INTEGER, completion REAL, phase_pct REAL, had_squeeze_release INTEGER, had_ema_cross INTEGER, had_st_flip INTEGER, had_momentum_elite INTEGER, had_flip_watch INTEGER, sample_count INTEGER, created_at INTEGER)')
max_ts = 0
for r in rows:
    ticker = r.get('ticker'); bucket_ts = int(r.get('bucket_ts') or 0)
    if bucket_ts > max_ts: max_ts = bucket_ts
    cur.execute('DELETE FROM trail_5m_facts WHERE ticker=? AND bucket_ts=?', (ticker, bucket_ts))
    cur.execute('''INSERT INTO trail_5m_facts (ticker, bucket_ts, price_open, price_high, price_low, price_close, htf_score_avg, ltf_score_avg, state, rank, completion, phase_pct, had_squeeze_release, had_ema_cross, had_st_flip, had_momentum_elite, had_flip_watch, sample_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        (ticker, bucket_ts, r.get('price_open'), r.get('price_high'), r.get('price_low'), r.get('price_close'), r.get('htf_score_avg'), r.get('ltf_score_avg'), r.get('state'), r.get('rank'), r.get('completion'), r.get('phase_pct'), r.get('had_squeeze_release'), r.get('had_ema_cross'), r.get('had_st_flip'), r.get('had_momentum_elite'), r.get('had_flip_watch'), r.get('sample_count'), r.get('created_at')))
conn.commit()
cur.execute('INSERT OR REPLACE INTO _sync_meta (table_name, last_ts, last_sync_at) VALUES (?,?,?)', ('trail_5m_facts', max_ts if max_ts else 0, int(__import__('time').time()*1000)))
conn.commit()
conn.close()
print('   Fetched:', len(rows), 'rows')
" 2>/dev/null || true
}

sync_trades() {
  local last_ts
  last_ts=$(sqlite3 "$OUT" "SELECT COALESCE(MAX(CAST(last_ts AS INTEGER)), 0) FROM _sync_meta WHERE table_name='trades';" 2>/dev/null || echo "0")
  echo "── trades (since entry_ts=$last_ts)"
  local json
  json=$(query_d1 "SELECT * FROM trades WHERE entry_ts > $last_ts ORDER BY entry_ts LIMIT 2000") || true
  echo "$json" | python3 -c "
import sys, json, sqlite3
raw = sys.stdin.read()
try:
    d = json.loads(raw)
    rows = d[0]['results'] if isinstance(d, list) and d and 'results' in d[0] else (d.get('results') or [])
except: rows = []
if not rows:
    print('   Fetched: 0 rows')
    sys.exit(0)
db = '$OUT'
conn = sqlite3.connect(db)
cur = conn.cursor()
cur.execute('CREATE TABLE IF NOT EXISTS trades (trade_id TEXT PRIMARY KEY, ticker TEXT, direction TEXT, entry_ts INTEGER, entry_price REAL, rank INTEGER, rr REAL, status TEXT, exit_ts INTEGER, exit_price REAL, exit_reason TEXT, pnl_pct REAL)')
max_ts = 0
for r in rows:
    ets = int(r.get('entry_ts') or 0)
    if ets > max_ts: max_ts = ets
    cur.execute('INSERT OR REPLACE INTO trades (trade_id, ticker, direction, entry_ts, entry_price, rank, rr, status, exit_ts, exit_price, exit_reason, pnl_pct) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        (r.get('trade_id'), r.get('ticker'), r.get('direction'), ets, r.get('entry_price'), r.get('rank'), r.get('rr'), r.get('status'), r.get('exit_ts'), r.get('exit_price'), r.get('exit_reason'), r.get('pnl_pct')))
conn.commit()
cur.execute('INSERT OR REPLACE INTO _sync_meta (table_name, last_ts, last_sync_at) VALUES (?,?,?)', ('trades', max_ts if max_ts else 0, int(__import__('time').time()*1000)))
conn.commit()
conn.close()
print('   Fetched:', len(rows), 'rows')
" 2>/dev/null || true
}

sync_direction_accuracy() {
  local last_ts
  last_ts=$(sqlite3 "$OUT" "SELECT COALESCE(MAX(CAST(last_ts AS INTEGER)), 0) FROM _sync_meta WHERE table_name='direction_accuracy';" 2>/dev/null || echo "0")
  echo "── direction_accuracy (since ts=$last_ts)"
  local json
  json=$(query_d1 "SELECT * FROM direction_accuracy WHERE ts > $last_ts ORDER BY ts LIMIT 5000") || true
  echo "$json" | python3 -c "
import sys, json, sqlite3
raw = sys.stdin.read()
try:
    d = json.loads(raw)
    rows = d[0]['results'] if isinstance(d, list) and d and 'results' in d[0] else (d.get('results') or [])
except: rows = []
if not rows:
    print('   Fetched: 0 rows')
    sys.exit(0)
db = '$OUT'
conn = sqlite3.connect(db)
cur = conn.cursor()
cur.execute('CREATE TABLE IF NOT EXISTS direction_accuracy (trade_id TEXT PRIMARY KEY, ticker TEXT, ts INTEGER, signal_snapshot_json TEXT, regime_daily TEXT, regime_weekly TEXT, regime_combined TEXT, entry_path TEXT)')
max_ts = 0
for r in rows:
    ts = int(r.get('ts') or 0)
    if ts > max_ts: max_ts = ts
    cur.execute('INSERT OR REPLACE INTO direction_accuracy (trade_id, ticker, ts, signal_snapshot_json, regime_daily, regime_weekly, regime_combined, entry_path) VALUES (?,?,?,?,?,?,?,?)',
        (r.get('trade_id'), r.get('ticker'), ts, r.get('signal_snapshot_json'), r.get('regime_daily'), r.get('regime_weekly'), r.get('regime_combined'), r.get('entry_path')))
conn.commit()
cur.execute('INSERT OR REPLACE INTO _sync_meta (table_name, last_ts, last_sync_at) VALUES (?,?,?)', ('direction_accuracy', max_ts if max_ts else 0, int(__import__('time').time()*1000)))
conn.commit()
conn.close()
print('   Fetched:', len(rows), 'rows')
" 2>/dev/null || true
}

sync_ticker_candles
sync_trail_5m_facts
sync_trades
sync_direction_accuracy

echo ""
echo "╚══════════════════════════════════════════════════════╝"
echo "  Delta sync complete: $OUT"
echo "  Size: $(du -h "$OUT" 2>/dev/null | cut -f1)"
echo ""
