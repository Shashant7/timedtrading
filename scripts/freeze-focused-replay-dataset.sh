#!/bin/bash
# Build a basket-scoped frozen dataset manifest for focused/monthly replay lanes.
# Usage:
#   ./scripts/freeze-focused-replay-dataset.sh --tickers "XLY,PH,..." 2025-07-01 2025-08-29 july-aug-basket
#   ./scripts/freeze-focused-replay-dataset.sh --tickers "XLY,PH,..." --label=july-aug-basket --force 2025-07-01 2025-08-29

set -euo pipefail

API_BASE="https://timed-trading-ingest.shashant.workers.dev"
API_KEY="AwesomeSauce"

LABEL=""
FORCE=false
TICKERS_RAW=""
POSARGS=()

while [[ $# -gt 0 ]]; do
  arg="$1"
  shift
  case "$arg" in
    --label=*) LABEL="${arg#--label=}" ;;
    --label)
      [[ -n "${1:-}" && "$1" != --* ]] && LABEL="$1" && shift
      ;;
    --tickers=*) TICKERS_RAW="${arg#--tickers=}" ;;
    --tickers)
      [[ -n "${1:-}" && "$1" != --* ]] && TICKERS_RAW="$1" && shift
      ;;
    --force) FORCE=true ;;
    *)
      [[ "$arg" != --* ]] && POSARGS+=("$arg")
      ;;
  esac
done

START_DATE="${POSARGS[0]:-}"
END_DATE="${POSARGS[1]:-}"
if [[ -z "$START_DATE" || -z "$END_DATE" || -z "$TICKERS_RAW" ]]; then
  echo "Usage: ./scripts/freeze-focused-replay-dataset.sh --tickers \"AAPL,TSLA\" [--label=name] [--force] START_DATE END_DATE [label]"
  exit 1
fi
if [[ -z "$LABEL" ]]; then
  LABEL="${POSARGS[2]:-focused-dataset-${START_DATE}-to-${END_DATE}}"
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

BACKFILL_START_DATE=$(compute_backfill_start_date "$START_DATE")
SAFE_LABEL=$(sanitize_tag "$LABEL")
OUT_DIR="data/replay-datasets/${SAFE_LABEL}"
TMP_DIR="${OUT_DIR}/.tmp"
MANIFEST_PATH="${OUT_DIR}/manifest.json"

TICKER_ARR=()
while IFS= read -r line; do
  [[ -n "$line" ]] && TICKER_ARR+=("$line")
done < <(python3 - <<'PY' "$TICKERS_RAW"
import sys
items = []
for part in sys.argv[1].split(","):
    sym = part.strip().upper()
    if sym and sym not in items:
        items.append(sym)
for sym in items:
    print(sym)
PY
)

if [[ "${#TICKER_ARR[@]}" -eq 0 ]]; then
  echo "ERROR: no valid tickers were provided"
  exit 1
fi

if [[ -d "$OUT_DIR" && "$FORCE" != "true" ]]; then
  echo "ERROR: ${OUT_DIR} already exists. Use --force to rebuild."
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$TMP_DIR"
: > "${TMP_DIR}/backfill.ndjson"
: > "${TMP_DIR}/earnings.ndjson"

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Freeze Focused Replay Dataset: $START_DATE → $END_DATE"
echo "║  Coverage window: $BACKFILL_START_DATE → $END_DATE"
echo "║  Label: $SAFE_LABEL"
echo "║  Tickers: ${#TICKER_ARR[@]}"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

