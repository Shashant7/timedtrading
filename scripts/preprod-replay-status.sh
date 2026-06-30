#!/usr/bin/env bash
# Preprod replay queue status — one writer at a time on timed-trading-ingest-preprod.
#
# Usage:
#   TIMED_API_KEY=... scripts/preprod-replay-status.sh
#   scripts/preprod-replay-status.sh --json

set -euo pipefail

PRE="${PREPROD_BASE:-https://timed-trading-ingest-preprod.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:-${TIMED_TRADING_API_KEY:-}}"
JSON=false
[[ "${1:-}" == "--json" ]] && JSON=true

[[ -n "$API_KEY" ]] || { echo "ERROR: TIMED_API_KEY required" >&2; exit 2; }

http() {
  curl -sS -m 20 -H "X-API-Key: $API_KEY" "$@"
}

LOCK=$(http "$PRE/timed/admin/replay-lock?key=$API_KEY")
RUNNING=$(http "$PRE/timed/admin/kv/get?k=timed:replay:running&key=$API_KEY")
BT=$(http "$PRE/timed/admin/backtests/status?key=$API_KEY")
HEALTH=$(http "$PRE/timed/health")

locked=$(echo "$LOCK" | jq -r '.locked // false')
lock_val=$(echo "$LOCK" | jq -r '.lock // ""')
run_date=$(echo "$RUNNING" | jq -r '.value.date // ""')
run_since=$(echo "$RUNNING" | jq -r '.value.since // 0')
do_active=$(echo "$BT" | jq -r '.active // ""')
do_job=$(echo "$BT" | jq -r '.job.id // .job // ""')

# Local tmux sessions that commonly hold the preprod replay lock
TMUX_SESSIONS=()
if command -v tmux >/dev/null 2>&1; then
  while IFS= read -r s; do
    [[ -n "$s" ]] && TMUX_SESSIONS+=("$s")
  done < <(tmux -f /exec-daemon/tmux.portal.conf ls -F '#{session_name}' 2>/dev/null \
    | grep -E 'v15-july|investor-post890|july-v[0-9]|july-slice|monthly-slice' || true)
fi

# Checkpoint hints for known July trader lanes
checkpoints=()
for d in /workspace/data/trade-analysis/phase-d-slice-2025-07-v*/slice.checkpoint.json; do
  [[ -f "$d" ]] || continue
  rid=$(jq -r '.run_id // ""' "$d" 2>/dev/null)
  last=$(jq -r '.last_completed_date // ""' "$d" 2>/dev/null)
  updated=$(jq -r '.updated_at // ""' "$d" 2>/dev/null)
  checkpoints+=("${rid}|${last}|${updated}")
done

recommend=""
if [[ "$locked" == "true" ]]; then
  recommend="Hold — replay lock held by: ${lock_val}. Do not start investor/trader slices in parallel."
elif [[ "$do_active" != "null" && -n "$do_active" && "$do_active" != "false" ]]; then
  recommend="Hold — BacktestRunner DO active (${do_job}). Wait or cancel DO before direct-loop."
else
  recommend="Lock free — safe to start ONE replay lane (trader OR investor, not both)."
fi

if $JSON; then
  jq -nc \
    --arg pre "$PRE" \
    --argjson locked "$([[ "$locked" == true ]] && echo true || echo false)" \
    --arg lock "$lock_val" \
    --arg run_date "$run_date" \
    --argjson run_since "${run_since:-0}" \
    --arg do_active "${do_active:-}" \
    --arg do_job "${do_job:-}" \
    --arg recommend "$recommend" \
    --argjson tmux "$(printf '%s\n' "${TMUX_SESSIONS[@]:-}" | jq -R . | jq -s .)" \
    --argjson checkpoints "$(printf '%s\n' "${checkpoints[@]:-}" | jq -R . | jq -s .)" \
    '{preprod: $pre, locked: $locked, lock: $lock, replay_running: {date: $run_date, since_ms: $run_since}, backtest_do: {active: $do_active, job: $do_job}, tmux_sessions: $tmux, checkpoints: $checkpoints, recommend: $recommend}'
  exit 0
fi

echo "=== Preprod replay status ==="
echo "Base: $PRE"
echo ""
echo "Replay lock:  locked=$locked"
echo "              holder=${lock_val:-(none)}"
echo "Replay heartbeat: date=${run_date:-—} since_ms=${run_since:-0}"
echo "Backtest DO:  active=${do_active:-—} job=${do_job:-—}"
echo ""
echo "Local tmux (replay-related):"
if [[ ${#TMUX_SESSIONS[@]} -eq 0 ]]; then
  echo "  (none)"
else
  for s in "${TMUX_SESSIONS[@]}"; do echo "  - $s"; done
fi
echo ""
echo "July checkpoints:"
if [[ ${#checkpoints[@]} -eq 0 ]]; then
  echo "  (none)"
else
  for c in "${checkpoints[@]}"; do
    IFS='|' read -r rid last updated <<< "$c"
    echo "  $rid  last=$last  updated=$updated"
  done
fi
echo ""
echo "Recommendation: $recommend"
echo ""
echo "Rule: ONE writer on preprod. Serialize trader monthly-slice, then investor-slice."
echo "1102/503 on candle-replay = worker CPU limit; monthly-slice retries 5x — do not stack lanes."
