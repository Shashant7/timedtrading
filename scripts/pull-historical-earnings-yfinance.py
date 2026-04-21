#!/usr/bin/env python3
"""
pull-historical-earnings-yfinance.py

One-time bulk pull of historical earnings dates from Yahoo Finance (yfinance)
for the full backtest universe. TwelveData's earnings calendar only returns
forward-looking data (confirmed via production: AGYS coverage begins
2026-01-26, missing its 2025-07-21 earnings), so Yahoo fills the gap for
Jul 2025 – present backtest needs.

Output: JSON array of market_events rows ready to POST to
`/timed/admin/market-events/bulk-seed`.

Usage:
  python3 scripts/pull-historical-earnings-yfinance.py \
      --tickers-file configs/backfill-universe-2026-04-18.txt \
      --start 2025-06-01 --end 2026-05-31 \
      --out data/market-events/earnings-yfinance.json

  # then:
  python3 scripts/upload-historical-earnings.py \
      --input data/market-events/earnings-yfinance.json \
      --key $TIMED_API_KEY
"""

import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path

try:
    import yfinance as yf
except ImportError:
    print("ERROR: yfinance not installed. Run: pip install yfinance lxml", file=sys.stderr)
    sys.exit(1)


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tickers-file", required=True, help="Path to newline-separated ticker list")
    ap.add_argument("--start", required=True, help="Start date YYYY-MM-DD")
    ap.add_argument("--end", required=True, help="End date YYYY-MM-DD")
    ap.add_argument("--out", required=True, help="Output JSON file path")
    ap.add_argument("--limit-per-ticker", type=int, default=12,
                    help="yfinance earnings_dates lookback limit per ticker (default 12 covers ~3 years)")
    ap.add_argument("--sleep-sec", type=float, default=0.15,
                    help="Sleep between ticker requests to avoid rate limiting")
    return ap.parse_args()


def load_tickers(path: Path) -> list[str]:
    tickers = []
    for line in path.read_text().splitlines():
        sym = line.strip().upper()
        if not sym or sym.startswith("#"):
            continue
        tickers.append(sym)
    return tickers


def infer_session(dt_utc: dt.datetime) -> tuple[str, str]:
    """Map UTC datetime to NY market session + scheduled_time_et string.

    yfinance timestamps are in UTC. We classify:
      - bmo / premarket: before 09:30 ET (13:30 UTC during EST; 14:30 UTC during EDT rare)
      - rth: 09:30-16:00 ET
      - amc / afterhours: after 16:00 ET (20:00 UTC EST; 21:00 UTC EDT)
    """
    # Convert UTC -> NY. DST aware via zoneinfo.
    try:
        from zoneinfo import ZoneInfo
        ny = dt_utc.astimezone(ZoneInfo("America/New_York"))
    except Exception:
        # Fallback: approximate EST as UTC-5
        ny = dt_utc - dt.timedelta(hours=5)

    hh = ny.hour
    mm = ny.minute
    et_str = f"{hh:02d}:{mm:02d}"
    if hh < 9 or (hh == 9 and mm < 30):
        return "bmo", et_str
    if hh < 16:
        return "rth", et_str
    return "amc", et_str


def _coerce_float(v):
    """Convert pandas NaN/NaT/None to None, otherwise float(v). Returns None on any failure."""
    if v is None:
        return None
    try:
        import math
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def fetch_ticker_earnings(sym: str, limit: int) -> list[dict]:
    """Return list of earnings event dicts for a ticker."""
    try:
        t = yf.Ticker(sym)
        ed = t.get_earnings_dates(limit=limit)
    except Exception as e:
        return [{"__error": f"yf_error: {e}"}]

    if ed is None or len(ed) == 0:
        return []

    events = []
    ed = ed.reset_index()
    for _, row in ed.iterrows():
        ts = row.get("Earnings Date")
        if ts is None:
            continue
        try:
            dt_utc = ts.to_pydatetime().astimezone(dt.timezone.utc)
        except Exception:
            continue
        date_key = dt_utc.strftime("%Y-%m-%d")
        session, et_str = infer_session(dt_utc)
        eps_est = _coerce_float(row.get("EPS Estimate"))
        eps_act = _coerce_float(row.get("Reported EPS"))
        events.append({
            "ticker": sym,
            "date": date_key,
            "scheduled_ts": int(dt_utc.timestamp() * 1000),
            "scheduled_time_et": et_str,
            "session": session,
            "eps_estimate": eps_est,
            "eps_actual": eps_act,
        })
    return events


def main():
    args = parse_args()

    tickers_path = Path(args.tickers_file)
    if not tickers_path.is_file():
        print(f"ERROR: tickers file not found: {tickers_path}", file=sys.stderr)
        sys.exit(2)
    tickers = load_tickers(tickers_path)
    print(f"Loaded {len(tickers)} tickers from {tickers_path}", file=sys.stderr)

    start_dt = dt.datetime.fromisoformat(args.start).replace(tzinfo=dt.timezone.utc)
    end_dt = dt.datetime.fromisoformat(args.end).replace(tzinfo=dt.timezone.utc)
    print(f"Filtering earnings to {start_dt.date()} .. {end_dt.date()}", file=sys.stderr)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    all_events = []
    errors = []
    t_start = time.time()
    for i, sym in enumerate(tickers, 1):
        events = fetch_ticker_earnings(sym, args.limit_per_ticker)
        err_events = [e for e in events if e.get("__error")]
        ok_events = [e for e in events if not e.get("__error")]
        if err_events:
            errors.append({"ticker": sym, "error": err_events[0]["__error"]})

        kept = 0
        for ev in ok_events:
            ev_ts_ms = ev["scheduled_ts"]
            if ev_ts_ms < int(start_dt.timestamp() * 1000):
                continue
            if ev_ts_ms > int(end_dt.timestamp() * 1000):
                continue
            all_events.append(ev)
            kept += 1

        if i % 10 == 0 or i == len(tickers):
            elapsed = time.time() - t_start
            rate = i / elapsed if elapsed > 0 else 0
            eta = (len(tickers) - i) / rate if rate > 0 else 0
            print(
                f"[{i}/{len(tickers)}] {sym}: kept {kept} events "
                f"(total so far: {len(all_events)}, errors: {len(errors)}) "
                f"ETA {eta:.0f}s",
                file=sys.stderr,
            )
        time.sleep(args.sleep_sec)

    out = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": "yfinance",
        "start_date": args.start,
        "end_date": args.end,
        "tickers_requested": len(tickers),
        "tickers_with_events": len({e["ticker"] for e in all_events}),
        "total_events": len(all_events),
        "errors": errors,
        "events": all_events,
    }
    out_path.write_text(json.dumps(out, indent=2))
    print(f"\nWrote {len(all_events)} earnings events to {out_path}", file=sys.stderr)
    print(f"Errors: {len(errors)}", file=sys.stderr)
    if errors:
        for e in errors[:10]:
            print(f"  - {e['ticker']}: {e['error']}", file=sys.stderr)


if __name__ == "__main__":
    main()
