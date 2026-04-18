#!/usr/bin/env bash
# scripts/monthly-slice.sh — Phase C monthly slicer (direct-loop).
#
# Drives POST /timed/admin/candle-replay one trading day at a time for a
# single calendar month on the locked Phase-B 24-ticker universe with the
# Phase-A base config package (R5 entry bias + R2v3 decay + R6 MFE trail).
#
# Guard rails this script adds on top of the existing direct-loop pattern:
#
#   1. Local PID-based lock in data/.locks/monthly-slice.<month>.lock so two
#      invocations for the same month cannot race.
#   2. Single-writer enforcement: before acquiring the worker replay lock we
#      assert GET /timed/admin/backtests/status reports no active DO job
#      AND that timed:replay:lock is either empty or already owned by this
#      run (used on --resume). Bails out cleanly with a loud message
#      otherwise, never stepping on the BacktestRunner DO.
#   3. Watchdog: every per-day candle-replay POST runs under a hard
#      curl --max-time budget. If the day's batch does not acknowledge for
#      >180s we abort the day, restore the checkpoint, and exit non-zero so
#      the caller can re-run with --resume. This is the "no
#      runner_session_complete for > 180 s" guard from the plan.
#   4. Resume-from-checkpoint: last completed date is persisted to
#      data/trade-analysis/<run_id>/slice.checkpoint.json; --resume reads it
#      and starts the loop from the next trading day. Raw trades already
#      written to backtest_run_trades survive the restart.
#
#   5. --block-chain: when present, the worker returns a per-bar trace of
#      rejected entry candidates (ticker, ts, reason, kanban_stage, state,
#      score) and the script appends them to
#      data/trade-analysis/<run_id>/block_chain.jsonl. This is the input
#      to scripts/compare-block-chains.js for redistribution analysis.
#
# Usage:
#
#   scripts/monthly-slice.sh \
#     --month=2025-07 \
#     [--run-id=<run_id>] \
#     [--tickers=<csv>|tier1-tier2] \
#     [--ticker-batch=24] \
#     [--interval-minutes=5] \
#     [--label="phase-c-2025-07"] \
#     [--watchdog-seconds=180] \
#     [--resume] \
#     [--dry-run] \
#     [--api-base=<url>] \
#     [--api-key=<key>|env TIMED_API_KEY]
#
# Exit codes:
#   0  success (full month completed + finalized)
#   2  usage error
#   3  single-writer guard tripped (DO active or foreign replay lock held)
#   4  watchdog fired (day exceeded --watchdog-seconds)
#   5  worker-side error (candle-replay returned ok=false after retries)
#   6  lock acquire / checkpoint IO failure

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# 24-ticker universe frozen in
# tasks/holistic-regime-calibration-plan-2026-04-17.md §Universe. Keep in
# sync with scripts/build-monthly-backdrop.js.
TIER1_TICKERS="SPY,QQQ,IWM,AAPL,MSFT,GOOGL,AMZN,META,NVDA,TSLA"
TIER2_TICKERS="AGQ,CDNS,ETN,FIX,GRNY,HUBS,IESC,MTZ,ON,PH,RIOT,SGI,SWK,XLY"
DEFAULT_TICKERS="${TIER1_TICKERS},${TIER2_TICKERS}"

# NYSE full-day holidays 2024-2027 — keep in sync with the NYSE_HOLIDAYS set
# in scripts/build-monthly-backdrop.js. TwelveData sometimes emits a
# synthetic daily bar on these dates which would otherwise be treated as a
# trading day and counted in replay metrics.
NYSE_HOLIDAYS=(
  "2024-01-01" "2024-01-15" "2024-02-19" "2024-03-29" "2024-05-27"
  "2024-06-19" "2024-07-04" "2024-09-02" "2024-11-28" "2024-12-25"
  "2025-01-01" "2025-01-09" "2025-01-20" "2025-02-17" "2025-04-18"
  "2025-05-26" "2025-06-19" "2025-07-04" "2025-09-01" "2025-11-27"
  "2025-12-25"
  "2026-01-01" "2026-01-19" "2026-02-16" "2026-04-03" "2026-05-25"
  "2026-06-19" "2026-07-03" "2026-09-07" "2026-11-26" "2026-12-25"
  "2027-01-01" "2027-01-18" "2027-02-15" "2027-03-26" "2027-05-31"
  "2027-06-18" "2027-07-05" "2027-09-06" "2027-11-25" "2027-12-24"
)

