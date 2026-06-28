#!/usr/bin/env bash
# scripts/investor-slice.sh — Investor-Mode training slice (trader-parity).
#
# The Active Trader evolves via scripts/monthly-slice.sh: reset → replay a month
# day-by-day under a run_id → analyze → tune deep_audit_* knobs → re-run →
# compare vs an anchor. Investor Mode had the replay PRIMITIVE
# (/timed/admin/investor-replay) but no turnkey iterate-and-compare loop. This
# driver is the investor analog so the lane gets the SAME training regimen.
#
# It:
#   1. Acquires the worker replay lock (single-writer; never steps on a
#      BacktestRunner DO or another slice).
#   2. Resets the replay lane (replayOnly) on a fresh run.
#   3. Walks the period calling POST /timed/admin/investor-replay?date= one
#      trading day at a time (weekends/holidays skipped), with retries.
#   4. Closes residual open positions and prints the accuracy report
#      (WR / P&L / payoff, split by FSD tier) via investor-accuracy-report.mjs.
#
# Run on PRE-PROD (isolated D1) so live investor state is never touched.
#
# Usage:
#   TIMED_API_KEY=... scripts/investor-slice.sh \
#     --month=2025-07 \
#     [--run-id=investor-slice-2025-07-v1] \
#     [--api-base=https://timed-trading-ingest-preprod.shashant.workers.dev] \
#     [--resume] [--no-reset] [--seed-daystate] [--dry-run]
#
# Exit codes: 0 ok · 2 usage · 3 single-writer guard · 5 worker error · 6 lock IO

set -euo pipefail

DEFAULT_API_BASE="https://timed-trading-ingest-preprod.shashant.workers.dev"
RETRIES_PER_DAY=5
RETRY_BACKOFF_SECONDS=30
WATCHDOG_SECONDS=120

MONTH=""; START=""; END=""; RUN_ID=""; RESUME=false; DRY_RUN=false; RESET_ON_FRESH=true; SEED_DAYSTATE=false
API_BASE="$DEFAULT_API_BASE"
API_KEY="${TIMED_API_KEY:-${TIMED_TRADING_API_KEY:-}}"

NYSE_HOLIDAYS="2025-07-04 2025-09-01 2025-11-27 2025-12-25 2026-01-01 2026-01-19 2026-02-16 2026-04-03 2026-05-25 2026-06-19 2026-07-03 2026-09-07 2026-11-26 2026-12-25"

die_usage() { echo "ERROR: $1" >&2; echo "Usage: $0 --month=YYYY-MM [--run-id=..] [--start=.. --end=..] [--api-base=url] [--resume] [--no-reset] [--dry-run]" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  arg="$1"; shift
  case "$arg" in
    --month=*) MONTH="${arg#*=}" ;;
    --start=*) START="${arg#*=}" ;;
    --end=*) END="${arg#*=}" ;;
    --run-id=*) RUN_ID="${arg#*=}" ;;
    --api-base=*) API_BASE="${arg#*=}" ;;
    --resume) RESUME=true ;;
    --no-reset) RESET_ON_FRESH=false ;;
    --seed-daystate) SEED_DAYSTATE=true ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die_usage "unknown arg: $arg" ;;
  esac
done

[[ -z "$API_KEY" ]] && die_usage "TIMED_API_KEY (or TIMED_TRADING_API_KEY) required"
command -v jq >/dev/null || die_usage "jq required"
command -v python3 >/dev/null || die_usage "python3 required"

if [[ -n "$MONTH" ]]; then
  [[ "$MONTH" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]] || die_usage "--month must be YYYY-MM"
  START="${MONTH}-01"
  END=$(date -u -d "${START} +1 month -1 day" "+%Y-%m-%d")
fi
[[ -z "$START" || -z "$END" ]] && die_usage "provide --month=YYYY-MM or --start/--end"
[[ -z "$RUN_ID" ]] && RUN_ID="investor-slice-${MONTH:-${START}}-$(date -u +%H%M%S)"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ART_DIR="$REPO_ROOT/data/trade-analysis/${RUN_ID//[^[:alnum:]._-]/-}"
LOCK_TOKEN="investor_slice_${RUN_ID}"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
http() { curl -sS -m "${3:-60}" -X "$1" "$2" -H "Content-Type: application/json" -H "X-API-Key: $API_KEY"; }

is_weekend() { local d; d=$(date -u -d "$1" '+%u'); [[ "$d" == "6" || "$d" == "7" ]]; }
is_holiday() { [[ " $NYSE_HOLIDAYS " == *" $1 "* ]]; }
next_day() { date -u -d "$1 + 1 day" '+%Y-%m-%d'; }

log "=== Investor training slice ==="
log "period=$START → $END  run_id=$RUN_ID  base=$API_BASE  resume=$RESUME  reset=$RESET_ON_FRESH  seed=$SEED_DAYSTATE"

# Build trading-day list
DAYS=(); cur="$START"
while [[ "$cur" < "$END" || "$cur" == "$END" ]]; do
  if ! is_weekend "$cur" && ! is_holiday "$cur"; then DAYS+=("$cur"); fi
  cur=$(next_day "$cur")
done
log "trading days: ${#DAYS[@]} (${DAYS[0]} .. ${DAYS[-1]})"

