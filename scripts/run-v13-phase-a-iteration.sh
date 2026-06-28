#!/usr/bin/env bash
# v13 — Phase-A anchor config re-seed + block-chain slice + admission diff.
#
# Closes the WR gap using doc-backed methodology (july-readiness-review,
# july-slice-v2-improvement-plan):
#   1. Seed frozen phase-c-slice-2025-07-v1 config (144 keys) to pre-prod
#   2. Run July slice WITH --block-chain under Phase-A config (+ v12 worker index block)
#   3. Compare block chains: v13 (strict) vs v2 (loose prod-sync proxy)
#   4. Calibration diff + engine commit diff
#
# Does NOT blanket-block ATH on singles — index stock-path block is worker-side only.
set +H 2>/dev/null || true
set -euo pipefail

PRE="${PREPROD_BASE:-https://timed-trading-ingest-preprod.shashant.workers.dev}"
REPO="${REPO_ROOT:-/workspace}"
RUN_ID="phase-d-slice-2025-07-v13"
LOG="$REPO/data/trade-analysis/run-v13-phase-a-iteration.log"
V2_CHAIN="$REPO/data/trade-analysis/phase-d-slice-2025-07-v2/block_chain.jsonl"
ANCHOR_DIR="$REPO/data/trade-analysis/phase-c-slice-2025-07-v1"

mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1

cd "$REPO"

echo "=== v13 Phase-A iteration started $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="

echo "=== Step 1: seed Phase-A anchor config to pre-prod ==="
node scripts/seed-phase-a-anchor-config.mjs

echo "=== Step 2: engine diff since anchor (1d7d8d3) ==="
bash scripts/diff-engine-since-anchor.sh

echo "=== Step 3: July slice with block-chain (Phase-A config) ==="
scripts/monthly-slice.sh \
  --month=2025-07 \
  --run-id="$RUN_ID" \
  --block-chain \
  --watchdog-seconds=300 \
  --api-base="$PRE" \
  --api-key="${TIMED_API_KEY:?}"

echo "=== Step 4: block-chain diff (v13 strict vs v2 loose proxy) ==="
V13_CHAIN="$REPO/data/trade-analysis/$RUN_ID/block_chain.jsonl"
OUT_BC="$REPO/data/trade-analysis/$RUN_ID/block_chain_vs_v2.md"
if [[ -f "$V2_CHAIN" && -f "$V13_CHAIN" ]]; then
  node scripts/compare-block-chains.js \
    --baseline "$V13_CHAIN" \
    --challenger "$V2_CHAIN" \
    --out "$OUT_BC" \
    --cohort "etf:SPY,QQQ,IWM" \
    --cohort "t1_stocks:AAPL,MSFT,GOOGL,AMZN,META,NVDA,TSLA" \
    --top 30
  echo "Wrote $OUT_BC"
else
  echo "WARN: missing block chain file(s): v13=$V13_CHAIN v2=$V2_CHAIN"
fi

echo "=== Step 5: calibration diff (anchor frozen vs post-seed pre-prod) ==="
node scripts/calibration-diff-anchor.mjs \
  --output-json "$REPO/data/trade-analysis/calibration-diff-v13-phase-a.json" \
  --output "$REPO/data/trade-analysis/calibration-diff-v13-phase-a.md" || true

echo "=== Step 6: summarize v13 trades vs anchor ==="
if [[ -f "$REPO/data/trade-analysis/$RUN_ID/trades.json" ]]; then
  python3 - <<'PY'
import json
from pathlib import Path
repo = Path("/workspace")

def load_trades(rid):
    p = repo / "data/trade-analysis" / rid / "trades.json"
    if not p.exists():
        return []
    raw = json.loads(p.read_text())
    return raw.get("trades") or raw if isinstance(raw, list) else []

def stats(trades):
    closed = [t for t in trades if t.get("exit_ts")]
    wins = sum(1 for t in closed if float(t.get("pnl_pct") or 0) > 0)
    pnl = sum(float(t.get("pnl_pct") or 0) for t in closed)
    idx = [t for t in closed if t.get("ticker") in ("SPY", "QQQ", "IWM")]
    wr = 100 * wins / max(1, len(closed))
    return len(trades), len(closed), wr, pnl, len(idx)

for rid in ["phase-c-slice-2025-07-v1", "phase-d-slice-2025-07-v12", "phase-d-slice-2025-07-v13"]:
    tr = load_trades(rid)
    if not tr and rid.startswith("phase-c"):
        continue
    if not tr:
        print(f"{rid}: (no trades file yet)")
        continue
    n, c, wr, pnl, idx = stats(tr)
    print(f"{rid}: trades={n} closed={c} WR={wr:.1f}% sum_pnl={pnl:.2f}% index_trades={idx}")
PY
fi

echo "=== v13 Phase-A iteration complete ==="