DEFAULT_API_BASE="https://timed-trading-ingest.shashant.workers.dev"
DEFAULT_INTERVAL_MINUTES=5
DEFAULT_TICKER_BATCH=24
DEFAULT_WATCHDOG_SECONDS=180
DEFAULT_RETRIES_PER_DAY=3
DEFAULT_RETRY_BACKOFF_SECONDS=8

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------

MONTH=""
RUN_ID=""
TICKERS_ARG=""
TICKER_BATCH="$DEFAULT_TICKER_BATCH"
INTERVAL_MINUTES="$DEFAULT_INTERVAL_MINUTES"
LABEL=""
WATCHDOG_SECONDS="$DEFAULT_WATCHDOG_SECONDS"
RESUME=false
DRY_RUN=false
BLOCK_CHAIN=false
API_BASE="$DEFAULT_API_BASE"
API_KEY="${TIMED_API_KEY:-}"

die_usage() {
  echo "ERROR: $1" >&2
  echo "" >&2
  echo "Usage: $0 --month=YYYY-MM [--resume] [--dry-run] [--block-chain] [--tickers=csv|tier1-tier2] \\" >&2
  echo "             [--ticker-batch=N] [--interval-minutes=N] [--watchdog-seconds=N] \\" >&2
  echo "             [--label=str] [--run-id=str] [--api-base=url] [--api-key=str]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  arg="$1"
  shift
  case "$arg" in
    --help|-h)
      sed -n '3,48p' "$0"
      exit 0
      ;;
    --month=*) MONTH="${arg#*=}" ;;
    --run-id=*) RUN_ID="${arg#*=}" ;;
    --tickers=*) TICKERS_ARG="${arg#*=}" ;;
    --ticker-batch=*) TICKER_BATCH="${arg#*=}" ;;
    --interval-minutes=*) INTERVAL_MINUTES="${arg#*=}" ;;
    --label=*) LABEL="${arg#*=}" ;;
    --watchdog-seconds=*) WATCHDOG_SECONDS="${arg#*=}" ;;
    --resume) RESUME=true ;;
    --dry-run) DRY_RUN=true ;;
    --block-chain) BLOCK_CHAIN=true ;;
    --api-base=*) API_BASE="${arg#*=}" ;;
    --api-key=*) API_KEY="${arg#*=}" ;;
    *) die_usage "unknown argument: $arg" ;;
  esac
done

[[ -z "$MONTH" ]] && die_usage "--month=YYYY-MM is required"
if ! [[ "$MONTH" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]]; then
  die_usage "--month must be YYYY-MM with month in 01..12, got '$MONTH'"
fi
[[ -z "$API_KEY" ]] && die_usage "TIMED_API_KEY env var or --api-key is required"

if [[ "$TICKERS_ARG" == "" || "$TICKERS_ARG" == "tier1-tier2" ]]; then
  TICKERS="$DEFAULT_TICKERS"
elif [[ "$TICKERS_ARG" == "tier1" ]]; then
  TICKERS="$TIER1_TICKERS"
elif [[ "$TICKERS_ARG" == "tier2" ]]; then
  TICKERS="$TIER2_TICKERS"
else
  TICKERS="$TICKERS_ARG"
fi
TICKER_COUNT=$(awk -F, '{print NF}' <<<"$TICKERS")

