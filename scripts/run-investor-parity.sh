#!/bin/bash
set -e

API_BASE="${TIMED_API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:-AwesomeSauce}"

START_DATE="${1:-2025-07-01}"
END_DATE="${2:-$(date '+%Y-%m-%d')}"
TICKER_BATCH="${3:-15}"
CONFIG_FILE="${4:-configs/iter5-runtime-recovered-20260325.json}"
LABEL="${5:-investor-parity}"

SNAPSHOT_TS=$(date "+%Y%m%d-%H%M%S")
OUT_DIR="data/backtest-artifacts/${LABEL}--${SNAPSHOT_TS}"
mkdir -p "$OUT_DIR"

echo "=== Investor Parity Harness ==="
echo "Range:  $START_DATE -> $END_DATE"
echo "Batch:  $TICKER_BATCH"
echo "Config: $CONFIG_FILE"
echo "Out:    $OUT_DIR"
echo ""

./scripts/full-backtest.sh --sequence --config-file "$CONFIG_FILE" --label="$LABEL" "$START_DATE" "$END_DATE" "$TICKER_BATCH"

curl -s "${API_BASE}/timed/investor/scores?key=${API_KEY}" > "$OUT_DIR/investor-scores.json"
curl -s "${API_BASE}/timed/investor/market-health?key=${API_KEY}" > "$OUT_DIR/investor-market-health.json"
curl -s "${API_BASE}/timed/investor/portfolio?key=${API_KEY}" > "$OUT_DIR/investor-portfolio.json"
curl -s "${API_BASE}/timed/account-summary?mode=investor&key=${API_KEY}" > "$OUT_DIR/investor-account-summary.json"

cat > "$OUT_DIR/manifest.json" <<EOF
{
  "ok": true,
  "label": "$LABEL",
  "start_date": "$START_DATE",
  "end_date": "$END_DATE",
  "ticker_batch": $TICKER_BATCH,
  "config_file": "$CONFIG_FILE",
  "captured_at": "$SNAPSHOT_TS"
}
EOF

echo ""
echo "Investor parity artifacts captured in $OUT_DIR"
