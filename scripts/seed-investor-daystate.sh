#!/usr/bin/env bash
# scripts/seed-investor-daystate.sh — Patch replay day-state with monthly_bundle.
#
# Trader monthly-slice writes timed:replay:daystate:{date} via skipInvestor=1.
# Replay's M bundle gate (50 bars) fails for Jul 2025 (~13 unique months in D1),
# so monthly_bundle stays null and investor-replay's D/W/M ST gate opens 0.
# This driver calls POST /timed/admin/seed-investor-daystate per trading day
# to backfill monthly_bundle from D1 M candles (15-bar minimum).
#
# Run AFTER a trader monthly-slice (day-state must exist) and BEFORE
# investor-slice.sh --no-reset.
#
# Usage:
#   TIMED_API_KEY=... scripts/seed-investor-daystate.sh \
#     --month=2025-07 \
#     [--tickers=SPY,QQQ,...] \
#     [--api-base=https://timed-trading-ingest-preprod.shashant.workers.dev]

set -euo pipefail

DEFAULT_API_BASE="https://timed-trading-ingest-preprod.shashant.workers.dev"
MONTH=""; START=""; END=""; TICKERS=""; API_BASE="$DEFAULT_API_BASE"
API_KEY="${TIMED_API_KEY:-${TIMED_TRADING_API_KEY:-}}"

NYSE_HOLIDAYS="2025-07-04 2025-09-01 2025-11-27 2025-12-25 2026-01-01 2026-01-19 2026-02-16 2026-04-03 2026-05-25 2026-06-19 2026-07-03 2026-09-07 2026-11-26 2026-12-25"

die_usage() { echo "ERROR: $1" >&2; echo "Usage: $0 --month=YYYY-MM [--tickers=csv] [--start=.. --end=..] [--api-base=url]" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --month=*) MONTH="${1#*=}" ;;
    --start=*) START="${1#*=}" ;;
    --end=*) END="${1#*=}" ;;
    --tickers=*) TICKERS="${1#*=}" ;;
    --api-base=*) API_BASE="${1#*=}" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die_usage "unknown arg: $1" ;;
  esac
  shift
done

[[ -z "$API_KEY" ]] && die_usage "TIMED_API_KEY required"
command -v jq >/dev/null || die_usage "jq required"

if [[ -n "$MONTH" ]]; then
  [[ "$MONTH" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]] || die_usage "--month must be YYYY-MM"
  START="${MONTH}-01"
  END=$(date -u -d "${START} +1 month -1 day" "+%Y-%m-%d")
fi
[[ -z "$START" || -z "$END" ]] && die_usage "provide --month or --start/--end"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
is_weekend() { local d; d=$(date -u -d "$1" '+%u'); [[ "$d" == "6" || "$d" == "7" ]]; }
is_holiday() { [[ " $NYSE_HOLIDAYS " == *" $1 "* ]]; }
next_day() { date -u -d "$1 + 1 day" '+%Y-%m-%d'; }

DAYS=(); cur="$START"
while [[ "$cur" < "$END" || "$cur" == "$END" ]]; do
  if ! is_weekend "$cur" && ! is_holiday "$cur"; then DAYS+=("$cur"); fi
  cur=$(next_day "$cur")
done

log "=== Seed investor day-state === period=$START → $END days=${#DAYS[@]} base=$API_BASE"

PATCHED=0; ERR=0
for d in "${DAYS[@]}"; do
  url="$API_BASE/timed/admin/seed-investor-daystate?date=$d&key=$API_KEY"
  [[ -n "$TICKERS" ]] && url+="&tickers=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$TICKERS'))")"
  RES=$(curl -sS -m 120 -X POST "$url" -H "X-API-Key: $API_KEY" 2>&1) || { log "  ERROR $d curl failed"; ERR=$((ERR+1)); continue; }
  if [[ "$(echo "$RES" | jq -r '.ok // false')" != "true" ]]; then
    log "  WARN $d: $(echo "$RES" | jq -c '{ok,error,message}' 2>/dev/null || echo "$RES" | head -c 120)"
    ERR=$((ERR+1)); continue
  fi
  p=$(echo "$RES" | jq -r '.patched // 0')
  PATCHED=$((PATCHED + p))
  [[ "$p" != "0" ]] && log "  $d patched=$p skippedNoBars=$(echo "$RES" | jq -r '.skippedNoBars // 0')"
done

log "=== Seed complete patched=$PATCHED errors=$ERR ==="
[[ "$ERR" -gt 0 ]] && exit 5
exit 0
