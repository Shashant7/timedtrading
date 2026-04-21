#!/usr/bin/env bash
# v9-watchdog.sh — Stall detector for continuous-slice.sh runs.
#
# Design (2026-04-21 rewrite after 53-min silent-hang incident):
#   - ZERO log-file reads. Old watchdogs `grep`-ed the main log file, which
#     got starved when the main script's `tee -a` held the file and when
#     curl was stuck in uninterruptible kernel state. 53 minutes of silence
#     instead of the 15-min threshold.
#   - Reads ONLY the heartbeat file via `stat` (nanosecond-fast, no I/O
#     contention, no grep pipelines).
#   - Every internal command is wrapped in `timeout` so nothing in the
#     watchdog can block for longer than a few seconds.
#   - Relaunch is via `nohup` + disown (no tmux dependency) so stalled
#     tmux sessions don't prevent the new process from starting.
#   - Aggressive kill chain: SIGTERM → 2s → SIGKILL → PGID sweep of
#     any stale curl processes hitting the replay endpoint.
#
# Environment:
#   V9_ID        (required) — run_id (e.g. phase-h-v10b-1776787446)
#   TIMED_API_KEY (required)
#   TICKERS_SPEC        — default @configs/backfill-universe-2026-04-18.txt
#   START_DATE / END_DATE
#   STALL_MIN           — minutes before we declare stuck (default 15)
#   POLL_SEC            — seconds between polls (default 30)
#   LOG                 — path to continuous-slice stdout log
#   WATCHDOG_LOG        — path to watchdog log
#   HEARTBEAT_FILE      — path to the heartbeat file written by
#                         continuous-slice (default derived from V9_ID)

set -uo pipefail

V9_ID="${V9_ID:?V9_ID required}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"
API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
LOG="${LOG:-/workspace/data/trade-analysis/_phase-h-v9.log}"
WATCHDOG_LOG="${WATCHDOG_LOG:-/workspace/data/trade-analysis/_phase-h-v9-watchdog.log}"
HEARTBEAT_FILE="${HEARTBEAT_FILE:-/workspace/data/trade-analysis/${V9_ID}/continuous.heartbeat}"
STALL_MIN="${STALL_MIN:-15}"
POLL_SEC="${POLL_SEC:-30}"
TICKERS_SPEC="${TICKERS_SPEC:-@configs/backfill-universe-2026-04-18.txt}"
START_DATE="${START_DATE:-2025-07-01}"
END_DATE="${END_DATE:-2026-04-30}"

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[$(ts)] $*" | tee -a "$WATCHDOG_LOG"; }

log "watchdog v2 starting: run=$V9_ID stall_min=$STALL_MIN poll=${POLL_SEC}s heartbeat=$HEARTBEAT_FILE"

# Guard against duplicate watchdog invocation (flock)
WD_LOCK="/tmp/v9-watchdog-${V9_ID}.lock"
exec 8>"$WD_LOCK"
if ! flock -n 8; then
  log "another watchdog is already running for $V9_ID — exiting"
  exit 0
fi