ISO_NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="phase-c-slice-${MONTH}@${ISO_NOW}"
fi
[[ -z "$LABEL" ]] && LABEL="phase-c-slice-${MONTH}"

command -v jq >/dev/null || die_usage "jq is required but not on PATH"
command -v curl >/dev/null || die_usage "curl is required but not on PATH"

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK_ROOT="$REPO_ROOT/data/.locks"
LOCK_DIR="$LOCK_ROOT/monthly-slice.${MONTH}.lock"
SAFE_RUN_ID="${RUN_ID//[^[:alnum:]._-]/-}"
ARTIFACT_DIR="$REPO_ROOT/data/trade-analysis/$SAFE_RUN_ID"
CHECKPOINT_FILE="$ARTIFACT_DIR/slice.checkpoint.json"
PROGRESS_LOG="$ARTIFACT_DIR/slice.progress.log"
REPLAY_LOCK_TOKEN="direct_loop_${SAFE_RUN_ID}@${ISO_NOW}"

mkdir -p "$LOCK_ROOT"
# Defer artifact dir creation until we actually plan to write to it; a
# --dry-run should not leave pollution behind.

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() {
  # Stream to stdout AND append to the progress log so watchdogs / external
  # observers can tail the artifact dir without having to attach to stdout.
  local line
  line="[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"
  echo "$line"
  [[ -d "$ARTIFACT_DIR" ]] && echo "$line" >> "$PROGRESS_LOG" || true
}

is_weekend() {
  # 1=Mon..5=Fri, 6=Sat, 7=Sun
  local dow
  dow=$(date -u -d "$1" '+%u' 2>/dev/null || date -j -f "%Y-%m-%d" "$1" '+%u' 2>/dev/null)
  [[ "$dow" == "6" || "$dow" == "7" ]]
}

is_holiday() {
  local d="$1"
  for h in "${NYSE_HOLIDAYS[@]}"; do
    [[ "$h" == "$d" ]] && return 0
  done
  return 1
}

next_day() {
  date -u -d "$1 + 1 day" '+%Y-%m-%d' 2>/dev/null || \
    date -j -v+1d -f "%Y-%m-%d" "$1" '+%Y-%m-%d' 2>/dev/null
}

month_bounds() {
  # echoes "$start $end" for the given YYYY-MM.
  local ym="$1"
  local y="${ym%-*}"
  local m="${ym#*-}"
  local start="${ym}-01"
  local next_y="$y" next_m
  next_m=$((10#$m + 1))
  if [[ "$next_m" -gt 12 ]]; then next_m=1; next_y=$((y + 1)); fi
  local next_start
  next_start=$(printf "%04d-%02d-01" "$next_y" "$next_m")
  local end
  end=$(date -u -d "$next_start - 1 day" '+%Y-%m-%d' 2>/dev/null || \
        date -j -v-1d -f "%Y-%m-%d" "$next_start" '+%Y-%m-%d' 2>/dev/null)
  echo "$start $end"
}

trading_days_for_month() {
  local bounds
  bounds=$(month_bounds "$1")
  local start="${bounds% *}"
  local end="${bounds#* }"
  local cur="$start"
  while [[ "$cur" < "$end" || "$cur" == "$end" ]]; do
    if ! is_weekend "$cur" && ! is_holiday "$cur"; then
      echo "$cur"
    fi
    cur=$(next_day "$cur")
  done
}

# ---------------------------------------------------------------------------
# Script-lock (PID-based, same shape as scripts/full-backtest.sh)
# ---------------------------------------------------------------------------

acquire_script_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" > "$LOCK_DIR/pid"
    echo "$RUN_ID" > "$LOCK_DIR/run_id"
    return 0
  fi

  local existing_pid=""
  [[ -f "$LOCK_DIR/pid" ]] && existing_pid=$(tr -cd '0-9' < "$LOCK_DIR/pid" 2>/dev/null || true)

  if [[ -n "$existing_pid" ]] && ! kill -0 "$existing_pid" 2>/dev/null; then
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR"
    echo "$$" > "$LOCK_DIR/pid"
    echo "$RUN_ID" > "$LOCK_DIR/run_id"
    return 0
  fi

  log "ERROR: another monthly-slice run is active for ${MONTH} (pid=${existing_pid:-unknown})"
  exit 6
}

release_script_lock() { rm -rf "$LOCK_DIR" 2>/dev/null || true; }

# ---------------------------------------------------------------------------
# Worker helpers
# ---------------------------------------------------------------------------

http() {
  # http METHOD URL [--data BODY] [--timeout SEC]
  local method="$1"; shift
  local url="$1"; shift
  local data=""
  local timeout=60
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --data) data="$2"; shift 2 ;;
      --timeout) timeout="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  local args=(-sS -m "$timeout" -X "$method" "$url" -H "Content-Type: application/json")
  [[ -n "$data" ]] && args+=(-d "$data")
  curl "${args[@]}"
}

