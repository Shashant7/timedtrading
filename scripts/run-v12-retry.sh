#!/usr/bin/env bash
# v12 retry: trader slice then investor slice (seed + month-end close).
set +H 2>/dev/null || true
set -euo pipefail

PRE="${PREPROD_BASE:-https://timed-trading-ingest-preprod.shashant.workers.dev}"
LOG="${REPO_ROOT:-/workspace}/data/trade-analysis/run-v12-retry-2025-07.log"
mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1

cd "${REPO_ROOT:-/workspace}"

echo "=== Push v12 config ==="
node scripts/push-july-v12-config.mjs

echo "=== Phase 1: v12 trader slice ==="
scripts/monthly-slice.sh --month=2025-07 --run-id=phase-d-slice-2025-07-v12 \
  --watchdog-seconds=300 --api-base="$PRE" --api-key="${TIMED_API_KEY:?}"

echo "=== Phase 2: seed investor day-state ==="
scripts/seed-investor-daystate.sh --month=2025-07 --api-base="$PRE"

echo "=== Phase 3: investor slice (no reset, month-end close) ==="
scripts/investor-slice.sh --month=2025-07 --run-id=investor-slice-2025-07-v12 \
  --no-reset --api-base="$PRE"

echo "=== Phase 4: calibration diff (anchor from prod) ==="
node scripts/calibration-diff-anchor.mjs || true

echo "=== v12 retry complete ==="
