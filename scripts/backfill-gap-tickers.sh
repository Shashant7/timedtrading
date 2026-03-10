#!/bin/bash
# Backfill candle gaps using Alpaca via the worker endpoint.
# Targets the 90 tickers identified by audit-data-completeness with intraday gaps.
# Uses ?provider=alpaca to force Alpaca even when DATA_PROVIDER=twelvedata.

set -e

API_BASE="${WORKER_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:-AwesomeSauce}"

START_DATE="2025-01-01"
END_DATE="2026-03-04"

GAP_TICKERS=(
  AAPU ABBV ABNB ADBE AEE AEP AMAT AMT BAC BIIB
  BKNG BLK BMY BRK.B BTBT C CMCSA CMG COF COP
  CRVS D DHR DIS DLR DUK ECL EOG EQIX ES
  ETHT ETR EXC EXPI FCX FDX FE FIG GD GDXJ
  GLD GOLD GOOG GRAB HD HON IBKR IBRX JNJ LIN
  LMT LOW MCO MPC MRK MS NEE NEM O ONDS
  OPEN PEG PLD PSA PSX PYPL QCOM REGN SBET SBUX
  SCHW SHW SLB SMCI SO SPG SRE T TFC TMO
  TXN USB VICI VZ W WDAY WEC WELL WFC XEL
)

TFS=(10 30 60 240)

TOTAL=${#GAP_TICKERS[@]}
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Alpaca Gap Backfill: $TOTAL tickers × ${#TFS[@]} TFs                    ║"
echo "║  Range: $START_DATE → $END_DATE                          ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

GRAND_UPSERTED=0
GRAND_ERRORS=0
START_TS=$(date +%s)

for TF in "${TFS[@]}"; do
  echo ""
  echo "══════════════════════════════════════════"
  echo "  TF=$TF — Processing $TOTAL tickers"
  echo "══════════════════════════════════════════"

  TF_UPSERTED=0
  TF_ERRORS=0
  IDX=0

  for TICKER in "${GAP_TICKERS[@]}"; do
    IDX=$((IDX + 1))
    PCT=$((IDX * 100 / TOTAL))
    echo -n "  [$IDX/$TOTAL $PCT%] $TICKER TF=$TF ... "

    RESULT=$(curl -s -m 300 -X POST \
      "$API_BASE/timed/admin/alpaca-backfill?provider=alpaca&tf=$TF&ticker=$TICKER&startDate=$START_DATE&endDate=$END_DATE&key=$API_KEY" 2>&1)

    OK=$(echo "$RESULT" | jq -r '.ok // false' 2>/dev/null || echo "false")
    UPSERTED=$(echo "$RESULT" | jq -r '.upserted // 0' 2>/dev/null || echo "0")
    ERRS=$(echo "$RESULT" | jq -r '.errors // 0' 2>/dev/null || echo "0")

    if [[ "$OK" == "true" ]]; then
      echo "${UPSERTED} bars"
      TF_UPSERTED=$((TF_UPSERTED + UPSERTED))
    else
      ERR_MSG=$(echo "$RESULT" | jq -r '.error // "unknown"' 2>/dev/null || echo "unknown")
      echo "FAIL: $ERR_MSG"
      TF_ERRORS=$((TF_ERRORS + 1))
    fi
    TF_ERRORS=$((TF_ERRORS + ERRS))

    sleep 0.5
  done

  GRAND_UPSERTED=$((GRAND_UPSERTED + TF_UPSERTED))
  GRAND_ERRORS=$((GRAND_ERRORS + TF_ERRORS))
  echo ""
  echo "  TF=$TF complete: $TF_UPSERTED bars, $TF_ERRORS errors"
done

ELAPSED=$(( $(date +%s) - START_TS ))
echo ""
echo "══════════════════════════════════════════"
echo "  DONE: $GRAND_UPSERTED total bars, $GRAND_ERRORS errors, ${ELAPSED}s elapsed"
echo "══════════════════════════════════════════"
