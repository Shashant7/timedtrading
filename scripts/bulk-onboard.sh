#!/bin/bash
# Bulk Onboard — populate ticker profiles for all watchlist tickers
# Usage: ./scripts/bulk-onboard.sh [--skip-existing] [--tickers=AAPL,TSLA,NVDA] [--batch=15]
#
# Calls POST /timed/admin/onboard in batches to stay within Cloudflare Worker limits.
# Each ticker runs: backfill → harvest moves → fingerprint → calibrate → store profile.

set -e

API_BASE="https://timed-trading-ingest.shashant.workers.dev"
API_KEY="AwesomeSauce"
BATCH_SIZE=15
SKIP_EXISTING=false
SPECIFIC_TICKERS=""
SUMMARY_FILE="data/onboard-summary.json"

for arg in "$@"; do
  [[ "$arg" == "--skip-existing" ]] && SKIP_EXISTING=true
  [[ "$arg" =~ ^--tickers= ]] && SPECIFIC_TICKERS="${arg#--tickers=}"
  [[ "$arg" =~ ^--batch= ]] && BATCH_SIZE="${arg#--batch=}"
done

mkdir -p data

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Bulk Ticker Onboarding                              ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Batch size: $BATCH_SIZE"
echo "║  Skip existing: $SKIP_EXISTING"
if [[ -n "$SPECIFIC_TICKERS" ]]; then
  echo "║  Tickers: $SPECIFIC_TICKERS"
fi
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# Build ticker list
if [[ -n "$SPECIFIC_TICKERS" ]]; then
  IFS=',' read -ra TICKERS <<< "$SPECIFIC_TICKERS"
else
  echo "Fetching ticker list from API..."
  TICKER_JSON=$(curl -s -m 30 "$API_BASE/timed/tickers" 2>&1)
  if ! echo "$TICKER_JSON" | jq -e '.tickers' >/dev/null 2>&1; then
    echo "ERROR: Failed to fetch ticker list"
    echo "$TICKER_JSON" | head -5
    exit 1
  fi
  TICKERS=($(echo "$TICKER_JSON" | jq -r '.tickers[]' 2>/dev/null | sort))
  echo "Found ${#TICKERS[@]} tickers"
fi

