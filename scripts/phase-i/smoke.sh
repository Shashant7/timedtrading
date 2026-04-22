#!/usr/bin/env bash
# Phase-I STEP smoke runner.
# Usage:
#   scripts/phase-i/smoke.sh <label> [start=2025-08-01] [end=2025-08-07]
# Produces: data/trade-analysis/phase-i-<label>-<ts>/
set -euo pipefail
API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"
LABEL="${1:?label required (e.g. 'baseline','w1','w2','w3','rankv2','all')}"
START="${2:-2025-08-01}"
END="${3:-2025-08-07}"

RUN_ID="phase-i-${LABEL}-$(date +%s)"
LOG="/workspace/data/trade-analysis/_${RUN_ID}.log"
WDLOG="/workspace/data/trade-analysis/_${RUN_ID}-watchdog.log"

echo ">>> Launching smoke: $RUN_ID"
echo "    range=${START}..${END}"
echo "    label=${LABEL}"

# Make sure no previous run is blocking
curl -sS --max-time 10 -X DELETE "$API_BASE/timed/admin/replay-lock?key=$API_KEY" > /dev/null
tmux -f /exec-daemon/tmux.portal.conf kill-session -t phase-i-smoke 2>/dev/null || true
tmux -f /exec-daemon/tmux.portal.conf kill-session -t phase-i-watchdog 2>/dev/null || true
rm -f /tmp/v9-watchdog-${RUN_ID}.lock

tmux -f /exec-daemon/tmux.portal.conf new-session -d -s phase-i-smoke -c /workspace -- \
  bash -lc "TIMED_API_KEY='$API_KEY' scripts/continuous-slice.sh \
    --start=$START --end=$END --run-id=$RUN_ID \
    --tickers=@configs/backfill-universe-2026-04-18.txt \
    --watchdog-seconds=420 2>&1 | tee -a $LOG"

sleep 8

tmux -f /exec-daemon/tmux.portal.conf new-session -d -s phase-i-watchdog -c /workspace -- \
  bash -lc "V9_ID=$RUN_ID TIMED_API_KEY='$API_KEY' \
    LOG=$LOG WATCHDOG_LOG=$WDLOG \
    HEARTBEAT_FILE=/workspace/data/trade-analysis/$RUN_ID/continuous.heartbeat \
    TICKERS_SPEC='@configs/backfill-universe-2026-04-18.txt' \
    START_DATE=$START END_DATE=$END \
    STALL_MIN=10 POLL_SEC=20 scripts/v9-watchdog.sh"

echo "$RUN_ID" > /tmp/phase_i_current_run.txt
echo "    log=${LOG}"
echo "    check progress: tail -f $LOG"
