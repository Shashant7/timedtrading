#!/usr/bin/env bash
# scripts/continuous-slice-watchdog.sh
#
# Polls the continuous-slice run every N minutes. If the progress log
# hasn't advanced (no new "day YYYY-MM-DD ok" or ">>> day" line within
# the poll window), kicks the run back into action:
#   1. Capture the current tmux session output for forensics
#   2. Kill the tmux session (frees any wedged bash wait)
#   3. Release the replay lock so a fresh run can take it
#   4. Relaunch continuous-slice.sh with --resume
#
# This is belt-and-suspenders on top of the per-day watchdog already in
# continuous-slice.sh. The per-day watchdog kills curl at 420s but a
# pathologically bad bash wait could still hang for longer. This outer
# watchdog covers that case.
#
# Usage:
#   TIMED_API_KEY=... scripts/continuous-slice-watchdog.sh \
#     --run-id=phase-f-continuous-v6 \
#     --session=phase-f-continuous-v6 \
#     [--poll-min=15] \
#     [--stall-min=20] \
#     [--start=2025-07-01] \
#     [--end=2026-04-30] \
#     [--tickers=tier1-tier2]
#
# All --start/--end/--tickers flags are ONLY used when relaunching on
# stall; they should match the original continuous-slice launch.

set -euo pipefail

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RUN_ID=""
SESSION=""
POLL_MIN=15
STALL_MIN=20
START_DATE=""
END_DATE=""
TICKERS_SPEC="tier1-tier2"
WATCHDOG_SECONDS=420

for arg in "$@"; do
  case "$arg" in
    --run-id=*) RUN_ID="${arg#*=}" ;;
    --session=*) SESSION="${arg#*=}" ;;
    --poll-min=*) POLL_MIN="${arg#*=}" ;;
    --stall-min=*) STALL_MIN="${arg#*=}" ;;
    --start=*) START_DATE="${arg#*=}" ;;
    --end=*) END_DATE="${arg#*=}" ;;
    --tickers=*) TICKERS_SPEC="${arg#*=}" ;;
    --watchdog-seconds=*) WATCHDOG_SECONDS="${arg#*=}" ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

[[ -z "$RUN_ID" ]] && { echo "Missing --run-id=..."; exit 2; }
SESSION="${SESSION:-$RUN_ID}"

ARTIFACT_DIR="${ROOT}/data/trade-analysis/${RUN_ID}"
LOG_FILE="${ARTIFACT_DIR}/continuous.log"
WATCHDOG_LOG="${ARTIFACT_DIR}/watchdog.log"
mkdir -p "$ARTIFACT_DIR"

wd_log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [watchdog] $*" | tee -a "$WATCHDOG_LOG"; }

wd_log "=== watchdog start: run=$RUN_ID session=$SESSION poll=${POLL_MIN}min stall=${STALL_MIN}min ==="

# tmux wrapper: use a function so flag parsing works correctly.
# Previous TMUX="tmux -f ..." string expansion was mangling args.
tmux_cmd() {
  if [[ -f /exec-daemon/tmux.portal.conf ]]; then
    tmux -f /exec-daemon/tmux.portal.conf "$@"
  else
    tmux "$@"
  fi
}

current_progress_line() {
  [[ -f "$LOG_FILE" ]] || { echo ""; return; }
  grep -E '^\[.*\] (day [0-9-]+ ok|>>> day [0-9]+/[0-9]+)' "$LOG_FILE" | tail -1
}

log_file_mtime() {
  [[ -f "$LOG_FILE" ]] || { echo 0; return; }
  stat -c %Y "$LOG_FILE" 2>/dev/null || stat -f %m "$LOG_FILE" 2>/dev/null || echo 0
}

is_run_complete() {
  [[ -f "$LOG_FILE" ]] || return 1
  tail -50 "$LOG_FILE" | grep -qE "continuous-slice complete|Saved [0-9]+ trades"
}

