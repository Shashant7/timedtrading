#!/usr/bin/env bash
# Phase 3.9 / preprod-fidelity (2026-05-10).
#
# Full live → preprod data sync. The earlier `clone-live-to-preprod.sh` was
# the v1 bootstrap (model_config + day-state KV only). After running phase-c
# stage2 on preprod we discovered:
#
#   - 13 scoring-input D1 tables were ALSO needed (ticker_profiles,
#     ticker_index, calibration_profiles, path_performance, ticker_moves,
#     ticker_move_signals, direction_accuracy, ai_cio_decisions, etc.)
#
#   - day-state KV gets MUTATED by every preprod backtest (the candle
#     replay rewrites it as it walks). So preprod's blobs decay over time
#     and need periodic re-clone from live to maintain canonical fidelity.
#
# This script restores preprod to a "canonical mirror" state by mirroring
# all scoring-relevant data from live. Trade tables (trades, account_ledger,
# investor_positions, backtest_run_*) are NOT cloned — those are populated
# by preprod's own backtest runs.
#
# Diagnostic that produced this script:
#   tasks/phase-c/WR_DIAGNOSTIC_2026-05-10.md
#   tasks/phase-c/PREPROD_FIDELITY_2026-05-10.md
#
# Usage:
#   TIMED_API_KEY=... CLOUDFLARE_API_TOKEN=... \
#     bash scripts/sync-live-to-preprod.sh
#
# Idempotent — every operation is INSERT OR REPLACE / KV put.

set -uo pipefail
LIVE_BASE="${LIVE_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
PREPROD_BASE="${PREPROD_BASE:-https://timed-trading-ingest-preprod.shashant.workers.dev}"
LIVE_DB="${LIVE_DB:-timed-trading-ledger}"
PREPROD_DB="${PREPROD_DB:-timed-trading-ledger-preprod}"
API_KEY="${TIMED_API_KEY:-${TIMED_TRADING_API_KEY:-}}"

if [[ -z "$API_KEY" ]]; then
  echo "ERROR: TIMED_API_KEY env required" >&2
  exit 2
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -n "${CLOUDFLARE_TOKEN:-}" ]]; then
  export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_TOKEN"
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "ERROR: CLOUDFLARE_API_TOKEN env required for wrangler d1 access" >&2
  exit 4
fi

WORK=$(mktemp -d /tmp/sync-live-to-preprod.XXXXXX)
trap "rm -rf $WORK" EXIT

echo "═══════════════════════════════════════════════════════════════"
echo "  SYNC LIVE → PREPROD (full canonical mirror)"
echo "  live worker:    $LIVE_BASE"
echo "  preprod worker: $PREPROD_BASE"
echo "  live D1:        $LIVE_DB"
echo "  preprod D1:     $PREPROD_DB"
echo "  workdir:        $WORK"
echo "═══════════════════════════════════════════════════════════════"

# ─────────────────────────────────────────────────────────────────
# 1. Sanity: both endpoints reachable.
# ─────────────────────────────────────────────────────────────────
echo
echo "[1/6] Reachability check..."
LIVE_OK=$(curl -sS -m 10 "$LIVE_BASE/timed/admin/replay-lock?key=$API_KEY" 2>&1 \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok','false'))" 2>/dev/null || echo "false")
PRE_OK=$(curl -sS -m 10 "$PREPROD_BASE/timed/admin/replay-lock?key=$API_KEY" 2>&1 \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok','false'))" 2>/dev/null || echo "false")
echo "  live: $LIVE_OK    preprod: $PRE_OK"
[[ "$LIVE_OK" != "True" ]] && { echo "ERROR: live not reachable" >&2; exit 3; }
[[ "$PRE_OK" != "True" ]] && { echo "ERROR: preprod not reachable" >&2; exit 3; }

# ─────────────────────────────────────────────────────────────────
# 2. D1: full model_config dump → restore (one-shot, not row-by-row).
# ─────────────────────────────────────────────────────────────────
echo
echo "[2/6] D1 model_config (full clone) ..."
DUMP_JSON="$WORK/model_config.json"
SEED_SQL="$WORK/model_config.sql"
npx wrangler d1 execute "$LIVE_DB" --remote --json \
  --command="SELECT config_key, config_value, description FROM model_config ORDER BY config_key" \
  > "$DUMP_JSON" 2>/dev/null
TOTAL_KEYS=$(jq '.[0].results | length' "$DUMP_JSON" 2>/dev/null || echo "0")
echo "  dumped $TOTAL_KEYS rows from live model_config"
[[ "$TOTAL_KEYS" -lt 100 ]] && { echo "  ERROR: expected >300 rows" >&2; exit 5; }

NOW_MS=$(date +%s)000
jq -r --arg ts "$NOW_MS" '.[0].results[] | "INSERT OR REPLACE INTO model_config (config_key, config_value, description, updated_at, updated_by) VALUES (" +
  "'"'"'" + (.config_key | gsub("'"'"'"; "''"))   + "'"'"'," +
  "'"'"'" + ((.config_value // "") | tostring | gsub("'"'"'"; "''")) + "'"'"'," +
  "'"'"'" + ((.description // "")   | gsub("'"'"'"; "''"))   + "'"'"'," +
  ($ts) + "," +
  "'"'"'sync-live-to-preprod'"'"');"' "$DUMP_JSON" > "$SEED_SQL"

