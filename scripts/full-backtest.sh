#!/bin/bash
# Full Candle-Based Backtest Script
# Usage: ./scripts/full-backtest.sh [start_date] [end_date] [ticker_batch_size]
#        ./scripts/full-backtest.sh --resume [--trader-only]
#        ./scripts/full-backtest.sh --trader-only 2025-07-01 2026-03-04 20
#        ./scripts/full-backtest.sh --trader-only --keep-open-at-end 2025-07-01 2026-03-04 20
#        ./scripts/full-backtest.sh --trader-only --low-write 2025-07-01 2026-03-04 20
# Example: ./scripts/full-backtest.sh 2025-07-01 2026-03-04 15
# Resume: ./scripts/full-backtest.sh --resume
# Trader-only (faster, no investor/snapshots): add --trader-only
# Investor-only backfill (after trader-only): ./scripts/full-backtest.sh --investor-only 2025-07-01 2026-03-04
# Sequence (trader-only then investor-only): ./scripts/full-backtest.sh --sequence 2025-07-01 2026-03-04 20
# --skip-backfill: Skip gap detection + backfill entirely (use when candles exist from prior runs)
# --force-backfill: Force full-universe backfill even if gap check fails or returns no ticker list
# Interval: 4th arg defaults to 5 (minutes). We use 5 min for replay fidelity; 10 is optional for faster runs.
# Each day is processed in batch-by-batch requests (tickerBatch tickers per request) to stay
# within Cloudflare Worker CPU/wall-time limits. Investor replay runs on the last batch.
# Note: Backfill detects candle gaps and only fills what's missing. On gap-check failure,
# it retries 3 times, then skips (safe default). Use --force-backfill to override.

set -e

API_BASE="https://timed-trading-ingest.shashant.workers.dev"
API_KEY="AwesomeSauce"
CHECKPOINT_FILE="data/replay-checkpoint.txt"
HOLIDAYS="2025-07-04 2025-09-01 2025-11-27 2025-12-25 2026-01-01 2026-01-19 2026-02-16 2026-05-25 2026-07-03 2026-09-07 2026-11-26 2026-12-25"
# Symbols known to be unavailable in our current Alpaca backfill route.
# Keep them in trading universe, but skip repeated backfill attempts.
UNSUPPORTED_BACKFILL_TICKERS=" BRK-B CL1! ES1! GC1! NQ1! SI1! VX1! SPX "

RESUME=false
TRADER_ONLY=false
INVESTOR_ONLY=false
SEQUENCE=false
KEEP_OPEN_AT_END=false
LOW_WRITE=false
SKIP_BACKFILL=false
FORCE_BACKFILL=false
RUN_LABEL=""
RUN_DESCRIPTION=""
SNAPSHOT_BEFORE_RESET=true
FROZEN_DATASET=""
ENV_OVERRIDES=()
POSARGS=()
while [[ $# -gt 0 ]]; do
  arg="$1"
  shift
  case "$arg" in
    --resume) RESUME=true ;;
    --trader-only) TRADER_ONLY=true ;;
    --investor-only) INVESTOR_ONLY=true ;;
    --sequence) SEQUENCE=true ;;
    --keep-open-at-end) KEEP_OPEN_AT_END=true ;;
    --low-write) LOW_WRITE=true ;;
    --skip-backfill) SKIP_BACKFILL=true ;;
    --force-backfill) FORCE_BACKFILL=true ;;
    --no-snapshot-before-reset) SNAPSHOT_BEFORE_RESET=false ;;
    --frozen-dataset=*) FROZEN_DATASET="${arg#--frozen-dataset=}" ;;
    --dataset-manifest=*) FROZEN_DATASET="${arg#--dataset-manifest=}" ;;
    --frozen-dataset|--dataset-manifest)
      [[ -n "$1" && "$1" != --* ]] && FROZEN_DATASET="$1" && shift
      ;;
    --label=*) RUN_LABEL="${arg#--label=}" ;;
    --desc=*|--description=*) RUN_DESCRIPTION="${arg#*=}" ;;
    --env-override=*) ENV_OVERRIDES+=("${arg#--env-override=}") ;;
    --env-override)
      [[ -n "$1" && "$1" != --* ]] && ENV_OVERRIDES+=("$1") && shift
      ;;
    *)
      [[ "$arg" != --* ]] && POSARGS+=("$arg")
      ;;
  esac
done
if $SEQUENCE; then TRADER_ONLY=true; fi

sanitize_tag() {
  echo "$1" | tr -cs '[:alnum:]_.-' '-'
}

is_backfill_supported_ticker() {
  local t="$1"
  [[ " $UNSUPPORTED_BACKFILL_TICKERS " == *" $t "* ]] && return 1
  return 0
}

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

snapshot_replay_artifacts() {
  local label="$1"
  local snapshot_ts
  snapshot_ts=$(date "+%Y%m%d-%H%M%S")
  local safe_label
  safe_label=$(sanitize_tag "$label")
  local out_dir="data/backtest-artifacts/${safe_label}-${snapshot_ts}"
  mkdir -p "$out_dir"

  echo "Saving pre-reset replay artifacts → $out_dir"

  curl -s "$API_BASE/timed/trades?source=d1&key=$API_KEY" > "$out_dir/trades.json" || true
  curl -s "$API_BASE/timed/ledger/trades?key=$API_KEY&limit=5000" > "$out_dir/ledger-trades.json" || true
  curl -s "$API_BASE/timed/ledger/summary?key=$API_KEY" > "$out_dir/ledger-summary.json" || true
  curl -s "$API_BASE/timed/account-summary?key=$API_KEY" > "$out_dir/account-summary.json" || true
  curl -s "$API_BASE/timed/admin/trade-autopsy/trades?key=$API_KEY" > "$out_dir/trade-autopsy-trades.json" || true
  curl -s "$API_BASE/timed/admin/trade-autopsy/annotations?all=1&key=$API_KEY" > "$out_dir/trade-autopsy-annotations.json" || true
  curl -s "$API_BASE/timed/admin/losing-trades-report?key=$API_KEY" > "$out_dir/losing-trades-report.json" || true

  cat > "$out_dir/manifest.json" <<EOF
{
  "ok": true,
  "label": "$safe_label",
  "captured_at": "$snapshot_ts",
  "start_date": "${START_DATE:-unknown}",
  "end_date": "${END_DATE:-unknown}",
  "trader_only": ${TRADER_ONLY},
  "sequence": ${SEQUENCE},
  "note": "Captured automatically before reset for A/B comparison."
}
EOF
}

