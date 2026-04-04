#!/bin/bash
# Focused Replay — replay specific tickers over a narrow date range for validation.
# Unlike full-backtest.sh, this does NOT reset/clear existing state. It replays
# the specified tickers in isolation and saves a compact report.
#
# Usage:
#   ./scripts/replay-focused.sh --tickers "AAPL,TSLA,NVDA" --start 2025-10-01 --end 2025-10-31
#   ./scripts/replay-focused.sh --tickers "AAPL" --start 2025-10-01 --end 2025-10-31 --label "aapl-deep-dive"
#   ./scripts/replay-focused.sh --tickers "FIX,ETN" --start 2025-07-01 --end 2025-07-25 --config-file "configs/iter5-runtime-recovered-20260325.json"
#   ./scripts/replay-focused.sh --tickers "FIX,ETN" --start 2025-07-01 --end 2025-07-25 --skip-backfill --clean-slate
#   ./scripts/replay-focused.sh --tickers "CDNS,ORCL,CSX,ITT" --start 2025-07-01 --end 2025-07-02 --clean-slate --dataset-manifest data/replay-datasets/jul1-parity/manifest.json
#   ./scripts/replay-focused.sh --from-losses 20  # Auto-pick the 20 worst-performing tickers

set -e

LOCK_ROOT="data/.locks"
LOCK_DIR="$LOCK_ROOT/replay-focused.lock"
mkdir -p "$LOCK_ROOT"

acquire_script_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" > "$LOCK_DIR/pid"
    return 0
  fi

  local existing_pid=""
  if [[ -f "$LOCK_DIR/pid" ]]; then
    existing_pid=$(tr -cd '0-9' < "$LOCK_DIR/pid" 2>/dev/null || true)
  fi

  if [[ -n "$existing_pid" ]] && ! kill -0 "$existing_pid" 2>/dev/null; then
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR"
    echo "$$" > "$LOCK_DIR/pid"
    return 0
  fi

  echo "ERROR: another replay-focused run is already active (pid=${existing_pid:-unknown})."
  echo "Stop the existing focused replay before starting a new one."
  exit 1
}

acquire_script_lock

API_BASE="https://timed-trading-ingest.shashant.workers.dev"
API_KEY="AwesomeSauce"
DEFAULT_RECOVERED_CONFIG="configs/iter5-runtime-recovered-20260325.json"
HOLIDAYS="2025-07-04 2025-09-01 2025-11-27 2025-12-25 2026-01-01 2026-01-19 2026-02-16 2026-05-25 2026-07-03 2026-09-07 2026-11-26 2026-12-25"

compute_backfill_start_date() {
  local base_start="$1"
  date -j -v-60d -f "%Y-%m-%d" "$base_start" "+%Y-%m-%d" 2>/dev/null || \
    date -d "$base_start 60 days ago" "+%Y-%m-%d" 2>/dev/null || \
    echo "$base_start"
}

resolve_frozen_dataset_manifest() {
  local ref="$1"
  if [[ -z "$ref" ]]; then
    echo ""
    return 0
  fi
  if [[ -f "$ref" ]]; then
    echo "$ref"
    return 0
  fi
  if [[ -f "data/replay-datasets/$ref/manifest.json" ]]; then
    echo "data/replay-datasets/$ref/manifest.json"
    return 0
  fi
  echo "$ref"
}

TICKERS=""
START_DATE=""
END_DATE=""
RUN_LABEL=""
INTERVAL_MIN=5
FROM_LOSSES=0
SKIP_BACKFILL=0
SKIP_MARKET_EVENTS=0
CONFIG_FILE=""
CLEAN_SLATE=0
USE_LIVE_CONFIG=0
FROZEN_DATASET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tickers) TICKERS="$2"; shift 2 ;;
    --start) START_DATE="$2"; shift 2 ;;
    --end) END_DATE="$2"; shift 2 ;;
    --label) RUN_LABEL="$2"; shift 2 ;;
    --interval) INTERVAL_MIN="$2"; shift 2 ;;
    --from-losses) FROM_LOSSES="$2"; shift 2 ;;
    --skip-backfill) SKIP_BACKFILL=1; shift ;;
    --skip-market-events) SKIP_MARKET_EVENTS=1; shift ;;
    --config-file) CONFIG_FILE="$2"; shift 2 ;;
    --clean-slate) CLEAN_SLATE=1; shift ;;
    --live-config) USE_LIVE_CONFIG=1; shift ;;
    --frozen-dataset|--dataset-manifest) FROZEN_DATASET="$2"; shift 2 ;;
    --frozen-dataset=*|--dataset-manifest=*) FROZEN_DATASET="${1#*=}"; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done
