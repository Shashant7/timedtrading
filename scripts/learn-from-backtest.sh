#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# learn-from-backtest.sh — Automated Self-Learning Loop
#
# One-command pipeline: backtest → calibrate → apply → measure → commit/rollback
#
# Usage:
#   ./scripts/learn-from-backtest.sh                           # full loop
#   ./scripts/learn-from-backtest.sh --skip-backtest           # skip replay, just calibrate
#   ./scripts/learn-from-backtest.sh --skip-backtest --dry-run # calibrate but don't apply
#   START=2025-07-01 END=2026-02-28 ./scripts/learn-from-backtest.sh
#
# Prerequisites:
#   - Candle data complete (run ensure-candle-completeness.js first)
#   - Trail_5m_facts backfilled (run backfill-trail-facts.js first)
#   - TIMED_API_KEY set (default: AwesomeSauce)
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

API_BASE="${WORKER_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:-AwesomeSauce}"
START_DATE="${START:-2025-07-01}"
END_DATE="${END:-$(date '+%Y-%m-%d')}"
TICKER_BATCH="${BATCH:-15}"
DATA_DIR="data"
TIMESTAMP=$(date '+%Y%m%d-%H%M%S')
LOG_FILE="$DATA_DIR/learning-cycle-$TIMESTAMP.log"
METRICS_FILE="$DATA_DIR/learning-metrics.json"

SKIP_BACKTEST=false
DRY_RUN=false
for arg in "$@"; do
  [[ "$arg" == "--skip-backtest" ]] && SKIP_BACKTEST=true
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=true
done

mkdir -p "$DATA_DIR"

echo "╔══════════════════════════════════════════════════════════════╗" | tee -a "$LOG_FILE"
echo "║   SELF-LEARNING LOOP                                        ║" | tee -a "$LOG_FILE"
echo "╚══════════════════════════════════════════════════════════════╝" | tee -a "$LOG_FILE"
echo "  Date range: $START_DATE → $END_DATE" | tee -a "$LOG_FILE"
echo "  Skip backtest: $SKIP_BACKTEST  |  Dry run: $DRY_RUN" | tee -a "$LOG_FILE"
echo "  Log: $LOG_FILE" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# ── Step 0: Pre-flight — capture baseline metrics ──────────────────────────

echo "═══ Step 0: Capturing baseline metrics ═══" | tee -a "$LOG_FILE"

BASELINE_REPORT=$(curl -s -m 60 "$API_BASE/timed/calibration/report?key=$API_KEY" 2>/dev/null || echo "{}")
BASELINE_SQN=$(echo "$BASELINE_REPORT" | jq -r '.report.system_health.overall.sqn // "N/A"' 2>/dev/null || echo "N/A")
BASELINE_WR=$(echo "$BASELINE_REPORT" | jq -r '.report.system_health.overall.win_rate // "N/A"' 2>/dev/null || echo "N/A")
BASELINE_EXP=$(echo "$BASELINE_REPORT" | jq -r '.report.system_health.overall.expectancy // "N/A"' 2>/dev/null || echo "N/A")
BASELINE_PF=$(echo "$BASELINE_REPORT" | jq -r '.report.system_health.overall.profit_factor // "N/A"' 2>/dev/null || echo "N/A")

echo "  Baseline: SQN=$BASELINE_SQN  WR=$BASELINE_WR%  Exp=$BASELINE_EXP  PF=$BASELINE_PF" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# ── Step 1: Full Backtest (optional) ──────────────────────────────────────

if [[ "$SKIP_BACKTEST" != "true" ]]; then
  echo "═══ Step 1: Running full backtest ($START_DATE → $END_DATE) ═══" | tee -a "$LOG_FILE"
  echo "  This will take several hours. Monitor: tail -f $LOG_FILE" | tee -a "$LOG_FILE"

  bash "$SCRIPT_DIR/full-backtest.sh" "$START_DATE" "$END_DATE" "$TICKER_BATCH" --trader-only 2>&1 | tee -a "$LOG_FILE"

  echo "  Backtest complete." | tee -a "$LOG_FILE"
else
  echo "═══ Step 1: Skipping backtest (--skip-backtest) ═══" | tee -a "$LOG_FILE"
fi
echo "" | tee -a "$LOG_FILE"

# ── Step 2: Calibration (harvest + autopsy + analysis) ────────────────────

echo "═══ Step 2: Running calibration ═══" | tee -a "$LOG_FILE"

USE_D1=1 TIMED_API_KEY="$API_KEY" API_BASE="$API_BASE" node "$SCRIPT_DIR/calibrate.js" --lookback 250 2>&1 | tee -a "$LOG_FILE"

echo "" | tee -a "$LOG_FILE"