session_alive() {
  tmux_cmd has-session -t "=$SESSION" 2>/dev/null
}

relaunch_run() {
  wd_log "RELAUNCH: killing session (if any) + releasing lock"
  tmux_cmd kill-session -t "$SESSION" 2>/dev/null || true
  curl -sS -m 15 -X DELETE "$API_BASE/timed/admin/replay-lock?key=$API_KEY" > /dev/null 2>&1 || true

  # Build resume command
  local cmd="cd $ROOT && export TIMED_API_KEY=$API_KEY && scripts/continuous-slice.sh --run-id=$RUN_ID --tickers=$TICKERS_SPEC --watchdog-seconds=$WATCHDOG_SECONDS --resume"
  if [[ -n "$START_DATE" ]]; then cmd="$cmd --start=$START_DATE"; fi
  if [[ -n "$END_DATE" ]]; then cmd="$cmd --end=$END_DATE"; fi
  wd_log "RELAUNCH: $cmd"

  tmux_cmd new-session -d -s "$SESSION" -c "$ROOT" -- /bin/bash -l
  tmux_cmd send-keys -t "$SESSION:0.0" "$cmd" C-m
  wd_log "RELAUNCH: session $SESSION recreated"
}

LAST_PROGRESS=""
LAST_PROGRESS_TS=$(date -u +%s)

# Robust outer loop: if any step in a poll cycle throws, we log it and
# continue rather than let the watchdog die silently.
while true; do
  if ! sleep $((POLL_MIN * 60)); then
    wd_log "sleep interrupted, continuing"
  fi

  # Keep running even if inner logic hits an error.
  {
    if is_run_complete; then
      wd_log "RUN COMPLETE — watchdog exiting"
      exit 0
    fi

    current=$(current_progress_line || true)
    now=$(date -u +%s)
    log_mtime=$(log_file_mtime)
    log_age_s=$((now - log_mtime))
    log_age_min=$((log_age_s / 60))

    # Stall logic (fixed 2026-04-20): the "log advanced since last poll"
    # signal is necessary but not sufficient. The log may have advanced
    # to a line that was posted MUCH earlier than NOW. Decoupled watchdog
    # polls can skip intervals due to VM resource contention — if we
    # only check "is this line different from last poll?", a 60-min
    # stale line still looks OK. So:
    #   OK     = progress line changed AND log_age < stall threshold
    #            AND session alive
    #   ALERT  = log_age >= stall threshold OR session dead
    #   QUIET  = progress changed (or not), log fresh (< stall threshold),
    #            session alive — normal in-progress state
    progress_changed=false
    if [[ -n "$current" && "$current" != "$LAST_PROGRESS" ]]; then
      progress_changed=true
      LAST_PROGRESS="$current"
      LAST_PROGRESS_TS=$now
    fi

    progress_stall_min=$(( (now - LAST_PROGRESS_TS) / 60 ))
    alive=true
    session_alive || alive=false

    if [[ "$alive" != "true" ]]; then
      wd_log "ALERT tmux session missing (progress_age=${progress_stall_min}min log_age=${log_age_min}min) — relaunching"
      relaunch_run
      LAST_PROGRESS_TS=$now
    elif [[ "$log_age_min" -ge "$STALL_MIN" ]]; then
      wd_log "ALERT log stale ${log_age_min}min (threshold=${STALL_MIN}min) — relaunching"
      relaunch_run
      LAST_PROGRESS_TS=$now
    elif [[ "$progress_stall_min" -ge "$STALL_MIN" ]]; then
      wd_log "ALERT progress frozen ${progress_stall_min}min — relaunching"
      relaunch_run
      LAST_PROGRESS_TS=$now
    elif $progress_changed; then
      wd_log "OK log_age=${log_age_min}min progress=${current:0:110}"
    else
      wd_log "QUIET progress_age=${progress_stall_min}min log_age=${log_age_min}min (threshold=${STALL_MIN}min) — waiting"
    fi
  } || wd_log "poll cycle error — continuing"
done
