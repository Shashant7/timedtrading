#!/usr/bin/env bash
# scripts/multi-month-slice.sh
#
# Drive monthly-slice.sh across a sequence of months with automatic
# stall recovery. Each month gets its own run_id so Trade Autopsy /
# synthesis tooling stays clean, but this wrapper:
#   1. Runs monthly-slice.sh with a hard timeout per month.
#   2. On timeout or exit != 0, auto-salvages the partial D1 state
#      (close positions + finalize + save trades.json locally).
#   3. Moves on to the next month.
#   4. At the end, prints a summary of completed / partial / skipped.
#
# Usage:
#   TIMED_API_KEY=... scripts/multi-month-slice.sh \
#     --months=2025-07,2025-08,2025-09,...,2026-04 \
#     --version=v6 \
#     --tickers=tier1-tier2 \
#     [--slice-timeout=1800] \
#     [--watchdog-seconds=420] \
#     [--run-prefix=phase-f-slice]
#
# Salvage behaviour: if a month stalls mid-run, we keep whatever trades
# made it to D1 (that's how we rescued Jul v3, Dec v4, Oct/Dec v5, Jul v6).
#
# Design goals:
#  - One chain, start it and forget it.
#  - No tmux hibernation impact: each monthly-slice has its own sub-tmux
#    so the outer loop isn't blocked by a single stalled curl.
#  - Recoverable: the state is all on disk + D1, so if the outer driver
#    itself dies, you re-invoke the same command and it skips already-
#    finalized months.
#

set -euo pipefail

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONTHS=""
VERSION=""
TICKERS="tier1-tier2"
SLICE_TIMEOUT=1800
WATCHDOG_SECONDS=420
RUN_PREFIX="phase-f-slice"
BLOCK_CHAIN="--block-chain"

for arg in "$@"; do
  case "$arg" in
    --months=*) MONTHS="${arg#*=}" ;;
    --version=*) VERSION="${arg#*=}" ;;
    --tickers=*) TICKERS="${arg#*=}" ;;
    --slice-timeout=*) SLICE_TIMEOUT="${arg#*=}" ;;
    --watchdog-seconds=*) WATCHDOG_SECONDS="${arg#*=}" ;;
    --run-prefix=*) RUN_PREFIX="${arg#*=}" ;;
    --no-block-chain) BLOCK_CHAIN="" ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

[[ -z "$MONTHS" ]] && { echo "Missing --months=..."; exit 2; }
[[ -z "$VERSION" ]] && { echo "Missing --version=..."; exit 2; }

LOG="${ROOT}/data/trade-analysis/_multi-month-${RUN_PREFIX}-${VERSION}.log"
mkdir -p "$(dirname "$LOG")"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG"; }

salvage() {
  local run_id="$1" end_date="$2" month="$3"
  log "SALVAGE: closing any open positions at $end_date for $run_id"
  curl -sS -m 120 -X POST \
    "$API_BASE/timed/admin/close-replay-positions?date=${end_date}&runId=${run_id}&key=${API_KEY}" \
    -H "Content-Type: application/json" -d '{}' > /dev/null || true
  log "SALVAGE: finalizing $run_id"
  curl -sS -m 60 -X POST \
    "$API_BASE/timed/admin/runs/finalize?key=${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"run_id\":\"${run_id}\",\"status\":\"completed\",\"status_note\":\"Auto-salvaged by multi-month-slice after partial run for $month\"}" > /dev/null || true
  local artifact="${ROOT}/data/trade-analysis/${run_id}"
  mkdir -p "$artifact"
  log "SALVAGE: pulling trades from D1 into $artifact/trades.json"
  curl -sS -m 120 \
    "$API_BASE/timed/admin/runs/trades?run_id=${run_id}&key=${API_KEY}" \
    | python3 -c "
import json, sys
d = json.load(sys.stdin)
trades = d.get('trades') or []
out = {'run_id': '${run_id}', 'trades': trades}
print(json.dumps(out))" > "${artifact}/trades.json"
  local n
  n=$(python3 -c "import json; print(len(json.load(open('${artifact}/trades.json'))['trades']))" 2>/dev/null || echo 0)
  log "SALVAGE: $run_id saved $n trades"
}

days_for_month() {
  local m="$1"
  local y=${m%-*}
  local mo=${m#*-}
  local start="${y}-${mo}-01"
  local end
  end=$(python3 -c "
import calendar
y, mo = ${y}, ${mo}
d = calendar.monthrange(y, mo)[1]
print(f'{y}-{mo:02d}-{d:02d}')")
  echo "$start $end"
}

# --- Main loop ---
IFS=',' read -ra MONTH_ARR <<< "$MONTHS"
TOTAL=${#MONTH_ARR[@]}
COMPLETED=0
PARTIAL=0
SKIPPED=0

log "=== multi-month-slice start: ${TOTAL} months | version=${VERSION} | prefix=${RUN_PREFIX} | tickers=${TICKERS} ==="

for month in "${MONTH_ARR[@]}"; do
  run_id="${RUN_PREFIX}-${month}-${VERSION}"
  local_artifact="${ROOT}/data/trade-analysis/${run_id}"

  if [[ -f "${local_artifact}/trades.json" ]]; then
    log "SKIP: ${month} already has trades.json at ${local_artifact}/"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  log "=== month ${month} (run_id=${run_id}) start ==="
  read -r start_date end_date <<< "$(days_for_month "$month")"

  # Clear locks from any prior abandoned run
  curl -sS -m 15 -X DELETE "$API_BASE/timed/admin/replay-lock?key=$API_KEY" > /dev/null 2>&1 || true
  rm -rf "${ROOT}/data/.locks/monthly-slice.${month}.lock" 2>/dev/null || true

  # Invoke monthly-slice with hard timeout
  set +e
  timeout "$SLICE_TIMEOUT" "$SCRIPT_DIR/monthly-slice.sh" \
    --month="$month" \
    --run-id="$run_id" \
    --label="$run_id" \
    --tickers="$TICKERS" \
    --watchdog-seconds="$WATCHDOG_SECONDS" \
    $BLOCK_CHAIN 2>&1 | tee -a "$LOG"
  slice_rc=$?
  set -e

  if [[ "$slice_rc" -eq 0 && -f "${local_artifact}/trades.json" ]]; then
    log "=== month ${month} completed cleanly ==="
    COMPLETED=$((COMPLETED + 1))
  else
    log "=== month ${month} exit=${slice_rc}, local trades.json missing → SALVAGING ==="
    # Clear replay lock in case slice abandoned without releasing
    curl -sS -m 15 -X DELETE "$API_BASE/timed/admin/replay-lock?key=$API_KEY" > /dev/null 2>&1 || true
    salvage "$run_id" "$end_date" "$month"
    if [[ -f "${local_artifact}/trades.json" ]]; then
      PARTIAL=$((PARTIAL + 1))
      log "=== month ${month} SALVAGED (partial) ==="
    else
      log "=== month ${month} SALVAGE FAILED — no trades.json produced ==="
    fi
  fi
done

log "=== multi-month-slice done: completed=${COMPLETED} partial=${PARTIAL} skipped=${SKIPPED} / total=${TOTAL} ==="
