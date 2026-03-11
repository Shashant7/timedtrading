#!/bin/bash
# Build and freeze a replay-ready candle dataset for a specific backtest window.
# Usage:
#   ./scripts/freeze-replay-dataset.sh 2025-07-01 2025-07-31 july-2025-canonical
#   ./scripts/freeze-replay-dataset.sh --label=july-2025-canonical --force 2025-07-01 2025-07-31

set -euo pipefail

API_BASE="https://timed-trading-ingest.shashant.workers.dev"
API_KEY="AwesomeSauce"
BF_BATCH=3
MAX_VERIFY_PASSES=3
UNSUPPORTED_BACKFILL_TICKERS=(BRK-B CL1! ES1! GC1! NQ1! SI1! VX1! SPX BTCUSD ETHUSD)
UNSUPPORTED_CSV=$(IFS=,; printf '%s' "${UNSUPPORTED_BACKFILL_TICKERS[*]}")

LABEL=""
FORCE=false
POSARGS=()
while [[ $# -gt 0 ]]; do
  arg="$1"
  shift
  case "$arg" in
    --label=*) LABEL="${arg#--label=}" ;;
    --label)
      [[ -n "${1:-}" && "$1" != --* ]] && LABEL="$1" && shift
      ;;
    --force) FORCE=true ;;
    *)
      [[ "$arg" != --* ]] && POSARGS+=("$arg")
      ;;
  esac
done

START_DATE="${POSARGS[0]:-}"
END_DATE="${POSARGS[1]:-}"
if [[ -z "$START_DATE" || -z "$END_DATE" ]]; then
  echo "Usage: ./scripts/freeze-replay-dataset.sh [--label=name] [--force] START_DATE END_DATE [label]"
  exit 1
fi
if [[ -z "$LABEL" ]]; then
  LABEL="${POSARGS[2]:-dataset-${START_DATE}-to-${END_DATE}}"
fi

sanitize_tag() {
  printf '%s' "$1" | tr -cs '[:alnum:]_.-' '-'
}

compute_backfill_start_date() {
  local base_start="$1"
  date -j -v-60d -f "%Y-%m-%d" "$base_start" "+%Y-%m-%d" 2>/dev/null || \
    date -d "$base_start 60 days ago" "+%Y-%m-%d" 2>/dev/null || \
    echo "$base_start"
}

is_backfill_supported_ticker() {
  local t="$1"
  local unsupported
  for unsupported in "${UNSUPPORTED_BACKFILL_TICKERS[@]}"; do
    [[ "$unsupported" == "$t" ]] && return 1
  done
  return 0
}

join_by() {
  local sep="$1"
  shift
  local out=""
  local item
  for item in "$@"; do
    [[ -n "$out" ]] && out+="$sep"
    out+="$item"
  done
  echo "$out"
}

BACKFILL_START_DATE=$(compute_backfill_start_date "$START_DATE")
SAFE_LABEL=$(sanitize_tag "$LABEL")
OUT_DIR="data/replay-datasets/${SAFE_LABEL}"
MANIFEST_PATH="${OUT_DIR}/manifest.json"
UNSUPPORTED_JSON=$(printf '%s\n' "${UNSUPPORTED_BACKFILL_TICKERS[@]}" | jq -R . | jq -s .)
TOTAL_TICKERS=$(curl -s "$API_BASE/timed/admin/alpaca-status?key=$API_KEY" | jq -r '.total_tickers // 200' 2>/dev/null || echo "200")

if [[ -d "$OUT_DIR" && "$FORCE" != "true" ]]; then
  echo "ERROR: ${OUT_DIR} already exists. Use --force to rebuild."
  exit 1
fi
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Freeze Replay Dataset: $START_DATE → $END_DATE"
echo "║  Coverage window: $BACKFILL_START_DATE → $END_DATE"
echo "║  Label: $SAFE_LABEL"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

run_gap_check() {
  curl -s -m 120 \
    "$API_BASE/timed/admin/candle-gaps?startDate=$BACKFILL_START_DATE&endDate=$END_DATE&key=$API_KEY"
}

