#!/bin/bash
# Walk-Forward Validation Pipeline
# Orchestrates: bulk onboard → full backtest → calibration → profile impact → report
#
# Usage:
#   ./scripts/walk-forward.sh [test_start] [test_end] [--skip-onboard] [--skip-replay] [--trader-only]
#
# Defaults: test_start=2025-07-01, test_end=2026-02-26
# Example:  ./scripts/walk-forward.sh 2025-07-01 2026-02-26
# Resume:   ./scripts/walk-forward.sh --skip-onboard --skip-replay  (just calibrate + report)

set -e

API_BASE="https://timed-trading-ingest.shashant.workers.dev"
API_KEY="AwesomeSauce"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/data"
mkdir -p "$DATA_DIR"

SKIP_ONBOARD=false
SKIP_REPLAY=false
TRADER_ONLY=true
POSARGS=()

for arg in "$@"; do
  [[ "$arg" == "--skip-onboard" ]] && SKIP_ONBOARD=true
  [[ "$arg" == "--skip-replay" ]] && SKIP_REPLAY=true
  [[ "$arg" == "--trader-only" ]] && TRADER_ONLY=true
  [[ "$arg" != --* ]] && POSARGS+=("$arg")
done

TEST_START="${POSARGS[0]:-2025-07-01}"
TEST_END="${POSARGS[1]:-2026-02-26}"
REPORT_FILE="$DATA_DIR/walk-forward-report-$(date '+%Y%m%d-%H%M%S').json"
LOG_FILE="$DATA_DIR/walk-forward-$(date '+%Y%m%d-%H%M%S').log"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Walk-Forward Validation Pipeline                        ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Test Period:  $TEST_START → $TEST_END"
echo "║  Skip Onboard: $SKIP_ONBOARD"
echo "║  Skip Replay:  $SKIP_REPLAY"
echo "║  Log:          $LOG_FILE"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

PIPELINE_START=$(date "+%s")

# ═══════════════════════════════════════════════════════════════════════════
# STEP 1: Bulk Onboard — populate ticker profiles for all watchlist tickers
# ═══════════════════════════════════════════════════════════════════════════

if $SKIP_ONBOARD; then
  echo "⏭  Step 1: Skipping onboarding (--skip-onboard)"
  echo ""
else
  echo "═══ Step 1/4: Bulk Onboard All Tickers ═══"
  echo ""
  ONBOARD_START=$(date "+%s")

  "$SCRIPT_DIR/bulk-onboard.sh" --skip-existing 2>&1 | tee -a "$LOG_FILE"
  ONBOARD_EXIT=${PIPESTATUS[0]}

  ONBOARD_ELAPSED=$(( $(date "+%s") - ONBOARD_START ))
  echo ""
  echo "  Onboarding completed in $((ONBOARD_ELAPSED / 60))m ${ONBOARD_ELAPSED}s (exit: $ONBOARD_EXIT)"
  echo ""

  if [[ $ONBOARD_EXIT -ne 0 ]]; then
    echo "WARNING: Onboarding had errors. Continuing anyway..."
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# STEP 2: Full Backtest — replay test period with ticker profiles active
# ═══════════════════════════════════════════════════════════════════════════

if $SKIP_REPLAY; then
  echo "⏭  Step 2: Skipping replay (--skip-replay)"
  echo ""
