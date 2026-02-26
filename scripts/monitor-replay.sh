#!/bin/bash
# Monitor running backtest progress
# Usage: ./scripts/monitor-replay.sh [logfile]
# If no logfile given, uses the most recent replay-*.log in data/

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

HOLIDAYS="2025-07-04 2025-09-01 2025-11-27 2025-12-25 2026-01-01 2026-01-19 2026-02-16"

count_trading_days() {
  local start="$1" end="$2" count=0
  local current="$start"
  while [[ "$current" < "$end" ]] || [[ "$current" == "$end" ]]; do
    local dow=$(date -j -f "%Y-%m-%d" "$current" "+%u" 2>/dev/null || date -d "$current" "+%u")
    if [[ "$dow" -lt 6 ]] && [[ " $HOLIDAYS " != *" $current "* ]]; then
      count=$((count + 1))
    fi
    current=$(date -j -v+1d -f "%Y-%m-%d" "$current" "+%Y-%m-%d" 2>/dev/null || date -d "$current + 1 day" "+%Y-%m-%d")
  done
  echo "$count"
}

# Find the log file
if [[ -n "$1" && -f "$1" ]]; then
  LOG="$1"
else
  LOG=$(ls -t data/replay-*.log 2>/dev/null | head -1)
fi

if [[ -z "$LOG" || ! -f "$LOG" ]]; then
  echo -e "${RED}No replay log found. Run the backtest first or pass a logfile path.${NC}"
  exit 1
fi

echo -e "${DIM}Monitoring: $LOG${NC}"
echo ""

# Parse start/end from the log header
START_DATE=$(grep -o '[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\} → [0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}' "$LOG" | head -1 | awk '{print $1}')
END_DATE=$(grep -o '[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\} → [0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}' "$LOG" | head -1 | awk '{print $3}')
BATCH_SIZE=$(grep "Ticker batch:" "$LOG" | head -1 | grep -o '[0-9]*' | head -1)
INTERVAL=$(grep "Interval:" "$LOG" | head -1 | grep -o '[0-9]*m' | head -1)

if [[ -z "$START_DATE" ]]; then START_DATE="2025-07-01"; fi
if [[ -z "$END_DATE" ]]; then END_DATE="2026-02-26"; fi

TOTAL_DAYS=$(count_trading_days "$START_DATE" "$END_DATE")

# Find the PID — look for caffeinate or full-backtest.sh
BT_PID=$(pgrep -f "full-backtest.sh.*$START_DATE" 2>/dev/null | head -1)
if [[ -z "$BT_PID" ]]; then
  BT_PID=$(pgrep -f "full-backtest.sh" 2>/dev/null | head -1)
fi

# Get file creation time as start reference
LOG_BIRTH=$(stat -f %B "$LOG" 2>/dev/null || stat -c %W "$LOG" 2>/dev/null || echo "0")

