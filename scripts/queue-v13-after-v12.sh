#!/usr/bin/env bash
# Wait for v12 retry to finish, log a brief verdict, then launch v13 Phase-A iteration.
set +H 2>/dev/null || true
set -euo pipefail

REPO="${REPO_ROOT:-/workspace}"
V12_LOG="$REPO/data/trade-analysis/run-v12-retry-2025-07.log"
V13_LOG="$REPO/data/trade-analysis/run-v13-phase-a-iteration.log"
POLL_SECONDS="${POLL_SECONDS:-60}"
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-7200}"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

log "Waiting for v12 to complete (max ${MAX_WAIT_SECONDS}s, poll ${POLL_SECONDS}s)..."

elapsed=0
while [[ "$elapsed" -lt "$MAX_WAIT_SECONDS" ]]; do
  if [[ -f "$V12_LOG" ]] && grep -q "v12 retry complete" "$V12_LOG"; then
    log "v12 finished."
    break
  fi
  if ! tmux -f /exec-daemon/tmux.portal.conf has-session -t "=run-v12-retry" 2>/dev/null; then
    if [[ -f "$V12_LOG" ]] && grep -q "Phase C slice 2025-07 complete.*v12" "$V12_LOG"; then
      log "v12 tmux gone but slice complete marker found."
      break
    fi
    log "WARN: run-v12-retry tmux session ended without complete marker — proceeding anyway."
    break
  fi
  sleep "$POLL_SECONDS"
  elapsed=$((elapsed + POLL_SECONDS))
  [[ $((elapsed % 300)) -eq 0 ]] && log "still waiting (${elapsed}s)..."
done

if [[ "$elapsed" -ge "$MAX_WAIT_SECONDS" ]]; then
  log "ERROR: timed out waiting for v12"
  exit 1
fi

if [[ -f "$REPO/data/trade-analysis/phase-d-slice-2025-07-v12/trades.json" ]]; then
  log "v12 quick stats:"
  python3 - <<'PY' || true
import json
from pathlib import Path
p = Path("/workspace/data/trade-analysis/phase-d-slice-2025-07-v12/trades.json")
raw = json.loads(p.read_text())
tr = raw.get("trades") or raw
closed = [t for t in tr if t.get("exit_ts")]
w = sum(1 for t in closed if float(t.get("pnl_pct") or 0) > 0)
pnl = sum(float(t.get("pnl_pct") or 0) for t in closed)
idx = sum(1 for t in closed if t.get("ticker") in ("SPY","QQQ","IWM"))
print(f"  v12: {len(closed)} closed WR={100*w/max(1,len(closed)):.1f}% pnl={pnl:.2f}% index={idx}")
PY
fi

log "Launching v13 Phase-A iteration..."
export TIMED_API_KEY="${TIMED_API_KEY:?}"
exec "$REPO/scripts/run-v13-phase-a-iteration.sh"
