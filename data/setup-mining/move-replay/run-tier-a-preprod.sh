#!/usr/bin/env bash
# Tier A only — all remaining move_atr >= 8 missed windows on PREPROD D1.
# Skips move_ids already in out-dir summary-*.json (--resume).
set -euo pipefail
cd /workspace
export TIMED_API_KEY="${TIMED_API_KEY:-${TIMED_TRADING_API_KEY:-}}"
export TIMED_API_BASE="${TIMED_API_BASE:-https://timed-trading-ingest-preprod.shashant.workers.dev}"
OUT_DIR="data/setup-mining/move-replay"
BATCH_SIZE="${BATCH_SIZE:-5}"
WRANGLER_ENV="${WRANGLER_ENV:-preprod}"
mkdir -p "$OUT_DIR"

if [ ! -x "node_modules/.bin/wrangler" ]; then
  echo "wrangler missing — run: npm install"
  exit 1
fi

LOG="$OUT_DIR/run-tier-a-preprod-$(date -u +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

run_phase() {
  local phase="Tier-A-high-atr"
  local min_atr="8"
  local batch=0
  echo ""
  echo "========== $phase start min_atr=$min_atr api=$TIMED_API_BASE wrangler=$WRANGLER_ENV $(date -u -Iseconds) =========="
  while true; do
    batch=$((batch + 1))
    echo ""
    echo "--- $phase batch $batch $(date -u -Iseconds) ---"
    set +e
    batch_log="$OUT_DIR/.batch-${phase}-${batch}.log"
    node scripts/replay-move-windows.mjs \
      --discovery-file data/move-discovery-live.json \
      --limit "$BATCH_SIZE" \
      --min-atr "$min_atr" \
      --pre-entry-days 5 \
      --wrangler-d1 "$WRANGLER_ENV" \
      --out-dir "$OUT_DIR" \
      --resume \
      2>&1 | tee "$batch_log"
    code=${PIPESTATUS[0]}
    set -e
    if grep -q '"done": true' "$batch_log"; then
      rm -f "$batch_log"
      echo "========== $phase complete $(date -u -Iseconds) =========="
      return 0
    fi
    rm -f "$batch_log"
    if [ "$code" -ne 0 ]; then
      echo "=== $phase batch $batch failed exit=$code — retry in 60s ==="
      sleep 60
      continue
    fi
    sleep 5
  done
}

echo "=== Tier A preprod replay $(date -u -Iseconds) ==="
echo "batch_size=$BATCH_SIZE out_dir=$OUT_DIR log=$LOG api=$TIMED_API_BASE"

run_phase

node scripts/aggregate-tier-replay.mjs --out-dir data/setup-mining/tiered-reliability

echo "=== Tier A preprod replay finished $(date -u -Iseconds) ===="
