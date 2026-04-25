#!/usr/bin/env bash
# scripts/continuous-slice.sh
#
# ONE continuous backtest across a date range (e.g. Jul 2025 → Apr 2026)
# under a single run_id, single replay-lock, single clean-slate reset.
#
# Problem this solves:
#   Running month-by-month with monthly-slice.sh means:
#     - N separate runs_register calls
#     - N separate lock acquire/release cycles
#     - N clean-slate resets between months (wipes state you may want)
#     - N fragile transitions where stalls can kill the chain
#   The multi-month wrapper tried to paper over this with auto-salvage
#   but the session-1 → session-2 lock-vanishing bug shows the
#   architecture is fragile.
#
# This script instead:
#   - Acquires ONE replay lock for the whole Jul→Apr span
#   - Registers ONE run
#   - Does ONE clean-slate reset at the very start
#   - Loops every trading day across the entire range
#   - Writes checkpoint per day for resumability
#   - On stall: the OUTER coreutils `timeout` + `assert_lock_still_ours`
#     handles it; auto-retry is at the per-day level
#   - Periodically writes the "current month" marker so you can see
#     progress cleanly
#
# Positional runs/finalize at the END produces one archive row with
# all trades. For per-month reports we split trades.json by entry_ts
# after the fact.
#
# Usage:
#   TIMED_API_KEY=... scripts/continuous-slice.sh \
#     --start=2025-07-01 \
#     --end=2026-04-30 \
#     --run-id=phase-f-continuous-v6 \
#     --tickers=tier1-tier2 \
#     [--watchdog-seconds=420] \
#     [--resume]

set -euo pipefail

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

START_DATE=""
END_DATE=""
RUN_ID=""
TICKERS_SPEC="tier1-tier2"
WATCHDOG_SECONDS=420
RESUME=false
BLOCK_CHAIN=true

for arg in "$@"; do
  case "$arg" in
    --start=*) START_DATE="${arg#*=}" ;;
    --end=*) END_DATE="${arg#*=}" ;;
    --run-id=*) RUN_ID="${arg#*=}" ;;
    --tickers=*) TICKERS_SPEC="${arg#*=}" ;;
    --watchdog-seconds=*) WATCHDOG_SECONDS="${arg#*=}" ;;
    --resume) RESUME=true ;;
    --no-block-chain) BLOCK_CHAIN=false ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

[[ -z "$START_DATE" ]] && { echo "Missing --start=YYYY-MM-DD"; exit 2; }
[[ -z "$END_DATE" ]] && { echo "Missing --end=YYYY-MM-DD"; exit 2; }
[[ -z "$RUN_ID" ]] && { echo "Missing --run-id=..."; exit 2; }

# Resolve ticker universe (same expansion as monthly-slice.sh)
case "$TICKERS_SPEC" in
  tier1-tier2)
    TICKERS="SPY,QQQ,IWM,AAPL,MSFT,GOOGL,AMZN,META,NVDA,TSLA,AGQ,CDNS,ETN,FIX,GRNY,HUBS,IESC,MTZ,ON,PH,RIOT,SGI,SWK,XLY"
    ;;
  tier1)
    TICKERS="SPY,QQQ,IWM,AAPL,MSFT,GOOGL,AMZN,META,NVDA,TSLA"
    ;;
  phase-d-40)
    TICKERS=$(tr '\n' ',' < "$ROOT/configs/backtest-universe-phase-d-40.txt" | sed 's/,$//')
    ;;
  @*)
    TICKERS=$(tr '\n' ',' < "${TICKERS_SPEC#@}" | sed 's/,$//')
    ;;
  *) TICKERS="$TICKERS_SPEC" ;;
esac

ARTIFACT_DIR="${ROOT}/data/trade-analysis/${RUN_ID}"
CHECKPOINT_FILE="${ARTIFACT_DIR}/continuous.checkpoint.json"
LOG_FILE="${ARTIFACT_DIR}/continuous.log"
# Heartbeat file — touched on every successful HTTP response (per batch, not
# per day). The watchdog polls this via `stat` only, so it can't be starved
# by log-file contention or grep-on-growing-tee scenarios. This is the
# authoritative "are we making progress?" signal.
HEARTBEAT_FILE="${ARTIFACT_DIR}/continuous.heartbeat"

mkdir -p "$ARTIFACT_DIR"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"; }
heartbeat() { touch "$HEARTBEAT_FILE" 2>/dev/null || true; }

# Build NYSE holiday set + weekend filter — mirrors monthly-slice.sh logic.
declare -a ALL_DAYS
build_trading_days() {
  python3 <<EOF
from datetime import date, timedelta
start = date.fromisoformat("$START_DATE")
end = date.fromisoformat("$END_DATE")
# NYSE holidays for 2025-2026 covered by our span
holidays = {
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
}
d = start
while d <= end:
  s = d.isoformat()
  if d.weekday() < 5 and s not in holidays:
    print(s)
  d += timedelta(days=1)
EOF
}

