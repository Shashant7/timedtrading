#!/usr/bin/env bash
# Retry wrangler deploy for transient Cloudflare API failures (code 10013)
# when multiple monolith-bundle workers deploy back-to-back.
set -euo pipefail

WORKDIR="${1:?usage: deploy-wrangler-retry.sh <workingDirectory> [extra wrangler args...]}"
shift || true

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/$WORKDIR"

WRANGLER_VERSION="${WRANGLER_VERSION:-4.92.0}"
MAX_ATTEMPTS="${WRANGLER_DEPLOY_RETRIES:-4}"
SLEEP_BASE_SEC="${WRANGLER_DEPLOY_RETRY_SLEEP_SEC:-20}"

if ! command -v wrangler >/dev/null 2>&1; then
  npx "wrangler@${WRANGLER_VERSION}" --version >/dev/null
  WRANGLER=(npx "wrangler@${WRANGLER_VERSION}")
else
  WRANGLER=(wrangler)
fi

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  echo "wrangler deploy attempt ${attempt}/${MAX_ATTEMPTS} in ${WORKDIR} $*"
  if "${WRANGLER[@]}" deploy "$@"; then
    echo "Deploy succeeded on attempt ${attempt}"
    exit 0
  fi
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "::error::wrangler deploy failed after ${MAX_ATTEMPTS} attempts in ${WORKDIR}"
    exit 1
  fi
  sleep_sec=$((attempt * SLEEP_BASE_SEC))
  echo "Deploy failed — sleeping ${sleep_sec}s before retry"
  sleep "$sleep_sec"
  attempt=$((attempt + 1))
done
