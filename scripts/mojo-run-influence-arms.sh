#!/usr/bin/env bash
# Run mojo influence arms A0→A4 on fixed U24 for one month (preprod).
# Usage:
#   TIMED_API_KEY=$TIMED_TRADING_API_KEY bash scripts/mojo-run-influence-arms.sh \
#     [--month=2026-07] [--from-arm=A0-tech] [--only=A0-tech]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MONTH="2026-07"
FROM_ARM=""
ONLY=""
API_BASE="${API_BASE:-https://timed-trading-ingest-preprod.shashant.workers.dev}"
U24_FILE="${U24_FILE:-data/mojo-weekend/u24.txt}"
INTERVAL="${INTERVAL:-30}"
WATCHDOG="${WATCHDOG:-900}"

for arg in "$@"; do
  case "$arg" in
    --month=*) MONTH="${arg#*=}" ;;
    --from-arm=*) FROM_ARM="${arg#*=}" ;;
    --only=*) ONLY="${arg#*=}" ;;
    --api-base=*) API_BASE="${arg#*=}" ;;
    --interval=*) INTERVAL="${arg#*=}" ;;
  esac
done

if [[ -z "${TIMED_API_KEY:-}" && -n "${TIMED_TRADING_API_KEY:-}" ]]; then
  export TIMED_API_KEY="$TIMED_TRADING_API_KEY"
fi
if [[ -z "${TIMED_API_KEY:-}" ]]; then
  echo "TIMED_API_KEY required" >&2
  exit 2
fi

TICKERS="$(tr '\n' ',' < "$U24_FILE" | sed 's/,$//')"
N=$(tr ',' '\n' <<< "$TICKERS" | grep -c . || true)
echo "U24 file=$U24_FILE n=$N tickers=$TICKERS"
echo "month=$MONTH api=$API_BASE interval=${INTERVAL}m"

ARMS=(A0-tech A1-tt A2-lists A3-theme A4-full)
started=0
for ARM in "${ARMS[@]}"; do
  if [[ -n "$ONLY" && "$ARM" != "$ONLY" ]]; then continue; fi
  if [[ -n "$FROM_ARM" && "$started" -eq 0 && "$ARM" != "$FROM_ARM" ]]; then continue; fi
  started=1

  echo "======== ARM $ARM ========"
  node scripts/mojo-ablation-arm.mjs "$ARM"

  # Clear foreign lock if any
  curl -sS -X DELETE -H "X-API-Key: $TIMED_API_KEY" "$API_BASE/timed/admin/replay-lock" >/dev/null || true
  sleep 2
  curl -sS -X DELETE -H "X-API-Key: $TIMED_API_KEY" "$API_BASE/timed/admin/replay-lock" >/dev/null || true

  RUN_ID="mojo-${ARM}-u24-${MONTH//-/}"
  LABEL="mojo-${ARM}-u24"

  TIMED_API_KEY="$TIMED_API_KEY" bash scripts/monthly-slice.sh \
    --month="$MONTH" \
    --run-id="$RUN_ID" \
    --label="$LABEL" \
    --tickers="$TICKERS" \
    --ticker-batch="$N" \
    --interval-minutes="$INTERVAL" \
    --watchdog-seconds="$WATCHDOG" \
    --api-base="$API_BASE" \
    --block-chain \
    2>&1 | tee "/opt/cursor/artifacts/mojo/${RUN_ID}.log"

  echo "ARM $ARM done → $RUN_ID"
done

echo "All requested arms finished."