else
  echo "═══ Step 2/4: Full Backtest ($TEST_START → $TEST_END) ═══"
  echo ""
  REPLAY_START=$(date "+%s")

  BACKTEST_ARGS="$TEST_START $TEST_END 15 10"
  if $TRADER_ONLY; then
    BACKTEST_ARGS="--trader-only $BACKTEST_ARGS"
  fi

  echo "  Running: full-backtest.sh $BACKTEST_ARGS"
  echo "  (This will take several hours. Monitor with: ./scripts/monitor-replay.sh)"
  echo ""

  nohup "$SCRIPT_DIR/full-backtest.sh" $BACKTEST_ARGS >> "$LOG_FILE" 2>&1 &
  BACKTEST_PID=$!
  echo "  Backtest PID: $BACKTEST_PID"
  echo "  Log: $LOG_FILE"
  echo ""

  # Poll for completion
  POLL_INTERVAL=60
  DOTS=0
  while kill -0 $BACKTEST_PID 2>/dev/null; do
    ELAPSED=$(( $(date "+%s") - REPLAY_START ))
    ELAPSED_MIN=$((ELAPSED / 60))

    # Check for latest day from checkpoint
    CURRENT_DAY=""
    if [[ -f "$DATA_DIR/replay-checkpoint.txt" ]]; then
      CURRENT_DAY=$(head -1 "$DATA_DIR/replay-checkpoint.txt" 2>/dev/null | tr -d '[:space:]')
    fi

    printf "\r  Running... %dm elapsed | Current: %s    " "$ELAPSED_MIN" "${CURRENT_DAY:-starting}"
    sleep $POLL_INTERVAL
  done

  wait $BACKTEST_PID 2>/dev/null
  REPLAY_EXIT=$?
  REPLAY_ELAPSED=$(( $(date "+%s") - REPLAY_START ))
  echo ""
  echo "  Replay completed in $((REPLAY_ELAPSED / 60))m (exit: $REPLAY_EXIT)"
  echo ""

  if [[ $REPLAY_EXIT -ne 0 ]]; then
    echo "WARNING: Replay exited with code $REPLAY_EXIT. Check $LOG_FILE for details."
    echo "  Continuing to calibration (may have partial results)..."
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# STEP 3: Run Calibration Analysis
# ═══════════════════════════════════════════════════════════════════════════

echo "═══ Step 3/4: Calibration Analysis ═══"
echo ""

CALIB_START=$(date "+%s")
echo "  Running POST /timed/calibration/run ..."

CALIB_RESULT=$(curl -s -m 300 -X POST \
  "$API_BASE/timed/calibration/run?key=$API_KEY" \
  -H "Content-Type: application/json" 2>&1)

CALIB_OK=$(echo "$CALIB_RESULT" | jq -r '.ok // false' 2>/dev/null)
CALIB_REPORT_ID=$(echo "$CALIB_RESULT" | jq -r '.report_id // "none"' 2>/dev/null)
CALIB_ELAPSED=$(( $(date "+%s") - CALIB_START ))

if [[ "$CALIB_OK" == "true" ]]; then
  echo "  Calibration complete (${CALIB_ELAPSED}s)"
  echo "  Report ID: $CALIB_REPORT_ID"

  # Extract key metrics
  WFO_IS=$(echo "$CALIB_RESULT" | jq -r '.wfo_summary.in_sample_sqn // "N/A"' 2>/dev/null)
  WFO_OS=$(echo "$CALIB_RESULT" | jq -r '.wfo_summary.out_sample_sqn // "N/A"' 2>/dev/null)
  WFO_DEG=$(echo "$CALIB_RESULT" | jq -r '.wfo_summary.degradation_pct // "N/A"' 2>/dev/null)
  WFO_VERDICT=$(echo "$CALIB_RESULT" | jq -r '.wfo_summary.verdict // "N/A"' 2>/dev/null)
  SH_WR=$(echo "$CALIB_RESULT" | jq -r '.system_health.overall.win_rate // "N/A"' 2>/dev/null)
  SH_EXP=$(echo "$CALIB_RESULT" | jq -r '.system_health.overall.expectancy // "N/A"' 2>/dev/null)
  SH_SQN=$(echo "$CALIB_RESULT" | jq -r '.system_health.overall.sqn // "N/A"' 2>/dev/null)
  SH_N=$(echo "$CALIB_RESULT" | jq -r '.system_health.overall.n // "N/A"' 2>/dev/null)

  echo ""
  echo "  System Health:"
  echo "    Trades: $SH_N  |  Win Rate: $SH_WR%  |  Expectancy: $SH_EXP  |  SQN: $SH_SQN"
  echo "    Walk-Fwd IS/OS: $WFO_IS / $WFO_OS (degradation: ${WFO_DEG}%) → $WFO_VERDICT"
else
  echo "  Calibration failed: $(echo "$CALIB_RESULT" | jq -r '.error // "unknown"' 2>/dev/null)"
  echo "  Full response: $(echo "$CALIB_RESULT" | head -c 500)"
fi
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# STEP 4: Profile Impact Analysis
# ═══════════════════════════════════════════════════════════════════════════

