#!/usr/bin/env bash
# Seed Apr 2026 Core Ideas (Top/Bottom 5 Large-Cap + SMID) from the
# Fundstrat Direct April 2026 Market Update deck.
# Source: docs/20260423-Market-UpdatevFSD-1.pdf (deck slide 41 + 45)
#
# Usage:
#   TIMED_API_KEY=... bash scripts/seed-apr-2026-core-ideas.sh
#
# Idempotent: INSERT OR REPLACE keyed by (period_label, bucket, ticker).

set -euo pipefail
API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

read -r -d '' PAYLOAD <<'JSON' || true
{
  "period_label": "apr-2026",
  "period_date": "2026-04-23",
  "source_label": "Fundstrat Direct Apr 2026 Market Update (slide 41+45)",
  "large_cap_top": ["AMD", "ANET", "AVGO", "BK", "GS"],
  "large_cap_bottom": ["PKG", "VST", "GE", "PPG", "NOC"],
  "smid_top": ["IESC", "STRL", "FIX", "CRS", "LITE"],
  "smid_bottom": ["ARRY", "ELF", "GLXY", "CARR", "KTOS"]
}
JSON

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Seeding Apr 2026 Core Ideas"
curl -sS -m 30 -X POST "$API_BASE/timed/etf/core-ideas?key=$API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" | python3 -m json.tool
