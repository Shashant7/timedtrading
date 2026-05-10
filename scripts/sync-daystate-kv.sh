#!/usr/bin/env bash
# Phase 3.9 / preprod-fidelity (2026-05-10).
#
# Fast parallel clone of `timed:replay:daystate:*` KV blobs from live → preprod.
# Overwrites whatever preprod has — preprod's blobs get mutated by every
# backtest run, so the canonical-mirror snapshot decays over time.
#
# Usage:
#   TIMED_API_KEY=... bash scripts/sync-daystate-kv.sh
#
# Env overrides:
#   LIVE_BASE       default: live worker URL
#   PREPROD_BASE    default: preprod worker URL
#   CONCURRENCY     default: 4 parallel clones
#   PREFIX          default: timed:replay:daystate:
#
# Idempotent — safe to re-run.

set -uo pipefail
LIVE_BASE="${LIVE_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
PREPROD_BASE="${PREPROD_BASE:-https://timed-trading-ingest-preprod.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:-${TIMED_TRADING_API_KEY:-}}"
CONCURRENCY="${CONCURRENCY:-4}"
PREFIX="${PREFIX:-timed:replay:daystate:}"

if [[ -z "$API_KEY" ]]; then
  echo "ERROR: TIMED_API_KEY env required" >&2
  exit 2
fi

echo "═══════════════════════════════════════════════════════════════"
echo "  SYNC DAY-STATE KV: live → preprod"
echo "  prefix:      $PREFIX"
echo "  concurrency: $CONCURRENCY"
echo "  live:        $LIVE_BASE"
echo "  preprod:     $PREPROD_BASE"
echo "═══════════════════════════════════════════════════════════════"

# 1. List all live keys under prefix.
echo
echo "[1/3] Listing live keys..."
LIVE_KEYS=$(curl -sS "$LIVE_BASE/timed/admin/kv/list?prefix=$PREFIX&limit=1000&key=$API_KEY" 2>&1)
LIVE_COUNT=$(echo "$LIVE_KEYS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('keys',[])))")
LIVE_COMPLETE=$(echo "$LIVE_KEYS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('list_complete'))")
echo "  live: $LIVE_COUNT keys (list_complete=$LIVE_COMPLETE)"
MIN_KEYS="${MIN_KEYS:-1}"
if [[ "$LIVE_COUNT" -lt "$MIN_KEYS" ]]; then
  echo "ERROR: live returned $LIVE_COUNT keys (expected >=$MIN_KEYS). Check API_KEY / network." >&2
  exit 3
fi
if [[ "$LIVE_COUNT" -eq 0 ]]; then
  echo "  (no live keys under prefix — nothing to clone, exiting cleanly)"
  exit 0
fi

# 2. Build the work list.
KEYS_FILE=$(mktemp /tmp/daystate-keys.XXXXXX)
trap "rm -f $KEYS_FILE" EXIT
echo "$LIVE_KEYS" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for k in d.get('keys',[]):
    print(k['name'])
" > "$KEYS_FILE"
TOTAL=$(wc -l < "$KEYS_FILE")
echo "  work list: $TOTAL keys"

# 3. Parallel clone via xargs. Each worker:
#    - GET from live (kv/get returns {value: <obj>, raw: <str>})
#    - POST to preprod (kv/put accepts the same envelope; --data-binary @file)
echo
echo "[2/3] Cloning ($CONCURRENCY parallel)..."
CLONE_LOG=$(mktemp /tmp/daystate-clone.XXXXXX.log)
trap "rm -f $KEYS_FILE $CLONE_LOG" EXIT

clone_one() {
  local key="$1"
  local idx="$2"
  local total="$3"
  local tmp=$(mktemp /tmp/blob.XXXXXX.json)
  # GET from live
  local get_http=$(curl -sS -m 90 -o "$tmp" -w "%{http_code}" \
    "$LIVE_BASE/timed/admin/kv/get?k=$key&key=$API_KEY" 2>&1)
  if [[ "$get_http" != "200" ]]; then
    rm -f "$tmp"
    echo "ERR_GET $key http=$get_http"
    return 1
  fi
  local sz=$(wc -c < "$tmp")
  if [[ "$sz" -lt "${MIN_BYTES:-200}" ]]; then
    rm -f "$tmp"
    echo "SKIP $key size=$sz"
    return 0
  fi
  # PUT to preprod
  local put_http=$(curl -sS -m 90 -o /dev/null -w "%{http_code}" \
    -X POST "$PREPROD_BASE/timed/admin/kv/put?k=$key&key=$API_KEY" \
    -H "content-type: application/json" \
    --data-binary "@$tmp" 2>&1)
  rm -f "$tmp"
  if [[ "$put_http" != "200" ]]; then
    echo "ERR_PUT $key http=$put_http"
    return 1
  fi
  echo "OK $key ${sz}B [$idx/$total]"
}
export -f clone_one
export LIVE_BASE PREPROD_BASE API_KEY MIN_BYTES

# Use xargs to parallelize. Each line of KEYS_FILE becomes a clone_one call.
# We need to pass index info for progress; do that by piping nl through xargs.
cat "$KEYS_FILE" | nl -ba -nln | \
  xargs -P "$CONCURRENCY" -I{} bash -c '
    line="{}"; idx=$(echo "$line" | awk "{print \$1}"); key=$(echo "$line" | awk "{print \$2}")
    clone_one "$key" "$idx" "'$TOTAL'"
  ' > "$CLONE_LOG" 2>&1 &
WORKER_PID=$!

# Watch progress in main process
while kill -0 $WORKER_PID 2>/dev/null; do
  sleep 5
  if [[ -s "$CLONE_LOG" ]]; then
    OK=$(grep -c '^OK ' "$CLONE_LOG" 2>/dev/null | head -1)
    SKIP=$(grep -c '^SKIP ' "$CLONE_LOG" 2>/dev/null | head -1)
    ERR=$(grep -c '^ERR' "$CLONE_LOG" 2>/dev/null | head -1)
    echo "  progress: OK=${OK:-0} SKIP=${SKIP:-0} ERR=${ERR:-0}"
  fi
done
wait $WORKER_PID
EXIT_CODE=$?

OK=$(grep -c '^OK ' "$CLONE_LOG" 2>/dev/null | head -1)
SKIP=$(grep -c '^SKIP ' "$CLONE_LOG" 2>/dev/null | head -1)
ERR=$(grep -c '^ERR' "$CLONE_LOG" 2>/dev/null | head -1)
OK=${OK:-0}; SKIP=${SKIP:-0}; ERR=${ERR:-0}
echo "  done: OK=$OK SKIP=$SKIP ERR=$ERR (xargs_exit=$EXIT_CODE)"

if [[ "$ERR" -gt 0 ]]; then
  echo
  echo "  errors (head 10):"
  grep '^ERR' "$CLONE_LOG" | head -10
fi

# 4. Sanity check.
echo
echo "[3/3] Sanity check..."
SAMPLE=$(curl -sS "$PREPROD_BASE/timed/admin/kv/list?prefix=$PREFIX&limit=1000&key=$API_KEY" 2>&1)
PRE_COUNT=$(echo "$SAMPLE" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('keys',[])))")
echo "  preprod now has $PRE_COUNT $PREFIX keys (live had $LIVE_COUNT)"

echo
echo "═══════════════════════════════════════════════════════════════"
echo "  DONE."
echo "═══════════════════════════════════════════════════════════════"
