#!/usr/bin/env bash
set -euo pipefail

# Export D1 as SQL dump, optionally gzip, then load into local SQLite.
# Single bulk download — much faster than row-by-row pagination.
#
# Usage: ./scripts/export-d1-dump.sh [output.db] [--gzip]
#
# --gzip: compress backup.sql → backup.sql.gz before loading (saves disk during transfer)
# Requires: wrangler CLI authenticated, sqlite3

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKER_DIR="$ROOT_DIR/worker"
OUT="$ROOT_DIR/data/timed-local.db"
GZIP=false
for arg in "$@"; do
  [ "$arg" = "--gzip" ] && GZIP=true
  [ -n "$arg" ] && [ "${arg#--}" = "$arg" ] && OUT="$arg"
done

mkdir -p "$(dirname "$OUT")"
DUMP="$ROOT_DIR/data/d1-export.sql"
DB_NAME="timed-trading-ledger"
ENV_FLAG="--env production"

echo "╔══════════════════════════════════════════════════════╗"
echo "║  D1 → SQL Dump → Local SQLite                       ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "  Step 1: wrangler d1 export (bulk download)"
echo "  Step 2: load into $OUT"
echo ""

# Export remote D1 to SQL file
echo "── Exporting D1 → $DUMP"
cd "$WORKER_DIR" && npx wrangler d1 export "$DB_NAME" --remote $ENV_FLAG --output "$DUMP"
echo "   Done. Size: $(du -h "$DUMP" | cut -f1)"

# Optional gzip
if [ "$GZIP" = "true" ]; then
  echo "── Compressing..."
  gzip -f "$DUMP"
  DUMP="${DUMP}.gz"
  echo "   Done. Size: $(du -h "$DUMP" | cut -f1)"
fi

# Load into local SQLite (remove existing DB so we get a clean import)
echo "── Loading into $OUT"
rm -f "$OUT"
if [[ "$DUMP" == *.gz ]]; then
  gunzip -c "$DUMP" | sqlite3 "$OUT"
else
  sqlite3 "$OUT" < "$DUMP"
fi
echo "   Done. DB size: $(du -h "$OUT" | cut -f1)"

# Cleanup dump
rm -f "$DUMP" "${DUMP%.gz}"

echo ""
echo "╚══════════════════════════════════════════════════════╝"
echo "  Export complete: $OUT"
echo ""
echo "  Usage: sqlite3 $OUT"
echo "    sqlite> .tables"
echo "    sqlite> SELECT COUNT(*) FROM ticker_candles;"
echo ""
