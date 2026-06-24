#!/usr/bin/env bash
# Post-deploy smoke for /timed/health on monolith-bundle role workers.
# Cold-start after a ~7MB bundle deploy can exceed a single curl -m timeout;
# tt-research failed #824 CI when the probe hit the 20s limit and fell back
# to "{}" → ok=false even though wrangler deploy had succeeded.
set -euo pipefail

URL="${1:?usage: post-deploy-timed-health-smoke.sh <health-url> [label]}"
LABEL="${2:-$URL}"
RETRIES="${POST_DEPLOY_HEALTH_RETRIES:-4}"
SLEEP_SEC="${POST_DEPLOY_HEALTH_SLEEP_SEC:-15}"
CURL_TIMEOUT="${POST_DEPLOY_HEALTH_CURL_TIMEOUT:-25}"

OK="false"
HEALTH="{}"
for attempt in $(seq 1 "$RETRIES"); do
  if [ "$attempt" -gt 1 ]; then
    echo "${LABEL}: retry ${attempt}/${RETRIES} after ${SLEEP_SEC}s"
    sleep "$SLEEP_SEC"
  else
    sleep 5
  fi
  HEALTH=$(curl -s -m "$CURL_TIMEOUT" "$URL" || echo "{}")
  if ! echo "$HEALTH" | jq -e . >/dev/null 2>&1; then
    echo "::warning::${LABEL} returned non-JSON (attempt ${attempt}/${RETRIES}): $(echo "$HEALTH" | head -c 120 | tr -d '\n')"
    continue
  fi
  OK=$(echo "$HEALTH" | jq -r '.ok // false')
  ROLE=$(echo "$HEALTH" | jq -r '.workerRole // "unknown"')
  echo "${LABEL} attempt ${attempt}/${RETRIES}: ok=$OK workerRole=$ROLE"
  if [ "$OK" = "true" ]; then
    exit 0
  fi
done

echo "::error::${LABEL} did not return ok:true after ${RETRIES} attempts (last: $(echo "$HEALTH" | head -c 200 | tr -d '\n'))"
exit 1