if [[ -z "$CONFIG_FILE" && "$USE_LIVE_CONFIG" -ne 1 && -f "$DEFAULT_RECOVERED_CONFIG" ]]; then
  CONFIG_FILE="$DEFAULT_RECOVERED_CONFIG"
fi

if [[ "$FROM_LOSSES" -gt 0 ]]; then
  echo "Fetching top $FROM_LOSSES underperforming tickers from losing-trades-report..."
  LOSS_DATA=$(curl -s -m 30 "$API_BASE/timed/admin/losing-trades-report?key=$API_KEY" 2>&1)
  LOSS_TICKERS=$(echo "$LOSS_DATA" | jq -r --argjson n "$FROM_LOSSES" \
    '[.report[]? | select(.total_pnl < 0)] | sort_by(.total_pnl) | .[:$n] | map(.ticker) | join(",")' 2>/dev/null || echo "")
  if [[ -z "$LOSS_TICKERS" ]]; then
    echo "Could not extract losing tickers. Check the losing-trades-report endpoint."
    exit 1
  fi
  TICKERS="$LOSS_TICKERS"
  echo "  Selected: $TICKERS"
fi

if [[ -z "$TICKERS" ]]; then
  echo "ERROR: --tickers is required (or use --from-losses N)"
  exit 1
fi
if [[ -z "$START_DATE" ]]; then START_DATE="2025-07-01"; fi
if [[ -z "$END_DATE" ]]; then END_DATE=$(date '+%Y-%m-%d'); fi
if [[ -z "$RUN_LABEL" ]]; then
  SAFE_TICKERS=$(echo "$TICKERS" | tr ',' '-' | head -c 40)
  RUN_LABEL="focused-${SAFE_TICKERS}-${START_DATE}"
fi
if [[ -n "$CONFIG_FILE" && ! -f "$CONFIG_FILE" ]]; then
  echo "ERROR: --config-file not found: $CONFIG_FILE"
  exit 1
fi

SNAPSHOT_TS=$(date "+%Y%m%d-%H%M%S")
OUT_DIR="data/backtest-artifacts/focused-${RUN_LABEL}--${SNAPSHOT_TS}"
mkdir -p "$OUT_DIR"
GIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
BF_START=$(compute_backfill_start_date "$START_DATE")
FROZEN_DATASET_MANIFEST=""
if [[ -n "$FROZEN_DATASET" ]]; then
  FROZEN_DATASET_MANIFEST=$(resolve_frozen_dataset_manifest "$FROZEN_DATASET")
  if [[ ! -f "$FROZEN_DATASET_MANIFEST" ]]; then
    echo "ERROR: --dataset-manifest not found: $FROZEN_DATASET_MANIFEST"
    exit 1
  fi
fi
CONFIG_OVERRIDE_JSON="null"
CONFIG_OVERRIDE_KEY_COUNT=0
CONFIG_OVERRIDE_SOURCE_RUN_ID=""
if [[ -n "$CONFIG_FILE" ]]; then
  CONFIG_OVERRIDE_JSON=$(jq -c '.config // .' "$CONFIG_FILE")
  CONFIG_OVERRIDE_KEY_COUNT=$(echo "$CONFIG_OVERRIDE_JSON" | jq 'keys | length')
  CONFIG_OVERRIDE_SOURCE_RUN_ID=$(jq -r '.source_run_id // empty' "$CONFIG_FILE")
fi

REPLAY_LOCK=""

