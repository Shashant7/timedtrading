#!/usr/bin/env bash
# Replay all remaining MISSED discovery moves (resume-safe).
# Each iteration processes up to BATCH_SIZE moves; skips move_ids in prior summaries.
set -euo pipefail
cd /workspace
export TIMED_API_KEY="${TIMED_API_KEY:-${TIMED_TRADING_API_KEY:-}}"
OUT_DIR="data/setup-mining/move-replay"
BATCH_SIZE="${BATCH_SIZE:-10}"
MIN_ATR="${MIN_ATR:-0}"
mkdir -p "$OUT_DIR"
LOG="$OUT_DIR/run-all-$(date -u +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

echo "=== move replay marathon start $(date -u -Iseconds) ==="
echo "batch_size=$BATCH_SIZE min_atr=$MIN_ATR log=$LOG"

batch=0
while true; do
  batch=$((batch + 1))
  echo ""
  echo "=== batch $batch $(date -u -Iseconds) ==="
  set +e
  out=$(node scripts/replay-move-windows.mjs \
    --discovery-file data/move-discovery-live.json \
    --limit "$BATCH_SIZE" \
    --min-atr "$MIN_ATR" \
    --pre-entry-days 5 \
    --wrangler-d1 production \
    --out-dir "$OUT_DIR" \
    --resume \
    2>&1)
  code=$?
  set -e
  echo "$out"
  if echo "$out" | grep -q '"done": true'; then
    echo "=== all moves complete $(date -u -Iseconds) ==="
    exit 0
  fi
  if [ "$code" -ne 0 ]; then
    echo "=== batch $batch failed exit=$code — retry in 60s $(date -u -Iseconds) ==="
    sleep 60
    continue
  fi
  sleep 5
done
