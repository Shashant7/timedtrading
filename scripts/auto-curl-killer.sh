#!/bin/bash
# Auto-kill stuck curl processes for the active backtest run.
#
# Reads the run_id from /workspace/.auto-killer-target so we can
# update the target without restarting the killer.
#
# Polls heartbeat freshness every 30s. If heartbeat is older than 240s
# (4 minutes) AND there's a curl in flight, kill it. The continuous-slice
# script will then retry the request.

TARGET_FILE="/workspace/.auto-killer-target"
LOG="/workspace/.auto-killer.log"
# V15 P0.7.15 (2026-04-28): tighten stall threshold from 240s -> 150s.
# A normal batch takes 12-15s. 150s gives 10x headroom but still kills
# stalls quickly. Saves ~12 min per stall vs the 900s curl --max-time.
# Also poll every 15s instead of 30s so worst-case kill-time = 165s.
STALE_THRESHOLD=150
VERBOSE_INTERVAL=600
POLL_INTERVAL=15

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] auto-curl-killer started" >> "$LOG"
last_verbose=0

while true; do
  if [[ -f "$TARGET_FILE" ]]; then
    RUN_ID=$(cat "$TARGET_FILE" 2>/dev/null | head -1 | tr -d '[:space:]')
    if [[ -n "$RUN_ID" ]]; then
      HB="/workspace/data/trade-analysis/${RUN_ID}/continuous.heartbeat"
      if [[ -f "$HB" ]]; then
        NOW=$(date +%s)
        HB_TIME=$(stat -c %Y "$HB" 2>/dev/null || echo 0)
        AGE=$((NOW - HB_TIME))

        if [[ $AGE -gt $STALE_THRESHOLD ]]; then
          STUCK_CURLS=$(pgrep -f "curl.*candle-replay" 2>/dev/null | head -10 | tr '\n' ' ')
          STUCK_SETSID=$(pgrep -f "setsid curl" 2>/dev/null | head -10 | tr '\n' ' ')

          if [[ -n "$STUCK_CURLS" || -n "$STUCK_SETSID" ]]; then
            echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] STALE: hb=${AGE}s for ${RUN_ID}, killing curls='${STUCK_CURLS}' setsid='${STUCK_SETSID}'" >> "$LOG"
            for pid in $STUCK_CURLS $STUCK_SETSID; do
              kill -KILL "$pid" 2>/dev/null
            done
          else
            echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] STALE_NO_TARGET: hb=${AGE}s but no curls to kill" >> "$LOG"
          fi
        fi

        if [[ $((NOW - last_verbose)) -ge $VERBOSE_INTERVAL ]]; then
          echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] HEARTBEAT_OK: hb=${AGE}s for ${RUN_ID}" >> "$LOG"
          last_verbose=$NOW
        fi
      else
        echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] NO_HEARTBEAT_FILE: ${HB}" >> "$LOG"
      fi
    fi
  fi
  sleep "$POLL_INTERVAL"
done