fetch_replay_lock() {
  http GET "$API_BASE/timed/admin/replay-lock?key=$API_KEY" --timeout 15
}

fetch_backtest_status() {
  http GET "$API_BASE/timed/admin/backtests/status?key=$API_KEY" --timeout 15
}

# ---------------------------------------------------------------------------
# Single-writer enforcement (Bug D pattern — tasks/lessons.md)
# ---------------------------------------------------------------------------

assert_single_writer() {
  # Refuse to run if a BacktestRunner DO is active, or if the worker replay
  # lock is held by someone other than us. On --resume we allow a lock that
  # is ours already (key suffix matches $REPLAY_LOCK_TOKEN-ish prefix).
  local status_json
  status_json=$(fetch_backtest_status)
  local status_ok
  status_ok=$(echo "$status_json" | jq -r '.ok // false')
  if [[ "$status_ok" != "true" ]]; then
    log "WARN: backtests/status returned non-ok: $(echo "$status_json" | head -c 300)"
  fi
  local active
  active=$(echo "$status_json" | jq -c '.active // null')
  if [[ "$active" != "null" ]]; then
    local active_run_id active_status
    active_run_id=$(echo "$status_json" | jq -r '.active.runId // .active.run_id // ""')
    active_status=$(echo "$status_json" | jq -r '.active.status // ""')
    log "ERROR: BacktestRunner reports an active job (run_id=$active_run_id, status=$active_status)."
    log "       Cancel it with POST /timed/admin/backtests/cancel before restarting this slice."
    exit 3
  fi

  local lock_json
  lock_json=$(fetch_replay_lock)
  local locked lock_val
  locked=$(echo "$lock_json" | jq -r '.locked // false')
  lock_val=$(echo "$lock_json" | jq -r '.lock // ""')
  if [[ "$locked" == "true" ]]; then
    if $RESUME && [[ "$lock_val" == direct_loop_${SAFE_RUN_ID}* ]]; then
      log "RESUME: keeping existing direct-loop lock '$lock_val'"
      REPLAY_LOCK_TOKEN="$lock_val"
      return 0
    fi
    log "ERROR: worker replay lock is already held by '$lock_val'"
    log "       DELETE /timed/admin/replay-lock (after confirming no other writer) before retrying."
    exit 3
  fi
}

acquire_replay_lock() {
  # reason= becomes the KV value via worker/index.js L44843.
  local encoded_reason="$REPLAY_LOCK_TOKEN"
  local resp
  resp=$(http POST "$API_BASE/timed/admin/replay-lock?reason=${encoded_reason// /_}&key=$API_KEY" --timeout 15)
  local ok val
  ok=$(echo "$resp" | jq -r '.ok // false')
  val=$(echo "$resp" | jq -r '.lock // ""')
  if [[ "$ok" != "true" ]]; then
    log "ERROR: replay-lock acquire failed: $resp"
    exit 3
  fi
  REPLAY_LOCK_TOKEN="$val"
  log "Acquired replay lock: $REPLAY_LOCK_TOKEN"
}