if $DRY_RUN; then log "--dry-run: plan only"; exit 0; fi
mkdir -p "$ART_DIR"

# Single-writer: acquire the replay lock.
LOCK_RESP=$(http POST "$API_BASE/timed/admin/replay-lock?reason=${LOCK_TOKEN}&key=$API_KEY" 15)
if [[ "$(echo "$LOCK_RESP" | jq -r '.ok // false')" != "true" ]]; then
  log "ERROR: could not acquire replay lock: $LOCK_RESP"; exit 3
fi
log "Acquired replay lock"
release_lock() { http DELETE "$API_BASE/timed/admin/replay-lock?key=$API_KEY" 15 >/dev/null 2>&1 || true; log "Released replay lock"; }
trap release_lock EXIT INT TERM

# Reset the replay lane on a fresh run.
if $RESET_ON_FRESH && ! $RESUME; then
  R=$(http POST "$API_BASE/timed/admin/reset?resetLedger=1&skipTickerLatest=1&replayOnly=1&confirm_destroy=YES_DESTROY&key=$API_KEY" 120)
  log "reset replay lane: $(echo "$R" | jq -c '{ok}' 2>/dev/null || echo "$R" | head -c 120)"
fi

# Optional: patch monthly_bundle onto existing trader day-state before replay.
if $SEED_DAYSTATE; then
  log "=== Seeding investor day-state (monthly_bundle backfill) ==="
  SEED_ARGS=(--start="$START" --end="$END" --api-base="$API_BASE")
  TIMED_API_KEY="$API_KEY" "$REPO_ROOT/scripts/seed-investor-daystate.sh" "${SEED_ARGS[@]}" || {
    log "ERROR: seed-investor-daystate failed"; exit 5;
  }
fi

# Walk the period.
OPENED=0; CLOSED=0; ERR=0
for d in "${DAYS[@]}"; do
  attempt=1; ok=false
  while [[ "$attempt" -le "$RETRIES_PER_DAY" ]]; do
    RES=$(timeout --kill-after=10s "${WATCHDOG_SECONDS}s" curl -sS -m "$WATCHDOG_SECONDS" -X POST "$API_BASE/timed/admin/investor-replay?date=$d&key=$API_KEY" -H "X-API-Key: $API_KEY" 2>&1) && rc=$? || rc=$?
    if [[ "$rc" -eq 0 ]] && echo "$RES" | jq -e '.ok' >/dev/null 2>&1; then
      o=$(echo "$RES" | jq -r '.investor.opened // 0'); c=$(echo "$RES" | jq -r '.investor.closed // 0')
      OPENED=$((OPENED + o)); CLOSED=$((CLOSED + c))
      [[ "$o" != "0" || "$c" != "0" ]] && log "  $d  +$o open / -$c close"
      ok=true; break
    fi
    # no_day_state = nothing to replay that day (not an error)
    if echo "$RES" | grep -q "no_day_state"; then ok=true; break; fi
    log "  WARN $d attempt $attempt: $(echo "$RES" | head -c 160)"
    attempt=$((attempt + 1)); sleep "$RETRY_BACKOFF_SECONDS"
  done
  $ok || { log "  ERROR $d failed after $RETRIES_PER_DAY"; ERR=$((ERR + 1)); }
done
log "Replay complete: opened=$OPENED closed=$CLOSED errors=$ERR"

# Force-close any still-open investor positions at month-end so WR/P&L are measurable.
log "Closing open investor positions at $END"
CLOSE_INV=$(http POST "$API_BASE/timed/admin/close-investor-replay-positions?date=$END&key=$API_KEY" 60)
log "close-investor-replay-positions: $(echo "$CLOSE_INV" | jq -c '{ok, closed, open_before}' 2>/dev/null || echo "$CLOSE_INV" | head -c 120)"

# Day-state dependency guard.
# and scores the investor universe from it. The trader monthly-slice writes that
# day-state with skipInvestor=1, so it carries TRADER scoring but not the
# investor inputs (monthly bundle / accumulate stage) the investor ST-alignment
# gate needs — investor-replay then opens 0. A standalone investor slice on a
# freshly-reset env therefore cannot produce entries.
if [[ "$OPENED" == "0" && "$CLOSED" == "0" ]]; then
  log "WARN: 0 opens/closes across the whole period."
  log "      investor-replay needs INVESTOR-scored day-state. The trader"
  log "      monthly-slice writes day-state with skipInvestor=1 (trader-only),"
  log "      which lacks the investor inputs the entry gate requires."
  log "      Fix path: seed investor-inclusive day-state first (a candle-replay"
  log "      WITHOUT skipInvestor, or a per-day investor scoring pass) and run"
  log "      this slice with --no-reset so it reuses that day-state."
  log "      See docs/investor-training-regimen.md › Day-state dependency."
fi

# Accuracy report (WR / P&L / payoff by FSD tier) against the same env.
log "=== Accuracy report ==="
TIMED_API_BASE="$API_BASE" TIMED_API_KEY="$API_KEY" \
  node "$REPO_ROOT/scripts/investor-accuracy-report.mjs" --days=400 2>/dev/null | tee "$ART_DIR/report.md" || \
  log "WARN: accuracy report failed"

log "=== Investor slice $RUN_ID complete · artifacts=$ART_DIR ==="