npx wrangler d1 execute "$PREPROD_DB" --remote --file="$SEED_SQL" 2>&1 | tail -3 | head -1
PRE_COUNT=$(npx wrangler d1 execute "$PREPROD_DB" --remote --json \
  --command="SELECT COUNT(*) AS n FROM model_config" 2>/dev/null \
  | jq -r '.[0].results[0].n')
echo "  preprod model_config now: $PRE_COUNT rows"

# ─────────────────────────────────────────────────────────────────
# 3. D1: scoring/entry-relevant reference tables.
#    These are bulk-dumped via `wrangler d1 export --no-schema --table=`
#    then bulk-imported via `wrangler d1 execute --file=`.
#    Trade-history tables (trades, account_ledger, etc.) are EXCLUDED.
# ─────────────────────────────────────────────────────────────────
echo
echo "[3/6] D1 scoring-relevant reference tables..."
TABLES=(
  ticker_profiles
  ticker_index
  calibration_profiles
  path_performance
  path_performance_calibration
  user_tickers
  promoted_trade_datasets
  promoted_trades
  pattern_library
  ticker_moves
  ticker_move_signals
  direction_accuracy
  ai_cio_decisions
)
for t in "${TABLES[@]}"; do
  f="$WORK/${t}.sql"
  echo "  $t: dumping..."
  npx wrangler d1 export "$LIVE_DB" --remote --no-schema --table="$t" --output="$f" -y 2>&1 | tail -1
  if [[ ! -s "$f" ]]; then echo "    SKIP $t (empty dump)"; continue; fi
  rows=$(grep -c '^INSERT' "$f" 2>/dev/null | head -1)
  rows=${rows:-0}
  if [[ "$rows" -eq 0 ]]; then echo "    SKIP $t (0 inserts)"; continue; fi
  echo "    importing $rows rows..."
  # The wrangler export uses INSERT (not INSERT OR REPLACE), so we wipe
  # the destination table first to keep the operation idempotent.
  npx wrangler d1 execute "$PREPROD_DB" --remote --command="DELETE FROM $t" 2>&1 | tail -1 > /dev/null
  npx wrangler d1 execute "$PREPROD_DB" --remote --file="$f" 2>&1 | tail -3 | head -1 > /dev/null
  L=$(npx wrangler d1 execute "$LIVE_DB" --remote --json --command="SELECT COUNT(*) AS n FROM $t" 2>/dev/null | jq -r '.[0].results[0].n')
  P=$(npx wrangler d1 execute "$PREPROD_DB" --remote --json --command="SELECT COUNT(*) AS n FROM $t" 2>/dev/null | jq -r '.[0].results[0].n')
  m="✓"; [[ "$L" != "$P" ]] && m="✗"
  printf "    %s %s   live=%s  preprod=%s\n" "$m" "$t" "$L" "$P"
done

# ─────────────────────────────────────────────────────────────────
# 4. KV: scoring-relevant prefixes. Delegates to sync-daystate-kv.sh
#    which is generic on the PREFIX env var. Each prefix is parallel-
#    cloned by 4 workers; bulky cohorts run sequentially because
#    each one already saturates parallelism within its prefix.
#
#    Why these prefixes matter at backtest time:
#      timed:replay:daystate:*    — per-day scoring snapshot (largest, ~6GB)
#      timed:internals:*          — historical market internals per indicator/day
#      timed:context:*            — per-ticker sector context cache
#      timed:capture:*            — per-indicator capture trail
#      timed:sector_map:*         — sector classification
#      timed:profile:*            — per-ticker profile cache
#      timed:calibration:*        — calibration golden profiles
#      phase-c:*                  — Phase C admission/doctrine/loop config blobs
# ─────────────────────────────────────────────────────────────────
echo
echo "[4/6] KV: scoring-relevant prefixes..."
HERE="$(cd "$(dirname "$0")" && pwd)"
KV_PREFIXES=(
  "timed:replay:daystate:"
  "timed:internals:"
  "timed:context:"
  "timed:capture:"
  "timed:sector_map:"
  "timed:profile:"
  "timed:calibration:"
  "phase-c:"
)
for prefix in "${KV_PREFIXES[@]}"; do
  echo "  prefix=$prefix"
  TIMED_API_KEY="$API_KEY" \
    LIVE_BASE="$LIVE_BASE" \
    PREPROD_BASE="$PREPROD_BASE" \
    PREFIX="$prefix" \
    bash "$HERE/sync-daystate-kv.sh" 2>&1 \
      | grep -E '^\[|^  done:|^  preprod now|^═' \
      | sed 's/^/    /'