for ticker in "${TICKER_ARR[@]}"; do
  echo -n "Backfill $ticker ... "
  response=$(curl -sS -m 600 -w '\n__STATUS__:%{http_code}' -X POST \
    "$API_BASE/timed/admin/alpaca-backfill?startDate=$BACKFILL_START_DATE&endDate=$END_DATE&tf=all&ticker=$ticker&key=$API_KEY")
  status_code="${response##*$'\n'__STATUS__:}"
  body="${response%$'\n'__STATUS__:*}"
  upserted=$(printf '%s' "$body" | jq -r '.upserted // 0' 2>/dev/null || echo "0")
  errors=$(printf '%s' "$body" | jq -r '.errors // 0' 2>/dev/null || echo "0")
  ok=$(printf '%s' "$body" | jq -r '.ok // false' 2>/dev/null || echo "false")
  echo "status=$status_code upserted=$upserted errors=$errors"
  jq -nc \
    --arg ticker "$ticker" \
    --argjson status_code "${status_code:-0}" \
    --argjson ok "$( [[ "$ok" == "true" ]] && echo true || echo false )" \
    --argjson upserted "${upserted:-0}" \
    --argjson errors "${errors:-0}" \
    '{ticker:$ticker,status_code:$status_code,ok:$ok,upserted:$upserted,errors:$errors}' \
    >> "${TMP_DIR}/backfill.ndjson"
done
echo ""

echo "Gap check ..."
GAP_RESULT=$(curl -sS -m 120 "$API_BASE/timed/admin/candle-gaps?startDate=$BACKFILL_START_DATE&endDate=$END_DATE&key=$API_KEY")
printf '%s' "$GAP_RESULT" > "${OUT_DIR}/gap-check.json"

echo "Macro event seed ..."
MACRO_RESPONSE=$(curl -sS -m 300 -w '\n__STATUS__:%{http_code}' -X POST \
  "$API_BASE/timed/admin/backfill-market-events?startDate=$START_DATE&endDate=$END_DATE&macroOnly=1&key=$API_KEY")
MACRO_STATUS="${MACRO_RESPONSE##*$'\n'__STATUS__:}"
MACRO_BODY="${MACRO_RESPONSE%$'\n'__STATUS__:*}"
printf '%s' "$MACRO_BODY" > "${OUT_DIR}/macro-events.json"
echo "  status=$MACRO_STATUS macro_seeded=$(printf '%s' "$MACRO_BODY" | jq -r '.macroSeeded // 0' 2>/dev/null || echo 0)"

for ticker in "${TICKER_ARR[@]}"; do
  echo -n "Earnings $ticker ... "
  response=$(curl -sS -m 300 -w '\n__STATUS__:%{http_code}' -X POST \
    "$API_BASE/timed/admin/backfill-market-events?startDate=$START_DATE&endDate=$END_DATE&earningsOnly=1&ticker=$ticker&key=$API_KEY")
  status_code="${response##*$'\n'__STATUS__:}"
  body="${response%$'\n'__STATUS__:*}"
  earnings_seeded=$(printf '%s' "$body" | jq -r '.earningsSeeded // 0' 2>/dev/null || echo "0")
  errors_json=$(printf '%s' "$body" | jq -c '.errors // []' 2>/dev/null || echo '[]')
  ok=$(printf '%s' "$body" | jq -r '.ok // false' 2>/dev/null || echo "false")
  echo "status=$status_code earnings_seeded=$earnings_seeded"
  jq -nc \
    --arg ticker "$ticker" \
    --argjson status_code "${status_code:-0}" \
    --argjson ok "$( [[ "$ok" == "true" ]] && echo true || echo false )" \
    --argjson earnings_seeded "${earnings_seeded:-0}" \
    --argjson errors "$errors_json" \
    '{ticker:$ticker,status_code:$status_code,ok:$ok,earnings_seeded:$earnings_seeded,errors:$errors}' \
    >> "${TMP_DIR}/earnings.ndjson"
done
echo ""

