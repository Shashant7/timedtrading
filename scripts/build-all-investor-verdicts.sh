#!/usr/bin/env bash
# Phase 3 — generate per-month verdicts for the full Jul 2025 → Apr 2026 window.
#
# Usage:
#   TIMED_TRADING_API_KEY=... \
#   PREPROD_BASE=https://timed-trading-ingest-preprod.shashant.workers.dev \
#     bash scripts/build-all-investor-verdicts.sh \
#       --trader-run-id phase-c-stage1-jul2025-may2026 \
#       --th-run-id     phase-c-stage2-trader-th-jul2025-may2026
#
# Or against live worker (read-only, safe — same as universe-benchmark.py):
#   bash scripts/build-all-investor-verdicts.sh \
#     --trader-run-id phase-c-stage1-jul2025-may2026

set -uo pipefail

TRADER_RUN_ID=""
TH_RUN_ID=""
API_BASE="${PREPROD_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
OUT_DIR="tasks/phase-c/monthly-verdicts"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --trader-run-id) TRADER_RUN_ID="$2"; shift 2 ;;
    --th-run-id)     TH_RUN_ID="$2"; shift 2 ;;
    --api-base)      API_BASE="$2"; shift 2 ;;
    --out-dir)       OUT_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

if [[ -z "$TRADER_RUN_ID" ]]; then
  echo "ERROR: --trader-run-id required" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"

# Walk Jul 2025 → Apr 2026 (10 months). May 2026 is partial; skip unless explicitly run.
MONTHS=(2025-07 2025-08 2025-09 2025-10 2025-11 2025-12 2026-01 2026-02 2026-03 2026-04)

echo "[verdict-all] running ${#MONTHS[@]} monthly verdicts"
echo "[verdict-all] trader=$TRADER_RUN_ID th=${TH_RUN_ID:-(none)} api=$API_BASE"
echo ""

FAILED=0
for m in "${MONTHS[@]}"; do
  echo "=== $m ==="
  ARGS=(--month "$m" --trader-run-id "$TRADER_RUN_ID" --api-base "$API_BASE" --out "$OUT_DIR/$m-investor.md")
  if [[ -n "$TH_RUN_ID" ]]; then
    ARGS+=(--th-run-id "$TH_RUN_ID")
  fi
  if node scripts/build-investor-monthly-verdict.js "${ARGS[@]}"; then
    echo ""
  else
    echo "  FAIL on $m"
    FAILED=$((FAILED + 1))
  fi
done

echo "[verdict-all] done. failures=$FAILED"
exit $FAILED