# ── Step 3: Apply calibration (with versioning) ──────────────────────────

REPORT_ID=$(curl -s -m 60 "$API_BASE/timed/calibration/report?key=$API_KEY" | jq -r '.report.report_id // empty' 2>/dev/null)

if [[ -z "$REPORT_ID" ]]; then
  echo "  ERROR: No calibration report found. Cannot apply." | tee -a "$LOG_FILE"
  exit 1
fi

echo "═══ Step 3: Applying calibration (report $REPORT_ID) ═══" | tee -a "$LOG_FILE"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "  DRY RUN — skipping apply" | tee -a "$LOG_FILE"
else
  APPLY_RESULT=$(curl -s -m 60 -X POST "$API_BASE/timed/calibration/apply?key=$API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"report_id\":\"$REPORT_ID\"}" 2>&1)
  APPLY_OK=$(echo "$APPLY_RESULT" | jq -r '.ok // false' 2>/dev/null || echo "false")
  APPLIED_KEYS=$(echo "$APPLY_RESULT" | jq -r '.applied // [] | join(", ")' 2>/dev/null || echo "?")
  echo "  Applied: $APPLY_OK  Keys: $APPLIED_KEYS" | tee -a "$LOG_FILE"
fi
echo "" | tee -a "$LOG_FILE"

# ── Step 4: Move discovery + diagnosis ────────────────────────────────────

echo "═══ Step 4: Move discovery + diagnosis ═══" | tee -a "$LOG_FILE"

USE_D1=1 node "$SCRIPT_DIR/discover-moves.js" --upload 2>&1 | tee -a "$LOG_FILE"
USE_D1=1 node "$SCRIPT_DIR/diagnose-missed-moves.js" 2>&1 | tee -a "$LOG_FILE"

echo "" | tee -a "$LOG_FILE"

# ── Step 5: Capture post-calibration metrics ──────────────────────────────

echo "═══ Step 5: Measuring improvement ═══" | tee -a "$LOG_FILE"

POST_REPORT=$(curl -s -m 60 "$API_BASE/timed/calibration/report?key=$API_KEY" 2>/dev/null || echo "{}")
POST_SQN=$(echo "$POST_REPORT" | jq -r '.report.system_health.overall.sqn // "N/A"' 2>/dev/null || echo "N/A")
POST_WR=$(echo "$POST_REPORT" | jq -r '.report.system_health.overall.win_rate // "N/A"' 2>/dev/null || echo "N/A")
POST_EXP=$(echo "$POST_REPORT" | jq -r '.report.system_health.overall.expectancy // "N/A"' 2>/dev/null || echo "N/A")
POST_PF=$(echo "$POST_REPORT" | jq -r '.report.system_health.overall.profit_factor // "N/A"' 2>/dev/null || echo "N/A")
POST_TRADES=$(echo "$POST_REPORT" | jq -r '.report.system_health.overall.n // "N/A"' 2>/dev/null || echo "N/A")

# Parse diagnosis results
DIAGNOSIS_FILE="$DATA_DIR/missed-move-diagnosis.json"
NO_TRAIL_PCT="N/A"
LOW_RANK_PCT="N/A"
TOTAL_DIAGNOSED="N/A"
if [[ -f "$DIAGNOSIS_FILE" ]]; then
  TOTAL_DIAGNOSED=$(jq -r '.total_diagnosed // 0' "$DIAGNOSIS_FILE" 2>/dev/null || echo "0")
  NO_TRAIL=$(jq -r '.breakdown.no_trail_data // 0' "$DIAGNOSIS_FILE" 2>/dev/null || echo "0")
  LOW_RANK=$(jq -r '.breakdown.low_rank // 0' "$DIAGNOSIS_FILE" 2>/dev/null || echo "0")
  if [[ "$TOTAL_DIAGNOSED" -gt 0 ]]; then
    NO_TRAIL_PCT=$(echo "scale=1; $NO_TRAIL * 100 / $TOTAL_DIAGNOSED" | bc 2>/dev/null || echo "?")
    LOW_RANK_PCT=$(echo "scale=1; $LOW_RANK * 100 / $TOTAL_DIAGNOSED" | bc 2>/dev/null || echo "?")
  fi
fi

# Parse discover-moves results
DISCOVERY_FILE=$(ls -t "$DATA_DIR"/move-discovery-*.json 2>/dev/null | head -1)
CAPTURE_RATE="N/A"
TOTAL_MOVES="N/A"
if [[ -n "$DISCOVERY_FILE" ]]; then
  TOTAL_MOVES=$(jq -r '.moves | length' "$DISCOVERY_FILE" 2>/dev/null || echo "0")
  CAPTURED=$(jq -r '[.moves[] | select(.capture == "FULL" or .capture == "PARTIAL")] | length' "$DISCOVERY_FILE" 2>/dev/null || echo "0")
  if [[ "$TOTAL_MOVES" -gt 0 ]]; then
    CAPTURE_RATE=$(echo "scale=1; $CAPTURED * 100 / $TOTAL_MOVES" | bc 2>/dev/null || echo "?")
  fi
