#!/usr/bin/env bash
set -euo pipefail
cd /workspace
export TIMED_API_KEY="${TIMED_API_KEY:-${TIMED_TRADING_API_KEY:-}}"
mkdir -p data/setup-mining/move-replay
exec node scripts/replay-move-windows.mjs \
  --discovery-file data/move-discovery-live.json \
  --limit 10 \
  --min-atr 10 \
  --one-per-ticker \
  --exclude-ticker SOXL,KLAC,DELL,ARM,INTC,FTNT,STRL,DDOG,ENPH,SNOW,SNDK,ON,AMD,ETHA,IBM,PANW,VSXY,CRWD,SMCI \
  --pre-entry-days 5 \
  --wrangler-d1 production \
  --out-dir data/setup-mining/move-replay \
  2>&1 | tee "data/setup-mining/move-replay/batch-11-$(date -u +%Y%m%d-%H%M%S).log"
