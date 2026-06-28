#!/usr/bin/env bash
# Chained runner: investor anchor on v10 day-state, then v11 trader slice.
set +H 2>/dev/null || true
set -euo pipefail

PRE="${PREPROD_BASE:-https://timed-trading-ingest-preprod.shashant.workers.dev}"
LOG="${REPO_ROOT:-/workspace}/data/trade-analysis/run-both-2025-07.log"
mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1

cd "${REPO_ROOT:-/workspace}"

echo "=== Phase 1: seed investor day-state (existing trader day-state) ==="
scripts/seed-investor-daystate.sh --month=2025-07 --api-base="$PRE"

echo "=== Phase 2: investor anchor slice (--no-reset) ==="
scripts/investor-slice.sh --month=2025-07 --run-id=investor-slice-2025-07-v1 --no-reset --api-base="$PRE"

echo "=== Phase 3: calibration diff (anchor vs current pre-prod) ==="
node scripts/calibration-diff-anchor.mjs || true

echo "=== Phase 4: v11 monthly slice (index model OFF) ==="
scripts/monthly-slice.sh --month=2025-07 --run-id=phase-d-slice-2025-07-v11 \
  --watchdog-seconds=300 --api-base="$PRE" --api-key="${TIMED_API_KEY:?}"

echo "=== Phase 5: seed v11 day-state + investor slice on v11 book ==="
scripts/seed-investor-daystate.sh --month=2025-07 --api-base="$PRE"
scripts/investor-slice.sh --month=2025-07 --run-id=investor-slice-2025-07-v11 --no-reset --api-base="$PRE"

echo "=== ALL DONE ==="
