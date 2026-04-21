#!/usr/bin/env bash
# V9 15-minute stall watchdog — checks progress, restarts if stuck.
#
# Logic:
#   - Sample log tail every 60s
#   - "Stuck" = no new "day YYYY-MM-DD ok" line for STALL_MIN minutes
#     AND log file mtime is also older than STALL_MIN minutes
#     (both checks required to avoid false positives from slow days)
#   - On stall: kill the tmux session, release replay lock, relaunch with
#     --resume so we pick up from last completed day
#
# Usage:
#   TIMED_API_KEY=... V9_ID=phase-h-v9-XXX bash scripts/v9-watchdog.sh

set -uo pipefail

V9_ID="${V9_ID:?V9_ID required}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"
API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
LOG="${LOG:-/workspace/data/trade-analysis/_phase-h-v9.log}"
WATCHDOG_LOG="${WATCHDOG_LOG:-/workspace/data/trade-analysis/_phase-h-v9-watchdog.log}"
STALL_MIN="${STALL_MIN:-15}"
POLL_SEC="${POLL_SEC:-60}"
SESSION="${SESSION:-phase-h-v9}"
TMUX_BIN="${TMUX_BIN:-tmux -f /exec-daemon/tmux.portal.conf}"
# Ticker spec used by relaunch. Defaults to phase-d-40 for backwards
# compat; pass TICKERS_SPEC to override (e.g. "@configs/backfill-universe-2026-04-18.txt").
TICKERS_SPEC="${TICKERS_SPEC:-phase-d-40}"
START_DATE="${START_DATE:-2025-07-01}"
END_DATE="${END_DATE:-2026-04-30}"

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[$(ts)] $*" | tee -a "$WATCHDOG_LOG"; }

last_ok_line=""
last_ok_ts=$(date +%s)

log "watchdog starting: run=$V9_ID stall_min=$STALL_MIN poll=${POLL_SEC}s log=$LOG"

heartbeat_ts=0
while true; do
  # 1) Did the run finish? (timeout guard — grep can rarely block on massive logs)
  finished=$(timeout 10 grep -cE "continuous-slice complete|Finalized run" "$LOG" 2>/dev/null || echo 0)
  if [[ "$finished" -gt 0 ]]; then
    log "run completed — exiting watchdog"
    break
  fi

  # 2) Scan for latest "day OK" line (timeout guard on grep+tail)
  current_ok=$(timeout 10 bash -c "grep -E '^\[.*\] day .* ok \{' '$LOG' 2>/dev/null | tail -1")
  now=$(date +%s)

  # Heartbeat every 5 min so we can see the watchdog is actually alive
  if (( now - heartbeat_ts > 300 )); then
    day_num=$(timeout 10 grep -cE "^\[.*\] day .* ok \{" "$LOG" 2>/dev/null || echo "?")
    log "heartbeat: day $day_num, last_ok_age=$(( now - last_ok_ts ))s"
    heartbeat_ts=$now
  fi

  if [[ -n "$current_ok" && "$current_ok" != "$last_ok_line" ]]; then
    last_ok_line="$current_ok"
    last_ok_ts=$now
    day_num=$(timeout 10 grep -cE "^\[.*\] day .* ok \{" "$LOG" 2>/dev/null || echo "?")
    log "progress: day $day_num done"
  fi

  # 3) Stall check — no "day OK" progress line in STALL_MIN minutes.
  age_sec=$(( now - last_ok_ts ))
  if (( age_sec > STALL_MIN * 60 )); then
    log "STALL DETECTED: no 'day OK' progress line in ${age_sec}s (threshold ${STALL_MIN}min)"
    log "last ok line: $last_ok_line"

    log "killing tmux session $SESSION"
    $TMUX_BIN kill-session -t "$SESSION" 2>/dev/null

    log "releasing replay lock"
    timeout 20 curl -sS --max-time 15 -X DELETE "$API_BASE/timed/admin/replay-lock?key=$API_KEY" 2>&1 | tee -a "$WATCHDOG_LOG" >/dev/null

    sleep 5

    log "relaunching with --resume (tickers=$TICKERS_SPEC)"
    $TMUX_BIN new-session -d -s "$SESSION" -c /workspace -- bash -lc \
      "TIMED_API_KEY=$API_KEY scripts/continuous-slice.sh --start=$START_DATE --end=$END_DATE --run-id=$V9_ID --tickers=$TICKERS_SPEC --watchdog-seconds=420 --resume 2>&1 | tee -a $LOG"

    last_ok_ts=$(date +%s)
    sleep 60
  fi

  sleep "$POLL_SEC"
done

log "watchdog exit"
