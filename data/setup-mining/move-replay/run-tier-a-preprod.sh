#!/usr/bin/env bash
# Tier A only — all remaining move_atr >= 8 missed windows on PREPROD D1.
#
# Re-run uses --force-replay + --replay-since session checkpoint so each batch
# advances to the next move. Preflight + per-move quality gates + early session
# audits (batches 1–5) catch scheduling loops within minutes, not hours.
#
# Env:
#   FORCE_REPLAY=1       default — re-process all moves (ignore pre-session summaries)
#   SKIP_PREFLIGHT=1     skip one-day probe (not recommended)
#   SKIP_EARLY_AUDIT=1   skip batch 1–5 session audits (not recommended)
#   BATCH_SIZE=1         moves per batch (default 1 for checkpointing)
set -euo pipefail
cd /workspace
export TIMED_API_KEY="${TIMED_API_KEY:-${TIMED_TRADING_API_KEY:-}}"
export TIMED_API_BASE="${TIMED_API_BASE:-https://timed-trading-ingest-preprod.shashant.workers.dev}"
OUT_DIR="data/setup-mining/move-replay"
BATCH_SIZE="${BATCH_SIZE:-1}"
WRANGLER_ENV="${WRANGLER_ENV:-preprod}"
FORCE_REPLAY="${FORCE_REPLAY:-1}"
SKIP_PREFLIGHT="${SKIP_PREFLIGHT:-0}"
SKIP_EARLY_AUDIT="${SKIP_EARLY_AUDIT:-0}"
EARLY_AUDIT_MAX_BATCH="${EARLY_AUDIT_MAX_BATCH:-5}"
mkdir -p "$OUT_DIR"

if [ ! -x "node_modules/.bin/wrangler" ]; then
  echo "wrangler missing — run: npm install"
  exit 1
fi

LOG="$OUT_DIR/run-tier-a-preprod-$(date -u +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

export TIER_A_REPLAY_SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

REPLAY_EXTRA=()
if [ "$FORCE_REPLAY" = "1" ]; then
  REPLAY_EXTRA+=(--force-replay)
fi
REPLAY_EXTRA+=(--quality-gate --replay-since "$TIER_A_REPLAY_SINCE")

audit_session() {
  local expected="$1"
  echo ""
  echo "=== Session audit (expect $expected distinct move(s), since $TIER_A_REPLAY_SINCE) ==="
  node scripts/audit-tier-a-session.mjs \
    --since "$TIER_A_REPLAY_SINCE" \
    --out-dir "$OUT_DIR" \
    --expected-moves "$expected"
}

run_phase() {
  local phase="Tier-A-high-atr"
  local min_atr="8"
  local batch=0
  echo ""
  echo "========== $phase start min_atr=$min_atr api=$TIMED_API_BASE wrangler=$WRANGLER_ENV force_replay=$FORCE_REPLAY $(date -u -Iseconds) =========="
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
      "${REPLAY_EXTRA[@]}" \
      2>&1 | tee "$batch_log"
    code=${PIPESTATUS[0]}
    set -e
    if [ "$code" -eq 2 ]; then
      echo "=== ABORT: quality gate failed on batch $batch — fix preprod payload before continuing ==="
      exit 2
    fi
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
    if [ "$SKIP_EARLY_AUDIT" != "1" ] && [ "$batch" -le "$EARLY_AUDIT_MAX_BATCH" ]; then
      audit_session "$batch" || exit 3
    fi
    sleep 5
  done
}

echo "=== Tier A preprod replay $(date -u -Iseconds) ==="
echo "batch_size=$BATCH_SIZE out_dir=$OUT_DIR log=$LOG api=$TIMED_API_BASE force_replay=$FORCE_REPLAY"
echo "replay_since=$TIER_A_REPLAY_SINCE (force-replay session checkpoint)"

if [ "$SKIP_PREFLIGHT" != "1" ]; then
  echo "=== Preflight probe (sequence_trail payload) ==="
  node scripts/preflight-tier-a-replay.mjs
fi

run_phase

node scripts/aggregate-tier-replay.mjs --out-dir data/setup-mining/tiered-reliability

echo "=== Tier A preprod replay finished $(date -u -Iseconds) ===="
