#!/usr/bin/env bash
# v15 July slice — anchor-recovery lane (v12 selectivity + global range-reversal block).
set +H 2>/dev/null || true
set -euo pipefail

PRE="${PREPROD_BASE:-https://timed-trading-ingest-preprod.shashant.workers.dev}"
REPO="${REPO_ROOT:-/workspace}"
RUN_ID="${RUN_ID:-phase-d-slice-2025-07-v15}"
LOG="$REPO/data/trade-analysis/run-v15-july.log"

mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1

cd "$REPO"

echo "=== v15 July slice started $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="
echo "=== Step 1: push v15 config (index OFF, range-reversal blocked) ==="
node scripts/push-july-v15-config.mjs

echo "=== Step 2: July slice (fresh reset, 300s watchdog) ==="
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

echo "=== Step 3: scorecard vs anchor / v6 / v14 ==="
python3 - <<'PY'
import json
from pathlib import Path

repo = Path("/workspace")
ANCHOR = {"trades": 25, "wr": 76.0, "pnl": 26.05, "index": 0}

def load_trades(rid):
    p = repo / "data/trade-analysis" / rid / "trades.json"
    if not p.exists():
        return []
    raw = json.loads(p.read_text())
    return raw.get("trades") or (raw if isinstance(raw, list) else [])

def stats(trades):
    closed = [t for t in trades if t.get("status") in ("WIN", "LOSS") or t.get("exit_ts")]
    pnls = [float(t.get("pnl_pct") or 0) for t in closed]
    wins = sum(1 for p in pnls if p > 0)
    idx = sum(
        1 for t in closed
        if t.get("ticker") in ("SPY", "QQQ", "IWM")
    )
    rr = sum(1 for t in closed if t.get("entry_path") == "tt_range_reversal_long")
    ge90 = [t for t in closed if (t.get("rank") or 0) >= 90]
    wr90 = 100 * sum(1 for t in ge90 if t.get("status") == "WIN" or (t.get("pnl_pct") or 0) > 0) / max(1, len(ge90))
    return {
        "trades": len(closed),
        "wr": 100 * wins / max(1, len(pnls)),
        "pnl": sum(pnls),
        "index": idx,
        "range_reversal": rr,
        "rank90_wr": wr90,
        "rank90_n": len(ge90),
    }

print(f"{'run':<35} {'n':>4} {'WR%':>6} {'pnl%':>8} {'idx':>4} {'RR':>3} {'r90WR':>6}")
print("-" * 72)
print(f"{'ANCHOR (target)':<35} {ANCHOR['trades']:>4} {ANCHOR['wr']:>5.1f} {ANCHOR['pnl']:>+8.2f} {ANCHOR['index']:>4} {'—':>3} {'84+':>6}")

for rid in [
    "phase-d-slice-2025-07-v6",
    "phase-d-slice-2025-07-v12",
    "phase-d-slice-2025-07-v14",
    "phase-d-slice-2025-07-v15",
]:
    tr = load_trades(rid)
    if not tr:
        print(f"{rid:<35} {'—':>4} {'—':>6} {'—':>8} {'—':>4} {'—':>3} {'—':>6}")
        continue
    s = stats(tr)
    print(
        f"{rid:<35} {s['trades']:>4} {s['wr']:>5.1f} {s['pnl']:>+8.2f} "
        f"{s['index']:>4} {s['range_reversal']:>3} {s['rank90_wr']:>5.0f}%"
    )

v15 = stats(load_trades("phase-d-slice-2025-07-v15"))
if v15["trades"]:
    ok = []
    if v15["trades"] <= 30:
        ok.append("trade count ≤30 (selectivity)")
    if v15["index"] == 0:
        ok.append("0 index entries")
    if v15["range_reversal"] == 0:
        ok.append("0 range-reversal entries")
    if v15["wr"] >= 60:
        ok.append("WR ≥60%")
    if v15["pnl"] >= 18:
        ok.append("pnl ≥ v6 baseline (+18%)")
    print("")
    print("v15 acceptance checks:", ", ".join(ok) if ok else "none yet")
PY

echo "=== v15 July slice complete ==="