cleanup() {
  if [[ -n "$REPLAY_LOCK" ]]; then
    curl -s -X DELETE "$API_BASE/timed/admin/replay-lock?key=$API_KEY" >/dev/null 2>&1 || true
  fi
  rm -rf "$LOCK_DIR"
}
trap cleanup EXIT

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Focused Replay"
echo "║  Tickers: $TICKERS"
echo "║  Range:   $START_DATE → $END_DATE"
echo "║  Interval: ${INTERVAL_MIN}m"
if [[ -n "$CONFIG_FILE" ]]; then echo "║  Config:  $CONFIG_FILE (${CONFIG_OVERRIDE_KEY_COUNT} keys)"; fi
if [[ "$CLEAN_SLATE" -eq 1 ]]; then echo "║  Mode:    clean-slate (reset working replay state on day 1)"; fi
if [[ -n "$FROZEN_DATASET_MANIFEST" ]]; then echo "║  Dataset: $FROZEN_DATASET_MANIFEST"; fi
echo "║  Output:  $OUT_DIR"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# Step 1: Ensure candle data exists for these tickers
IFS=',' read -ra TICKER_ARR <<< "$TICKERS"
if [[ -n "$FROZEN_DATASET_MANIFEST" ]]; then
  echo "Step 1: Using frozen dataset manifest ($FROZEN_DATASET_MANIFEST)"
  echo ""
elif [[ "$SKIP_BACKFILL" -eq 1 ]]; then
  echo "Step 1: Skipping backfill (--skip-backfill). Candle data assumed present in D1."
  echo ""
else
  echo "Step 1: Checking/backfilling candle data..."
  for t in "${TICKER_ARR[@]}"; do
    echo -n "  $t ... "
    BF_RES=$(curl -s -m 300 -X POST "$API_BASE/timed/admin/alpaca-backfill?startDate=$BF_START&endDate=$END_DATE&tf=all&ticker=$t&key=$API_KEY" 2>&1)
    UPSERTED=$(echo "$BF_RES" | jq -r '.upserted // 0' 2>/dev/null || echo "?")
    echo "ok (${UPSERTED} candles)"
    sleep 1
  done
  echo ""
fi

# Step 1.25: Ensure historical market events exist for the focused window
if [[ "$SKIP_MARKET_EVENTS" -eq 1 || -n "$FROZEN_DATASET_MANIFEST" ]]; then
  echo "Step 1.25: Skipping market-event seeding"
  echo ""
else
  echo "Step 1.25: Seeding historical market events..."
  TIMED_API_KEY="$API_KEY" TIMED_API_BASE="$API_BASE" node scripts/backfill-market-events.js --start "$START_DATE" --end "$END_DATE" --macro-only
  for t in "${TICKER_ARR[@]}"; do
    TIMED_API_KEY="$API_KEY" TIMED_API_BASE="$API_BASE" node scripts/backfill-market-events.js --start "$START_DATE" --end "$END_DATE" --ticker "$t"
  done
  echo ""
fi

# Step 1.5: Acquire replay lock after backfill so the run_id belongs only to replay execution
echo "Step 1.5: Acquiring replay lock..."
REPLAY_LOCK=$(curl -s -X DELETE "$API_BASE/timed/admin/replay-lock?key=$API_KEY" >/dev/null 2>&1;   curl -s -X POST "$API_BASE/timed/admin/replay-lock?reason=focused_replay_${SNAPSHOT_TS}&key=$API_KEY" | jq -r '.lock // empty')
if [[ -z "$REPLAY_LOCK" ]]; then
  echo "ERROR: failed to acquire replay lock"
  exit 1
fi
echo "  lock: $REPLAY_LOCK"
echo ""

