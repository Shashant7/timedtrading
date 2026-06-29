#!/usr/bin/env bash
# v14-A July slice: v6/v7 challenger lane + global range-reversal block.
set +H 2>/dev/null || true
set -euo pipefail

PRE="${PREPROD_BASE:-https://timed-trading-ingest-preprod.shashant.workers.dev}"
REPO="${REPO_ROOT:-/workspace}"
RUN_ID="${RUN_ID:-phase-d-slice-2025-07-v14}"
LOG="$REPO/data/trade-analysis/run-v14-a-july.log"

mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1

cd "$REPO"

echo "=== v14-A July slice started $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="
echo "=== Step 1: push v14-A config to pre-prod ==="
node scripts/push-july-v14-config.mjs

echo "=== Step 2: July slice (metrics run; no block-chain by default) ==="
SLICE_ARGS=(
  --month=2025-07
  --run-id="$RUN_ID"
  --watchdog-seconds=300
  --api-base="$PRE"
  --api-key="${TIMED_API_KEY:?}"
)
if [[ "${BLOCK_CHAIN:-0}" == "1" ]]; then
  SLICE_ARGS+=(--block-chain)
fi
if [[ "${RESUME:-0}" == "1" ]]; then
  SLICE_ARGS+=(--resume)
fi

scripts/monthly-slice.sh "${SLICE_ARGS[@]}"

echo "=== Step 3: summarize v14-A vs prior runs ==="
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
    pnls = [float(t.get("pnl_pct") or 0) for t in closed]
    wins = sum(1 for p in pnls if p > 0)
    rr_long = [t for t in closed if t.get("entry_path") == "tt_range_reversal_long"]
    idx_stock = [
        t for t in closed
        if t.get("ticker") in ("SPY", "QQQ", "IWM")
        and t.get("entry_path") != "tt_index_etf_swing"
    ]
    return {
        "trades": len(trades),
        "closed": len(closed),
        "wr": 100 * wins / max(1, len(pnls)),
        "pnl": sum(pnls),
        "range_reversal": len(rr_long),
        "index_stock_path": len(idx_stock),
    }

for rid in [
    "phase-d-slice-2025-07-v6",
    "phase-d-slice-2025-07-v7",
    "phase-d-slice-2025-07-v13",
    "phase-d-slice-2025-07-v14",
]:
    tr = load_trades(rid)
    if not tr:
        print(f"{rid}: no trades artifact")
        continue
    s = stats(tr)
    print(
        f"{rid}: trades={s['trades']} closed={s['closed']} "
        f"WR={s['wr']:.1f}% sum_pnl={s['pnl']:+.2f}% "
        f"range_reversal={s['range_reversal']} index_stock_path={s['index_stock_path']}"
    )
PY

echo "=== v14-A July slice complete ==="