release_replay_lock() {
  local resp
  resp=$(http DELETE "$API_BASE/timed/admin/replay-lock?key=$API_KEY" --timeout 15 || true)
  log "Released replay lock: $(echo "$resp" | jq -c '{ok,released}' 2>/dev/null || echo "$resp")"
}

assert_lock_still_ours() {
  # Dual-writer guard: re-check the lock token before each per-day call so a
  # foreign writer (e.g. an accidentally-started BacktestRunner DO) cannot
  # silently interleave writes into the same run_id lane. Matches lessons
  # item 3 in "Backtest orchestration" (tasks/lessons.md).
  local lock_json lock_val
  lock_json=$(fetch_replay_lock)
  lock_val=$(echo "$lock_json" | jq -r '.lock // ""')
  if [[ "$lock_val" != "$REPLAY_LOCK_TOKEN" ]]; then
    log "ERROR: replay lock changed under us. Expected '$REPLAY_LOCK_TOKEN', got '$lock_val'"
    log "       Another writer has taken the lane; aborting to avoid dual-writer contamination."
    exit 3
  fi
}

# ---------------------------------------------------------------------------
# Register the run
# ---------------------------------------------------------------------------

register_run() {
  local start_date="$1" end_date="$2"
  local code_revision
  code_revision=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "")
  local payload
  payload=$(jq -nc \
    --arg run_id "$RUN_ID" \
    --arg label "$LABEL" \
    --arg description "Phase-C monthly slice ${MONTH} (24-ticker universe, R5+R2v3+R6 base package)" \
    --arg start_date "$start_date" \
    --arg end_date "$end_date" \
    --argjson interval_min "$INTERVAL_MINUTES" \
    --argjson ticker_batch "$TICKER_BATCH" \
    --argjson ticker_universe_count "$TICKER_COUNT" \
    --argjson trader_only true \
    --argjson keep_open_at_end false \
    --argjson low_write false \
    --arg status "running" \
    --arg status_note "Direct-loop monthly slice starting" \
    --arg code_revision "$code_revision" \
    --arg entry_engine "tt_core" \
    --arg management_engine "tt_core" \
    '{
       run_id: $run_id, label: $label, description: $description,
       start_date: $start_date, end_date: $end_date,
       interval_min: $interval_min, ticker_batch: $ticker_batch,
       ticker_universe_count: $ticker_universe_count,
       trader_only: $trader_only, keep_open_at_end: $keep_open_at_end,
       low_write: $low_write,
       status: $status, status_note: $status_note,
       code_revision: (if ($code_revision | length) > 0 then $code_revision else null end),
       entry_engine: $entry_engine, management_engine: $management_engine,
       tags: ["phase-c", "monthly-slice", ("month:" + ($start_date | .[0:7]))],
       active_experiment_slot: 1,
       live_config_slot: 0
     }')
  local resp
  resp=$(http POST "$API_BASE/timed/admin/runs/register?key=$API_KEY" --data "$payload" --timeout 30)
  local ok
  ok=$(echo "$resp" | jq -r '.ok // false')
  if [[ "$ok" != "true" ]]; then
    log "ERROR: runs/register failed: $resp"
    exit 5
  fi
  log "Registered run $RUN_ID (label=$LABEL)"
}

# ---------------------------------------------------------------------------
# Per-day replay (watchdog-wrapped)
# ---------------------------------------------------------------------------

