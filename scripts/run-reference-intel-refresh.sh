#!/bin/bash
set -euo pipefail

ROOT="/Users/shashant/timedtrading"
LOG_DIR="$ROOT/data/reference-intel"
LOG_FILE="$LOG_DIR/refresh-cron.log"

# launchd provides a minimal PATH; include common Node install paths.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
# launchd/system proxy vars can break direct worker and wrangler calls.
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
export NO_PROXY="localhost,127.0.0.1,timed-trading-ingest.shashant.workers.dev,timedtrading.pages.dev"

mkdir -p "$LOG_DIR"

{
  echo "============================================================"
  echo "reference-intel refresh started: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "============================================================"

  cd "$ROOT"
  if ! command -v npx >/dev/null 2>&1; then
    echo "ERROR: npx not found on PATH=$PATH"
    exit 1
  fi
  python3 scripts/reference-intel-refresh.py --run-matrix

  echo "------------------------------------------------------------"
  echo "reference-intel refresh completed: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "------------------------------------------------------------"
} >> "$LOG_FILE" 2>&1