summarize_gap_result() {
  local gap_json="$1"
  local prefix="$2"
  printf '%s' "$gap_json" | UNSUPPORTED_CSV="$UNSUPPORTED_CSV" python3 -c '
import json, os, sys
prefix = sys.argv[1]
data = json.load(sys.stdin)
unsupported = set(filter(None, os.environ.get("UNSUPPORTED_CSV", "").split(",")))
tickers = data.get("tickersNeedingBackfill") or []
supported = sorted([t for t in tickers if t not in unsupported])
unsupported_ticks = sorted([t for t in tickers if t in unsupported])
out = {
    f"{prefix}_raw_gap_count": data.get("gapCount", 0),
    f"{prefix}_raw_tickers_with_gaps": data.get("tickersWithGaps", 0),
    f"{prefix}_supported_tickers_with_gaps": len(supported),
    f"{prefix}_unsupported_tickers_with_gaps": len(unsupported_ticks),
    f"{prefix}_supported_tickers": supported,
    f"{prefix}_unsupported_tickers": unsupported_ticks,
}
print(json.dumps(out))
' "$prefix"
}

INITIAL_GAP_RESULT=$(run_gap_check)
if ! echo "$INITIAL_GAP_RESULT" | jq -e '.ok == true' >/dev/null 2>&1; then
  echo "ERROR: initial gap check failed: $(echo "$INITIAL_GAP_RESULT" | head -c 300)"
  exit 1
fi

echo "$INITIAL_GAP_RESULT" > "${OUT_DIR}/gap-check-initial.json"
INITIAL_SUMMARY=$(summarize_gap_result "$INITIAL_GAP_RESULT" "initial")
INITIAL_SUPPORTED_GAPS=$(echo "$INITIAL_SUMMARY" | jq -r '.initial_supported_tickers_with_gaps')
INITIAL_UNSUPPORTED_GAPS=$(echo "$INITIAL_SUMMARY" | jq -r '.initial_unsupported_tickers_with_gaps')

echo "Initial gap check:"
echo "  Raw gaps: $(echo "$INITIAL_SUMMARY" | jq -r '.initial_raw_gap_count') across $(echo "$INITIAL_SUMMARY" | jq -r '.initial_raw_tickers_with_gaps') tickers"
echo "  Supported tickers with gaps: $INITIAL_SUPPORTED_GAPS"
echo "  Unsupported tickers with gaps: $INITIAL_UNSUPPORTED_GAPS"
if [[ "$INITIAL_UNSUPPORTED_GAPS" != "0" ]]; then
  echo "  Ignoring unsupported gap tickers: $(echo "$INITIAL_SUMMARY" | python3 -c 'import json,sys; data=json.load(sys.stdin); print(", ".join(data.get("initial_unsupported_tickers") or []))')"
fi
echo ""

TOTAL_BACKFILL_UPSERTED=0
TOTAL_BACKFILL_ERRORS=0
TOTAL_BATCHES=0
VERIFY_PASS=0
CURRENT_GAP_RESULT="$INITIAL_GAP_RESULT"
CURRENT_SUMMARY="$INITIAL_SUMMARY"
CURRENT_SUPPORTED_GAPS="$INITIAL_SUPPORTED_GAPS"
START_TS=$(date +%s)

