#!/usr/bin/env bash
# Tier B only — one best move per ticker not yet replayed (breadth / personality).
#
# Excludes tickers present in any prior summary-*.json (Tier A + earlier Tier B).
# Uses --resume on move_id (no --force-replay by default).
#
# Env:
#   TIER_B_REPLAY_SINCE     preset to resume a prior Tier B session
#   SKIP_PREFLIGHT=1        skip probe (ok after Tier A validated pipeline)
#   SKIP_EARLY_AUDIT=1      skip batch 1–5 session audits
#   BATCH_SIZE=1            moves per batch (default 1 for checkpointing)
set -euo pipefail
cd /workspace
export TIMED_API_KEY="${TIMED_API_KEY:-${TIMED_TRADING_API_KEY:-}}"
export TIMED_API_BASE="${TIMED_API_BASE:-https://timed-trading-ingest-preprod.shashant.workers.dev}"
OUT_DIR="data/setup-mining/move-replay"
BATCH_SIZE="${BATCH_SIZE:-1}"
WRANGLER_ENV="${WRANGLER_ENV:-preprod}"
SKIP_PREFLIGHT="${SKIP_PREFLIGHT:-0}"
SKIP_EARLY_AUDIT="${SKIP_EARLY_AUDIT:-0}"
EARLY_AUDIT_MAX_BATCH="${EARLY_AUDIT_MAX_BATCH:-5}"
mkdir -p "$OUT_DIR"

if [ ! -x "node_modules/.bin/wrangler" ]; then
  echo "wrangler missing — run: npm install"
  exit 1
fi

LOG="$OUT_DIR/run-tier-b-preprod-$(date -u +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

completed_tickers_csv() {
  node --input-type=module <<'NODE'
import fs from "node:fs";
const dir = process.env.OUT_DIR || "data/setup-mining/move-replay";
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

if [ -z "${TIER_B_REPLAY_SINCE:-}" ]; then
  export TIER_B_REPLAY_SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  SESSION_MOVES_AT_START=0
else
  SESSION_MOVES_AT_START="$(TIER_B_REPLAY_SINCE="$TIER_B_REPLAY_SINCE" OUT_DIR="$OUT_DIR" node --input-type=module <<'NODE'
import fs from "node:fs";
const since = Date.parse(process.env.TIER_B_REPLAY_SINCE || "");
const dir = process.env.OUT_DIR || "data/setup-mining/move-replay";
const ids = new Set();
if (Number.isFinite(since)) {
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith("summary-") && x.endsWith(".json"))) {
    try {
      const j = JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8"));
      const gen = Date.parse(j.summary?.generated_at || "");
      if (!Number.isFinite(gen) || gen < since) continue;
      for (const it of j.summary?.items || []) {
        if (it?.move_id) ids.add(String(it.move_id));
      }
    } catch (_) {}
  }
}
process.stdout.write(String(ids.size));
NODE
)"
  echo "resuming Tier B session since=$TIER_B_REPLAY_SINCE ($SESSION_MOVES_AT_START move(s) already done)"
fi

audit_session() {
  local expected="$1"
  echo ""
  echo "=== Tier B session audit (expect $expected distinct move(s), since $TIER_B_REPLAY_SINCE) ==="
  node scripts/audit-tier-a-session.mjs \
    --since "$TIER_B_REPLAY_SINCE" \
    --out-dir "$OUT_DIR" \
    --expected-moves "$expected"
}

run_phase() {
  local phase="Tier-B-one-per-ticker"
  local batch=0
  echo ""
  echo "========== $phase start min_atr=0 one-per-ticker api=$TIMED_API_BASE wrangler=$WRANGLER_ENV $(date -u -Iseconds) =========="
  while true; do
    batch=$((batch + 1))
    echo ""
    echo "--- $phase batch $batch $(date -u -Iseconds) ---"
    local extra=(--one-per-ticker --quality-gate)
    local exclude
    exclude="$(OUT_DIR="$OUT_DIR" completed_tickers_csv)"
    if [ -n "$exclude" ]; then
      extra+=(--exclude-ticker "$exclude")
      echo "exclude tickers already replayed: $(echo "$exclude" | tr ',' ' ' | wc -w) symbol(s)"
    fi
    set +e
    batch_log="$OUT_DIR/.batch-${phase}-${batch}.log"
    node scripts/replay-move-windows.mjs \
      --discovery-file data/move-discovery-live.json \
      --limit "$BATCH_SIZE" \
      --min-atr 0 \
      --pre-entry-days 5 \
      --wrangler-d1 "$WRANGLER_ENV" \
      --out-dir "$OUT_DIR" \
      --resume \
      "${extra[@]}" \
      2>&1 | tee "$batch_log"
    code=${PIPESTATUS[0]}
    set -e
    if [ "$code" -eq 2 ]; then
      echo "=== ABORT: quality gate failed on batch $batch — fix before continuing ==="
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
      audit_session "$((batch + SESSION_MOVES_AT_START))" || exit 3
    fi
    sleep 5
  done
}

echo "=== Tier B preprod replay $(date -u -Iseconds) ==="
echo "batch_size=$BATCH_SIZE out_dir=$OUT_DIR log=$LOG api=$TIMED_API_BASE"
echo "replay_since=$TIER_B_REPLAY_SINCE (Tier B session checkpoint)"

if [ "$SKIP_PREFLIGHT" != "1" ]; then
  echo "=== Preflight probe (sequence_trail payload) ==="
  node scripts/preflight-tier-a-replay.mjs
fi

run_phase

node scripts/aggregate-tier-replay.mjs --out-dir data/setup-mining/tiered-reliability

echo "=== Tier B preprod replay finished $(date -u -Iseconds) ===="