replay_day() {
  local date="$1"
  local attempt=1
  local ok_ret=1
  while [[ "$attempt" -le "$DEFAULT_RETRIES_PER_DAY" ]]; do
    local url="$API_BASE/timed/admin/candle-replay"
    url+="?date=$date"
    url+="&tickers=$TICKERS"
    url+="&tickerBatch=$TICKER_BATCH"
    url+="&intervalMinutes=$INTERVAL_MINUTES"
    url+="&fullDay=1"
    url+="&runId=$RUN_ID"
    url+="&freshRun=1"
    url+="&skipInvestor=1"
    url+="&disableReferenceExecution=1"
    if $BLOCK_CHAIN; then
      url+="&blockChainTrace=1"
    fi
    url+="&key=$API_KEY"

    local t0 t1
    t0=$(date -u +%s)
    local resp http_status
    # -w %{http_code} captures the status alongside the body so we can
    # distinguish a watchdog timeout (curl exit 28) from a 5xx worker error.
    resp=$(curl -sS -m "$WATCHDOG_SECONDS" -X POST "$url" -H "Content-Type: application/json" -d '{}' -w "\n__HTTP_STATUS__:%{http_code}" 2>&1) && rc=$? || rc=$?
    t1=$(date -u +%s)
    local elapsed=$((t1 - t0))

    if [[ "$rc" -eq 28 ]]; then
      log "WATCHDOG: $date exceeded ${WATCHDOG_SECONDS}s (attempt $attempt); abandoning day"
      # Record checkpoint BEFORE exit so --resume can restart cleanly.
      write_checkpoint "$date" "stalled_watchdog"
      exit 4
    fi
    if [[ "$rc" -ne 0 ]]; then
      log "WARN: curl error (rc=$rc) for $date attempt $attempt in ${elapsed}s: $(echo "$resp" | head -c 200)"
      attempt=$((attempt + 1))
      sleep "$DEFAULT_RETRY_BACKOFF_SECONDS"
      continue
    fi

    http_status=$(echo "$resp" | awk -F: '/^__HTTP_STATUS__:/{print $2}')
    local body
    body=$(echo "$resp" | sed '/^__HTTP_STATUS__:/d')
    local ok_field intervals scored trades total_trades
    ok_field=$(echo "$body" | jq -r '.ok // false' 2>/dev/null || echo "false")
    if [[ "$ok_field" == "true" ]]; then
      intervals=$(echo "$body" | jq -r '.intervals // 0')
      scored=$(echo "$body" | jq -r '.scored // 0')
      trades=$(echo "$body" | jq -r '.tradesCreated // 0')
      total_trades=$(echo "$body" | jq -r '.totalTrades // 0')
      if $BLOCK_CHAIN; then
        # Append one line per blocked bar to block_chain.jsonl. Adds an
        # explicit `date` field so downstream consumers don't have to
        # reconstruct it from the ts.
        local bc_count
        bc_count=$(echo "$body" | jq -r '(.blockChainBars // []) | length')
        if [[ "$bc_count" -gt 0 ]]; then
          echo "$body" | jq -c --arg date "$date" --arg run_id "$RUN_ID" \
            '(.blockChainBars // [])[] | . + {date: $date, run_id: $run_id}' \
            >> "$ARTIFACT_DIR/block_chain.jsonl" || true
        fi
        log "day $date ok intervals=$intervals scored=$scored trades=$trades blocked_bars=$bc_count (cumulative=$total_trades, ${elapsed}s)"
      else
        log "day $date ok intervals=$intervals scored=$scored trades=$trades (cumulative=$total_trades, ${elapsed}s)"
      fi
      ok_ret=0
      break
    fi

    log "WARN: $date attempt $attempt returned ok=false (http=$http_status) in ${elapsed}s: $(echo "$body" | head -c 400)"
    attempt=$((attempt + 1))
    sleep "$DEFAULT_RETRY_BACKOFF_SECONDS"
  done
  if [[ "$ok_ret" -ne 0 ]]; then
    log "ERROR: $date failed after $DEFAULT_RETRIES_PER_DAY attempts"
    write_checkpoint "$date" "failed_after_retries"
    exit 5
  fi
}

