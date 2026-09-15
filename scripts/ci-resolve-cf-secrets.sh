#!/usr/bin/env bash
#
# Resolve the Cloudflare deploy credentials for a CI deploy job and export
# them under the canonical names wrangler reads.
#
# Accepts the standard secret names plus the aliases the repo has
# historically used, reading them from the environment:
#   token:   CF_TOKEN_A / CF_TOKEN_B / CF_TOKEN_C
#   account: CF_ACCT_A  / CF_ACCT_B
#
# FAILS when either is missing. The previous inline version of this logic
# wrote `secrets-ok=false` and `exit 0`, which made a no-op deploy report
# SUCCESS. Between 2026-09-03 and 2026-09-14 that hid eleven days of
# undeployed worker merges (see .github/workflows/deploy-worker.yml).
set -euo pipefail

CF_TOKEN=""
CF_ACCT=""
SRC_T=""
SRC_A=""

if   [ -n "${CF_TOKEN_A:-}" ]; then CF_TOKEN="$CF_TOKEN_A"; SRC_T="CLOUDFLARE_API_TOKEN"
elif [ -n "${CF_TOKEN_B:-}" ]; then CF_TOKEN="$CF_TOKEN_B"; SRC_T="CF_API_TOKEN"
elif [ -n "${CF_TOKEN_C:-}" ]; then CF_TOKEN="$CF_TOKEN_C"; SRC_T="CLOUDFLARE_TOKEN"
fi

if   [ -n "${CF_ACCT_A:-}" ]; then CF_ACCT="$CF_ACCT_A"; SRC_A="CLOUDFLARE_ACCOUNT_ID"
elif [ -n "${CF_ACCT_B:-}" ]; then CF_ACCT="$CF_ACCT_B"; SRC_A="CF_ACCOUNT_ID"
fi

if [ -z "$CF_TOKEN" ] || [ -z "$CF_ACCT" ]; then
  echo "::error::Cloudflare deploy credentials are not configured — nothing was deployed."
  echo "::error::Add these repo secrets (Settings -> Secrets and variables -> Actions):"
  echo "::error::  CLOUDFLARE_API_TOKEN   (or CF_API_TOKEN / CLOUDFLARE_TOKEN)"
  echo "::error::  CLOUDFLARE_ACCOUNT_ID  (or CF_ACCOUNT_ID)"
  echo "::error::Token template: 'Edit Cloudflare Workers'."
  echo "::error::Until then every merge must be deployed by hand with 'npm run deploy:worker'."
  exit 1
fi

echo "Found Cloudflare credentials (token: $SRC_T length=${#CF_TOKEN}, account: $SRC_A length=${#CF_ACCT})"

if [ -n "${GITHUB_ENV:-}" ]; then
  {
    echo "CLOUDFLARE_API_TOKEN=$CF_TOKEN"
    echo "CLOUDFLARE_ACCOUNT_ID=$CF_ACCT"
  } >> "$GITHUB_ENV"
fi