done

# ─────────────────────────────────────────────────────────────────
# 5. Reapply preprod-specific experiment overrides on model_config.
#    These are deltas we want vs live for backtest experimentation.
#    Currently: TH module enabled for preprod (live default off).
# ─────────────────────────────────────────────────────────────────
echo
echo "[5/6] Preprod experiment overrides..."
# IMPORTANT: by default we leave TH OFF on preprod after a sync, so the
# canonical-mirror baseline run can reproduce live's 56% Jul WR exactly.
# Enable TH explicitly via the preprod admin endpoint when running TH
# experiments. To enable here, set ENABLE_TH=1.
if [[ "${ENABLE_TH:-0}" == "1" ]]; then
  OVR_PAYLOAD=$(python3 -c "
import json
print(json.dumps({'updates': [
  {'key':'deep_audit_trend_hold_enabled', 'value':'true', 'description':'preprod override — TH on for backtest validation'},
  {'key':'deep_audit_trend_hold_max_positions', 'value':6, 'description':'preprod override — max 6 simultaneous TH positions'},
]}))")
  curl -sS -X POST "$PREPROD_BASE/timed/admin/model-config?key=$API_KEY" \
    -H "content-type: application/json" \
    -d "$OVR_PAYLOAD" | head -3 | sed 's/^/  /'
else
  echo "  (TH overrides not applied — set ENABLE_TH=1 to enable for experiments)"
fi

# ─────────────────────────────────────────────────────────────────
# 6. Equivalence summary.
# ─────────────────────────────────────────────────────────────────
echo
echo "[6/6] Equivalence summary..."
ALL=(
  model_config
  ticker_profiles
  ticker_index
  calibration_profiles
  path_performance
  path_performance_calibration
  user_tickers
  promoted_trade_datasets
  promoted_trades
  pattern_library
  ticker_moves
  ticker_move_signals
  direction_accuracy
  ai_cio_decisions
)
ALL_OK=1
for t in "${ALL[@]}"; do
  L=$(npx wrangler d1 execute "$LIVE_DB" --remote --json --command="SELECT COUNT(*) AS n FROM $t" 2>/dev/null | jq -r '.[0].results[0].n // "ERR"')
  P=$(npx wrangler d1 execute "$PREPROD_DB" --remote --json --command="SELECT COUNT(*) AS n FROM $t" 2>/dev/null | jq -r '.[0].results[0].n // "ERR"')
  m="✓"; [[ "$L" != "$P" ]] && { m="✗"; ALL_OK=0; }
  printf "  %s %-35s live=%-8s preprod=%-8s\n" "$m" "$t" "$L" "$P"
done

# Day-state KV count.
LIVE_KV=$(curl -sS "$LIVE_BASE/timed/admin/kv/list?prefix=timed:replay:daystate:&limit=1000&key=$API_KEY" \
  | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('keys',[])))")
PRE_KV=$(curl -sS "$PREPROD_BASE/timed/admin/kv/list?prefix=timed:replay:daystate:&limit=1000&key=$API_KEY" \
  | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('keys',[])))")
m="✓"; [[ "$LIVE_KV" != "$PRE_KV" ]] && { m="✗"; ALL_OK=0; }
printf "  %s %-35s live=%-8s preprod=%-8s\n" "$m" "KV timed:replay:daystate:*" "$LIVE_KV" "$PRE_KV"

echo
if [[ "$ALL_OK" -eq 1 ]]; then
  echo "═══════════════════════════════════════════════════════════════"
  echo "  ✓ SYNC COMPLETE — preprod is a canonical mirror of live."
  echo "    Next: run a trader-only smoke backtest on preprod and verify"
  echo "    Jul 2025 WR ~ 56% (matches phase-c-stage1 canonical baseline)."
  echo "═══════════════════════════════════════════════════════════════"
  exit 0
else
  echo "═══════════════════════════════════════════════════════════════"
  echo "  ✗ SYNC FINISHED WITH MISMATCHES — see ✗ rows above."
  echo "═══════════════════════════════════════════════════════════════"
  exit 7
fi
