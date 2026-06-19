#!/usr/bin/env bash
# Tiered move replay on PREPROD D1 (not production).
#
# Tier A: all remaining move_atr >= 8 windows (tradable misses).
# Tier B: one best move per ticker not yet replayed (breadth / personality).
#
# Skips move_ids already in out-dir summary-*.json (--resume).
set -euo pipefail
cd /workspace
export TIMED_API_KEY="${TIMED_API_KEY:-${TIMED_TRADING_API_KEY:-}}"
OUT_DIR="data/setup-mining/move-replay"
BATCH_SIZE="${BATCH_SIZE:-10}"
WRANGLER_ENV="${WRANGLER_ENV:-preprod}"
mkdir -p "$OUT_DIR"
LOG="$OUT_DIR/run-tiered-preprod-$(date -u +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

completed_tickers_csv() {
  node --input-type=module <<'NODE'
import fs from "node:fs";
const dir = "data/setup-mining/move-replay";
const tickers = new Set();
if (fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith("summary-") || !f.endsWith(".json")) continue;
    try {
      for (const it of JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")).summary?.items || []) {
        if (it?.ticker) tickers.add(String(it.ticker).toUpperCase());
      }
    } catch (_) {}
  }
}
process.stdout.write([...tickers].sort().join(","));
NODE
}

run_phase() {
  local phase="$1"
  local min_atr="$2"
  local mode="${3:-}" # "one-per-ticker" or empty
  local batch=0
  echo ""
  echo "========== $phase start min_atr=$min_atr wrangler=$WRANGLER_ENV $(date -u -Iseconds) =========="
  while true; do
    batch=$((batch + 1))
    echo ""
    echo "--- $phase batch $batch $(date -u -Iseconds) ---"
    local extra=()
    if [ "$mode" = "one-per-ticker" ]; then
      extra+=(--one-per-ticker)
      local exclude
      exclude="$(completed_tickers_csv)"
      if [ -n "$exclude" ]; then
        extra+=(--exclude-ticker "$exclude")
        echo "exclude ${exclude//,/ } (already replayed tickers)"
      fi
    fi
    set +e
    out=$(node scripts/replay-move-windows.mjs \
      --discovery-file data/move-discovery-live.json \
      --limit "$BATCH_SIZE" \
      --min-atr "$min_atr" \
      --pre-entry-days 5 \
      --wrangler-d1 "$WRANGLER_ENV" \
      --out-dir "$OUT_DIR" \
      --resume \
      "${extra[@]}" \
      2>&1)
    code=$?
    set -e
    echo "$out"
    if echo "$out" | grep -q '"done": true'; then
      echo "========== $phase complete $(date -u -Iseconds) =========="
      return 0
    fi
    if [ "$code" -ne 0 ]; then
      echo "=== $phase batch $batch failed exit=$code — retry in 60s ==="
      sleep 60
      continue
    fi
    sleep 5
  done
}

echo "=== tiered preprod replay $(date -u -Iseconds) ==="
echo "batch_size=$BATCH_SIZE out_dir=$OUT_DIR log=$LOG"

# Tier A: every remaining high-ATR miss (includes 2nd moves on same name).
run_phase "Tier-A-high-atr" "8"

# Tier B: one move per ticker with no prior replay.
run_phase "Tier-B-one-per-ticker" "0" "one-per-ticker"

echo "=== tiered preprod replay finished $(date -u -Iseconds) ==="