if [[ ${#TICKERS[@]} -eq 0 ]]; then
  echo "ERROR: No tickers to onboard"
  exit 1
fi

# Filter out already-profiled tickers if --skip-existing
FILTERED_TICKERS=()
SKIPPED=0
if $SKIP_EXISTING; then
  echo "Checking for existing profiles..."
  for ticker in "${TICKERS[@]}"; do
    PROFILE=$(curl -s -m 10 "$API_BASE/timed/profile/$ticker" 2>&1)
    HAS_PROFILE=$(echo "$PROFILE" | jq -r '.ok // false' 2>/dev/null)
    if [[ "$HAS_PROFILE" == "true" ]]; then
      SKIPPED=$((SKIPPED + 1))
    else
      FILTERED_TICKERS+=("$ticker")
    fi
  done
  echo "  Skipping $SKIPPED already-profiled tickers, ${#FILTERED_TICKERS[@]} remaining"
  TICKERS=("${FILTERED_TICKERS[@]}")
fi

TOTAL=${#TICKERS[@]}
if [[ $TOTAL -eq 0 ]]; then
  echo "All tickers already profiled. Nothing to do."
  exit 0
fi

echo ""
echo "Onboarding $TOTAL tickers in batches of $BATCH_SIZE..."
echo ""

# Process in batches
BATCH_NUM=0
TOTAL_OK=0
TOTAL_FAIL=0
STARTED_AT=$(date "+%s")
RESULTS_JSON="[]"

for ((i=0; i<TOTAL; i+=BATCH_SIZE)); do
  BATCH_NUM=$((BATCH_NUM + 1))
  BATCH_TICKERS=("${TICKERS[@]:i:BATCH_SIZE}")
  BATCH_CSV=$(IFS=','; echo "${BATCH_TICKERS[*]}")
  BATCH_COUNT=${#BATCH_TICKERS[@]}
  DONE_SO_FAR=$((i + BATCH_COUNT))
  TOTAL_BATCHES=$(( (TOTAL + BATCH_SIZE - 1) / BATCH_SIZE ))

  echo "─── Batch $BATCH_NUM/$TOTAL_BATCHES ($DONE_SO_FAR/$TOTAL) ───"
  echo "  Tickers: $BATCH_CSV"

  RESULT=$(curl -s -m 600 -X POST \
    "$API_BASE/timed/admin/onboard?ticker=$BATCH_CSV&key=$API_KEY" \
    -H "Content-Type: application/json" 2>&1)

  BATCH_OK=$(echo "$RESULT" | jq '[.results[]? | select(.ok == true)] | length' 2>/dev/null || echo "0")
  BATCH_FAIL=$(echo "$RESULT" | jq '[.results[]? | select(.ok != true)] | length' 2>/dev/null || echo "0")
  TOTAL_OK=$((TOTAL_OK + BATCH_OK))
  TOTAL_FAIL=$((TOTAL_FAIL + BATCH_FAIL))

  # Extract per-ticker summaries
  for ticker in "${BATCH_TICKERS[@]}"; do
    TICKER_RESULT=$(echo "$RESULT" | jq -c ".results[]? | select(.ticker == \"$ticker\")" 2>/dev/null)
    if [[ -n "$TICKER_RESULT" ]]; then
      T_OK=$(echo "$TICKER_RESULT" | jq -r '.ok' 2>/dev/null)
      T_TYPE=$(echo "$TICKER_RESULT" | jq -r '.profile.behaviorType // "N/A"' 2>/dev/null)
      T_ATR=$(echo "$TICKER_RESULT" | jq -r '.profile.atrPctP50 // 0' 2>/dev/null)
      T_SL=$(echo "$TICKER_RESULT" | jq -r '.profile.slMult // 1' 2>/dev/null)
      T_TP=$(echo "$TICKER_RESULT" | jq -r '.profile.tpMult // 1' 2>/dev/null)
      T_MOVES=$(echo "$TICKER_RESULT" | jq -r '.moveCount // 0' 2>/dev/null)
      if [[ "$T_OK" == "true" ]]; then
        printf "  ✓ %-6s %s  ATR%%=%.1f%%  SL×%.2f  TP×%.2f  moves=%s\n" "$ticker" "$T_TYPE" "$T_ATR" "$T_SL" "$T_TP" "$T_MOVES"
      else
        T_ERR=$(echo "$TICKER_RESULT" | jq -r '.error // "unknown"' 2>/dev/null)
        printf "  ✗ %-6s FAILED: %s\n" "$ticker" "$T_ERR"
      fi
      RESULTS_JSON=$(echo "$RESULTS_JSON" | jq ". + [$TICKER_RESULT]")
    fi
  done

  ELAPSED=$(($(date "+%s") - STARTED_AT))
  if [[ $DONE_SO_FAR -gt 0 && $DONE_SO_FAR -lt $TOTAL ]]; then
    PACE=$((ELAPSED / DONE_SO_FAR))
    REMAINING=$(( (TOTAL - DONE_SO_FAR) * PACE ))
    ETA_MIN=$((REMAINING / 60))
    echo "  Progress: $DONE_SO_FAR/$TOTAL | OK: $TOTAL_OK | Fail: $TOTAL_FAIL | ETA: ~${ETA_MIN}m"
  fi
  echo ""

  # Brief pause between batches to avoid rate limits
  if [[ $DONE_SO_FAR -lt $TOTAL ]]; then
    sleep 2
  fi
done

ELAPSED_TOTAL=$(($(date "+%s") - STARTED_AT))
ELAPSED_MIN=$((ELAPSED_TOTAL / 60))

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Bulk Onboarding Complete                            ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Total:   $TOTAL tickers"
echo "║  Success: $TOTAL_OK"
echo "║  Failed:  $TOTAL_FAIL"
echo "║  Skipped: $SKIPPED (already profiled)"
echo "║  Time:    ${ELAPSED_MIN}m ${ELAPSED_TOTAL}s"
echo "╚══════════════════════════════════════════════════════╝"

# Save summary
cat > "$SUMMARY_FILE" <<ENDJSON
{
  "completed_at": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "total": $TOTAL,
  "ok": $TOTAL_OK,
  "failed": $TOTAL_FAIL,
  "skipped": $SKIPPED,
  "elapsed_seconds": $ELAPSED_TOTAL,
  "results": $RESULTS_JSON
}
ENDJSON

echo ""
echo "Summary saved to $SUMMARY_FILE"
