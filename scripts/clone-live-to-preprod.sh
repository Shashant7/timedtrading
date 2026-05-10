#!/usr/bin/env bash
# Phase 3.7 (2026-05-09) — One-time clone of live → preprod.
#
# Purpose: bootstrap the pre-prod environment with the configuration +
# day-state KV needed for backtest replays, WITHOUT cloning live trader
# state. Trades / positions / account_ledger start empty on preprod by
# design — backtest replays populate them.
#
# What gets cloned:
#   D1:
#     - model_config        (all daCfg / experiment flags)
#     - sector_map          (sector classification reference)
#     - tickers / ticker_profiles  (universe + character profiles)
#     - promoted_trade_datasets    (promoted dataset metadata only,
#                                    not the trades themselves)
#   KV:
#     - timed:replay:daystate:*    (218 day-state blobs from Phase C)
#     - timed:sector_map           (sector classification)
#     - phase-c:*                  (Phase C config blobs)
#     - timed:fundamentals_v2:*    (fundamentals cache)
#
# What does NOT get cloned (intentional):
#   - trades, account_ledger, investor_positions, investor_lots,
#     direction_accuracy, backtest_run_trades, trade_events,
#     timed_trail
#   - Any KV under timed:trades:, timed:portfolio:, timed:activity:
#
# Usage:
#   TIMED_API_KEY=... bash scripts/clone-live-to-preprod.sh
#
# Idempotent — re-running upserts model_config rows, no duplicates.
# Safe to run multiple times.

set -uo pipefail
LIVE_BASE="${LIVE_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
PREPROD_BASE="${PREPROD_BASE:-https://timed-trading-ingest-preprod.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:-${TIMED_TRADING_API_KEY:-}}"
if [[ -z "$API_KEY" ]]; then
  echo "ERROR: TIMED_API_KEY env required (worker admin auth)" >&2
  exit 2
fi

echo "═══════════════════════════════════════════════════════════════"
echo "  CLONE LIVE → PREPROD"
echo "  live:    $LIVE_BASE"
echo "  preprod: $PREPROD_BASE"
echo "═══════════════════════════════════════════════════════════════"

# 1. Verify both environments are reachable.
echo
echo "[1/5] Checking reachability..."
LIVE_OK=$(curl -sS -m 10 "$LIVE_BASE/timed/admin/replay-lock?key=$API_KEY" 2>&1 | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok','false'))" 2>/dev/null || echo "false")
PRE_OK=$(curl -sS -m 10 "$PREPROD_BASE/timed/admin/replay-lock?key=$API_KEY" 2>&1 | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok','false'))" 2>/dev/null || echo "false")
echo "  live: $LIVE_OK    preprod: $PRE_OK"
if [[ "$LIVE_OK" != "True" ]]; then
  echo "ERROR: live not reachable — check API_KEY and LIVE_BASE" >&2
  exit 3
fi
if [[ "$PRE_OK" != "True" ]]; then
  echo "ERROR: preprod not reachable — has 'wrangler deploy --env=preprod' been run?" >&2
  exit 3
fi

# 2. Apply trend-hold schema on preprod (self-healing schema endpoint).
echo
echo "[2/5] Applying trend-hold + base schema on preprod..."
curl -sS -X POST "$PREPROD_BASE/timed/admin/ensure-trend-hold-schema?key=$API_KEY" \
  | python3 -m json.tool | head -20

# 3. Clone model_config rows from live → preprod.
echo
echo "[3/5] Cloning model_config (full dump → restore via wrangler d1)..."
#
# 2026-05-10 (Phase 3.9): switched from "12 explicit keys" partial-clone
# to a full dump-and-restore via the wrangler d1 CLI. The earlier partial
# approach silently produced a 5-row preprod model_config which then
# fed the DO backtest path (`backtest-runner-do.js:165 snapshotConfig`),
# pinning a 5-row backtest_run_config — and `loadReplayRuntimeConfig`
# (worker/replay-runtime-setup.js:677) treats partial pinned snapshots
# as authoritative without per-key fallback. Net effect: ~85 deep_audit_*
# keys silently fell through to hardcoded code defaults, producing the
# 19% WR observed on `phase-c-stage2-th-do-v3-jul2025-may2026`.
#
# Full diagnostic: tasks/phase-c/WR_DIAGNOSTIC_2026-05-10.md
#
# Requirements: CLOUDFLARE_API_TOKEN must be set (or CLOUDFLARE_TOKEN is
# auto-promoted below). Run from repo root.

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -n "${CLOUDFLARE_TOKEN:-}" ]]; then
  export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_TOKEN"
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "ERROR: CLOUDFLARE_API_TOKEN env required for wrangler d1 access" >&2
  exit 4