if $RESUME; then
  if [[ -f "$CHECKPOINT_FILE" ]]; then
    CHECKPOINT_DATE=$(cat "$CHECKPOINT_FILE" | head -1 | tr -d '[:space:]')
    CHECKPOINT_END=$(sed -n '2p' "$CHECKPOINT_FILE" | tr -d '[:space:]')
    CHECKPOINT_BATCH=$(sed -n '3p' "$CHECKPOINT_FILE" | tr -d '[:space:]')
    CHECKPOINT_INTERVAL=$(sed -n '4p' "$CHECKPOINT_FILE" | tr -d '[:space:]')
    START_DATE="${CHECKPOINT_DATE}"
    END_DATE="${CHECKPOINT_END:-$(date '+%Y-%m-%d')}"
    TICKER_BATCH="${CHECKPOINT_BATCH:-15}"
    INTERVAL_MIN="${CHECKPOINT_INTERVAL:-5}"
    echo "╔══════════════════════════════════════════════════════╗"
    echo "║  RESUMING Backtest from $START_DATE → $END_DATE"
    echo "║  Ticker batch: $TICKER_BATCH | Interval: ${INTERVAL_MIN}m"
    $TRADER_ONLY && echo "║  Mode: trader-only (investor/snapshots skipped)"
    $LOW_WRITE && echo "║  Mode: low-write (skip timed_trail writes + lifecycle)"
    echo "╚══════════════════════════════════════════════════════╝"
    echo ""
  else
    echo "ERROR: No checkpoint file found at $CHECKPOINT_FILE"
    echo "Run a fresh backtest first: ./scripts/full-backtest.sh 2025-07-01 \$(date '+%Y-%m-%d') 15"
    exit 1
  fi
else
  START_DATE="${POSARGS[0]:-2025-07-01}"
  END_DATE="${POSARGS[1]:-$(date '+%Y-%m-%d')}"
  TICKER_BATCH="${POSARGS[2]:-15}"
  INTERVAL_MIN="${POSARGS[3]:-5}"
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║  Candle-Based Backtest: $START_DATE → $END_DATE"
  echo "║  Ticker batch: $TICKER_BATCH | Interval: ${INTERVAL_MIN}m"
  $TRADER_ONLY && echo "║  Mode: trader-only (investor/snapshots skipped)"
  $LOW_WRITE && echo "║  Mode: low-write (skip timed_trail writes + lifecycle)"
  $SEQUENCE && echo "║  Mode: sequence (trader-only then investor-only)"
  echo "╚══════════════════════════════════════════════════════╝"
  echo ""
fi

BF_START_DATE=$(compute_backfill_start_date "$START_DATE")
FROZEN_DATASET_MANIFEST=""
if [[ -n "$FROZEN_DATASET" ]]; then
  FROZEN_DATASET_MANIFEST=$(resolve_frozen_dataset_manifest "$FROZEN_DATASET")
fi

# ─── Investor-only only: no lock/reset/backfill/replay, just investor-replay per day ─
if $INVESTOR_ONLY && ! $SEQUENCE; then
  START_DATE="${POSARGS[0]:-2025-07-01}"
  END_DATE="${POSARGS[1]:-$(date '+%Y-%m-%d')}"
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║  Investor-only backfill: $START_DATE → $END_DATE"
  echo "╚══════════════════════════════════════════════════════╝"
  echo ""
  INV_CURRENT="$START_DATE"
  INV_DAY_COUNT=0
  while [[ "$INV_CURRENT" < "$END_DATE" ]] || [[ "$INV_CURRENT" == "$END_DATE" ]]; do
    DW=$(date -j -f "%Y-%m-%d" "$INV_CURRENT" "+%u" 2>/dev/null || date -d "$INV_CURRENT" "+%u")
    if [[ "$DW" -ge 6 ]]; then
      INV_CURRENT=$(date -j -v+1d -f "%Y-%m-%d" "$INV_CURRENT" "+%Y-%m-%d" 2>/dev/null || date -d "$INV_CURRENT + 1 day" "+%Y-%m-%d")
      continue
    fi
    if [[ " $HOLIDAYS " == *" $INV_CURRENT "* ]]; then
      INV_CURRENT=$(date -j -v+1d -f "%Y-%m-%d" "$INV_CURRENT" "+%Y-%m-%d" 2>/dev/null || date -d "$INV_CURRENT + 1 day" "+%Y-%m-%d")
      continue
    fi
    INV_RESULT=$(curl -s -m 120 -X POST "$API_BASE/timed/admin/investor-replay?date=$INV_CURRENT&key=$API_KEY" 2>&1)
    if ! echo "$INV_RESULT" | jq -e '.ok' >/dev/null 2>&1; then
      echo "ERROR: investor-replay failed for $INV_CURRENT: $(echo "$INV_RESULT" | head -c 300)"
      exit 1
    fi
    INV_DAY_COUNT=$((INV_DAY_COUNT + 1))
    echo "  $INV_CURRENT: ok"
    INV_CURRENT=$(date -j -v+1d -f "%Y-%m-%d" "$INV_CURRENT" "+%Y-%m-%d" 2>/dev/null || date -d "$INV_CURRENT + 1 day" "+%Y-%m-%d")
    sleep 1
  done
  echo ""
  echo "Investor-only backfill complete ($INV_DAY_COUNT days)."
  exit 0