while [[ "$CURRENT_SUPPORTED_GAPS" != "0" && "$VERIFY_PASS" -lt "$MAX_VERIFY_PASSES" ]]; do
  VERIFY_PASS=$((VERIFY_PASS + 1))
  SUPPORTED_TICKERS=()
  while IFS= read -r ticker; do
    [[ -n "$ticker" ]] && SUPPORTED_TICKERS+=("$ticker")
  done < <(echo "$CURRENT_SUMMARY" | python3 -c 'import json,sys; data=json.load(sys.stdin); arr=data.get("initial_supported_tickers") or data.get("verify_supported_tickers") or []; [print(x) for x in arr]')
  if [[ "${#SUPPORTED_TICKERS[@]}" -eq 0 ]]; then
    break
  fi

  echo "Backfill pass $VERIFY_PASS: ${#SUPPORTED_TICKERS[@]} supported tickers need coverage"
  IDX=0
  while [[ "$IDX" -lt "${#SUPPORTED_TICKERS[@]}" ]]; do
    BATCH=()
    while [[ "$IDX" -lt "${#SUPPORTED_TICKERS[@]}" && "${#BATCH[@]}" -lt "$BF_BATCH" ]]; do
      if is_backfill_supported_ticker "${SUPPORTED_TICKERS[$IDX]}"; then
        BATCH+=("${SUPPORTED_TICKERS[$IDX]}")
      fi
      IDX=$((IDX + 1))
    done
    [[ "${#BATCH[@]}" -eq 0 ]] && continue
    TOTAL_BATCHES=$((TOTAL_BATCHES + 1))
    BATCH_LABEL=$(join_by "," "${BATCH[@]}")
    echo -n "  [${TOTAL_BATCHES}] ${BATCH_LABEL} ... "
    BATCH_UPSERTED=0
    BATCH_ERRORS=0
    for ticker in "${BATCH[@]}"; do
      BF_RESULT=$(curl -s -m 600 -X POST \
        "$API_BASE/timed/admin/alpaca-backfill?startDate=$BACKFILL_START_DATE&endDate=$END_DATE&tf=all&ticker=$ticker&key=$API_KEY" 2>&1)
      UPSERTED=$(echo "$BF_RESULT" | jq -r '.upserted // 0' 2>/dev/null || echo "0")
      ERRS=$(echo "$BF_RESULT" | jq -r '.errors // 0' 2>/dev/null || echo "0")
      BATCH_UPSERTED=$((BATCH_UPSERTED + UPSERTED))
      BATCH_ERRORS=$((BATCH_ERRORS + ERRS))
    done
    TOTAL_BACKFILL_UPSERTED=$((TOTAL_BACKFILL_UPSERTED + BATCH_UPSERTED))
    TOTAL_BACKFILL_ERRORS=$((TOTAL_BACKFILL_ERRORS + BATCH_ERRORS))
    ELAPSED=$(( $(date +%s) - START_TS ))
    echo "done (${BATCH_UPSERTED} candles, ${BATCH_ERRORS}err) [${ELAPSED}s]"
    sleep 2
  done

  CURRENT_GAP_RESULT=$(run_gap_check)
  if ! echo "$CURRENT_GAP_RESULT" | jq -e '.ok == true' >/dev/null 2>&1; then
    echo "ERROR: verification gap check failed after pass $VERIFY_PASS: $(echo "$CURRENT_GAP_RESULT" | head -c 300)"
    exit 1
  fi
  echo "$CURRENT_GAP_RESULT" > "${OUT_DIR}/gap-check-after-pass-${VERIFY_PASS}.json"
  CURRENT_SUMMARY=$(summarize_gap_result "$CURRENT_GAP_RESULT" "verify")
  CURRENT_SUPPORTED_GAPS=$(echo "$CURRENT_SUMMARY" | jq -r '.verify_supported_tickers_with_gaps')
  echo "  Verification after pass $VERIFY_PASS: supported tickers with gaps = $CURRENT_SUPPORTED_GAPS"
  echo ""
done

FINAL_GAP_RESULT="$CURRENT_GAP_RESULT"
FINAL_SUMMARY=$(summarize_gap_result "$FINAL_GAP_RESULT" "final")
FINAL_SUPPORTED_GAPS=$(echo "$FINAL_SUMMARY" | jq -r '.final_supported_tickers_with_gaps')
FINAL_UNSUPPORTED_GAPS=$(echo "$FINAL_SUMMARY" | jq -r '.final_unsupported_tickers_with_gaps')
FINAL_RAW_GAPS=$(echo "$FINAL_SUMMARY" | jq -r '.final_raw_gap_count')
FINAL_RAW_TICKERS=$(echo "$FINAL_SUMMARY" | jq -r '.final_raw_tickers_with_gaps')
FINAL_SUPPORTED_TICKERS=$(echo "$FINAL_SUMMARY" | jq -c '.final_supported_tickers')
FINAL_UNSUPPORTED_TICKERS=$(echo "$FINAL_SUMMARY" | jq -c '.final_unsupported_tickers')

