#!/usr/bin/env bash
# Phase C — Stage 1 driver
# ========================
# Runs the monthly walk-forward backtest with pause-for-calibration between
# each calendar month. Wraps continuous-slice.sh per-month, generates the
# verdict, then waits for a "go" signal in the repo before resuming.
#
# Resumption preserves state across months because:
#   * Open positions stay in D1 between leg invocations
#   * Loop 1 scorecard stays in KV (phase-c:scorecards master key)
#   * Loop 2 pulse + pause flag stay in KV
#   * Each leg passes --resume so the checkpoint walks forward day by day
#
# Lock is released between legs (continuous-slice.sh's EXIT trap), which is
# fine because no other process is racing for it on this single-user system.
# Re-acquired in seconds when the next leg launches.
#
# Usage:
#     TIMED_API_KEY=... bash scripts/phase-c-stage1-driver.sh
#
# To advance to the next month:
#     git commit an empty file at tasks/phase-c/go-YYYY-MM.txt and push.
#     This driver polls origin/main for the go-file every 60s.
#
# To override the calibration BEFORE the next month launches:
#     POST DA flag updates to /timed/admin/model-config (or use
#     scripts/v15-activate.sh and re-deploy). Then commit the go-file.
#     Loops + flags are read live from model_config every scoring cycle,
#     so changes take effect immediately when the next leg starts.

set -euo pipefail

# ── Constants ─────────────────────────────────────────────────────────
RUN_ID="phase-c-stage1-jul2025-may2026"
UNIVERSE_FILE="configs/backtest-universe-phase-c-stage1.txt"
ARTIFACT_ROOT="data/trade-analysis/$RUN_ID"
GO_DIR="tasks/phase-c"
INTERVAL_MIN=30
TICKER_BATCH=24
WATCHDOG_SECONDS=600

# Months to walk through, in order. Each leg runs from the 1st of the
# month through the LAST trading day of the month. continuous-slice.sh
# handles the trading-day filter.
LEGS=(
  "2025-07-01:2025-07-31:Jul2025"
  "2025-08-01:2025-08-31:Aug2025"
  "2025-09-01:2025-09-30:Sep2025"
  "2025-10-01:2025-10-31:Oct2025"
  "2025-11-01:2025-11-30:Nov2025"
  "2025-12-01:2025-12-31:Dec2025"
  "2026-01-01:2026-01-31:Jan2026"
  "2026-02-01:2026-02-28:Feb2026"
  "2026-03-01:2026-03-31:Mar2026"
  "2026-04-01:2026-04-30:Apr2026"
  "2026-05-01:2026-05-01:May2026"
)

mkdir -p "$ARTIFACT_ROOT" "$GO_DIR"

log() { echo "[driver $(date -u +%FT%TZ)] $*"; }

: "${TIMED_API_KEY:?TIMED_API_KEY required}"

# ── Wait for go-file ──────────────────────────────────────────────────
wait_for_go() {
  local month_label="$1"   # e.g. "2025-08"
  local go_file="$GO_DIR/go-$month_label.txt"
  log "Waiting for go-file: $go_file (commit + push to advance)"
  while true; do
    git fetch origin main --quiet 2>/dev/null || true
    if git ls-tree -r origin/main --name-only 2>/dev/null | grep -qx "$go_file"; then
      log "Found go-file for $month_label — advancing"
      git pull --rebase --quiet origin main 2>/dev/null || true
      return 0
    fi
    sleep 60
  done
}

# ── Run one leg ───────────────────────────────────────────────────────
run_leg() {
  local start_date="$1"
  local end_date="$2"
  local label="$3"
  local resume_flag="$4"     # "" or "--resume"
  local finalize_flag="$5"   # "" (skip finalize) or "--allow-finalize" (let it close all)

  # Phase C — Stage 1 (2026-05-02): every leg EXCEPT the final one
  # passes --no-finalize so open positions persist across month boundaries.
  # Only the final May leg gets the full close+finalize treatment.
  local no_finalize_flag="--no-finalize"
  [[ "$finalize_flag" == "--allow-finalize" ]] && no_finalize_flag=""

  log "=== LEG $label  $start_date → $end_date  ${resume_flag:-fresh}  ${no_finalize_flag:-FINAL+finalize} ==="
  local leg_log="$ARTIFACT_ROOT/leg-$label.log"

  TIMED_API_KEY="$TIMED_API_KEY" \
  INTERVAL_MINUTES="$INTERVAL_MIN" \
  bash scripts/continuous-slice.sh \
    --start="$start_date" \
    --end="$end_date" \
    --run-id="$RUN_ID" \
    --tickers="@$UNIVERSE_FILE" \
    --watchdog-seconds="$WATCHDOG_SECONDS" \
    $resume_flag \
    $no_finalize_flag \
    > "$leg_log" 2>&1 || {
      log "LEG $label exited non-zero — see $leg_log"
      return 1
    }
  log "LEG $label complete"
}

# ── Generate monthly verdict ──────────────────────────────────────────
generate_verdict() {
  local month_yyyy_mm="$1"     # "2025-07"
  log "Generating verdict for $month_yyyy_mm"
  TIMED_API_KEY="$TIMED_API_KEY" python3 scripts/phase-c-monthly-verdict.py \
    --run-id="$RUN_ID" \
    --month="$month_yyyy_mm" \
    --output-dir="tasks/phase-c/monthly-verdicts" \
    || log "verdict generator failed (non-fatal)"
  local out_file="tasks/phase-c/monthly-verdicts/$month_yyyy_mm-$RUN_ID.md"
  if [[ -f "$out_file" ]]; then
    log "Verdict ready: $out_file"
    git add "$out_file"
    git commit -m "phase-c: $month_yyyy_mm verdict (Stage 1)" --quiet 2>/dev/null || true
    git push origin "$(git rev-parse --abbrev-ref HEAD)" --quiet 2>/dev/null || true
  fi
}

# ── Main ──────────────────────────────────────────────────────────────
log "Phase C Stage 1 driver starting"
log "  run_id=$RUN_ID"
log "  universe=$UNIVERSE_FILE ($(wc -l < $UNIVERSE_FILE) tickers)"
log "  interval_min=$INTERVAL_MIN ticker_batch=$TICKER_BATCH"
log "  legs=${#LEGS[@]}"

LAST_IDX=$((${#LEGS[@]} - 1))
for i in "${!LEGS[@]}"; do
  IFS=':' read -r start_date end_date label <<< "${LEGS[$i]}"
  month_yyyy_mm="${start_date:0:7}"
  resume_flag=""
  [[ $i -gt 0 ]] && resume_flag="--resume"
  # Final leg gets full finalize (closes any still-open positions, marks run completed).
  finalize_flag=""
  [[ $i -eq $LAST_IDX ]] && finalize_flag="--allow-finalize"

  run_leg "$start_date" "$end_date" "$label" "$resume_flag" "$finalize_flag"
  generate_verdict "$month_yyyy_mm"

  # Don't pause after the final leg
  if [[ $i -lt $LAST_IDX ]]; then
    next_label="${LEGS[$((i+1))]}"
    next_month="${next_label:0:7}"
    wait_for_go "$next_month"
  fi
done

log "=== ALL LEGS COMPLETE — Stage 1 done ==="
