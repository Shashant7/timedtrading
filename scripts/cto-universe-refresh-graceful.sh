#!/usr/bin/env bash
# Gracefully seed/refresh the CTO scored-universe rollup without blowing the
# worker CPU budget. Runs priority first, then batched full passes until the
# daily tier stops early or max passes is reached.
set -euo pipefail

BASE="${WORKER_URL:-https://timed-trading-ingest.shashant.workers.dev}"
KEY="${TIMED_API_KEY:-${TIMED_TRADING_API_KEY:-}}"
if [[ -z "$KEY" ]]; then
  echo "Missing TIMED_API_KEY" >&2
  exit 1
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

post_refresh() {
  local mode="$1"
  local max_ms="${2:-240000}"
  curl -sS -X POST "$BASE/timed/admin/cto/universe/refresh?key=$KEY" \
    -H "Content-Type: application/json" \
    -d "{\"mode\":\"$mode\",\"forceRefresh\":false,\"maxElapsedMs\":$max_ms}" \
    -o "$TMP"
}

summarize_file() {
  python3 <<'PY'
import json
with open("/tmp/cto_refresh_resp.json") as f:
    j = json.load(f)
print(
  "  mode={mode} ok={ok} processed={proc}/{req} rollup_ok={okn} in_rollup={roll} "
  "scored={scored} cache_hits={hits} computed={comp} stopped_early={early} elapsed_ms={ms}".format(
    mode=j.get("mode"),
    ok=j.get("ok"),
    proc=j.get("tickers_processed"),
    req=j.get("tickers_requested"),
    okn=j.get("tickers_ok"),
    roll=j.get("tickers_in_rollup"),
    scored=j.get("scored_universe_size"),
    hits=j.get("cache_hits"),
    comp=j.get("computed"),
    early=j.get("stopped_early"),
    ms=j.get("elapsed_ms"),
  )
)
PY
}

RESP="/tmp/cto_refresh_resp.json"

echo "== CTO graceful refresh @ $BASE =="

echo
echo "[1/3] Priority pass (indices + open positions, 45s cap)..."
post_refresh priority 45000
cp "$TMP" "$RESP"
summarize_file

echo
echo "[2/3] Full scored-universe passes (4m cap each, stop when not early)..."
max_passes=6
for i in $(seq 1 "$max_passes"); do
  echo "  pass $i/$max_passes..."
  post_refresh all 240000
  cp "$TMP" "$RESP"
  summarize_file
  stopped="$(python3 -c 'import json; print(json.load(open("/tmp/cto_refresh_resp.json")).get("stopped_early"))')"
  if [[ "$stopped" == "False" || "$stopped" == "false" ]]; then
    echo "  completed without early stop."
    break
  fi
  echo "  stopped early — sleeping 10s before next pass..."
  sleep 10
done

echo
echo "[3/3] Rebuild public CTO feed KV..."
curl -sS -X POST "$BASE/timed/admin/cto/feed/refresh?key=$KEY" \
  -H "Content-Type: application/json" -d '{}' -o "$TMP"
cp "$TMP" "$RESP"
python3 -c 'import json; j=json.load(open("/tmp/cto_refresh_resp.json")); print("  feed ok={} items={} tickers_ok={}".format(j.get("ok"), j.get("count"), j.get("tickers_ok")))'

echo
echo "Done."
