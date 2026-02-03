#!/usr/bin/env bash
# Run Phase 2 D1 migration: positions, lots, execution_actions tables.
# Requires: wrangler logged in (wrangler login) and D1 DB exists.
#
# Usage:
#   ./scripts/run-phase2-migration.sh
#   WRANGLER_ENV=production ./scripts/run-phase2-migration.sh
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV="${WRANGLER_ENV:-production}"
DB_NAME="timed-trading-ledger"
MIGRATION_FILE="$REPO_ROOT/worker/migrations/add-positions-lots-actions.sql"

if [[ ! -f "$MIGRATION_FILE" ]]; then
  echo "Migration file not found: $MIGRATION_FILE"
  exit 1
fi

echo "Running Phase 2 D1 migration (env=$ENV, db=$DB_NAME)..."
# Run from worker/ so wrangler.toml (and D1 binding) is found; use repo's wrangler via npx
(cd "$REPO_ROOT/worker" && npx wrangler d1 execute "$DB_NAME" --remote --file="$MIGRATION_FILE" --env "$ENV")
echo "Done. If you see 'Authentication error [code: 10000]', run: npx wrangler login"
echo "Then run backfill: TIMED_API_KEY=your_key node scripts/backfill-positions.js"