fi

# ─── Step 0: Acquire replay lock ─────────────────────────────────────────────
echo "Step 0: Acquiring replay lock..."
LOCK_RESULT=$(curl -s -m 30 -X POST "$API_BASE/timed/admin/replay-lock?reason=backtest_${START_DATE}_${END_DATE}&key=$API_KEY")
echo "Lock: $(echo "$LOCK_RESULT" | jq -c '{ok, lock}' 2>/dev/null || echo "$LOCK_RESULT")"
echo ""
RUN_ID=$(echo "$LOCK_RESULT" | jq -r '.lock // ""' 2>/dev/null || echo "")
if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
  RUN_ID="backtest_${START_DATE}_${END_DATE}@$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
fi

ENV_OVERRIDES_JSON=$(printf '%s\n' "${ENV_OVERRIDES[@]}" | jq -Rn '
  [inputs | select(length > 0)] |
  reduce .[] as $item ({};
    ($item | capture("^(?<key>[^=]+)=(?<value>.*)$")?) as $pair |
    if $pair == null then . else . + { ($pair.key): $pair.value } end
  )
')
RUN_PARAMS_JSON=$(jq -nc --argjson env_overrides "$ENV_OVERRIDES_JSON" '
  if ($env_overrides | length) == 0 then null else { env_overrides: $env_overrides } end
')

REGISTER_PAYLOAD=$(jq -nc \
  --arg run_id "$RUN_ID" \
  --arg label "${RUN_LABEL:-backtest-${START_DATE}-to-${END_DATE}}" \
  --arg description "${RUN_DESCRIPTION:-}" \
  --arg start_date "$START_DATE" \
  --arg end_date "$END_DATE" \
  --argjson interval_min "$INTERVAL_MIN" \
  --argjson ticker_batch "$TICKER_BATCH" \
  --argjson ticker_universe_count 0 \
  --argjson trader_only "$($TRADER_ONLY && echo true || echo false)" \
  --argjson keep_open_at_end "$($KEEP_OPEN_AT_END && echo true || echo false)" \
  --argjson low_write "$($LOW_WRITE && echo true || echo false)" \
  --arg status "running" \
  --arg status_note "Replay started" \
  --argjson params "$RUN_PARAMS_JSON" \
  --argjson tags "$(jq -nc --arg label "${RUN_LABEL:-}" '[($label | select(length>0)), "backtest"] | map(select(. != null))')" \
  '{
    run_id: $run_id,
    label: $label,
    description: ($description | if length > 0 then . else null end),
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
    params: $params,
    tags: $tags
  }')
curl -s -m 30 -X POST "$API_BASE/timed/admin/runs/register?key=$API_KEY" \
  -H "Content-Type: application/json" \
  -d "$REGISTER_PAYLOAD" >/dev/null || true

if $RESUME; then
  echo "Step 1: SKIPPED (resuming from checkpoint $START_DATE)"
  echo ""
  echo "Step 1.5: SKIPPED (backfill already complete)"
  echo ""
else
  # ─── Step 1: Full reset ────────────────────────────────────────────────────
  if $SNAPSHOT_BEFORE_RESET; then
    CURRENT_TRADE_COUNT=$(curl -s "$API_BASE/timed/trades?source=d1&key=$API_KEY" | jq -r '.count // 0' 2>/dev/null || echo "0")
    if [[ "$CURRENT_TRADE_COUNT" != "0" ]]; then
      SNAP_LABEL="${RUN_LABEL:-pre-reset-${START_DATE}-to-${END_DATE}}"
      snapshot_replay_artifacts "$SNAP_LABEL"
      echo ""
    else
      echo "Pre-reset snapshot: skipped (no trades present)."
      echo ""
    fi
  fi

  echo "Step 1: Resetting all trade state (D1 + KV)..."
  RESET_RESULT=$(curl -s -m 300 -X POST "$API_BASE/timed/admin/reset?resetLedger=1&key=$API_KEY")
  echo "Reset: $(echo "$RESET_RESULT" | jq -c '{ok, kvCleared}' 2>/dev/null || echo "$RESET_RESULT")"
  # Verify D1 trades are actually deleted (admin/reset may silently fail on D1)
  D1_CHECK=$(echo "$RESET_RESULT" | jq -r '.d1Cleared[] | select(.sql == "DELETE FROM trades") | .changes // 0' 2>/dev/null || echo "?")
  echo "D1 trades deleted: $D1_CHECK"
  if [[ "$D1_CHECK" == "?" ]] || [[ -z "$D1_CHECK" ]]; then
    echo "WARNING: Could not verify D1 trade deletion. Forcing explicit cleanup..."
    FORCE_RESET=$(curl -s -m 60 "$API_BASE/timed/admin/candle-replay?action=force-d1-cleanup&key=$API_KEY" 2>&1)
    echo "Force cleanup: $(echo "$FORCE_RESET" | jq -c '{ok}' 2>/dev/null || echo "$FORCE_RESET")"
  fi
  echo ""

  TOTAL_TICKERS=$(curl -s "$API_BASE/timed/admin/alpaca-status?key=$API_KEY" | jq -r '.total_tickers // 200' 2>/dev/null || echo "200")
  echo "Total tickers in universe: $TOTAL_TICKERS"
  echo ""
  REGISTER_PAYLOAD=$(echo "$REGISTER_PAYLOAD" | jq --argjson ticker_universe_count "$TOTAL_TICKERS" '.ticker_universe_count = $ticker_universe_count')
  curl -s -m 30 -X POST "$API_BASE/timed/admin/runs/register?key=$API_KEY" \
    -H "Content-Type: application/json" \
    -d "$REGISTER_PAYLOAD" >/dev/null || true

  # ─── Step 1.5: Backfill candle data ─────────────────────────────────────────
  # Backfill from 60 days before start (EMA/indicator warm-up) through end date
  BF_BATCH=3

  if [[ -n "$FROZEN_DATASET_MANIFEST" ]]; then
    echo "Step 1.5: Using frozen dataset manifest ($FROZEN_DATASET_MANIFEST)"
    if [[ ! -f "$FROZEN_DATASET_MANIFEST" ]]; then
      echo "ERROR: Frozen dataset manifest not found: $FROZEN_DATASET_MANIFEST"
      exit 1
    fi
    MANIFEST_OK=$(jq -r '.ok // false' "$FROZEN_DATASET_MANIFEST" 2>/dev/null || echo "false")
    MANIFEST_START=$(jq -r '.replay_window.start_date // ""' "$FROZEN_DATASET_MANIFEST" 2>/dev/null || echo "")
    MANIFEST_END=$(jq -r '.replay_window.end_date // ""' "$FROZEN_DATASET_MANIFEST" 2>/dev/null || echo "")
    MANIFEST_COVERAGE_START=$(jq -r '.coverage_window.start_date // ""' "$FROZEN_DATASET_MANIFEST" 2>/dev/null || echo "")
    MANIFEST_COVERAGE_END=$(jq -r '.coverage_window.end_date // ""' "$FROZEN_DATASET_MANIFEST" 2>/dev/null || echo "")
    MANIFEST_SUPPORTED_GAPS=$(jq -r '.verification.supported_tickers_with_gaps // 999999' "$FROZEN_DATASET_MANIFEST" 2>/dev/null || echo "999999")
    MANIFEST_LABEL=$(jq -r '.label // ""' "$FROZEN_DATASET_MANIFEST" 2>/dev/null || echo "")
    if [[ "$MANIFEST_OK" != "true" ]]; then
      echo "ERROR: Frozen dataset manifest is not marked ok=true"
      exit 1
    fi
    if [[ "$MANIFEST_START" != "$START_DATE" || "$MANIFEST_END" != "$END_DATE" ]]; then
      echo "ERROR: Frozen dataset replay window mismatch."
      echo "  Manifest: $MANIFEST_START → $MANIFEST_END"
      echo "  Requested: $START_DATE → $END_DATE"
      exit 1
    fi
    if [[ "$MANIFEST_COVERAGE_START" != "$BF_START_DATE" || "$MANIFEST_COVERAGE_END" != "$END_DATE" ]]; then
      echo "ERROR: Frozen dataset coverage window mismatch."
      echo "  Manifest: $MANIFEST_COVERAGE_START → $MANIFEST_COVERAGE_END"
      echo "  Expected: $BF_START_DATE → $END_DATE"
      exit 1
    fi
    if [[ "$MANIFEST_SUPPORTED_GAPS" != "0" ]]; then
      echo "ERROR: Frozen dataset manifest still reports supported tickers with gaps ($MANIFEST_SUPPORTED_GAPS)."
      exit 1
    fi
    [[ -n "$MANIFEST_LABEL" ]] && echo "  Frozen dataset: $MANIFEST_LABEL"
    echo "  Verified manifest window $MANIFEST_START → $MANIFEST_END"
    echo "  Supported tickers with gaps remaining: 0"
    echo ""
  else
    # ─── Step 1.5: Candle gap detection + backfill ─────────────────────────────
    if $SKIP_BACKFILL; then
      echo "Step 1.5: SKIPPED (--skip-backfill)"
      echo ""
    else
    echo "Step 1.5: Checking candle coverage (gap detection, range $BF_START_DATE → $END_DATE)..."

    # Retry gap check up to 3 times (transient failures during deployment are common)
    GAP_OK="false"
    ALL_CLEAR="false"
    for GAP_ATTEMPT in 1 2 3; do
      GAP_RESULT=$(curl -s -m 120 \
        "$API_BASE/timed/admin/candle-gaps?startDate=$BF_START_DATE&endDate=$END_DATE&key=$API_KEY" 2>&1)
      GAP_OK=$(echo "$GAP_RESULT" | jq -r '.ok // false' 2>/dev/null || echo "false")
      if [[ "$GAP_OK" == "true" ]]; then
        break
      fi
      if [[ "$GAP_ATTEMPT" -lt 3 ]]; then
        echo "  Gap check attempt $GAP_ATTEMPT failed, retrying in 10s..."
        sleep 10
      fi
    done

    ALL_CLEAR=$(echo "$GAP_RESULT" | jq -r '.allClear // false' 2>/dev/null || echo "false")
    TICKERS_WITH_GAPS=$(echo "$GAP_RESULT" | jq -r '.tickersWithGaps // 0' 2>/dev/null || echo "0")
    GAP_COUNT=$(echo "$GAP_RESULT" | jq -r '.gapCount // 0' 2>/dev/null || echo "0")

    if [[ "$GAP_OK" != "true" ]]; then
      echo "  WARNING: Gap check failed after 3 attempts ($(echo "$GAP_RESULT" | head -c 200))"
      if $FORCE_BACKFILL; then
        echo "  --force-backfill set: proceeding with full universe backfill..."
        ALL_CLEAR="false"
        TICKERS_WITH_GAPS="$TOTAL_TICKERS"
      else
        echo "  SKIPPING backfill (candles likely already exist from prior runs)."
        echo "  Use --force-backfill to override, or fix the candle-gaps endpoint."
        ALL_CLEAR="true"
      fi
    fi

    if [[ "$ALL_CLEAR" == "true" ]]; then
      echo "  All candles present — no gaps detected. Skipping backfill."
      echo ""
    else
    BACKFILL_TICKERS=$(echo "$GAP_RESULT" | jq -r '.tickersNeedingBackfill[]' 2>/dev/null || echo "")
    BACKFILL_COUNT=$(echo "$BACKFILL_TICKERS" | grep -c . 2>/dev/null || echo "$TICKERS_WITH_GAPS")

    echo "  Found $GAP_COUNT gaps across $TICKERS_WITH_GAPS tickers. Backfilling..."
    echo ""

    BF_ROUND=0
    BF_TOTAL_UPSERTED=0
    BF_TOTAL_ERRORS=0
    BF_START_TS=$(date +%s)

    if [[ -n "$BACKFILL_TICKERS" ]]; then
      # Targeted backfill: only tickers with gaps, 3 at a time
      TICKER_ARRAY=()
      SKIPPED_UNSUPPORTED=()
      while IFS= read -r t; do
        if [[ -n "$t" ]]; then
          if is_backfill_supported_ticker "$t"; then
            TICKER_ARRAY+=("$t")
          else
            SKIPPED_UNSUPPORTED+=("$t")
          fi
        fi
      done <<< "$BACKFILL_TICKERS"

      if [ "${#SKIPPED_UNSUPPORTED[@]}" -gt 0 ]; then
        echo "  Skipping unsupported backfill symbols: ${SKIPPED_UNSUPPORTED[*]}"
      fi

      if [ "${#TICKER_ARRAY[@]}" -eq 0 ]; then
        echo "  No backfillable symbols remain after unsupported filter."
      fi

      BF_IDX=0
      while [ "$BF_IDX" -lt "${#TICKER_ARRAY[@]}" ]; do
        BF_ROUND=$((BF_ROUND + 1))
        BATCH_TICKERS=""
        BATCH_END=$((BF_IDX + BF_BATCH))
        while [ "$BF_IDX" -lt "$BATCH_END" ] && [ "$BF_IDX" -lt "${#TICKER_ARRAY[@]}" ]; do
          [[ -n "$BATCH_TICKERS" ]] && BATCH_TICKERS="${BATCH_TICKERS},"
          BATCH_TICKERS="${BATCH_TICKERS}${TICKER_ARRAY[$BF_IDX]}"
          BF_IDX=$((BF_IDX + 1))
        done

        echo -n "  [$BF_ROUND] $BATCH_TICKERS ... "

        BATCH_UPSERTED=0
        BATCH_ERRS=0
        IFS=',' read -ra BTICKERS <<< "$BATCH_TICKERS"
        for BF_TICKER in "${BTICKERS[@]}"; do
          BF_RESULT=$(curl -s -m 600 -X POST \
            "$API_BASE/timed/admin/alpaca-backfill?startDate=$BF_START_DATE&endDate=$END_DATE&tf=all&ticker=$BF_TICKER&key=$API_KEY" 2>&1)
          UPSERTED=$(echo "$BF_RESULT" | jq -r '.upserted // 0' 2>/dev/null || echo "0")
          BF_ERR=$(echo "$BF_RESULT" | jq -r '.errors // 0' 2>/dev/null || echo "0")
          BATCH_UPSERTED=$((BATCH_UPSERTED + UPSERTED))
          BATCH_ERRS=$((BATCH_ERRS + BF_ERR))
        done

        BF_TOTAL_UPSERTED=$((BF_TOTAL_UPSERTED + BATCH_UPSERTED))
        BF_TOTAL_ERRORS=$((BF_TOTAL_ERRORS + BATCH_ERRS))
        ELAPSED=$(( $(date +%s) - BF_START_TS ))
        PCTDONE=$(( BF_IDX * 100 / ${#TICKER_ARRAY[@]} ))
        echo "done (${BATCH_UPSERTED} candles, ${BATCH_ERRS}err) [${PCTDONE}% | ${ELAPSED}s]"

        sleep 2
      done
    elif $FORCE_BACKFILL; then
      # Full universe backfill only when explicitly forced
      BF_OFFSET=0
      while [ "$BF_OFFSET" -lt "$TOTAL_TICKERS" ]; do
        BF_ROUND=$((BF_ROUND + 1))
        REMAINING=$((TOTAL_TICKERS - BF_OFFSET))
        THIS_BATCH=$(( REMAINING < BF_BATCH ? REMAINING : BF_BATCH ))

        echo -n "  [$BF_ROUND] offset=$BF_OFFSET ($THIS_BATCH tickers)... "

        BF_RESULT=$(curl -s -m 600 -X POST \
          "$API_BASE/timed/admin/alpaca-backfill?startDate=$BF_START_DATE&endDate=$END_DATE&tf=all&offset=$BF_OFFSET&limit=$THIS_BATCH&key=$API_KEY" 2>&1)
        BF_OK_INNER=$(echo "$BF_RESULT" | jq -r '.ok // false' 2>/dev/null || echo "false")
        UPSERTED=$(echo "$BF_RESULT" | jq -r '.upserted // 0' 2>/dev/null || echo "0")
        BF_ERRS=$(echo "$BF_RESULT" | jq -r '.errors // 0' 2>/dev/null || echo "0")

        BF_TOTAL_UPSERTED=$((BF_TOTAL_UPSERTED + UPSERTED))
        BF_TOTAL_ERRORS=$((BF_TOTAL_ERRORS + BF_ERRS))
        ELAPSED=$(( $(date +%s) - BF_START_TS ))
        PCTDONE=$(( (BF_OFFSET + THIS_BATCH) * 100 / TOTAL_TICKERS ))

        if [[ "$BF_OK_INNER" == "true" ]]; then
          echo "done (${UPSERTED} candles, ${BF_ERRS}err) [${PCTDONE}% | ${ELAPSED}s]"
        else
          echo "ERROR: $(echo "$BF_RESULT" | head -c 300) [${ELAPSED}s]"
        fi

        BF_OFFSET=$((BF_OFFSET + BF_BATCH))
        sleep 2
      done
    else
      echo "  Gap check returned gaps but no ticker list. Skipping full-universe backfill."
      echo "  Use --force-backfill to re-download all candles."
    fi

    BF_ELAPSED=$(( $(date +%s) - BF_START_TS ))
    echo ""
    echo "  Backfill complete: ${BF_TOTAL_UPSERTED} total candles, ${BF_TOTAL_ERRORS} errors (${BF_ELAPSED}s)"
    echo ""
    fi
    fi
  fi
fi

# ─── Step 2: Process each trading day ────────────────────────────────────────
CURRENT_DATE="$START_DATE"
TOTAL_TRADES=0
TOTAL_SCORED=0
DAY_COUNT=0
SKIP_COUNT=0
IS_FIRST_BATCH=true
if $RESUME; then IS_FIRST_BATCH=false; fi

while [[ "$CURRENT_DATE" < "$END_DATE" ]] || [[ "$CURRENT_DATE" == "$END_DATE" ]]; do
  DAY_OF_WEEK=$(date -j -f "%Y-%m-%d" "$CURRENT_DATE" "+%u" 2>/dev/null || date -d "$CURRENT_DATE" "+%u")
  if [[ "$DAY_OF_WEEK" -ge 6 ]]; then
    CURRENT_DATE=$(date -j -v+1d -f "%Y-%m-%d" "$CURRENT_DATE" "+%Y-%m-%d" 2>/dev/null || date -d "$CURRENT_DATE + 1 day" "+%Y-%m-%d")
    continue
  fi

  if [[ " $HOLIDAYS " == *" $CURRENT_DATE "* ]]; then
    SKIP_COUNT=$((SKIP_COUNT + 1))
    CURRENT_DATE=$(date -j -v+1d -f "%Y-%m-%d" "$CURRENT_DATE" "+%Y-%m-%d" 2>/dev/null || date -d "$CURRENT_DATE + 1 day" "+%Y-%m-%d")
    continue
  fi

  echo "=== Processing $CURRENT_DATE ==="
  DAY_COUNT=$((DAY_COUNT + 1))
  DAY_TRADES=0
  DAY_SCORED=0
  DAY_D1=0
  DAY_ERRS=0
  DAY_TOTAL_TR=0

  CLEAN_PARAM=""
  if $IS_FIRST_BATCH; then
    CLEAN_PARAM="&cleanSlate=1"
    IS_FIRST_BATCH=false
  fi
  SKIP_INV=""
  $TRADER_ONLY && SKIP_INV="&skipInvestor=1"
  LOW_WRITE_PARAM=""
  $LOW_WRITE && LOW_WRITE_PARAM="&lowWrite=1&skipTrailWrite=1"
  ENV_OVERRIDE_PARAM=""
  for ov in "${ENV_OVERRIDES[@]}"; do
    key="${ov%%=*}"
    val="${ov#*=}"
    ENV_OVERRIDE_PARAM="${ENV_OVERRIDE_PARAM}&${key}=${val}"
  done

  # Process day in batches (avoids Cloudflare Worker CPU/wall-time limits on large DBs)
  BATCH_OFFSET=0
  BATCH_NUM=0
  while true; do
    BATCH_NUM=$((BATCH_NUM + 1))
    REPLAY_URL="$API_BASE/timed/admin/candle-replay?date=$CURRENT_DATE&tickerOffset=$BATCH_OFFSET&tickerBatch=$TICKER_BATCH&intervalMinutes=$INTERVAL_MIN&key=$API_KEY${CLEAN_PARAM}${SKIP_INV}${LOW_WRITE_PARAM}${ENV_OVERRIDE_PARAM}"
    CLEAN_PARAM=""

    RESULT=""
    for retry in 1 2 3 4 5; do
      RESULT=$(curl -s -m 300 -X POST "$REPLAY_URL" 2>&1) || true
      if echo "$RESULT" | jq -e '.scored >= 0' >/dev/null 2>&1; then
        break
      fi
      echo "  batch $BATCH_NUM attempt $retry failed, retrying in 15s..."
      sleep 15
    done
    if ! echo "$RESULT" | jq -e '.scored >= 0' >/dev/null 2>&1; then
      echo "ERROR: candle-replay failed after 5 attempts on $CURRENT_DATE batch $BATCH_NUM (offset=$BATCH_OFFSET)."
      echo "  Last response: $(echo "$RESULT" | head -c 300)"
      exit 1
    fi

    B_SCORED=$(echo "$RESULT" | jq -r '.scored // 0' 2>/dev/null || echo "0")
    B_TRADES=$(echo "$RESULT" | jq -r '.tradesCreated // 0' 2>/dev/null || echo "0")
    B_ERRS=$(echo "$RESULT" | jq -r '.errorsCount // 0' 2>/dev/null || echo "0")
    B_TOTAL_TR=$(echo "$RESULT" | jq -r '.totalTrades // 0' 2>/dev/null || echo "0")
    B_D1=$(echo "$RESULT" | jq -r '.d1StateWritten // 0' 2>/dev/null || echo "0")
    B_HAS_MORE=$(echo "$RESULT" | jq -r '.hasMore // false' 2>/dev/null || echo "false")
    B_NEXT_OFFSET=$(echo "$RESULT" | jq -r '.nextTickerOffset // 0' 2>/dev/null || echo "0")
    B_TICKERS=$(echo "$RESULT" | jq -r '.tickersProcessed // 0' 2>/dev/null || echo "0")

    DAY_SCORED=$((DAY_SCORED + B_SCORED))
    DAY_TRADES=$((DAY_TRADES + B_TRADES))
    DAY_D1=$((DAY_D1 + B_D1))
    DAY_ERRS=$((DAY_ERRS + B_ERRS))
    DAY_TOTAL_TR=$B_TOTAL_TR

    echo "  batch $BATCH_NUM: ${B_TICKERS}tk scored=$B_SCORED trades=$B_TRADES d1=$B_D1 err=$B_ERRS"

    if [[ "$B_HAS_MORE" != "true" ]]; then
      break
    fi
    BATCH_OFFSET=$B_NEXT_OFFSET
    sleep 2
  done

  TOTAL_TRADES=$((TOTAL_TRADES + DAY_TRADES))
  TOTAL_SCORED=$((TOTAL_SCORED + DAY_SCORED))

  echo "  Day complete: scored=$DAY_SCORED trades=$DAY_TRADES total=$DAY_TOTAL_TR errors=$DAY_ERRS ($BATCH_NUM batches)"
  # Capture blocked entry gate diagnostics from last batch of the day
  B_BLOCKED=$(echo "$RESULT" | jq -c '.blockedEntryGates // {}' 2>/dev/null || echo "{}")
  if [[ "$B_BLOCKED" != "{}" ]] && [[ "$B_BLOCKED" != "null" ]]; then
    LAST_BLOCKED_GATES="$B_BLOCKED"
  fi
  echo ""

  # Periodic lifecycle: aggregate timed_trail → trail_5m_facts every 5 replayed days
  if (( DAY_COUNT % 5 == 0 )) && ! $LOW_WRITE; then
    echo -n "  ⚡ Lifecycle aggregation (day $DAY_COUNT)... "
    LC_RESULT=$(curl -s -m 300 -X POST "$API_BASE/timed/admin/run-lifecycle?key=$API_KEY&cutoff_hours=0" 2>&1) || true
    LC_OK=$(echo "$LC_RESULT" | jq -r '.ok // false' 2>/dev/null || echo "false")
    if [[ "$LC_OK" == "true" ]]; then
      echo "done"
    else
      echo "warn (non-fatal): $(echo "$LC_RESULT" | jq -r '.error // "unknown"' 2>/dev/null | head -c 100)"
    fi
  fi

  NEXT_DATE=$(date -j -v+1d -f "%Y-%m-%d" "$CURRENT_DATE" "+%Y-%m-%d" 2>/dev/null || date -d "$CURRENT_DATE + 1 day" "+%Y-%m-%d")
  mkdir -p "$(dirname "$CHECKPOINT_FILE")"
  printf '%s\n%s\n%s\n%s\n' "$NEXT_DATE" "$END_DATE" "$TICKER_BATCH" "$INTERVAL_MIN" > "$CHECKPOINT_FILE"

  CURRENT_DATE="$NEXT_DATE"
done

# ─── Phase 2 (sequence): investor-only backfill for same date range ─
if $SEQUENCE; then
  echo "=== Phase 2: Investor-only backfill ($START_DATE → $END_DATE) ==="
  INV_CURRENT="$START_DATE"
  INV_DAY_COUNT=0
  while [[ "$INV_CURRENT" < "$END_DATE" ]] || [[ "$INV_CURRENT" == "$END_DATE" ]]; do
    DW=$(date -j -f "%Y-%m-%d" "$INV_CURRENT" "+%u" 2>/dev/null || date -d "$INV_CURRENT" "+%u")
    if [[ "$DW" -ge 6 ]]; then
      INV_CURRENT=$(date -j -v+1d -f "%Y-%m-%d" "$INV_CURRENT" "+%Y-%m-%d" 2>/dev/null || date -d "$INV_CURRENT + 1 day" "+%Y-%m-%d")
      continue
    fi
    if [[ " $HOLIDAYS " == *" $INV_CURRENT "* ]]; then
      INV_CURRENT=$(date -j -v+1d -f "%Y-%m-%d" "$INV_CURRENT" "+%Y-%m-%d" 2>/dev/null || date -d "$INV_CURRENT + 1 day" "+%Y-%m-%d")
      continue
    fi
    INV_RESULT=$(curl -s -m 120 -X POST "$API_BASE/timed/admin/investor-replay?date=$INV_CURRENT&key=$API_KEY" 2>&1)
    if ! echo "$INV_RESULT" | jq -e '.ok' >/dev/null 2>&1; then
      echo "ERROR: investor-replay failed for $INV_CURRENT: $(echo "$INV_RESULT" | head -c 300)"
      exit 1
    fi
    INV_DAY_COUNT=$((INV_DAY_COUNT + 1))
    echo "  $INV_CURRENT: ok"
    INV_CURRENT=$(date -j -v+1d -f "%Y-%m-%d" "$INV_CURRENT" "+%Y-%m-%d" 2>/dev/null || date -d "$INV_CURRENT + 1 day" "+%Y-%m-%d")
    sleep 1
  done
  echo "  Investor backfill: $INV_DAY_COUNT days"
  echo ""
fi

# ─── Final lifecycle: flush remaining timed_trail → trail_5m_facts ───────────
if $LOW_WRITE; then
  echo "Final lifecycle aggregation skipped (--low-write enabled)"
else
  echo -n "Final lifecycle aggregation... "
  LC_FINAL=$(curl -s -m 300 -X POST "$API_BASE/timed/admin/run-lifecycle?key=$API_KEY&cutoff_hours=0" 2>&1) || true
  LC_FINAL_OK=$(echo "$LC_FINAL" | jq -r '.ok // false' 2>/dev/null || echo "false")
  if [[ "$LC_FINAL_OK" == "true" ]]; then
    echo "done"
  else
    echo "warn (non-fatal): $(echo "$LC_FINAL" | jq -r '.error // "unknown"' 2>/dev/null | head -c 100)"
  fi
fi
echo ""

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Backtest Complete"
echo "║  Days processed: $DAY_COUNT (skipped $SKIP_COUNT holidays)"
echo "║  Total scored: $TOTAL_SCORED"
echo "║  Total trades: $TOTAL_TRADES"
echo "╚══════════════════════════════════════════════════════╝"

if [[ -n "${LAST_BLOCKED_GATES:-}" ]] && [[ "$LAST_BLOCKED_GATES" != "{}" ]]; then
  echo ""
  echo "=== Blocked Entry Gate Diagnostics ==="
  echo "$LAST_BLOCKED_GATES" | jq -r 'to_entries | sort_by(-.value) | .[] | "  \(.key): \(.value)"' 2>/dev/null || echo "$LAST_BLOCKED_GATES"
fi
echo ""

# ─── Step 2b: Close open positions at replay end (optional) ─────────────────
TODAY_KEY=$(date "+%Y-%m-%d")
if $KEEP_OPEN_AT_END; then
  echo "=== Keeping open positions at replay end (--keep-open-at-end enabled) ==="
else
  echo "=== Closing open positions at replay end ($END_DATE) ==="
  CLOSE_RESULT=$(curl -s -m 120 -X POST "$API_BASE/timed/admin/close-replay-positions?date=$END_DATE&key=$API_KEY" 2>&1)
  CLOSED_COUNT=$(echo "$CLOSE_RESULT" | jq -r '.closed // 0' 2>/dev/null || echo "0")
  echo "Closed $CLOSED_COUNT open positions at $END_DATE market close"
fi
echo ""

# ─── Step 3: Final statistics ────────────────────────────────────────────────
echo "=== Trade Statistics ==="
TRADES_DATA=$(curl -s "$API_BASE/timed/trades?source=kv&key=$API_KEY" 2>&1)

echo "$TRADES_DATA" | jq '{
  totalTrades: (.trades | length),
  byDirection: (.trades | group_by(.direction) | map({direction: .[0].direction, count: length})),
  byStatus: (.trades | group_by(.status) | map({status: .[0].status, count: length})),
  openCount: ([.trades[] | select(.status == "OPEN")] | length)
}' 2>/dev/null || echo "Could not parse trade data"

echo ""
echo "=== P&L Statistics ==="
echo "$TRADES_DATA" | jq '{
  wins: ([.trades[] | select(.status == "WIN")] | length),
  losses: ([.trades[] | select(.status == "LOSS")] | length),
  avgWinPct: (([.trades[] | select(.status == "WIN") | .pnlPct] | if length > 0 then (add / length) else 0 end) | . * 100 | floor / 100),
  avgLossPct: (([.trades[] | select(.status == "LOSS") | .pnlPct] | if length > 0 then (add / length) else 0 end) | . * 100 | floor / 100),
  totalRealizedPnlPct: (([.trades[] | select(.status == "WIN" or .status == "LOSS") | .pnlPct] | add) // 0 | . * 100 | floor / 100)
}' 2>/dev/null || echo "Could not parse P&L data"

# ─── Step 3.5: Persist run summary for run registry ───────────────────────────
FINALIZE_PAYLOAD=$(jq -nc \
  --arg run_id "$RUN_ID" \
  --arg label "${RUN_LABEL:-backtest-${START_DATE}-to-${END_DATE}}" \
  --arg description "${RUN_DESCRIPTION:-}" \
  --arg start_date "$START_DATE" \
  --arg end_date "$END_DATE" \
  --argjson interval_min "$INTERVAL_MIN" \
  --argjson ticker_batch "$TICKER_BATCH" \
  --argjson ticker_universe_count "${TOTAL_TICKERS:-0}" \
  --argjson trader_only "$($TRADER_ONLY && echo true || echo false)" \
  --argjson keep_open_at_end "$($KEEP_OPEN_AT_END && echo true || echo false)" \
  --argjson low_write "$($LOW_WRITE && echo true || echo false)" \
  --arg status "completed" \
  --arg status_note "Replay completed" \
  --argjson params "$RUN_PARAMS_JSON" \
  '{
    run_id: $run_id,
    label: $label,
    description: ($description | if length > 0 then . else null end),
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
    params: $params
  }')
echo ""
echo "=== Recording run summary ==="
FINALIZE_RESULT=$(curl -s -m 45 -X POST "$API_BASE/timed/admin/runs/finalize?key=$API_KEY" \
  -H "Content-Type: application/json" \
  -d "$FINALIZE_PAYLOAD" 2>&1 || true)
echo "Run summary: $(echo "$FINALIZE_RESULT" | jq -c '{ok, run_id, status}' 2>/dev/null || echo "$FINALIZE_RESULT")"

# ─── Step 4: Release replay lock ─────────────────────────────────────────────
echo ""
echo "=== Releasing replay lock ==="
UNLOCK_RESULT=$(curl -s -m 30 -X DELETE "$API_BASE/timed/admin/replay-lock?key=$API_KEY")
echo "Unlock: $(echo "$UNLOCK_RESULT" | jq -c '{ok, released}' 2>/dev/null || echo "$UNLOCK_RESULT")"
echo ""

rm -f "$CHECKPOINT_FILE"
echo "=== All done (checkpoint cleared) ==="