mapfile -t ALL_DAYS < <(build_trading_days)
TOTAL=${#ALL_DAYS[@]}
heartbeat  # initial heartbeat so watchdog sees a fresh mtime on launch
log "=== continuous-slice: $RUN_ID ==="
log "    range=${START_DATE}..${END_DATE}  trading_days=${TOTAL}"
log "    tickers(24)=${TICKERS}"
log "    watchdog=${WATCHDOG_SECONDS}s  resume=${RESUME}  block_chain=${BLOCK_CHAIN}"

# Script-level flock to prevent parallel invocations
SCRIPT_LOCK_DIR="${ROOT}/data/.locks"
SCRIPT_LOCK_FILE="${SCRIPT_LOCK_DIR}/continuous-${RUN_ID}.lock"
mkdir -p "$SCRIPT_LOCK_DIR"
exec 9>"$SCRIPT_LOCK_FILE"
if ! flock -n 9; then
  echo "Another continuous-slice run for $RUN_ID is active" >&2
  exit 1
fi

# Lock tag — simple and searchable. Include run_id so foreign writers are
# easy to identify. The worker echoes the `reason` query param into the
# stored lock string with a timestamp suffix.
LOCK_REASON_TAG="continuous_${RUN_ID}"
# Actual lock value as stored by the worker (we learn it on acquire)
REPLAY_LOCK_VALUE=""

acquire_lock() {
  local resp
  resp=$(timeout 30 curl -sS -m 15 -X POST "$API_BASE/timed/admin/replay-lock?reason=${LOCK_REASON_TAG}&key=$API_KEY")
  local ok=$(echo "$resp" | jq -r '.ok // false')
  if [[ "$ok" != "true" ]]; then log "ERROR: acquire lock failed: $resp"; exit 5; fi
  REPLAY_LOCK_VALUE=$(echo "$resp" | jq -r '.lock // empty')
  log "Acquired replay lock: ${REPLAY_LOCK_VALUE:-<empty>}"
}

release_lock() {
  timeout 15 curl -sS -m 10 -X DELETE "$API_BASE/timed/admin/replay-lock?key=$API_KEY" > /dev/null 2>&1 || true
  log "Released replay lock"
}

assert_lock_still_ours() {
  local resp lock_val
  resp=$(timeout 15 curl -sS -m 10 "$API_BASE/timed/admin/replay-lock?key=$API_KEY" 2>&1) || true
  lock_val=$(echo "$resp" | jq -r '.lock // ""' 2>/dev/null || echo "")
  if [[ -z "$lock_val" ]]; then
    # Re-acquire on empty (common: clean-slate reset may clear it; external
    # ops may delete it). No alarm — just reclaim.
    log "WARN: lock was empty; re-acquiring"
    acquire_lock
    return
  fi
  # If the current lock value matches what we got on acquire, we own it.
  # If the reason-tag matches ours (but timestamp differs), the worker
  # refreshed the lock somehow — treat as ours.
  if [[ "$lock_val" == "$REPLAY_LOCK_VALUE" ]] || [[ "$lock_val" == *"$LOCK_REASON_TAG"* ]]; then
    return 0
  fi
  log "ERROR: lock changed to foreign writer: $lock_val (ours was: $REPLAY_LOCK_VALUE)"
  exit 3
}

register_run() {
  local payload
  payload=$(jq -nc \
    --arg run_id "$RUN_ID" \
    --arg start_date "$START_DATE" \
    --arg end_date "$END_DATE" \
    --arg label "$RUN_ID" \
    --argjson ticker_batch 24 \
    --argjson ticker_universe_count 24 \
    '{
      run_id: $run_id, label: $label,
      description: "Continuous Jul→Apr backtest (one run_id, one lock)",
      start_date: $start_date, end_date: $end_date,
      interval_min: 30, ticker_batch: $ticker_batch,
      ticker_universe_count: $ticker_universe_count,
      trader_only: true, keep_open_at_end: false, low_write: false,
      status: "running", status_note: "Continuous backtest starting",
      entry_engine: "tt_core", management_engine: "tt_core",
      active_experiment_slot: 1, live_config_slot: 0
    }')
  local resp
  resp=$(timeout 30 curl -sS -m 30 -X POST "$API_BASE/timed/admin/runs/register?key=$API_KEY" \
    -H "Content-Type: application/json" -d "$payload")
  local ok=$(echo "$resp" | jq -r '.ok // false')
  if [[ "$ok" != "true" ]]; then log "ERROR: runs/register failed: $resp"; exit 5; fi
  log "Registered run $RUN_ID"
}

reset_state() {
  local resp
  resp=$(timeout 120 curl -sS -m 120 -X POST "$API_BASE/timed/admin/reset?resetLedger=1&skipTickerLatest=1&replayOnly=1&key=$API_KEY" \
    -H "Content-Type: application/json" -d '{}')
  local ok=$(echo "$resp" | jq -r '.ok // false')
  if [[ "$ok" != "true" ]]; then log "WARN: reset returned non-ok: $resp"; fi
  log "Replay state reset complete"
}

# BUG FIX (2026-04-21): On the 215-ticker v10 run, `fullDay=1` silently
# processed only the FIRST ticker batch (24 tickers) instead of iterating
# through all 9 offsets. Root cause unclear (Worker CPU-time budget or
# silent try/catch somewhere in the replay-candle-batches internal loop).
# Rewriting this to loop tickerOffset EXTERNALLY in bash with fullDay=0
# — each HTTP call now processes exactly one batch, and the script
# advances the offset until hasMore=false. This also parallels the
# monthly-slice.sh approach.
replay_day() {
  local day="$1" clean_slate="$2"
  local total_scored=0 total_trades=0 total_blocked=0
  local offset=0
  # V14 (2026-04-25): batch=24 hit Cloudflare per-request CPU/wall-time
  # limits on 200+ ticker universes (60+ min curl hangs every ~20 days).
  # Smaller batches mean more HTTP roundtrips but each fits well within
  # the worker's per-request budget. Override via BATCH_SIZE env.
  local batch="${BATCH_SIZE:-12}"
  local cs="$clean_slate"  # only apply cleanSlate on the FIRST batch of the day
  local day_t0=$(date -u +%s)

  while :; do
    local url="$API_BASE/timed/admin/candle-replay?date=$day&runId=$RUN_ID&tickerOffset=${offset}&tickerBatch=${batch}&intervalMinutes=30&tickers=$TICKERS&fullDay=0&key=$API_KEY"
    if [[ "$cs" == "1" ]]; then url="${url}&cleanSlate=1"; cs=0; fi
    if $BLOCK_CHAIN; then url="${url}&blockChainTrace=1"; fi

    local attempt=1 max_attempts=3 rc=0 resp=""
    while [[ $attempt -le $max_attempts ]]; do
      local t0=$(date -u +%s)
      # Hard-kill wrapper: `timeout` alone has been observed to NOT kill
      # curl processes stuck in deep TCP/kernel state (observed: Aug 19
      # v10b hang, 3081s elapsed despite -m 420 AND timeout 420). We use
      # `setsid` so curl runs in its own process group, then `timeout`
      # can use SIGKILL after 5s of SIGTERM being ignored. Also, curl's
      # internal timeout options (--max-time + --connect-timeout) give
      # us a second line of defense.
      set +e
      resp=$(timeout --kill-after=5s --signal=TERM "${WATCHDOG_SECONDS}s" \
        setsid curl -sS \
        --max-time "$WATCHDOG_SECONDS" \
        --connect-timeout 30 \
        --speed-time 60 --speed-limit 1 \
        -X POST "$url" \
        -H "Content-Type: application/json" \
        -d '{}' \
        -w "\n__HTTP_STATUS__:%{http_code}" 2>&1)
      rc=$?
      set -e
      local t1=$(date -u +%s)
      local elapsed=$((t1 - t0))
      # Heartbeat regardless of success/failure — if this line is reached,
      # the curl process terminated and we're back in the main loop. A
      # stalled curl would NOT reach this, and the watchdog will see a
      # stale heartbeat file.
      heartbeat
      if [[ $rc -ne 0 ]]; then
        log "WARN: curl rc=$rc elapsed=${elapsed}s on $day offset=$offset attempt $attempt"
        attempt=$((attempt + 1))
        sleep 8
        assert_lock_still_ours
        continue
      fi
      local body status
      body=$(echo "$resp" | sed '$d')
      status=$(echo "$resp" | tail -n1 | sed 's|__HTTP_STATUS__:||')
      if [[ "$status" != "200" ]]; then
        log "WARN: status=$status on $day offset=$offset attempt $attempt"
        attempt=$((attempt + 1))
        sleep 8
        continue
      fi
      break
    done
    if [[ $rc -ne 0 ]]; then
      log "WARN: $day offset=$offset failed after $max_attempts attempts — abandoning day"
      return 1
    fi

    local body=$(echo "$resp" | sed '$d')
    local chunk_scored chunk_trades chunk_blocked has_more
    chunk_scored=$(echo "$body"  | jq -r '.scored // 0')
    chunk_trades=$(echo "$body"  | jq -r '.tradesCreated // 0')
    chunk_blocked=$(echo "$body" | jq -r '.blockChainBars | length // 0')
    has_more=$(echo "$body"       | jq -r '.hasMore // false')
    total_scored=$((total_scored + chunk_scored))
    total_trades=$((total_trades + chunk_trades))
    total_blocked=$((total_blocked + chunk_blocked))

    if [[ "$has_more" != "true" ]]; then
      break
    fi
    offset=$((offset + batch))
  done

  local day_elapsed=$(( $(date -u +%s) - day_t0 ))
  log "day $day ok {\"scored\":${total_scored},\"trades\":${total_trades},\"blocked_bars\":${total_blocked}} (${day_elapsed}s, batches=$((offset / batch + 1)))"
  return 0
}

write_checkpoint() {
  local last_day="$1"
  jq -nc \
    --arg run_id "$RUN_ID" \
    --arg last_completed_date "$last_day" \
    --arg updated_at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    '{run_id: $run_id, last_completed_date: $last_completed_date, updated_at: $updated_at}' \
    > "$CHECKPOINT_FILE.tmp" && mv "$CHECKPOINT_FILE.tmp" "$CHECKPOINT_FILE"
}

read_checkpoint() {
  if [[ -f "$CHECKPOINT_FILE" ]]; then
    jq -r '.last_completed_date // ""' "$CHECKPOINT_FILE" 2>/dev/null || echo ""
  fi
}

finalize() {
  log "Closing replay positions at $END_DATE"
  timeout 180 curl -sS -m 120 -X POST \
    "$API_BASE/timed/admin/close-replay-positions?date=$END_DATE&runId=$RUN_ID&key=$API_KEY" \
    -H "Content-Type: application/json" -d '{}' > /dev/null || true
  local payload
  payload=$(jq -nc --arg run_id "$RUN_ID" \
    '{run_id: $run_id, status: "completed", status_note: "Continuous backtest complete"}')
  timeout 60 curl -sS -m 60 -X POST "$API_BASE/timed/admin/runs/finalize?key=$API_KEY" \
    -H "Content-Type: application/json" -d "$payload" > /dev/null || true
  log "Finalized run $RUN_ID"

  # Save trades.json
  timeout 120 curl -sS -m 120 "$API_BASE/timed/admin/runs/trades?run_id=$RUN_ID&key=$API_KEY" \
    | python3 -c "
import json, sys
d = json.load(sys.stdin)
trades = d.get('trades') or []
out = {'run_id': '$RUN_ID', 'trades': trades}
print(json.dumps(out))" > "${ARTIFACT_DIR}/trades.json"
  local n=$(python3 -c "import json; print(len(json.load(open('${ARTIFACT_DIR}/trades.json'))['trades']))")
  log "Saved ${n} trades to ${ARTIFACT_DIR}/trades.json"

  # Also produce per-month splits
  python3 - <<EOF
import json, os
from datetime import datetime, timezone
trades = json.load(open('${ARTIFACT_DIR}/trades.json'))['trades']
by_month = {}
for t in trades:
    ts = t.get('entry_ts')
    if not ts: continue
    m = datetime.fromtimestamp(ts/1000, tz=timezone.utc).strftime('%Y-%m')
    by_month.setdefault(m, []).append(t)
for m, ts in by_month.items():
    d = '${ARTIFACT_DIR}/by-month/' + m
    os.makedirs(d, exist_ok=True)
    with open(d + '/trades.json', 'w') as f:
        json.dump({'run_id':'${RUN_ID}','month':m,'trades':ts}, f, indent=2)
print(f'Split into {len(by_month)} monthly buckets')
EOF
}

# ---- MAIN ----
trap 'release_lock' EXIT INT TERM

START_INDEX=0
if $RESUME; then
  LAST=$(read_checkpoint)
  if [[ -n "$LAST" ]]; then
    log "Resuming after last completed day $LAST"
    for i in "${!ALL_DAYS[@]}"; do
      if [[ "${ALL_DAYS[$i]}" == "$LAST" ]]; then START_INDEX=$((i + 1)); break; fi
    done
  fi
  acquire_lock
else
  acquire_lock
  register_run
  reset_state
fi

if [[ $START_INDEX -ge $TOTAL ]]; then
  log "Already at end; nothing to do"
  finalize
  exit 0
fi

for ((i=START_INDEX; i<TOTAL; i++)); do
  d="${ALL_DAYS[$i]}"
  log ">>> day $((i+1))/$TOTAL  $d"
  assert_lock_still_ours
  local_clean=0
  if [[ $i -eq 0 ]] && ! $RESUME; then local_clean=1; fi
  replay_day "$d" "$local_clean" || true
  write_checkpoint "$d"
done

log "=== All $TOTAL trading days processed; finalizing ==="
finalize
log "=== continuous-slice complete: $RUN_ID ==="
