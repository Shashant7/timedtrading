#!/usr/bin/env bash
# Resume v13 after a failed day (fixes checkpoint off-by-one on failed_after_retries).
set +H 2>/dev/null || true
set -euo pipefail

PRE="${PREPROD_BASE:-https://timed-trading-ingest-preprod.shashant.workers.dev}"
REPO="${REPO_ROOT:-/workspace}"
RUN_ID="phase-d-slice-2025-07-v13"
LOG="$REPO/data/trade-analysis/run-v13-phase-a-iteration.log"
CHECKPOINT="$REPO/data/trade-analysis/$RUN_ID/slice.checkpoint.json"
V2_CHAIN="$REPO/data/trade-analysis/phase-d-slice-2025-07-v2/block_chain.jsonl"

mkdir -p "$(dirname "$LOG")"
exec >> "$LOG" 2>&1

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

cd "$REPO"

if [[ -f "$CHECKPOINT" ]]; then
  reason=$(jq -r '.reason // ""' "$CHECKPOINT")
  last=$(jq -r '.last_completed_date // ""' "$CHECKPOINT")
  if [[ "$reason" == "failed_after_retries" && -n "$last" ]]; then
    # Resume logic starts AFTER last_completed_date; failed day was never completed.
    prev=$(date -u -d "$last - 1 day" '+%Y-%m-%d' 2>/dev/null || python3 -c "
import datetime as d
t=d.date.fromisoformat('$last')
while t.weekday()>=5: t-=d.timedelta(1)
print(t.isoformat())
")
    # Walk back to previous trading day in July 2025 window
    HOL="2025-07-04"
    while [[ "$prev" > "2025-07-01" ]]; do
      dow=$(date -u -d "$prev" '+%u')
      if [[ "$dow" != "6" && "$dow" != "7" && " $HOL " != *" $prev "* ]]; then break; fi
      prev=$(date -u -d "$prev - 1 day" '+%Y-%m-%d')
    done
    log "=== v13 resume: checkpoint had failed day $last; rewinding to $prev ==="
    jq --arg d "$prev" '.last_completed_date = $d | .reason = "session_complete"' \
      "$CHECKPOINT" > "${CHECKPOINT}.tmp" && mv "${CHECKPOINT}.tmp" "$CHECKPOINT"
  fi
fi

log "=== v13 resume: monthly slice (--resume) ==="
scripts/monthly-slice.sh \
  --month=2025-07 \
  --run-id="$RUN_ID" \
  --block-chain \
  --watchdog-seconds=300 \
  --resume \
  --api-base="$PRE" \
  --api-key="${TIMED_API_KEY:?}"

log "=== v13 resume: block-chain diff ==="
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
  log "Wrote $OUT_BC"
fi

log "=== v13 resume: calibration diff ==="
node scripts/calibration-diff-anchor.mjs \
  --output-json "$REPO/data/trade-analysis/calibration-diff-v13-phase-a.json" \
  --output "$REPO/data/trade-analysis/calibration-diff-v13-phase-a.md" || true

log "=== v13 resume: trade summary ==="
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
    if not tr:
        continue
    n, c, wr, pnl, idx = stats(tr)
    print(f"{rid}: trades={n} closed={c} WR={wr:.1f}% sum_pnl={pnl:.2f}% index_trades={idx}")
PY
fi

log "=== v13 Phase-A iteration complete (resumed) ==="