echo "═══ Step 4/4: Profile Impact Analysis ═══"
echo ""

IMPACT_START=$(date "+%s")
echo "  Running POST /timed/calibration/profile-impact ..."

IMPACT_RESULT=$(curl -s -m 120 -X POST \
  "$API_BASE/timed/calibration/profile-impact?key=$API_KEY" \
  -H "Content-Type: application/json" 2>&1)

IMPACT_OK=$(echo "$IMPACT_RESULT" | jq -r '.ok // false' 2>/dev/null)
IMPACT_ELAPSED=$(( $(date "+%s") - IMPACT_START ))

if [[ "$IMPACT_OK" == "true" ]]; then
  echo "  Profile impact analysis complete (${IMPACT_ELAPSED}s)"
  echo ""

  # ─── Overall ───
  OV_N=$(echo "$IMPACT_RESULT" | jq -r '.overall.n // 0' 2>/dev/null)
  OV_WR=$(echo "$IMPACT_RESULT" | jq -r '.overall.win_rate // 0' 2>/dev/null)
  OV_EXP=$(echo "$IMPACT_RESULT" | jq -r '.overall.expectancy // 0' 2>/dev/null)
  OV_SQN=$(echo "$IMPACT_RESULT" | jq -r '.overall.sqn // 0' 2>/dev/null)
  PROFILED=$(echo "$IMPACT_RESULT" | jq -r '.profiled_tickers // 0' 2>/dev/null)

  # ─── By Behavior Type ───
  BT_KEYS=$(echo "$IMPACT_RESULT" | jq -r '.by_behavior_type | keys[]' 2>/dev/null)

  # ─── SL Impact ───
  SL_WIDE_N=$(echo "$IMPACT_RESULT" | jq -r '.sl_impact.wide_sl.n // 0' 2>/dev/null)
  SL_WIDE_WR=$(echo "$IMPACT_RESULT" | jq -r '.sl_impact.wide_sl.win_rate // 0' 2>/dev/null)
  SL_NORM_WR=$(echo "$IMPACT_RESULT" | jq -r '.sl_impact.normal_sl.win_rate // 0' 2>/dev/null)

  # ─── TP Impact ───
  TP_EXT_N=$(echo "$IMPACT_RESULT" | jq -r '.tp_impact.extended_tp.n // 0' 2>/dev/null)
  TP_EXT_AVG=$(echo "$IMPACT_RESULT" | jq -r '.tp_impact.extended_tp.avg_pnl_pct // 0' 2>/dev/null)
  TP_NORM_AVG=$(echo "$IMPACT_RESULT" | jq -r '.tp_impact.normal_tp.avg_pnl_pct // 0' 2>/dev/null)

  # ─── Entry Threshold Impact ───
  ETH_RAISED_N=$(echo "$IMPACT_RESULT" | jq -r '.entry_threshold_impact.raised_bar.n // 0' 2>/dev/null)
  ETH_RAISED_WR=$(echo "$IMPACT_RESULT" | jq -r '.entry_threshold_impact.raised_bar.win_rate // 0' 2>/dev/null)
  ETH_NORM_WR=$(echo "$IMPACT_RESULT" | jq -r '.entry_threshold_impact.normal_bar.win_rate // 0' 2>/dev/null)

  PIPELINE_ELAPSED=$(( $(date "+%s") - PIPELINE_START ))
  PIPELINE_HRS=$((PIPELINE_ELAPSED / 3600))
  PIPELINE_MINS=$(( (PIPELINE_ELAPSED % 3600) / 60 ))

  echo ""
  echo "╔══════════════════════════════════════════════════════════════════╗"
  echo "║              WALK-FORWARD VALIDATION REPORT                     ║"
  echo "╠══════════════════════════════════════════════════════════════════╣"
  echo "║  Period: $TEST_START → $TEST_END"
  echo "║  Tickers Profiled: $PROFILED"
  echo "║  Pipeline Time: ${PIPELINE_HRS}h ${PIPELINE_MINS}m"
  echo "╠══════════════════════════════════════════════════════════════════╣"
  echo "║  OVERALL"
  echo "║    Trades: $OV_N  |  Win Rate: ${OV_WR}%  |  Exp: $OV_EXP  |  SQN: $OV_SQN"
  if [[ "$CALIB_OK" == "true" ]]; then
  echo "║    Walk-Fwd: IS=$WFO_IS  OS=$WFO_OS  (degrade: ${WFO_DEG}%) → $WFO_VERDICT"
  fi
  echo "╠══════════════════════════════════════════════════════════════════╣"
  echo "║  BY BEHAVIOR TYPE"
  for bt in $BT_KEYS; do
    BT_TC=$(echo "$IMPACT_RESULT" | jq -r ".by_behavior_type.\"$bt\".ticker_count // 0" 2>/dev/null)
    BT_N=$(echo "$IMPACT_RESULT" | jq -r ".by_behavior_type.\"$bt\".n // 0" 2>/dev/null)
    BT_WR=$(echo "$IMPACT_RESULT" | jq -r ".by_behavior_type.\"$bt\".win_rate // 0" 2>/dev/null)
    BT_EXP=$(echo "$IMPACT_RESULT" | jq -r ".by_behavior_type.\"$bt\".expectancy // 0" 2>/dev/null)
    BT_SQN=$(echo "$IMPACT_RESULT" | jq -r ".by_behavior_type.\"$bt\".sqn // 0" 2>/dev/null)
    printf "║    %-12s (%3s tickers, %4s trades)  WR=%s%%  Exp=%s  SQN=%s\n" "$bt" "$BT_TC" "$BT_N" "$BT_WR" "$BT_EXP" "$BT_SQN"
  done
  echo "╠══════════════════════════════════════════════════════════════════╣"
  echo "║  PROFILE ADJUSTMENTS IMPACT"
  echo "║    Wider SL (mult>1.1):    $SL_WIDE_N trades, WR=${SL_WIDE_WR}% (vs ${SL_NORM_WR}% normal)"
  echo "║    Extended TP (mult>1.1):  $TP_EXT_N trades, avg P&L=${TP_EXT_AVG}% (vs ${TP_NORM_AVG}%)"
  echo "║    Raised Entry Bar:        $ETH_RAISED_N trades, WR=${ETH_RAISED_WR}% (vs ${ETH_NORM_WR}%)"
  echo "╠══════════════════════════════════════════════════════════════════╣"
  echo "║  TOP 5 TICKERS BY EXPECTANCY"
  echo "$IMPACT_RESULT" | jq -r '.top_10[:5][] | "║    \(.ticker)  \(.behavior_type)  n=\(.n)  WR=\(.win_rate)%  Exp=\(.expectancy)  SL=\(.sl_mult)x  TP=\(.tp_mult)x"' 2>/dev/null
  echo "║"
  echo "║  BOTTOM 5 TICKERS"
  echo "$IMPACT_RESULT" | jq -r '.bottom_10[:5][] | "║    \(.ticker)  \(.behavior_type)  n=\(.n)  WR=\(.win_rate)%  Exp=\(.expectancy)"' 2>/dev/null
  echo "╚══════════════════════════════════════════════════════════════════╝"

  # Save full report
  jq -n \
    --arg test_start "$TEST_START" \
    --arg test_end "$TEST_END" \
    --arg report_id "$CALIB_REPORT_ID" \
    --argjson pipeline_seconds "$PIPELINE_ELAPSED" \
    --argjson impact "$IMPACT_RESULT" \
    --argjson calib_wfo "$(echo "$CALIB_RESULT" | jq '{wfo_summary, system_health: .system_health.overall, v3_regime_analysis, profile_impact}' 2>/dev/null || echo '{}')" \
    '{
      walk_forward_report: {
        test_start: $test_start,
        test_end: $test_end,
        calibration_report_id: $report_id,
        pipeline_seconds: $pipeline_seconds,
        calibration: $calib_wfo,
        profile_impact: $impact
      }
    }' > "$REPORT_FILE" 2>/dev/null

  echo ""
  echo "Full report saved to: $REPORT_FILE"

else
  echo "  Profile impact analysis failed: $(echo "$IMPACT_RESULT" | jq -r '.error // "unknown"' 2>/dev/null)"
  echo "  (This is expected if no closed trades exist yet)"
fi

echo ""
echo "═══ Walk-Forward Pipeline Complete ═══"