# ---------------------------------------------------------------------------
# Checkpoint (restart-safe)
# ---------------------------------------------------------------------------

write_checkpoint() {
  local last_date="$1" reason="$2"
  jq -nc \
    --arg run_id "$RUN_ID" \
    --arg month "$MONTH" \
    --arg last_completed_date "$last_date" \
    --arg reason "$reason" \
    --arg updated_at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --arg tickers "$TICKERS" \
    --argjson interval_minutes "$INTERVAL_MINUTES" \
    --argjson ticker_batch "$TICKER_BATCH" \
    --argjson watchdog_seconds "$WATCHDOG_SECONDS" \
    '{
       run_id: $run_id, month: $month,
       last_completed_date: $last_completed_date, reason: $reason,
       updated_at: $updated_at,
       tickers: $tickers,
       interval_minutes: $interval_minutes,
       ticker_batch: $ticker_batch,
       watchdog_seconds: $watchdog_seconds
     }' > "$CHECKPOINT_FILE.tmp" && mv "$CHECKPOINT_FILE.tmp" "$CHECKPOINT_FILE"
}

read_checkpoint_last_date() {
  if [[ -f "$CHECKPOINT_FILE" ]]; then
    jq -r '.last_completed_date // ""' < "$CHECKPOINT_FILE" 2>/dev/null || echo ""
  fi
}

# ---------------------------------------------------------------------------
# Finalize
# ---------------------------------------------------------------------------

finalize_run() {
  local end_date="$1"
  # Close any still-open positions at end-of-window using the same
  # canonical run_id so the archive sees them (full-backtest.sh L938).
  log "Closing any still-open replay positions at $end_date"
  local close_resp
  close_resp=$(http POST "$API_BASE/timed/admin/close-replay-positions?date=$end_date&runId=$RUN_ID&key=$API_KEY" --timeout 120 || true)
  log "close-replay-positions: $(echo "$close_resp" | jq -c '{ok, closed_positions}' 2>/dev/null || echo "$close_resp")"

  local payload
  payload=$(jq -nc \
    --arg run_id "$RUN_ID" \
    --arg status "completed" \
    --arg status_note "Monthly slice finalized" \
    '{run_id: $run_id, status: $status, status_note: $status_note}')
  local resp
  resp=$(http POST "$API_BASE/timed/admin/runs/finalize?key=$API_KEY" --data "$payload" --timeout 60 || true)
  log "runs/finalize: $(echo "$resp" | jq -c '{ok, run_id, status}' 2>/dev/null || echo "$resp")"
}

