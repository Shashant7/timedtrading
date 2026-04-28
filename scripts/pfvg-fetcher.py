#!/usr/bin/env python3
"""
PFVG Fetcher — TwelveData 1-min loader for the 9:30-10:00 ET window.

Loads 1-minute OHLCV bars for each (ticker, trading_day) pair and writes
them to a JSON file. Only the first 30 minutes of NY session are kept
(matching the PFVG detection window).

Usage:
  TWELVE_DATA_API_KEY=... python3 scripts/pfvg-fetcher.py \\
      --start 2025-07-01 --end 2025-10-31 \\
      --tickers SPY,QQQ,IWM,NVDA,AAPL,AMZN,META,MSFT,GOOGL,TSLA,AVGO,AMD,COIN,PLTR,MSTR \\
      --output data/pfvg/pfvg-bars-2025-jul-oct.json

Notes:
- TwelveData PRO plan: 1597 credits/day, ~8 credits/min.
- Each batch call costs (n_symbols + 1) credits.
- Time window is 09:30-10:00 ET, which is 13:30-14:00 UTC during DST and
  14:30-15:00 UTC during Standard Time. We compute per-day automatically.
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo


TD_BASE = "https://api.twelvedata.com"
NY_TZ = ZoneInfo("America/New_York")


def iter_trading_days(start: date, end: date):
    """Yield weekdays between start and end inclusive. (No US holiday filter,
    but the API will simply return no bars on holidays — caller handles.)"""
    cur = start
    while cur <= end:
        if cur.weekday() < 5:
            yield cur
        cur += timedelta(days=1)


def ny_window_to_utc(d: date):
    """Return (start_utc_str, end_utc_str) for 9:30-10:00 ET on date d."""
    open_ny = datetime(d.year, d.month, d.day, 9, 30, tzinfo=NY_TZ)
    close_ny = datetime(d.year, d.month, d.day, 10, 0, tzinfo=NY_TZ)
    open_utc = open_ny.astimezone(timezone.utc)
    close_utc = close_ny.astimezone(timezone.utc)
    fmt = "%Y-%m-%d %H:%M:%S"
    return open_utc.strftime(fmt), close_utc.strftime(fmt)


def fetch_batch(api_key: str, symbols: list[str], d: date, retries: int = 3):
    """Fetch 1-min bars for up to 8 symbols on date d. Returns dict
    {sym: [bars]} or None on failure."""
    start_utc, end_utc = ny_window_to_utc(d)
    params = {
        "symbol": ",".join(symbols),
        "interval": "1min",
        "apikey": api_key,
        "start_date": start_utc,
        "end_date": end_utc,
        "order": "asc",
        "timezone": "UTC",
    }
    url = f"{TD_BASE}/time_series?{urllib.parse.urlencode(params)}"
    last_err = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=45) as r:
                data = json.loads(r.read())
            if isinstance(data, dict) and data.get("status") == "error":
                last_err = data.get("message") or "api_error"
                if "credit" in last_err.lower() or "limit" in last_err.lower():
                    time.sleep(60)
                    continue
                return {}
            return data
        except Exception as e:
            last_err = str(e)
            time.sleep(2 ** attempt)
    print(f"[ERROR] fetch failed for {symbols} on {d}: {last_err}", file=sys.stderr)
    return None


def normalize(td_data: dict, symbols: list[str], d: date) -> dict[str, list]:
    """Normalize TD response into {sym: [bars]}. Single-symbol responses come
    back without the symbol key. Multi-symbol responses are keyed by symbol."""
    out = {}
    if len(symbols) == 1:
        s = symbols[0]
        vals = td_data.get("values") if isinstance(td_data, dict) else None
        if isinstance(vals, list):
            out[s] = [_to_bar(b) for b in vals]
    else:
        for sym in symbols:
            block = td_data.get(sym)
            if not isinstance(block, dict):
                continue
            vals = block.get("values") or []
            out[sym] = [_to_bar(b) for b in vals]
    return out


def _to_bar(td_bar: dict) -> dict:
    return {
        "t": td_bar.get("datetime"),
        "o": float(td_bar.get("open", 0)),
        "h": float(td_bar.get("high", 0)),
        "l": float(td_bar.get("low", 0)),
        "c": float(td_bar.get("close", 0)),
        "v": int(float(td_bar.get("volume", 0) or 0)),
    }


def get_usage(api_key: str) -> tuple[int, int] | None:
    try:
        with urllib.request.urlopen(
            f"{TD_BASE}/api_usage?apikey={api_key}", timeout=10
        ) as r:
            d = json.loads(r.read())
        return int(d.get("current_usage", 0)), int(d.get("plan_limit", 0))
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description="PFVG 1-min fetcher")
    ap.add_argument("--start", required=True, help="YYYY-MM-DD")
    ap.add_argument("--end", required=True, help="YYYY-MM-DD")
    ap.add_argument("--tickers", required=True, help="comma-separated symbols")
    ap.add_argument("--output", required=True, help="output JSON path")
    ap.add_argument("--batch-size", type=int, default=8, help="symbols per call (max 8)")
    ap.add_argument("--sleep-seconds", type=float, default=8.5,
                    help="sleep between calls (PRO is 8 req/min)")
    ap.add_argument("--resume", action="store_true",
                    help="skip ticker-days already in output")
    args = ap.parse_args()

    api_key = os.environ.get("TWELVE_DATA_API_KEY")
    if not api_key:
        print("TWELVE_DATA_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    start = datetime.strptime(args.start, "%Y-%m-%d").date()
    end = datetime.strptime(args.end, "%Y-%m-%d").date()
    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    days = list(iter_trading_days(start, end))

    print(f"=== PFVG fetcher ===")
    print(f"Window: {start} -> {end}  ({len(days)} weekdays)")
    print(f"Tickers ({len(tickers)}): {','.join(tickers[:10])}{'...' if len(tickers) > 10 else ''}")

    usage = get_usage(api_key)
    if usage:
        print(f"TD usage: {usage[0]} / {usage[1]}")
        approx = (len(tickers) + 1) * len(days) / args.batch_size
        approx = int(approx * args.batch_size + len(days))
        print(f"Estimated cost: ~{approx} credits")
        if usage[0] + approx > usage[1] * 0.95:
            print(f"WARNING: estimated cost would exceed plan. Consider reducing scope.")

    # Resume support
    bars_db = {}
    if args.resume and os.path.exists(args.output):
        try:
            with open(args.output) as f:
                bars_db = json.load(f)
            done = sum(len(v) for v in bars_db.values())
            print(f"Resumed: {len(bars_db)} ticker-day keys, {done} bars total")
        except Exception:
            bars_db = {}

    total_calls = 0
    total_bars = 0
    t_start = time.time()

    for d in days:
        date_key = d.strftime("%Y-%m-%d")
        # Determine which tickers still need this day
        pending = [t for t in tickers if f"{t}|{date_key}" not in bars_db]
        if not pending:
            continue
        for i in range(0, len(pending), args.batch_size):
            batch = pending[i : i + args.batch_size]
            data = fetch_batch(api_key, batch, d)
            total_calls += 1
            if data is None:
                continue
            normalized = normalize(data, batch, d)
            for sym, bars in normalized.items():
                key = f"{sym}|{date_key}"
                if bars:
                    bars_db[key] = bars
                    total_bars += len(bars)
                else:
                    bars_db[key] = []
            # Persist after every call so we don't lose progress
            os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
            with open(args.output, "w") as f:
                json.dump(bars_db, f)
            if total_calls % 10 == 0:
                elapsed = time.time() - t_start
                print(f"[{date_key}] calls={total_calls} bars={total_bars} elapsed={elapsed:.0f}s")
            if i + args.batch_size < len(pending) or d != days[-1]:
                time.sleep(args.sleep_seconds)

    elapsed = time.time() - t_start
    print(f"\n=== Done ===")
    print(f"Calls: {total_calls}  Bars: {total_bars}  Elapsed: {elapsed:.0f}s")
    print(f"Output: {args.output}")
    usage_after = get_usage(api_key)
    if usage and usage_after:
        print(f"Credits used: {usage_after[0] - usage[0]}")


if __name__ == "__main__":
    main()
