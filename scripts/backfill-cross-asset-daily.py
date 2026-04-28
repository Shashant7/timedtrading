#!/usr/bin/env python3
"""
Backfill missing daily candles for cross-asset reference symbols
(VIX, UUP) from TwelveData -> D1 ticker_candles.

These symbols are needed for context-aware analysis but are missing
from our D1 candle store. This is a one-time backfill script.

Usage:
    TWELVE_DATA_API_KEY=... TIMED_API_KEY=... python3 scripts/backfill-cross-asset-daily.py

Coverage:
    VIX:  Volatility index (daily for all of 2025)
    UUP:  Invesco DB US Dollar Index Bullish Fund
    DXY:  US Dollar Index (if TD has it)

Cost (TwelveData):
    1 day = 1 credit per symbol. ~252 trading days/year x 3 symbols
    = ~756 credits one-time. Within PRO daily budget.

Output:
    POSTs to /timed/admin/candle-bulk-upsert (TODO: add endpoint if missing)
    OR writes to data/cross-asset-backfill/<symbol>-daily.json for manual import
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

TD_BASE = "https://api.twelvedata.com"
WORKER_BASE = os.environ.get(
    "TIMED_WORKER_BASE",
    "https://timed-trading-ingest.shashant.workers.dev",
)
UA = "Mozilla/5.0 (compatible; TimedTrading-Backfill/1.0)"


def fetch_td_daily(api_key: str, symbol: str, start: str, end: str) -> list:
    """Fetch daily candles for symbol from TwelveData."""
    params = {
        "symbol": symbol,
        "interval": "1day",
        "apikey": api_key,
        "start_date": start,
        "end_date": end,
        "order": "asc",
        "timezone": "UTC",
    }
    url = f"{TD_BASE}/time_series?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            data = json.loads(r.read())
    except Exception as e:
        print(f"[ERROR] {symbol}: {e}", file=sys.stderr)
        return []
    if isinstance(data, dict) and data.get("status") == "error":
        print(f"[ERROR] {symbol}: {data.get('message')}", file=sys.stderr)
        return []
    values = data.get("values") or []
    out = []
    for v in values:
        dt = v.get("datetime")
        try:
            ts_ms = int(datetime.fromisoformat(f"{dt}T00:00:00+00:00").timestamp() * 1000)
        except Exception:
            continue
        out.append({
            "ts": ts_ms,
            "o": float(v.get("open", 0)),
            "h": float(v.get("high", 0)),
            "l": float(v.get("low", 0)),
            "c": float(v.get("close", 0)),
            "v": int(float(v.get("volume", 0) or 0)),
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2024-12-01", help="YYYY-MM-DD")
    ap.add_argument("--end", default=datetime.now().strftime("%Y-%m-%d"))
    ap.add_argument("--symbols", default="VIX,UUP,DXY")
    ap.add_argument("--out-dir", default="/workspace/data/cross-asset-backfill")
    args = ap.parse_args()

    api_key = os.environ.get("TWELVE_DATA_API_KEY")
    if not api_key:
        print("TWELVE_DATA_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    syms = [s.strip().upper() for s in args.symbols.split(",")]
    Path(args.out_dir).mkdir(parents=True, exist_ok=True)

    for sym in syms:
        print(f"\n=== Fetching {sym} from {args.start} to {args.end} ===")
        candles = fetch_td_daily(api_key, sym, args.start, args.end)
        if not candles:
            print(f"  No data for {sym}")
            continue
        out_path = f"{args.out_dir}/{sym.replace('/', '_')}-daily.json"
        with open(out_path, "w") as f:
            json.dump({"symbol": sym, "candles": candles, "n": len(candles)}, f)
        print(f"  {len(candles)} candles -> {out_path}")
        # Throttle to PRO rate limit
        time.sleep(8)


if __name__ == "__main__":
    main()
