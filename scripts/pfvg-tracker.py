#!/usr/bin/env python3
"""
PFVG Tracker — for each detected PFVG, determine its 6-trading-day fate.

Reads pfvg-levels.json + the worker's /timed/candles endpoint to fetch
daily OHLC for the 6 trading days starting from PFVG date, then computes:
  - state: untouched | touched_holding | mitigated
  - first_touch_day_idx: 0-5 (which session first entered the zone)
  - mitigated_day_idx: 0-5 (when bottom-broken for bull / top-broken for bear)
  - reached_midpoint: bool
  - max_favorable_react: max distance away from zone after first touch
  - days_alive: trading days the level survived

Usage:
  TIMED_API_KEY=... python3 scripts/pfvg-tracker.py \\
      --levels data/pfvg/pfvg-levels-2025-jul-oct.json \\
      --output data/pfvg/pfvg-tracking-2025-jul-oct.json
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta

WORKER_BASE = os.environ.get(
    "TIMED_WORKER_BASE",
    "https://timed-trading-ingest.shashant.workers.dev",
)


UA = "Mozilla/5.0 (compatible; TimedTrading-PFVG/1.0)"


def fetch_daily_candles(api_key: str, ticker: str, limit: int = 30) -> list:
    """Fetch up to `limit` daily candles for ticker (ascending by ts)."""
    params = {"ticker": ticker, "tf": "D", "limit": str(limit), "key": api_key}
    url = f"{WORKER_BASE}/timed/candles?{urllib.parse.urlencode(params)}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
    except Exception as e:
        print(f"[ERROR] fetch failed for {ticker}: {e}", file=sys.stderr)
        return []
    bars = data.get("candles") or data.get("bars") or []
    out = []
    for b in bars:
        ts = b.get("ts") or b.get("t")
        try:
            if isinstance(ts, str):
                ts_ms = int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
            else:
                ts_ms = int(ts)
        except Exception:
            continue
        out.append({
            "ts": ts_ms,
            "o": float(b.get("o", 0)),
            "h": float(b.get("h", 0)),
            "l": float(b.get("l", 0)),
            "c": float(b.get("c", 0)),
        })
    out.sort(key=lambda b: b["ts"])
    return out


def fetch_all_dailies(api_key: str, tickers: set[str]) -> dict[str, list]:
    """Bulk fetch daily candles for all tickers (large limit)."""
    db = {}
    for i, t in enumerate(sorted(tickers)):
        bars = fetch_daily_candles(api_key, t, limit=600)
        if bars:
            db[t] = bars
        if (i + 1) % 10 == 0:
            print(f"  fetched dailies for {i+1}/{len(tickers)}")
    return db


def date_to_ms(date_str: str) -> int:
    return int(datetime.strptime(date_str, "%Y-%m-%d").timestamp() * 1000)


def track_one(pfvg: dict, daily_bars: list) -> dict:
    """Compute fate for one PFVG over its 6 trading-day window."""
    pfvg_date_ms = date_to_ms(pfvg["date"])
    top, bottom, mid = pfvg["top"], pfvg["bottom"], pfvg["midpoint"]
    direction = pfvg["direction"]

    # Find day index for pfvg.date in daily_bars
    day_idx = -1
    for i, b in enumerate(daily_bars):
        b_date = datetime.fromtimestamp(b["ts"] / 1000).strftime("%Y-%m-%d")
        if b_date == pfvg["date"]:
            day_idx = i
            break
    if day_idx < 0:
        return {"state": "no_data", "reason": "pfvg_date_not_in_dailies"}

    # Use the 6 trading days STARTING from pfvg date (inclusive).
    # The PFVG forms in first 30 mins of that day, so the rest of that day
    # already qualifies as the first tracking day.
    window = daily_bars[day_idx : day_idx + 6]
    if not window:
        return {"state": "no_data", "reason": "no_window"}

    state = "untouched"
    first_touch_idx = None
    mitigated_idx = None
    reached_midpoint = False
    max_favorable = 0.0  # how far price moved in PFVG-favorable direction after first touch

    for i, bar in enumerate(window):
        # Touched if bar's range overlaps the zone
        bar_high, bar_low, bar_close = bar["h"], bar["l"], bar["c"]
        overlapped = bar_low <= top and bar_high >= bottom
        if overlapped and first_touch_idx is None:
            first_touch_idx = i
            state = "touched_holding"
            if bar_low <= mid <= bar_high:
                reached_midpoint = True

        # Mitigation: close beyond the zone in the OPPOSITE direction of PFVG
        # bull PFVG = support → mitigated when close < bottom
        # bear PFVG = resistance → mitigated when close > top
        if direction == "bull" and bar_close < bottom:
            state = "mitigated"
            mitigated_idx = i
            break
        if direction == "bear" and bar_close > top:
            state = "mitigated"
            mitigated_idx = i
            break

        # Favorable reaction: after first touch, how far did price move
        # in the PFVG-favorable direction?
        if first_touch_idx is not None and i >= first_touch_idx:
            if direction == "bull":
                # Favorable = price moves UP from zone top
                fav = max(0.0, bar_high - top)
            else:
                fav = max(0.0, bottom - bar_low)
            if fav > max_favorable:
                max_favorable = fav

    days_alive = (mitigated_idx if mitigated_idx is not None else len(window) - 1) + 1
    # Reaction quality
    reaction = "no_reaction"
    if first_touch_idx is not None:
        # Find the bar of first touch
        bar = window[first_touch_idx]
        bar_close = bar["c"]
        if direction == "bull":
            favorable_close = bar_close > bar["o"] and bar_close > mid
            wick_and_hold = bar["l"] <= mid and bar_close > bottom and (bar_close - bottom) / max(bar["h"] - bar["l"], 1e-9) > 0.5
            if wick_and_hold:
                reaction = "wick_and_hold"
            elif favorable_close:
                reaction = "midpoint_reaction"
            elif state == "mitigated" and mitigated_idx == first_touch_idx:
                reaction = "no_reaction"
            else:
                reaction = "midpoint_reaction" if reached_midpoint else "tagged_only"
        else:
            favorable_close = bar_close < bar["o"] and bar_close < mid
            wick_and_hold = bar["h"] >= mid and bar_close < top and (top - bar_close) / max(bar["h"] - bar["l"], 1e-9) > 0.5
            if wick_and_hold:
                reaction = "wick_and_hold"
            elif favorable_close:
                reaction = "midpoint_reaction"
            elif state == "mitigated" and mitigated_idx == first_touch_idx:
                reaction = "no_reaction"
            else:
                reaction = "midpoint_reaction" if reached_midpoint else "tagged_only"

    return {
        "state": state,
        "first_touch_day_idx": first_touch_idx,
        "mitigated_day_idx": mitigated_idx,
        "reached_midpoint": reached_midpoint,
        "reaction_quality": reaction,
        "days_alive": days_alive,
        "max_favorable_pts": round(max_favorable, 6),
        "max_favorable_pct_of_zone": round(max_favorable / max(top - bottom, 1e-9), 3),
        "window_size": len(window),
    }


def main():
    ap = argparse.ArgumentParser(description="PFVG tracker")
    ap.add_argument("--levels", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    api_key = os.environ.get("TIMED_API_KEY")
    if not api_key:
        print("TIMED_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    with open(args.levels) as f:
        levels = json.load(f)

    tickers = sorted(set(rec["ticker"] for rec in levels.values()))
    print(f"=== PFVG tracker ===")
    print(f"Levels: {len(levels)}  Tickers: {len(tickers)}")
    print(f"Fetching daily candles ...")
    dailies = fetch_all_dailies(api_key, set(tickers))
    print(f"  fetched dailies for {len(dailies)}/{len(tickers)} tickers")

    out = {}
    by_state = defaultdict(int)
    by_reaction = defaultdict(int)
    direction_state = defaultdict(int)

    for key, pfvg in levels.items():
        ticker = pfvg["ticker"]
        if ticker not in dailies:
            out[key] = {"pfvg": pfvg, "tracking": {"state": "no_data", "reason": "no_dailies"}}
            continue
        result = track_one(pfvg, dailies[ticker])
        out[key] = {"pfvg": pfvg, "tracking": result}
        by_state[result["state"]] += 1
        if result.get("reaction_quality"):
            by_reaction[result["reaction_quality"]] += 1
        direction_state[(pfvg["direction"], result["state"])] += 1

    print(f"\n=== Results ===")
    print(f"State distribution:")
    for s, n in sorted(by_state.items(), key=lambda x: -x[1]):
        print(f"  {s:<20} {n:>5} ({n/len(out)*100:.1f}%)")
    print(f"\nReaction at first touch:")
    for r, n in sorted(by_reaction.items(), key=lambda x: -x[1]):
        print(f"  {r:<20} {n:>5}")
    print(f"\nState by direction:")
    for (d, s), n in sorted(direction_state.items()):
        print(f"  {d:<5} {s:<20} {n:>5}")

    # Aggregate hold-rate: not mitigated within 6 days
    held = sum(n for s, n in by_state.items() if s in ("untouched", "touched_holding"))
    print(f"\nHold rate (not mitigated in 6 days): {held / max(1, len(out)) * 100:.1f}%")

    with open(args.output, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\nWritten: {args.output}")


if __name__ == "__main__":
    main()