# Step 1.6: Register focused run so config is snapshotted immediately
echo "Step 1.6: Registering focused run..."
REGISTER_PAYLOAD=$(jq -nc   --arg run_id "$REPLAY_LOCK"   --arg label "$RUN_LABEL"   --arg description "Focused replay for $TICKERS from $START_DATE to $END_DATE"   --arg start_date "$START_DATE"   --arg end_date "$END_DATE"   --argjson interval_min "$INTERVAL_MIN"   --argjson ticker_batch 0   --argjson ticker_universe_count 0   --arg status "running"   --arg status_note "Focused replay started"   --argjson trader_only true   --argjson keep_open_at_end false   --argjson low_write false   --argjson active_experiment_slot false   --arg config_file "$CONFIG_FILE"   --arg config_source_run_id "$CONFIG_OVERRIDE_SOURCE_RUN_ID"   --arg dataset_manifest "$FROZEN_DATASET_MANIFEST"   --argjson config_key_count "$CONFIG_OVERRIDE_KEY_COUNT"   --argjson config_override "$CONFIG_OVERRIDE_JSON"   --argjson params "$(jq -nc     --arg tickers "$TICKERS"     --arg snapshot_ts "$SNAPSHOT_TS"     --arg git_sha "$GIT_SHA"     --arg config_file "$CONFIG_FILE"     --arg config_source_run_id "$CONFIG_OVERRIDE_SOURCE_RUN_ID"     --arg dataset_manifest "$FROZEN_DATASET_MANIFEST"     --argjson config_key_count "$CONFIG_OVERRIDE_KEY_COUNT"     --argjson clean_slate "$([[ "$CLEAN_SLATE" -eq 1 ]] && echo true || echo false)"     --argjson skip_backfill "$([[ "$SKIP_BACKFILL" -eq 1 ]] && echo true || echo false)"     --argjson skip_market_events "$([[ "$SKIP_MARKET_EVENTS" -eq 1 ]] && echo true || echo false)"     '{tickers: ($tickers | split(",") | map(select(length > 0))), snapshot_ts: $snapshot_ts, git_sha: ($git_sha | select(length > 0)), config_file: ($config_file | select(length > 0)), config_source_run_id: ($config_source_run_id | select(length > 0)), dataset_manifest: ($dataset_manifest | select(length > 0)), config_key_count: (if $config_key_count > 0 then $config_key_count else empty end), clean_slate: $clean_slate, skip_backfill: $skip_backfill, skip_market_events: $skip_market_events}')"   --argjson tags "$(jq -nc --arg label "$RUN_LABEL" '[$label, "focused_replay"] | map(select(length > 0))')"   '{
    run_id: $run_id,
    label: $label,
    description: $description,
    start_date: $start_date,
    end_date: $end_date,
    interval_min: $interval_min,
    ticker_batch: $ticker_batch,
    ticker_universe_count: $ticker_universe_count,
    trader_only: $trader_only,
    keep_open_at_end: $keep_open_at_end,
    low_write: $low_write,
    status: $status,
    status_note: $status_note,
    active_experiment_slot: $active_experiment_slot,
    params: $params,
    tags: $tags,
    config_override: (if ($config_override | type) == "object" and ($config_override | length) > 0 then $config_override else empty end)
  }')
REGISTER_RESULT=$(curl -s -m 30 -X POST "$API_BASE/timed/admin/runs/register?key=$API_KEY"   -H "Content-Type: application/json"   -d "$REGISTER_PAYLOAD")
if ! echo "$REGISTER_RESULT" | jq -e '.ok' >/dev/null 2>&1; then
  echo "ERROR: failed to register focused run: $(echo "$REGISTER_RESULT" | head -c 300)"
  exit 1
fi
echo "  run: $REPLAY_LOCK"
echo ""

# Step 2: Replay each day (ticker-filtered)
echo "Step 2: Replaying..."
CURRENT_DATE="$START_DATE"
DAY_COUNT=0
TOTAL_SCORED=0
TOTAL_TRADES=0

