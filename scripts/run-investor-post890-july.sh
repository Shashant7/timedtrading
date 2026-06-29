#!/usr/bin/env bash
# Post-#890 July 2025 investor slice on pre-prod.
# Waits for replay lock (e.g. v13 block-chain slice), deploys preprod bundle,
# seeds monthly_bundle, runs investor-slice --no-reset.
set -euo pipefail

PRE="${PREPROD_BASE:-https://timed-trading-ingest-preprod.shashant.workers.dev}"
REPO="${REPO_ROOT:-/workspace}"
LOG="$REPO/data/trade-analysis/run-investor-post890-july.log"
RUN_ID="investor-slice-2025-07-post890"
MAX_WAIT="${MAX_WAIT_SECONDS:-28800}"
POLL="${POLL_SECONDS:-60}"
API_KEY="${TIMED_API_KEY:-${TIMED_TRADING_API_KEY:-}}"

mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

[[ -n "$API_KEY" ]] || { log "ERROR: TIMED_API_KEY required"; exit 2; }

log "=== Post-#890 investor July slice ==="
log "Waiting for replay lock (max ${MAX_WAIT}s, poll ${POLL}s)..."

elapsed=0
while [[ "$elapsed" -lt "$MAX_WAIT" ]]; do
  locked=$(curl -sS "$PRE/timed/admin/replay-lock?key=$API_KEY" -H "X-API-Key: $API_KEY" \
    | jq -r '.locked // false' 2>/dev/null || echo "true")
  if [[ "$locked" != "true" ]]; then
    log "Replay lock free after ${elapsed}s"
    break
  fi
  [[ $((elapsed % 300)) -eq 0 && "$elapsed" -gt 0 ]] && log "still waiting (${elapsed}s) lock held..."
  sleep "$POLL"
  elapsed=$((elapsed + POLL))
done

if [[ "$elapsed" -ge "$MAX_WAIT" ]]; then
  log "ERROR: timed out waiting for replay lock"
  exit 1
fi

log "=== Deploy preprod worker (#890 bundle) ==="
cd "$REPO"
node scripts/embed-dashboard.js
cd worker
../node_modules/.bin/wrangler deploy --env=preprod --var "ENGINE_GIT_SHA:$(git -C .. rev-parse --short HEAD)" 2>&1 | tail -8

log "=== Verify h4_timing on preprod ==="
curl -sS -m 180 -X POST "$PRE/timed/investor/compute?key=$API_KEY" -H "X-API-Key: $API_KEY" >/dev/null || true
sleep 3
ht=$(curl -sS "$PRE/timed/investor/scores?key=$API_KEY" -H "X-API-Key: $API_KEY" \
  | jq -r '[.scores[]? | select(.h4_timing != null)] | length' 2>/dev/null || echo "0")
log "scores with h4_timing: $ht"
[[ "$ht" != "0" ]] || log "WARN: h4_timing not visible yet — continuing (replay path may still have #890 code)"

log "=== Phase 1: seed investor day-state (July 2025) ==="
cd "$REPO"
TIMED_API_KEY="$API_KEY" scripts/seed-investor-daystate.sh --month=2025-07 --api-base="$PRE"

log "=== Phase 2: investor slice (no reset, month-end close) ==="
TIMED_API_KEY="$API_KEY" scripts/investor-slice.sh --month=2025-07 \
  --run-id="$RUN_ID" --no-reset --api-base="$PRE"

log "=== Post-#890 investor slice complete ==="