fi

echo "" | tee -a "$LOG_FILE"
echo "╔══════════════════════════════════════════════════════════════╗" | tee -a "$LOG_FILE"
echo "║   LEARNING CYCLE RESULTS                                    ║" | tee -a "$LOG_FILE"
echo "╚══════════════════════════════════════════════════════════════╝" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "  Metric          Before       After" | tee -a "$LOG_FILE"
echo "  ─────────────────────────────────────" | tee -a "$LOG_FILE"
echo "  SQN             $BASELINE_SQN         $POST_SQN" | tee -a "$LOG_FILE"
echo "  Win Rate        $BASELINE_WR%        $POST_WR%" | tee -a "$LOG_FILE"
echo "  Expectancy      $BASELINE_EXP        $POST_EXP" | tee -a "$LOG_FILE"
echo "  Profit Factor   $BASELINE_PF         $POST_PF" | tee -a "$LOG_FILE"
echo "  Trades          —             $POST_TRADES" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "  Capture Rate:   $CAPTURE_RATE% ($TOTAL_MOVES total moves)" | tee -a "$LOG_FILE"
echo "  NO_TRAIL_DATA:  $NO_TRAIL_PCT% ($TOTAL_DIAGNOSED diagnosed)" | tee -a "$LOG_FILE"
echo "  LOW_RANK:       $LOW_RANK_PCT%" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# ── Step 6: Save metrics to learning-metrics.json (append-only) ──────────

CYCLE_ENTRY=$(cat <<EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "report_id": "$REPORT_ID",
  "date_range": { "start": "$START_DATE", "end": "$END_DATE" },
  "baseline": { "sqn": "$BASELINE_SQN", "win_rate": "$BASELINE_WR", "expectancy": "$BASELINE_EXP", "profit_factor": "$BASELINE_PF" },
  "post": { "sqn": "$POST_SQN", "win_rate": "$POST_WR", "expectancy": "$POST_EXP", "profit_factor": "$POST_PF", "trades": "$POST_TRADES" },
  "capture_rate_pct": "$CAPTURE_RATE",
  "total_moves": "$TOTAL_MOVES",
  "no_trail_data_pct": "$NO_TRAIL_PCT",
  "low_rank_pct": "$LOW_RANK_PCT",
  "applied": "$DRY_RUN" != "true"
}
EOF
)

# Append to metrics file (create as array if new)
if [[ -f "$METRICS_FILE" ]]; then
  # Add to existing array
  TMP=$(mktemp)
  jq --argjson entry "$CYCLE_ENTRY" '. += [$entry]' "$METRICS_FILE" > "$TMP" 2>/dev/null && mv "$TMP" "$METRICS_FILE" || echo "$CYCLE_ENTRY" >> "$METRICS_FILE"
else
  echo "[$CYCLE_ENTRY]" | jq '.' > "$METRICS_FILE" 2>/dev/null || echo "[$CYCLE_ENTRY]" > "$METRICS_FILE"
fi

echo "  Metrics saved to $METRICS_FILE" | tee -a "$LOG_FILE"

# ── Step 7: Auto-rollback if degraded ────────────────────────────────────

if [[ "$DRY_RUN" != "true" && "$BASELINE_SQN" != "N/A" && "$POST_SQN" != "N/A" ]]; then
  DEGRADED=$(echo "$POST_SQN < $BASELINE_SQN * 0.8" | bc -l 2>/dev/null || echo "0")
  if [[ "$DEGRADED" == "1" ]]; then
    echo "" | tee -a "$LOG_FILE"
    echo "  ⚠ SQN degraded >20% ($BASELINE_SQN → $POST_SQN). Rolling back..." | tee -a "$LOG_FILE"
    ROLLBACK=$(curl -s -m 30 -X POST "$API_BASE/timed/calibration/rollback?key=$API_KEY" \
      -H "Content-Type: application/json" -d '{}' 2>&1)
    ROLLBACK_OK=$(echo "$ROLLBACK" | jq -r '.ok // false' 2>/dev/null || echo "false")
    echo "  Rollback: $ROLLBACK_OK" | tee -a "$LOG_FILE"
  else
    echo "  SQN maintained or improved. Calibration committed." | tee -a "$LOG_FILE"
  fi
fi

echo "" | tee -a "$LOG_FILE"
echo "  Learning cycle complete. Full log: $LOG_FILE" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