while [[ "$CURRENT_DATE" < "$END_DATE" ]] || [[ "$CURRENT_DATE" == "$END_DATE" ]]; do
  DOW=$(date -j -f "%Y-%m-%d" "$CURRENT_DATE" "+%u" 2>/dev/null || date -d "$CURRENT_DATE" "+%u")
  if [[ "$DOW" -ge 6 ]] || [[ " $HOLIDAYS " == *" $CURRENT_DATE "* ]]; then
    CURRENT_DATE=$(date -j -v+1d -f "%Y-%m-%d" "$CURRENT_DATE" "+%Y-%m-%d" 2>/dev/null || date -d "$CURRENT_DATE + 1 day" "+%Y-%m-%d")
    continue
  fi

  DAY_COUNT=$((DAY_COUNT + 1))
  REPLAY_URL="$API_BASE/timed/admin/candle-replay?date=$CURRENT_DATE&tickers=$TICKERS&intervalMinutes=$INTERVAL_MIN&freshRun=1&skipInvestor=1&disableReferenceExecution=1&key=$API_KEY"
  if [[ "$CLEAN_SLATE" -eq 1 && "$DAY_COUNT" -eq 1 ]]; then
    REPLAY_URL="${REPLAY_URL}&cleanSlate=1"
  fi

  RESULT=""
  for retry in 1 2 3; do
    RESULT=$(curl -s -m 300 -X POST "$REPLAY_URL" 2>&1) || true
    if echo "$RESULT" | jq -e '.scored >= 0' >/dev/null 2>&1; then break; fi
    echo "  $CURRENT_DATE attempt $retry failed, retrying in 10s..."
    sleep 10
  done

  SCORED=$(echo "$RESULT" | jq -r '.scored // 0' 2>/dev/null || echo "0")
  TRADES=$(echo "$RESULT" | jq -r '.tradesCreated // 0' 2>/dev/null || echo "0")
  TOTAL_SCORED=$((TOTAL_SCORED + SCORED))
  TOTAL_TRADES=$((TOTAL_TRADES + TRADES))

  echo "  $CURRENT_DATE: scored=$SCORED trades=$TRADES"

  CURRENT_DATE=$(date -j -v+1d -f "%Y-%m-%d" "$CURRENT_DATE" "+%Y-%m-%d" 2>/dev/null || date -d "$CURRENT_DATE + 1 day" "+%Y-%m-%d")
  sleep 1
done
echo ""

# Step 3: Finalize focused run so trades + config are archived together
echo "Step 3: Finalizing focused run..."
FINALIZE_PAYLOAD=$(jq -nc   --arg run_id "$REPLAY_LOCK"   --arg label "$RUN_LABEL"   --arg description "Focused replay for $TICKERS from $START_DATE to $END_DATE"   --arg status "completed"   --arg status_note "Focused replay completed"   --argjson preserve_registered_config "$(if [[ -n "$CONFIG_FILE" ]]; then echo true; else echo false; fi)"   '{
    run_id: $run_id,
    label: $label,
    description: $description,
    status: $status,
    status_note: $status_note,
    preserve_registered_config: $preserve_registered_config
  }')
FINALIZE_RESULT=$(curl -s -m 120 -X POST "$API_BASE/timed/admin/runs/finalize?key=$API_KEY"   -H "Content-Type: application/json"   -d "$FINALIZE_PAYLOAD")
echo "$FINALIZE_RESULT" > "$OUT_DIR/run-finalize.json"
if ! echo "$FINALIZE_RESULT" | jq -e '.ok' >/dev/null 2>&1; then
  echo "ERROR: failed to finalize focused run: $(echo "$FINALIZE_RESULT" | head -c 300)"
  exit 1
fi
ARCHIVED_CONFIG_COUNT=$(echo "$FINALIZE_RESULT" | jq -r '.archived.config // 0' 2>/dev/null || echo "0")
echo "  archived config rows: $ARCHIVED_CONFIG_COUNT"
echo ""

