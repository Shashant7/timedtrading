#!/usr/bin/env bash
# Isolated post890 vs v12 investor July re-run (reset ledger each variant).
# Waits for replay lock, reuses July trader daystate, exports per-lot JSON, runs diff.
set -euo pipefail

PRE="${PREPROD_BASE:-https://timed-trading-ingest-preprod.shashant.workers.dev}"
REPO="${REPO_ROOT:-/workspace}"
LOG="$REPO/data/trade-analysis/run-investor-post890-diff-rerun.log"
ART="$REPO/data/trade-analysis/investor-slice-2025-07-post890"
MAX_WAIT="${MAX_WAIT_SECONDS:-28800}"
POLL="${POLL_SECONDS:-60}"
API_KEY="${TIMED_API_KEY:-${TIMED_TRADING_API_KEY:-}}"

mkdir -p "$(dirname "$LOG")" "$ART"
exec > >(tee -a "$LOG") 2>&1

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

[[ -n "$API_KEY" ]] || { log "ERROR: TIMED_API_KEY required"; exit 2; }

push_slope() {
  local val="$1"
  log "Push deep_audit_investor_st_slope_gate_enabled=$val"
  curl -sS -m 60 -X POST "$PRE/timed/admin/model-config" \
    -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" \
    -d "{\"updates\":[{\"key\":\"deep_audit_investor_st_slope_gate_enabled\",\"value\":\"$val\"}]}" \
    | jq -c '{ok, written}' 2>/dev/null || true
}

export_investor_trades() {
  local out="$1"
  curl -sS -m 120 "$PRE/timed/ledger/trades?mode=investor&limit=2000&key=$API_KEY" \
    -H "X-API-Key: $API_KEY" > "$out"
  log "Exported investor ledger -> $out ($(jq -r '.trades|length // 0' "$out" 2>/dev/null || echo '?') rows)"
}

wait_lock_free() {
  log "Waiting for replay lock (max ${MAX_WAIT}s)..."
  local elapsed=0
  while [[ "$elapsed" -lt "$MAX_WAIT" ]]; do
    locked=$(curl -sS "$PRE/timed/admin/replay-lock?key=$API_KEY" -H "X-API-Key: $API_KEY" \
      | jq -r '.locked // false' 2>/dev/null || echo "true")
    if [[ "$locked" != "true" ]]; then
      log "Replay lock free after ${elapsed}s"
      return 0
    fi
    [[ $((elapsed % 300)) -eq 0 && "$elapsed" -gt 0 ]] && log "still waiting (${elapsed}s)..."
    sleep "$POLL"
    elapsed=$((elapsed + POLL))
  done
  log "ERROR: timed out waiting for replay lock"
  exit 1
}

ensure_july_daystate() {
  local d="2025-07-31"
  local ok
  ok=$(curl -sS "$PRE/timed/admin/kv/get?k=timed:replay:daystate:$d&key=$API_KEY" \
    -H "X-API-Key: $API_KEY" | jq -r '.ok // false' 2>/dev/null || echo "false")
  if [[ "$ok" == "true" ]]; then
    local n
    n=$(curl -sS "$PRE/timed/admin/kv/get?k=timed:replay:daystate:$d&key=$API_KEY" \
      -H "X-API-Key: $API_KEY" | jq -r '.value | if type=="object" then keys|length else 0 end' 2>/dev/null || echo "0")
    log "July daystate present for $d (tickers=$n)"
    [[ "$n" != "0" ]] && return 0
  fi
  log "WARN: missing Jul 31 daystate — run trader monthly-slice first"
  return 1
}

log "=== Investor post890 vs v12 isolated re-run ==="
wait_lock_free

if ! ensure_july_daystate; then
  log "=== Running trader July slice for daystate (v12 config) ==="
  cd "$REPO"
  node scripts/push-july-v12-config.mjs
  TIMED_API_KEY="$API_KEY" scripts/monthly-slice.sh --month=2025-07 \
    --run-id=phase-d-slice-2025-07-investor-diff \
    --watchdog-seconds=300 --api-base="$PRE"
fi

seed_investor_month() {
  if TIMED_API_KEY="$API_KEY" scripts/seed-investor-daystate.sh --month=2025-07 --api-base="$PRE"; then
    return 0
  fi
  log "WARN: seed pass had errors — retry single day 2025-07-15 then continue"
  TIMED_API_KEY="$API_KEY" scripts/seed-investor-daystate.sh \
    --start=2025-07-15 --end=2025-07-15 --api-base="$PRE" || true
  TIMED_API_KEY="$API_KEY" scripts/seed-investor-daystate.sh \
    --month=2025-07 --api-base="$PRE" --allow-errors
}

cd "$REPO"
log "=== Seed investor day-state ==="
seed_investor_month

log "=== Variant A: v12 baseline (slope gate OFF) ==="
node scripts/push-july-v12-config.mjs
push_slope "false"
TIMED_API_KEY="$API_KEY" scripts/investor-slice.sh --month=2025-07 \
  --run-id=investor-slice-2025-07-v12-rerun --api-base="$PRE"
export_investor_trades "$ART/trades-v12-rerun.json"

log "=== Variant B: post-#890 (slope gate ON) ==="
push_slope "true"
TIMED_API_KEY="$API_KEY" scripts/investor-slice.sh --month=2025-07 \
  --run-id=investor-slice-2025-07-post890-rerun --api-base="$PRE"
export_investor_trades "$ART/trades-post890-rerun.json"

log "=== Daystate diff analysis ==="
TIMED_API_KEY="$API_KEY" node scripts/analyze-investor-post890-july-diff.mjs

log "=== Isolated re-run complete ==="