if [[ "$FINAL_SUPPORTED_GAPS" != "0" ]]; then
  echo "ERROR: dataset is not replay-ready yet. Supported tickers with gaps remain: $FINAL_SUPPORTED_GAPS"
  echo "Remaining supported tickers: $(echo "$FINAL_SUPPORTED_TICKERS" | jq -r 'join(", ")')"
  exit 1
fi

CREATED_AT=$(date -u "+%Y-%m-%dT%H:%M:%SZ")
ELAPSED_TOTAL=$(( $(date +%s) - START_TS ))

jq -n \
  --arg label "$SAFE_LABEL" \
  --arg created_at "$CREATED_AT" \
  --arg start_date "$START_DATE" \
  --arg end_date "$END_DATE" \
  --arg coverage_start "$BACKFILL_START_DATE" \
  --arg coverage_end "$END_DATE" \
  --argjson total_tickers "$TOTAL_TICKERS" \
  --argjson supported_tickers_count "$((TOTAL_TICKERS - ${#UNSUPPORTED_BACKFILL_TICKERS[@]}))" \
  --argjson unsupported_tickers "$UNSUPPORTED_JSON" \
  --argjson initial_summary "$INITIAL_SUMMARY" \
  --argjson final_summary "$FINAL_SUMMARY" \
  --argjson total_backfill_upserted "$TOTAL_BACKFILL_UPSERTED" \
  --argjson total_backfill_errors "$TOTAL_BACKFILL_ERRORS" \
  --argjson total_batches "$TOTAL_BATCHES" \
  --argjson verify_passes "$VERIFY_PASS" \
  --argjson elapsed_sec "$ELAPSED_TOTAL" \
  --arg manifest_path "$MANIFEST_PATH" \
  '{
    ok: true,
    label: $label,
    created_at: $created_at,
    replay_window: {
      start_date: $start_date,
      end_date: $end_date
    },
    coverage_window: {
      start_date: $coverage_start,
      end_date: $coverage_end
    },
    universe: {
      total_tickers: $total_tickers,
      supported_tickers: $supported_tickers_count,
      unsupported_backfill_tickers: $unsupported_tickers
    },
    backfill: {
      batch_size: 3,
      verify_passes: $verify_passes,
      total_batches: $total_batches,
      total_upserted: $total_backfill_upserted,
      total_errors: $total_backfill_errors,
      elapsed_sec: $elapsed_sec
    },
    verification: {
      supported_tickers_with_gaps: ($final_summary.final_supported_tickers_with_gaps // 0),
      unsupported_tickers_with_gaps: ($final_summary.final_unsupported_tickers_with_gaps // 0),
      raw_gap_count: ($final_summary.final_raw_gap_count // 0),
      raw_tickers_with_gaps: ($final_summary.final_raw_tickers_with_gaps // 0),
      supported_tickers: ($final_summary.final_supported_tickers // []),
      unsupported_tickers: ($final_summary.final_unsupported_tickers // [])
    },
    initial_gap_summary: $initial_summary,
    final_gap_summary: $final_summary,
    usage: {
      note: "Use this manifest to skip Step 1.5 in full-backtest.sh for the exact same replay window.",
      full_backtest_example: ("./scripts/full-backtest.sh --frozen-dataset=" + $manifest_path + " --trader-only --low-write --keep-open-at-end " + $start_date + " " + $end_date + " 15")
    }
  }' > "$MANIFEST_PATH"

printf '%s' "$FINAL_GAP_RESULT" > "${OUT_DIR}/gap-check-final.json"

echo "Frozen replay dataset written to $MANIFEST_PATH"
echo "  Supported tickers with gaps: 0"
echo "  Unsupported gap tickers still ignored: $FINAL_UNSUPPORTED_GAPS"
if [[ "$FINAL_UNSUPPORTED_GAPS" != "0" ]]; then
  echo "  Unsupported tickers: $(echo "$FINAL_UNSUPPORTED_TICKERS" | jq -r 'join(", ")')"
fi
echo ""
echo "Next use:"
echo "  ./scripts/full-backtest.sh --frozen-dataset=$MANIFEST_PATH --trader-only --low-write --keep-open-at-end $START_DATE $END_DATE 15"