save_trades_csv() {
  # Pull trades back out via /admin/runs/trades so we have a reproducible
  # artifact alongside the checkpoint. The analyzer in Phase D consumes
  # this file.
  local out="$ARTIFACT_DIR/trades.json"
  local csv="$ARTIFACT_DIR/trades.csv"
  local resp
  resp=$(http GET "$API_BASE/timed/admin/runs/trades?run_id=$RUN_ID&limit=10000&key=$API_KEY" --timeout 60 || true)
  echo "$resp" > "$out"
  local count
  count=$(echo "$resp" | jq -r '.count // 0' 2>/dev/null || echo "0")
  log "Saved $out ($count trades)"
  # Minimal CSV: ticker, direction, entry_ts, exit_ts, entry_price, exit_price, pnl_usd, pnl_pct, exit_reason
  {
    echo "ticker,direction,entry_ts,exit_ts,entry_price,exit_price,pnl_usd,pnl_pct,exit_reason,status"
    echo "$resp" | jq -r '
      (.trades // []) | .[] | [
        .ticker, .direction, .entry_ts, .exit_ts,
        .entry_price, .exit_price, .pnl_usd, .pnl_pct,
        .exit_reason, .status
      ] | @csv
    ' 2>/dev/null || true
  } > "$csv"
  log "Saved $csv"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

acquire_script_lock
trap 'release_script_lock' EXIT INT TERM

bounds=$(month_bounds "$MONTH")
START_DATE="${bounds% *}"
END_DATE="${bounds#* }"
# Cap end_date to today (UTC) — partial months like 2026-04 should only
# replay completed sessions.
TODAY_UTC=$(date -u '+%Y-%m-%d')
if [[ "$END_DATE" > "$TODAY_UTC" ]]; then
  END_DATE="$TODAY_UTC"
fi

log "=== Phase C monthly slice ==="
log "month=$MONTH  start=$START_DATE  end=$END_DATE"
log "run_id=$RUN_ID  label=$LABEL"
log "tickers ($TICKER_COUNT): $TICKERS"
log "ticker_batch=$TICKER_BATCH  interval_minutes=$INTERVAL_MINUTES"
log "watchdog=${WATCHDOG_SECONDS}s  resume=$RESUME  dry_run=$DRY_RUN  block_chain=$BLOCK_CHAIN"

mapfile -t ALL_DAYS < <(trading_days_for_month "$MONTH" | awk -v end="$END_DATE" '$0 <= end')
if [[ "${#ALL_DAYS[@]}" -eq 0 ]]; then
  log "ERROR: no trading days in $MONTH (bounded at $END_DATE)"
  exit 2
fi
log "Trading days in scope: ${#ALL_DAYS[@]} (${ALL_DAYS[0]} .. ${ALL_DAYS[-1]})"

if $DRY_RUN; then
  log "--dry-run: resolved plan only, no HTTP calls will be made"
  log "Would register run, acquire replay lock, then replay ${#ALL_DAYS[@]} days:"
  for d in "${ALL_DAYS[@]}"; do log "  $d"; done
  release_script_lock
  trap - EXIT INT TERM
  exit 0
fi

# From here on out we will write artifacts, so create the dir.
mkdir -p "$ARTIFACT_DIR"

# Determine starting day (resume support).
START_INDEX=0
if $RESUME; then
  LAST=$(read_checkpoint_last_date || true)
  if [[ -n "$LAST" ]]; then
    log "Resuming after last completed day $LAST"
    local_idx=-1
    for i in "${!ALL_DAYS[@]}"; do
      if [[ "${ALL_DAYS[$i]}" == "$LAST" ]]; then local_idx=$i; fi
    done
    if [[ "$local_idx" -ge 0 ]]; then
      START_INDEX=$((local_idx + 1))
    else
      log "WARN: checkpoint date $LAST not in computed trading-day list; starting from day 0"
    fi
  else
    log "RESUME requested but no checkpoint found; starting from day 0"
  fi
fi
if [[ "$START_INDEX" -ge "${#ALL_DAYS[@]}" ]]; then
  log "Nothing to do: checkpoint already past end of month"
  exit 0
fi

# Single-writer + lock handshake (skipped parts on resume).
assert_single_writer
if ! $RESUME; then
  acquire_replay_lock
  register_run "$START_DATE" "$END_DATE"
else
  log "RESUME: skipping runs/register and replay-lock acquire"
fi
trap 'release_replay_lock; release_script_lock' EXIT INT TERM

# Main per-day loop.
for ((i=START_INDEX; i<${#ALL_DAYS[@]}; i++)); do
  d="${ALL_DAYS[$i]}"
  log ">>> session $((i+1))/${#ALL_DAYS[@]} $d"
  assert_lock_still_ours
  replay_day "$d"
  write_checkpoint "$d" "session_complete"
done

log "=== All $((${#ALL_DAYS[@]} - START_INDEX)) sessions complete; finalizing ==="
finalize_run "$END_DATE"
save_trades_csv

log "=== Phase C slice $MONTH complete: run_id=$RUN_ID artifacts=$ARTIFACT_DIR ==="