# Step 4: Capture artifacts
echo "Step 4: Capturing artifacts..."
EXPORT_SUMMARY=$(node "$(dirname "$0")/export-focused-run-artifacts.js"   --run-id "$REPLAY_LOCK"   --out-dir "$OUT_DIR"   --tickers "$TICKERS"   --api-base "$API_BASE"   --api-key "$API_KEY")
echo "$EXPORT_SUMMARY"
ARCHIVED_TRADE_COUNT=$(echo "$EXPORT_SUMMARY" | jq -r '.trade_count // 0' 2>/dev/null || echo "0")
ARCHIVED_CLOSED_COUNT=$(echo "$EXPORT_SUMMARY" | jq -r '.closed_trade_count // 0' 2>/dev/null || echo "0")
ARCHIVED_CONFIG_FILE_COUNT=$(echo "$EXPORT_SUMMARY" | jq -r '.config_key_count // 0' 2>/dev/null || echo "0")
FINGERPRINT_FILE="$OUT_DIR/jul1-fingerprint.json"
FINGERPRINT_MATCHED=0
FINGERPRINT_TOTAL=0
if [[ "$START_DATE" < "2025-07-02" && "$END_DATE" > "2025-06-30" ]] || [[ "$START_DATE" == "2025-07-01" ]] || [[ "$END_DATE" == "2025-07-01" ]]; then
  FINGERPRINT_JSON=$(node "$(dirname "$0")/check-jul1-fingerprint.js" --run-id "$REPLAY_LOCK" --api-base "$API_BASE" --api-key "$API_KEY" --interval-min "$INTERVAL_MIN" --output "$FINGERPRINT_FILE")
  FINGERPRINT_MATCHED=$(echo "$FINGERPRINT_JSON" | jq -r '.matched_targets // 0' 2>/dev/null || echo "0")
  FINGERPRINT_TOTAL=$(echo "$FINGERPRINT_JSON" | jq -r '.total_targets // 0' 2>/dev/null || echo "0")
fi

cat > "$OUT_DIR/manifest.json" <<EOF
{
  "ok": true,
  "type": "focused_replay",
  "label": "$RUN_LABEL",
  "run_id": "$REPLAY_LOCK",
  "tickers": $(printf '%s
' "$TICKERS" | jq -R 'split(",") | map(select(length > 0))'),
  "start_date": "$START_DATE",
  "end_date": "$END_DATE",
  "interval_min": $INTERVAL_MIN,
  "days_processed": $DAY_COUNT,
  "total_scored": $TOTAL_SCORED,
  "created_trade_events": $TOTAL_TRADES,
  "archived_trade_count": $ARCHIVED_TRADE_COUNT,
  "archived_closed_trade_count": $ARCHIVED_CLOSED_COUNT,
  "archived_config_count": $ARCHIVED_CONFIG_FILE_COUNT,
  "dataset_manifest": $(if [[ -n "$FROZEN_DATASET_MANIFEST" ]]; then jq -Rn --arg v "$FROZEN_DATASET_MANIFEST" '$v'; else echo "null"; fi),
  "jul1_fingerprint_file": $(if [[ -f "$FINGERPRINT_FILE" ]]; then jq -Rn --arg v "$FINGERPRINT_FILE" '$v'; else echo "null"; fi),
  "jul1_fingerprint_matched": $FINGERPRINT_MATCHED,
  "jul1_fingerprint_total": $FINGERPRINT_TOTAL,
  "git_sha": "${GIT_SHA}",
  "captured_at": "$SNAPSHOT_TS"
}
EOF

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Focused Replay Complete"
echo "║  Days: $DAY_COUNT | Scored: $TOTAL_SCORED | Created: $TOTAL_TRADES | Archived: $ARCHIVED_TRADE_COUNT"
echo "║  Artifacts: $OUT_DIR"
echo "╚══════════════════════════════════════════════════════╝"

# Quick P&L summary for the targeted tickers
echo ""
echo "=== P&L Summary (targeted tickers) ==="
jq --arg tickers "$TICKERS" '
  ($tickers | split(",")) as $tList |
  [.trades[]? | select(.ticker as $t | $tList | index($t))] |
  {
    total_trades: length,
    wins: [.[] | select(.status == "WIN")] | length,
    losses: [.[] | select(.status == "LOSS")] | length,
    total_pnl: ([.[].pnl // 0] | add | . * 100 | floor / 100),
    avg_pnl_pct: (if length > 0 then ([.[].pnlPct // 0] | add / length | . * 100 | floor / 100) else 0 end),
    by_ticker: (group_by(.ticker) | map({
      ticker: .[0].ticker,
      trades: length,
      wins: ([.[] | select(.status == "WIN")] | length),
      pnl: ([.[].pnl // 0] | add | . * 100 | floor / 100)
    }))
  }
' "$OUT_DIR/trades.json" 2>/dev/null || echo "Could not parse trade data"
