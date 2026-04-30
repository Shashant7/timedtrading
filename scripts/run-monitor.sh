#!/bin/bash
# Periodic 30-min status monitor for the V15 backtest run.
# Reads /workspace/.run-monitor-target for the run_id and TIMED_API_KEY.
# Writes status to /workspace/.run-monitor-status (latest snapshot).
# Appends every check to /workspace/.run-monitor.log.

TARGET_FILE="/workspace/.run-monitor-target"
STATUS_FILE="/workspace/.run-monitor-status"
LOG="/workspace/.run-monitor.log"
CHECK_INTERVAL=1800
STALL_THRESHOLD=2700
API_BASE="https://timed-trading-ingest.shashant.workers.dev"
API_KEY="${TIMED_API_KEY:-}"
UNIVERSE_FILE="/tmp/v15p06_universe.txt"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $1" | tee -a "$LOG"; }

last_day=""
last_day_seen_at=0
consecutive_stall=0

while true; do
  RUN_ID=""
  if [[ -f "$TARGET_FILE" ]]; then
    RUN_ID=$(cat "$TARGET_FILE" 2>/dev/null | head -1 | tr -d '[:space:]')
  fi
  if [[ -z "$RUN_ID" ]]; then
    sleep $CHECK_INTERVAL
    continue
  fi

  LOG_FILE="/workspace/data/trade-analysis/${RUN_ID}/continuous.log"
  HEARTBEAT_FILE="/workspace/data/trade-analysis/${RUN_ID}/continuous.heartbeat"
  now=$(date +%s)

  current_day_line=$(grep -E ">>> day [0-9]+/" "$LOG_FILE" 2>/dev/null | tail -1)
  current_day=$(echo "$current_day_line" | sed -E 's/.*day ([0-9]+)\/210.*/\1/')
  current_date=$(echo "$current_day_line" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | tail -1)

  hb_age=999999
  if [[ -f "$HEARTBEAT_FILE" ]]; then
    hb_mtime=$(stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
    hb_age=$((now - hb_mtime))
  fi

  cs_pids=$(pgrep -f "continuous-slice.sh.*${RUN_ID}" 2>/dev/null | wc -l)
  curl_pids=$(pgrep -f "curl.*candle-replay" 2>/dev/null | wc -l)

  trade_count=0
  pnl_sum="?"
  wins=0
  if [[ -n "$API_KEY" ]]; then
    trades_json=$(timeout 30 curl -sS -m 25 "$API_BASE/timed/admin/runs/trades?run_id=${RUN_ID}&limit=500&key=$API_KEY" 2>/dev/null)
    if [[ -n "$trades_json" ]]; then
      trade_count=$(echo "$trades_json" | python3 -c "import json,sys; d=json.load(sys.stdin); t=d.get('trades') or []; print(len([x for x in t if x.get('status') in ('WIN','LOSS')]))" 2>/dev/null || echo 0)
      pnl_sum=$(echo "$trades_json" | python3 -c "import json,sys; d=json.load(sys.stdin); t=d.get('trades') or []; print(round(sum((x.get('pnl_pct') or 0) for x in t if x.get('status') in ('WIN','LOSS')), 2))" 2>/dev/null || echo 0)
      wins=$(echo "$trades_json" | python3 -c "import json,sys; d=json.load(sys.stdin); t=d.get('trades') or []; print(len([x for x in t if x.get('status') in ('WIN','LOSS') and (x.get('pnl_pct') or 0) > 0]))" 2>/dev/null || echo 0)
    fi
  fi
  losses=$((trade_count - wins))
  wr_pct="0"
  if [[ "$trade_count" -gt 0 ]]; then
    wr_pct=$(python3 -c "print(round($wins / $trade_count * 100, 1))")
  fi

  stall_detected="no"
  if [[ -n "$current_date" ]]; then
    if [[ "$current_date" == "$last_day" ]]; then
      seconds_on_same_day=$((now - last_day_seen_at))
      if [[ $seconds_on_same_day -gt $STALL_THRESHOLD ]]; then
        stall_detected="yes"
      fi
    else
      last_day="$current_date"
      last_day_seen_at=$now
      consecutive_stall=0
    fi
  fi

  cat > "${STATUS_FILE}.tmp" << EOF
v15-run status (run_id=${RUN_ID})
========================================
Last check:        $(date -u '+%Y-%m-%dT%H:%M:%SZ')
Current day:       ${current_day:-?}/210 (${current_date:-?})
Heartbeat age:     ${hb_age}s
Stall detected:    ${stall_detected}
Same-day duration: $((now - last_day_seen_at))s on ${last_day}
Continuous-slice:  ${cs_pids} processes
Curl in flight:    ${curl_pids} processes
Trades closed:     ${trade_count} (W:${wins} L:${losses}, WR ${wr_pct}%)
Total PnL:         ${pnl_sum}%
Last log line:     $(tail -1 "$LOG_FILE" 2>/dev/null | head -c 200)
EOF
  mv "${STATUS_FILE}.tmp" "$STATUS_FILE"

  if [[ "$stall_detected" == "yes" ]]; then
    consecutive_stall=$((consecutive_stall + 1))
    log "STALL: same day ${current_date} for $((now - last_day_seen_at))s, count=${consecutive_stall}, cs=${cs_pids}, curl=${curl_pids}, hb_age=${hb_age}s"

    if [[ $curl_pids -gt 0 ]]; then
      log "  -> Killing $curl_pids stuck curl processes"
      pkill -KILL -f "curl.*candle-replay" 2>/dev/null
      pkill -KILL -f "setsid curl" 2>/dev/null
    fi

    if [[ $cs_pids -eq 0 ]]; then
      log "  -> continuous-slice DIED, attempting --resume relaunch"
      timeout 15 curl -sS -m 10 -X DELETE "$API_BASE/timed/admin/replay-lock?key=$API_KEY" >/dev/null 2>&1 || true
      UNIVERSE=$(cat "$UNIVERSE_FILE" 2>/dev/null)
      if [[ -n "$UNIVERSE" ]]; then
        timeout 15 curl -sS -m 10 -X POST "$API_BASE/timed/admin/replay-lock?reason=${RUN_ID}-resume&key=$API_KEY" >/dev/null 2>&1 || true
        # Use nohup so it survives
        nohup bash /workspace/scripts/continuous-slice.sh \
          --start=2025-07-01 --end=2026-04-30 \
          --run-id="$RUN_ID" --tickers="$UNIVERSE" \
          --watchdog-seconds=900 --resume \
          > "/tmp/${RUN_ID}.log.resume" 2>&1 &
        log "  -> Relaunched continuous-slice via nohup"
      fi
    fi
  else
    log "OK: day ${current_day:-?}/210 (${current_date:-?}), hb=${hb_age}s, cs=${cs_pids}, curl=${curl_pids}, trades=${trade_count}, WR=${wr_pct}%, PnL=${pnl_sum}%"
    consecutive_stall=0
  fi

  sleep $CHECK_INTERVAL
done
