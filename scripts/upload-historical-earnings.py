#!/usr/bin/env python3
"""
upload-historical-earnings.py

Uploads a JSON file produced by `pull-historical-earnings-yfinance.py` to the
worker's `POST /timed/admin/market-events/bulk-seed` endpoint. Chunks the
payload to stay under the 5,000-event-per-request server limit. Idempotent:
the endpoint upserts by `earn-<TICKER>-<DATE>` so re-running is safe.

Usage:
  python3 scripts/upload-historical-earnings.py \
      --input data/market-events/earnings-yfinance-full.json \
      --url https://timed-trading-ingest.shashant.workers.dev \
      --key "$TIMED_API_KEY"
"""

import argparse
import json
import subprocess
import sys


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="Path to yfinance JSON file")
    ap.add_argument("--url", default="https://timed-trading-ingest.shashant.workers.dev",
                    help="Worker base URL")
    ap.add_argument("--key", required=True, help="Admin API key")
    ap.add_argument("--chunk", type=int, default=1000, help="Events per POST")
    ap.add_argument("--dry-run", action="store_true", help="Send dryRun=1 flag")
    return ap.parse_args()


def main():
    args = parse_args()

    data = json.load(open(args.input))
    events = data.get("events") or []
    if not events:
        print("No events to upload.", file=sys.stderr)
        sys.exit(1)

    print(f"Uploading {len(events)} events from {args.input}")
    url = f"{args.url}/timed/admin/market-events/bulk-seed?key={args.key}"
    if args.dry_run:
        url += "&dryRun=1"

    total_seeded = 0
    total_errors = 0
    for i in range(0, len(events), args.chunk):
        batch = events[i:i + args.chunk]
        payload = json.dumps({"events": batch})
        res = subprocess.run(
            ["curl", "-sS", "--max-time", "60", "-X", "POST", url,
             "-H", "Content-Type: application/json",
             "--data-binary", "@-"],
            input=payload, capture_output=True, text=True,
        )
        try:
            result = json.loads(res.stdout)
        except json.JSONDecodeError:
            print(f"  chunk {i}-{i + len(batch)} FAILED (non-JSON): {res.stdout[:300]}")
            continue
        seeded = int(result.get("seeded", 0))
        err_count = int(result.get("errorCount", 0))
        total_seeded += seeded
        total_errors += err_count
        print(f"  chunk {i}-{i + len(batch)}: seeded={seeded} errors={err_count}")
        if err_count:
            for e in result.get("errors", [])[:5]:
                print(f"    - {e}")

    print(f"\nTotal seeded: {total_seeded}  total errors: {total_errors}")


if __name__ == "__main__":
    main()