python3 - <<'PY' "$MANIFEST_PATH" "$SAFE_LABEL" "$START_DATE" "$END_DATE" "$BACKFILL_START_DATE" "$MACRO_STATUS" "$TICKERS_RAW" "${TMP_DIR}/backfill.ndjson" "${TMP_DIR}/earnings.ndjson" "${OUT_DIR}/gap-check.json" "${OUT_DIR}/macro-events.json"
import json
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
label = sys.argv[2]
start_date = sys.argv[3]
end_date = sys.argv[4]
coverage_start = sys.argv[5]
macro_status = int(sys.argv[6] or 0)
tickers = [x.strip().upper() for x in sys.argv[7].split(",") if x.strip()]
backfill_path = Path(sys.argv[8])
earnings_path = Path(sys.argv[9])
gap_path = Path(sys.argv[10])
macro_path = Path(sys.argv[11])

def dedupe_by_ticker(rows):
    deduped = {}
    for row in rows:
        ticker = row.get("ticker")
        if ticker:
            deduped[ticker] = row
    return [deduped[ticker] for ticker in tickers if ticker in deduped]

backfill_results = dedupe_by_ticker([json.loads(line) for line in backfill_path.read_text().splitlines() if line.strip()])
earnings_results = dedupe_by_ticker([json.loads(line) for line in earnings_path.read_text().splitlines() if line.strip()])
gap_data = json.loads(gap_path.read_text() or "{}")
macro_data = json.loads(macro_path.read_text() or "{}")

gap_tickers = set(gap_data.get("tickersNeedingBackfill") or [])
watched_with_gaps = [ticker for ticker in tickers if ticker in gap_tickers]

macro_errors = macro_data.get("errors") or []
macro_ok = bool(macro_data.get("ok")) and macro_status == 200 and not macro_errors
earnings_ok = all(item.get("ok") and item.get("status_code") == 200 and not (item.get("errors") or []) for item in earnings_results)
backfill_ok = all(item.get("ok") and item.get("status_code") == 200 for item in backfill_results)
preflight_passed = backfill_ok and macro_ok and earnings_ok and not watched_with_gaps

manifest = {
    "ok": True,
    "label": label,
    "created_at": __import__("datetime").datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
    "contract": "focused_replay_dataset_v1",
    "purpose": "Frozen preflight evidence for the focused replay basket.",
    "replay_window": {"start_date": start_date, "end_date": end_date},
    "coverage_window": {"start_date": coverage_start, "end_date": end_date},
    "ticker_scope": tickers,
    "candle_backfill": {
        "provider": "twelvedata",
        "tf": "all",
        "start_date": coverage_start,
        "end_date": end_date,
        "results": backfill_results,
    },
    "verification": {
        "endpoint": "/timed/admin/candle-gaps",
        "checked_window": {"start_date": coverage_start, "end_date": end_date},
        "watched_with_gaps": watched_with_gaps,
        "global_gap_count": gap_data.get("gapCount", 0),
        "global_tickers_with_gaps": gap_data.get("tickersWithGaps", 0),
        "preflight_passed": not watched_with_gaps,
    },
    "event_readiness": {
        "endpoint": "/timed/admin/backfill-market-events",
        "macro": {
            "status_code": macro_status,
            "ok": bool(macro_data.get("ok")),
            "macro_seeded": macro_data.get("macroSeeded", 0),
            "errors": macro_errors,
        },
        "earnings": earnings_results,
        "preflight_passed": macro_ok and earnings_ok,
    },
    "preflight_passed": preflight_passed,
    "usage": {
        "replay_focused_example": f'./scripts/replay-focused.sh --tickers "{",".join(tickers)}" --start {start_date} --end {end_date} --clean-slate --dataset-manifest {manifest_path} --config-file data/backtest-artifacts/july-equalscope-deterministic-parity-v1-config-20260410.json'
    },
}

manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({
    "manifest": str(manifest_path),
    "watched_with_gaps": watched_with_gaps,
    "backfill_ok": backfill_ok,
    "event_preflight_ok": macro_ok and earnings_ok,
    "preflight_passed": preflight_passed,
}, indent=2))
PY

rm -rf "$TMP_DIR"
echo ""
echo "Focused dataset manifest written to $MANIFEST_PATH"