fi

DUMP_JSON=$(mktemp /tmp/live-model-config-dump.XXXXXX.json)
SEED_SQL=$(mktemp /tmp/preprod-model-config-seed.XXXXXX.sql)
trap "rm -f $DUMP_JSON $SEED_SQL" EXIT

echo "  3a. dumping live model_config to $DUMP_JSON ..."
npx wrangler d1 execute timed-trading-ledger --remote --json \
  --command="SELECT config_key, config_value, description FROM model_config ORDER BY config_key" \
  > "$DUMP_JSON" 2>&1
TOTAL_KEYS=$(jq '.[0].results | length' "$DUMP_JSON" 2>/dev/null || echo "0")
echo "     dumped $TOTAL_KEYS rows from live model_config"
if [[ "$TOTAL_KEYS" -lt 100 ]]; then
  echo "     ERROR: live model_config dump returned $TOTAL_KEYS rows (expected >300)" >&2
  echo "     (head of dump for inspection):" >&2
  head -40 "$DUMP_JSON" >&2
  exit 5
fi

echo "  3b. building INSERT OR REPLACE SQL ..."
NOW_MS=$(date +%s)000
jq -r --arg ts "$NOW_MS" '.[0].results[] | "INSERT OR REPLACE INTO model_config (config_key, config_value, description, updated_at, updated_by) VALUES (" +
  "'"'"'" + (.config_key | gsub("'"'"'"; "''"))   + "'"'"'," +
  "'"'"'" + ((.config_value // "") | tostring | gsub("'"'"'"; "''")) + "'"'"'," +
  "'"'"'" + ((.description // "")   | gsub("'"'"'"; "''"))   + "'"'"'," +
  ($ts) + "," +
  "'"'"'cloned-from-live'"'"');"' "$DUMP_JSON" > "$SEED_SQL"
SQL_LINES=$(wc -l < "$SEED_SQL")
echo "     built $SQL_LINES INSERT statements"

echo "  3c. applying seed to preprod model_config ..."
npx wrangler d1 execute timed-trading-ledger-preprod --remote --file="$SEED_SQL" 2>&1 | tail -10

echo "  3d. verifying preprod model_config row count ..."
PREPROD_COUNT=$(npx wrangler d1 execute timed-trading-ledger-preprod --remote --json \
  --command="SELECT COUNT(*) AS n FROM model_config" 2>&1 \
  | jq -r '.[0].results[0].n' 2>/dev/null || echo "0")
echo "     preprod model_config now has $PREPROD_COUNT rows"
if [[ "$PREPROD_COUNT" -lt 100 ]]; then
  echo "     ERROR: preprod model_config has $PREPROD_COUNT rows after clone (expected ~$TOTAL_KEYS)" >&2
  exit 6
fi