while true; do
  # Re-check PID
  IS_RUNNING=""
  if [[ -n "$BT_PID" ]]; then
    IS_RUNNING=$(ps -p "$BT_PID" -o pid= 2>/dev/null || echo "")
  fi
  if [[ -z "$IS_RUNNING" ]]; then
    BT_PID=$(pgrep -f "full-backtest.sh" 2>/dev/null | head -1)
    if [[ -n "$BT_PID" ]]; then IS_RUNNING="$BT_PID"; fi
  fi

  # Parse progress from log
  LAST_DAY=$(grep "^=== Processing " "$LOG" | tail -1 | sed 's/=== Processing \(.*\) ===/\1/')
  DAYS_STARTED=$(grep -c "^=== Processing " "$LOG" 2>/dev/null || echo "0")
  DAYS_COMPLETED=$(grep -c "Day complete:" "$LOG" 2>/dev/null || echo "0")

  # Sum trades and scores from "Day complete:" lines
  TOTAL_TRADES=$(grep "Day complete:" "$LOG" | grep -o 'trades=[0-9]*' | grep -o '[0-9]*' | paste -sd+ - | bc 2>/dev/null || echo "0")
  TOTAL_SCORED=$(grep "Day complete:" "$LOG" | grep -o 'scored=[0-9]*' | grep -o '[0-9]*' | paste -sd+ - | bc 2>/dev/null || echo "0")
  TOTAL_ERRORS=$(grep "Day complete:" "$LOG" | grep -o 'errors=[0-9]*' | grep -o '[0-9]*' | paste -sd+ - | bc 2>/dev/null || echo "0")
  TOTAL_OPEN=$(grep "Day complete:" "$LOG" | tail -1 | grep -o 'total=[0-9]*' | grep -o '[0-9]*' || echo "?")

  LAST_BATCH=$(grep "  batch \|  scored=" "$LOG" | tail -1)
  RETRY_COUNT=$(grep -c "attempt.*failed\|retrying" "$LOG" 2>/dev/null || echo "0")

  # Elapsed time
  NOW_EPOCH=$(date "+%s")
  if [[ "$LOG_BIRTH" -gt 0 ]]; then
    ELAPSED_SEC=$((NOW_EPOCH - LOG_BIRTH))
  else
    ELAPSED_SEC=0
  fi
  ELAPSED_HR=$((ELAPSED_SEC / 3600))
  ELAPSED_MIN=$(( (ELAPSED_SEC % 3600) / 60 ))

  # ETA
  if [[ "$DAYS_COMPLETED" -gt 0 && "$ELAPSED_SEC" -gt 0 ]]; then
    SEC_PER_DAY=$((ELAPSED_SEC / DAYS_COMPLETED))
    REMAINING=$((TOTAL_DAYS - DAYS_COMPLETED))
    ETA_SEC=$((SEC_PER_DAY * REMAINING))
    ETA_HR=$((ETA_SEC / 3600))
    ETA_MIN=$(( (ETA_SEC % 3600) / 60 ))
    ETA_STR="${ETA_HR}h ${ETA_MIN}m"
    MIN_PER_DAY=$(echo "scale=1; $SEC_PER_DAY / 60" | bc 2>/dev/null || echo "?")
    PACE="${MIN_PER_DAY}m/day"
  else
    ETA_STR="calculating..."
    PACE="—"
  fi

  PCT=0
  if [[ "$TOTAL_DAYS" -gt 0 && "$DAYS_COMPLETED" -gt 0 ]]; then
    PCT=$((DAYS_COMPLETED * 100 / TOTAL_DAYS))
  fi

  # Progress bar
  BAR_W=40
  FILLED=$((PCT * BAR_W / 100))
  EMPTY=$((BAR_W - FILLED))
  BAR=$(printf "%${FILLED}s" | tr ' ' '█')$(printf "%${EMPTY}s" | tr ' ' '░')

  # Phase detection (trader-only then investor)
  PHASE="Trader Replay"
  if grep -q "Phase 2: Investor-only" "$LOG" 2>/dev/null; then
    PHASE="Investor Backfill"
  fi
  if grep -q "Backtest Complete" "$LOG" 2>/dev/null; then
    if grep -q "Investor backfill:" "$LOG" 2>/dev/null; then
      PHASE="All Phases Complete"
    else
      PHASE="Trader Done → Investor Pending"
    fi
  fi

  # Display
  clear
  echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}║  ${CYAN}Backtest Progress Monitor${NC}${BOLD}                                ║${NC}"
  echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
  echo ""

  if [[ -n "$IS_RUNNING" ]]; then
    echo -e "  Status:    ${GREEN}${BOLD}RUNNING${NC} ${DIM}(PID $BT_PID)${NC}"
  elif grep -q "Backtest Complete\|All done" "$LOG" 2>/dev/null; then
    echo -e "  Status:    ${GREEN}${BOLD}COMPLETED${NC}"
  else
    echo -e "  Status:    ${RED}${BOLD}STOPPED / ERRORED${NC}"
  fi

  echo -e "  Phase:     ${YELLOW}${BOLD}${PHASE}${NC}"
  echo -e "  Range:     ${BOLD}$START_DATE${NC} → ${BOLD}$END_DATE${NC}  ${DIM}(batch=$BATCH_SIZE, interval=$INTERVAL)${NC}"
  echo -e "  Elapsed:   ${BOLD}${ELAPSED_HR}h ${ELAPSED_MIN}m${NC}"
  echo ""
  echo -e "  Progress:  ${CYAN}${BAR}${NC} ${BOLD}${PCT}%${NC}"
  echo -e "  Days:      ${BOLD}${DAYS_COMPLETED}${NC} / ${TOTAL_DAYS} trading days"
  echo -e "  Current:   ${YELLOW}${LAST_DAY:-waiting...}${NC}"
  echo -e "  Pace:      ${DIM}${PACE}${NC}"
  echo -e "  ETA:       ${BOLD}${ETA_STR}${NC}"
  echo ""
  echo -e "  ${BOLD}Stats${NC}"
  echo -e "  ├─ Scores:    ${BOLD}${TOTAL_SCORED:-0}${NC}"
  echo -e "  ├─ Trades:    ${BOLD}${TOTAL_TRADES:-0}${NC}  ${DIM}(open: ${TOTAL_OPEN})${NC}"
  echo -e "  ├─ Errors:    ${TOTAL_ERRORS:-0}"
  echo -e "  └─ Retries:   ${RETRY_COUNT}"
  echo ""
  echo -e "  ${DIM}Latest: ${LAST_BATCH}${NC}"
  echo ""

  if [[ -z "$IS_RUNNING" ]]; then
    echo -e "${DIM}───────────────────────────────────────────────────────────${NC}"
    tail -20 "$LOG" | head -15
    echo ""
    echo -e "${DIM}Process has ended. Press Ctrl+C to exit.${NC}"
    break
  fi

  echo -e "  ${DIM}Refreshing every 30s... Ctrl+C to stop monitoring.${NC}"
  sleep 30
done