heartbeat_age_sec() {
  # Reads heartbeat file mtime. If missing or unreadable, returns a large
  # number so the stall check fires. Never blocks.
  if [[ ! -f "$HEARTBEAT_FILE" ]]; then
    echo 99999
    return
  fi
  local mtime
  mtime=$(timeout 3 stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
  if [[ -z "$mtime" || "$mtime" == "0" ]]; then
    echo 99999
    return
  fi
  echo $(( $(date +%s) - mtime ))
}

kill_everything() {
  log "HARD KILL: killing all continuous-slice / curl processes for $V9_ID"

  # Find continuous-slice PIDs by run_id match
  local pids
  pids=$(timeout 5 pgrep -f "continuous-slice.sh.*${V9_ID}" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    log "  continuous-slice PIDs: $pids"
    # Send SIGTERM to the entire process group of each
    for pid in $pids; do
      local pgid
      pgid=$(timeout 3 ps -o pgid= "$pid" 2>/dev/null | tr -d ' ' || true)
      if [[ -n "$pgid" ]]; then
        timeout 3 kill -TERM -"$pgid" 2>/dev/null || true
      fi
    done
    sleep 2
    for pid in $pids; do
      local pgid
      pgid=$(timeout 3 ps -o pgid= "$pid" 2>/dev/null | tr -d ' ' || true)
      if [[ -n "$pgid" ]]; then
        timeout 3 kill -KILL -"$pgid" 2>/dev/null || true
      fi
    done
  fi

  # Additionally sweep any stray curl against candle-replay with our run_id
  local curl_pids
  curl_pids=$(timeout 5 pgrep -f "curl.*candle-replay.*runId=${V9_ID}" 2>/dev/null || true)
  if [[ -n "$curl_pids" ]]; then
    log "  orphaned curl PIDs: $curl_pids"
    timeout 3 kill -KILL $curl_pids 2>/dev/null || true
  fi

  # Kill any tmux session named after the run
  for session in "phase-h-v9" "phase-h-v10b" "phase-h-v10" "continuous-${V9_ID}" "$V9_ID"; do
    timeout 3 tmux -f /exec-daemon/tmux.portal.conf kill-session -t "$session" 2>/dev/null || true
  done

  sleep 2
}

release_lock_server_side() {
  log "releasing replay lock (server-side)"
  timeout 15 curl -sS --max-time 10 --connect-timeout 5 \
    -X DELETE "$API_BASE/timed/admin/replay-lock?key=$API_KEY" 2>&1 \
    | tee -a "$WATCHDOG_LOG" >/dev/null || true
}

relaunch() {
  log "relaunching continuous-slice.sh (tickers=$TICKERS_SPEC)"
  # Use nohup + setsid + disown so we're completely detached from this watchdog.
  # Route stdout/stderr to LOG using `|& tee -a` via a subshell.
  mkdir -p "$(dirname "$LOG")"
  (
    setsid nohup bash -lc "
      TIMED_API_KEY='$API_KEY' \
      /workspace/scripts/continuous-slice.sh \
        --start=$START_DATE \
        --end=$END_DATE \
        --run-id=$V9_ID \
        --tickers=$TICKERS_SPEC \
        --watchdog-seconds=420 \
        --resume 2>&1 | tee -a $LOG
    " </dev/null >>"$LOG" 2>&1 &
  ) &
  log "relaunched — new continuous-slice detached and running"
}

heartbeat_ts=0
last_reported_age=0

while true; do
  age=$(heartbeat_age_sec)
  now=$(date +%s)

  # Heartbeat of our own every 2.5 minutes so we're obviously alive
  if (( now - heartbeat_ts > 150 )); then
    log "heartbeat: heartbeat_age=${age}s (stall threshold ${STALL_MIN}min)"
    heartbeat_ts=$now
  fi

  # Quick completion check via checkpoint (non-blocking)
  checkpoint="/workspace/data/trade-analysis/${V9_ID}/continuous.checkpoint.json"
  if [[ -f "$checkpoint" ]]; then
    last_day=$(timeout 3 jq -r '.last_completed_date // ""' "$checkpoint" 2>/dev/null || echo "")
    if [[ "$last_day" == "$END_DATE" ]]; then
      log "run completed (checkpoint at $END_DATE) — exiting watchdog"
      break
    fi
  fi

  # Stall detection: heartbeat file hasn't been touched in STALL_MIN minutes
  if (( age > STALL_MIN * 60 )); then
    log "STALL DETECTED: heartbeat_age=${age}s > ${STALL_MIN}min threshold"
    kill_everything
    release_lock_server_side
    sleep 3
    relaunch
    # Reset clock — give fresh process a grace period
    touch "$HEARTBEAT_FILE" 2>/dev/null || true
    sleep 60
  fi

  sleep "$POLL_SEC"
done

log "watchdog exit"