# 3e. Re-apply preprod-specific experiment overrides on top.
# These are the 3 keys we want to differ from live so that backtests
# test the TH module rather than mirror live's dark-feature flag.
echo "  3e. applying preprod TH experiment overrides ..."
OVR_PAYLOAD=$(python3 -c "
import json
updates = [
  {'key': 'deep_audit_trend_hold_enabled', 'value': 'true', 'description': 'preprod override — TH on for backtest validation (live default false)'},
  {'key': 'deep_audit_trend_hold_max_positions', 'value': 6, 'description': 'preprod override — max 6 simultaneous TH positions'},
]
print(json.dumps({'updates': updates}))
")
OVR_RES=$(curl -sS -X POST "$PREPROD_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "content-type: application/json" \
  -d "$OVR_PAYLOAD")
echo "     $OVR_RES"

# 4. Clone day-state KV blobs from live → preprod.
#
# These are the timed:replay:daystate:YYYY-MM-DD keys produced by the
# original Phase C trader run. With them on preprod, the investor
# replay path becomes runnable without re-replaying from raw candles.
#
# WARNING: 218 daystate keys × ~500KB each = ~100MB of KV writes. Not
# free but well under the KV quota for the pro tier.
echo
echo "[4/5] Cloning day-state KV (218 blobs)..."
echo "  (this uses the kv/get + kv/put admin endpoints; ~5 min wall time)"
DATES=()
START="2025-07-01"
END="2026-05-08"
CUR="$START"
while [[ "$CUR" < "$END" || "$CUR" == "$END" ]]; do
  DOW=$(date -d "$CUR" "+%u")
  if [[ "$DOW" -lt 6 ]]; then
    DATES+=("$CUR")
  fi
  CUR=$(date -d "$CUR + 1 day" "+%Y-%m-%d")
done
echo "  total trading days to clone: ${#DATES[@]}"

CLONED=0
SKIPPED=0
ERRS=0
TMPFILE=$(mktemp /tmp/preprod-blob.XXXXXX.json)
trap "rm -f $TMPFILE" EXIT
for d in "${DATES[@]}"; do
  KEY="timed:replay:daystate:$d"
  # Fetch from live INTO A FILE (day-state blobs are ~500KB; too large
  # for shell variables on most systems — "Argument list too long").
  curl -sS -m 60 -o "$TMPFILE" "$LIVE_BASE/timed/admin/kv/get?k=$KEY&key=$API_KEY"
  HAS_VAL=$(python3 -c "
import sys, json
try:
    with open('$TMPFILE') as f: d = json.load(f)
    print('y' if d.get('value') else 'n')
except: print('?')")
  if [[ "$HAS_VAL" != "y" ]]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  # Push to preprod via kv/put — use --data-binary @file to avoid the
  # shell arg-length limit. The endpoint accepts the kv/get-style
  # response shape (parses .value or .raw).
  PUT_HTTP=$(curl -sS -m 60 -X POST "$PREPROD_BASE/timed/admin/kv/put?k=$KEY&key=$API_KEY" \
    -H "content-type: application/json" \
    --data-binary "@$TMPFILE" \
    -w "\n%{http_code}" 2>&1 | tail -1)
  if [[ "$PUT_HTTP" == "200" ]]; then
    CLONED=$((CLONED + 1))
  else
    ERRS=$((ERRS + 1))
    if [[ "$ERRS" -le 3 ]]; then
      echo "  $d ERR: HTTP $PUT_HTTP"
    fi
  fi
  if (( CLONED > 0 && CLONED % 25 == 0 )); then
    echo "  progress: $CLONED cloned, $SKIPPED skipped, $ERRS errors"
  fi
  sleep 0.05
done
echo "  done: cloned=$CLONED skipped=$SKIPPED errors=$ERRS"

# 5. Sanity check: a single day-state on preprod should be queryable.
echo
echo "[5/5] Sanity check..."
SAMPLE=$(curl -sS "$PREPROD_BASE/timed/admin/kv/get?k=timed:replay:daystate:2025-07-15&key=$API_KEY" 2>&1)
HAS_AAPL=$(echo "$SAMPLE" | python3 -c "
import sys, json
try:
  v = json.load(sys.stdin).get('value')
  print('y' if v and isinstance(v, dict) and 'AAPL' in v else 'n')
except: print('parse_err')")
echo "  preprod has 2025-07-15 day-state with AAPL: $HAS_AAPL"

echo
echo "═══════════════════════════════════════════════════════════════"
echo "  CLONE COMPLETE"
echo "  Next: run a destructive backtest on preprod via:"
echo "    API_BASE=$PREPROD_BASE bash scripts/full-backtest.sh \\"
echo "      --label=phase-c-stage2-th-jul2025-may2026 \\"
echo "      --keep-open-at-end \\"
echo "      2025-07-01 2026-05-08 20"
echo "═══════════════════════════════════════════════════════════════"
