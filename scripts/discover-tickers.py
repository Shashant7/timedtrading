#!/usr/bin/env python3
"""
Ticker Discovery Script — finds stocks not yet in our universe.

Uses tvscreener to scan TradingView's screener for momentum stocks,
big movers, and high-volume names that aren't in our SECTOR_MAP.

Usage:
    pip install tvscreener pandas requests
    python scripts/discover-tickers.py                     # Print candidates
    python scripts/discover-tickers.py --post              # POST to Worker API
    python scripts/discover-tickers.py --sector Technology # Filter by sector
    python scripts/discover-tickers.py --top-movers        # Today's top gainers/losers
    python scripts/discover-tickers.py --weekly            # Weekly momentum scan
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
from tvscreener import StockScreener, StockField, Market

# ── Load existing universe from sector-mapping.js ──────────────────────────

SCRIPT_DIR = Path(__file__).parent
SECTOR_MAP_PATH = SCRIPT_DIR.parent / "worker" / "sector-mapping.js"


def load_existing_universe():
    """Parse SECTOR_MAP from sector-mapping.js to get our known tickers."""
    if not SECTOR_MAP_PATH.exists():
        print(f"[WARN] sector-mapping.js not found at {SECTOR_MAP_PATH}", file=sys.stderr)
        return set()

    content = SECTOR_MAP_PATH.read_text()
    # Match 'TICKER': 'Sector' patterns in the JS object
    tickers = set(re.findall(r"'([A-Z][A-Z0-9.\-]+)':\s*'", content))
    return tickers


# ── Screener Queries ───────────────────────────────────────────────────────

def screen_momentum_stocks(min_price=5, min_volume=500_000, min_change_pct=3,
                           min_market_cap=2e9, limit=100):
    """Find stocks with strong daily momentum not in our universe."""
    ss = StockScreener()
    ss.select(
        StockField.NAME,
        StockField.PRICE,
        StockField.CHANGE_PERCENT,
        StockField.VOLUME,
        StockField.MARKET_CAPITALIZATION,
        StockField.SECTOR,
        StockField.RELATIVE_STRENGTH_INDEX_14,
        StockField.AVERAGE_VOLUME_10_DAY,
    )
    ss.where(StockField.PRICE >= min_price)
    ss.where(StockField.VOLUME >= min_volume)
    ss.where(StockField.CHANGE_PERCENT >= min_change_pct)
    ss.where(StockField.MARKET_CAPITALIZATION >= min_market_cap)
    ss.set_markets(Market.AMERICA)
    ss.sort_by(StockField.CHANGE_PERCENT, ascending=False)
    ss.set_range(0, limit)
    return ss.get()


def screen_weekly_momentum(min_price=10, min_volume=300_000,
                           min_market_cap=2e9, limit=100):
    """Find stocks with strong weekly performance."""
    ss = StockScreener()
    ss.select(
        StockField.NAME,
        StockField.PRICE,
        StockField.CHANGE_PERCENT,
        StockField.VOLUME,
        StockField.MARKET_CAPITALIZATION,
        StockField.SECTOR,
        StockField.CHANGE_PERCENT_1_WEEK,
        StockField.RELATIVE_STRENGTH_INDEX_14,
    )
    ss.where(StockField.PRICE >= min_price)
    ss.where(StockField.VOLUME >= min_volume)
    ss.where(StockField.MARKET_CAPITALIZATION >= min_market_cap)
    ss.where(StockField.CHANGE_PERCENT_1_WEEK >= 8)
    ss.set_markets(Market.AMERICA)
    ss.sort_by(StockField.CHANGE_PERCENT_1_WEEK, ascending=False)
    ss.set_range(0, limit)
    return ss.get()


def screen_top_movers(direction="gainers", limit=50):
    """Get today's top gainers or losers."""
    ss = StockScreener()
    ss.select(
        StockField.NAME,
        StockField.PRICE,
        StockField.CHANGE_PERCENT,
        StockField.VOLUME,
        StockField.MARKET_CAPITALIZATION,
        StockField.SECTOR,
    )
    ss.where(StockField.MARKET_CAPITALIZATION >= 1e9)
    ss.where(StockField.VOLUME >= 200_000)
    ss.set_markets(Market.AMERICA)
    ss.sort_by(StockField.CHANGE_PERCENT, ascending=(direction == "losers"))
    ss.set_range(0, limit)
    return ss.get()


# ── Result Processing ──────────────────────────────────────────────────────

def extract_ticker(symbol_str):
    """Extract clean ticker from TV symbol format (e.g., 'NASDAQ:AAPL' -> 'AAPL')."""
    if not symbol_str:
        return None
    parts = str(symbol_str).split(":")
    return parts[-1].strip() if parts else symbol_str


def filter_new_candidates(df, existing_universe):
    """Filter dataframe to only tickers NOT in our existing universe."""
    if df is None or df.empty:
        return df

    # tvscreener typically uses 'symbol' or the index for the ticker identifier
    symbol_col = None
    for col in ["symbol", "Symbol", "ticker", "Ticker", "name", "Name"]:
        if col in df.columns:
            symbol_col = col
            break

    # If no explicit column found, try the index
    if symbol_col is None:
        df = df.copy()
        df["_ticker"] = df.index.map(lambda x: extract_ticker(str(x)))
    else:
        df = df.copy()
        df["_ticker"] = df[symbol_col].apply(extract_ticker)

    return df[~df["_ticker"].isin(existing_universe)]


def safe_float(val, default=0.0):
    """Safely convert a value to float, handling NaN and None."""
    if val is None:
        return default
    try:
        f = float(val)
        return default if (f != f) else f  # NaN check
    except (ValueError, TypeError):
        return default


def format_candidates(df, scan_type="momentum"):
    """Format discovery results for display and API posting."""
    candidates = []

    for idx, row in df.iterrows():
        # Extract ticker from _ticker column or index
        ticker = row.get("_ticker", extract_ticker(str(idx)))
        if not ticker:
            continue

        # Map column names flexibly — tvscreener column names can vary
        candidate = {
            "ticker": ticker,
            "scan_type": scan_type,
            "discovered_at": datetime.now(timezone.utc).isoformat(),
        }

        # Price — try common column names
        for col in ["close", "price", "Price", "PRICE"]:
            if col in row.index:
                candidate["price"] = round(safe_float(row[col]), 2)
                break

        # Change percent
        for col in ["change", "Change %", "change_percent", "CHANGE_PERCENT", "Perf.D"]:
            if col in row.index:
                candidate["change_pct"] = round(safe_float(row[col]), 2)
                break

        # Volume
        for col in ["volume", "Volume", "VOLUME", "Vol"]:
            if col in row.index:
                candidate["volume"] = int(safe_float(row[col]))
                break

        # Market cap
        for col in ["market_cap_basic", "Market Capitalization", "MARKET_CAPITALIZATION", "market_cap"]:
            if col in row.index:
                candidate["market_cap"] = safe_float(row[col])
                break

        # Sector
        for col in ["sector", "Sector", "SECTOR"]:
            if col in row.index:
                val = row[col]
                if val and str(val) != "nan":
                    candidate["sector"] = str(val)
                break

        # Name
        for col in ["name", "Name", "NAME", "description"]:
            if col in row.index:
                val = row[col]
                if val and str(val) != "nan":
                    candidate["name"] = str(val)
                break
        if "name" not in candidate:
            candidate["name"] = ticker

        # Optional: RSI
        for col in ["RSI", "rsi", "RSI14", "Relative Strength Index (14)"]:
            if col in row.index:
                val = safe_float(row[col], None)
                if val is not None:
                    candidate["rsi"] = round(val, 1)
                break

        # Optional: Week change
        for col in ["change_percent_1_week", "Perf.W", "CHANGE_PERCENT_1_WEEK"]:
            if col in row.index:
                val = safe_float(row[col], None)
                if val is not None:
                    candidate["week_change_pct"] = round(val, 2)
                break

        candidates.append(candidate)

    return candidates


# ── API Integration ────────────────────────────────────────────────────────

def post_candidates_to_worker(candidates, api_base, api_key):
    """POST discovered candidates to Worker API."""
    url = f"{api_base}/timed/screener/candidates?key={api_key}"
    payload = {
        "candidates": candidates,
        "scan_ts": datetime.now(timezone.utc).isoformat(),
        "count": len(candidates),
    }

    try:
        resp = requests.post(url, json=payload, timeout=15)
        if resp.status_code == 200:
            result = resp.json()
            print(f"\n[OK] Posted {len(candidates)} candidates to Worker API")
            print(f"     Response: {json.dumps(result, indent=2)}")
            return result
        else:
            print(f"\n[ERROR] Worker API returned {resp.status_code}: {resp.text[:200]}",
                  file=sys.stderr)
            return None
    except Exception as e:
        print(f"\n[ERROR] Failed to POST candidates: {e}", file=sys.stderr)
        return None


# ── Display ────────────────────────────────────────────────────────────────

def print_table(candidates):
    """Pretty-print candidates as a table."""
    if not candidates:
        print("\n  No new candidates found.")
        return

    print(f"\n{'Ticker':<8} {'Name':<25} {'Price':>8} {'Chg%':>7} {'Volume':>12} "
          f"{'MCap($B)':>10} {'Sector':<20} {'Scan'}")
    print("─" * 110)

    for c in sorted(candidates, key=lambda x: abs(x.get("change_pct", 0)), reverse=True):
        mcap_b = c.get("market_cap", 0) / 1e9 if c.get("market_cap") else 0
        vol_str = f"{c.get('volume', 0):,}" if c.get("volume") else "N/A"
        name = c.get("name", c["ticker"])
        name = name[:24] if len(name) > 24 else name
        sector = c.get("sector", "Unknown")[:19]
        chg = c.get("change_pct", 0)
        price = c.get("price", 0)

        print(
            f"{c['ticker']:<8} {name:<25} {price:>8.2f} {chg:>+6.1f}% "
            f"{vol_str:>12} {mcap_b:>9.1f}B {sector:<20} {c['scan_type']}"
        )

    print(f"\n  Total: {len(candidates)} candidates")


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Discover new tickers not in our trading universe"
    )
    parser.add_argument("--post", action="store_true",
                        help="POST results to Worker API")
    parser.add_argument("--top-movers", action="store_true",
                        help="Scan top daily movers (gainers + losers)")
    parser.add_argument("--weekly", action="store_true",
                        help="Scan weekly momentum (8%%+ week change)")
    parser.add_argument("--sector", type=str, default=None,
                        help="Filter results by sector name")
    parser.add_argument("--min-change", type=float, default=3.0,
                        help="Minimum daily change pct for momentum scan (default: 3)")
    parser.add_argument("--min-mcap", type=float, default=2.0,
                        help="Minimum market cap in billions (default: 2)")
    parser.add_argument("--limit", type=int, default=100,
                        help="Max results per scan (default: 100)")
    parser.add_argument("--include-existing", action="store_true",
                        help="Include tickers already in our universe")
    parser.add_argument("--json", action="store_true",
                        help="Output as JSON instead of table")
    parser.add_argument("--api-base", type=str,
                        default=os.environ.get("TIMED_API_BASE",
                                               "https://timed-trading-ingest.shashant.workers.dev"),
                        help="Worker API base URL")
    parser.add_argument("--api-key", type=str,
                        default=os.environ.get("TIMED_API_KEY", ""),
                        help="Worker API key")
    args = parser.parse_args()

    # Load our existing ticker universe
    existing = load_existing_universe()
    print(f"[INFO] Loaded {len(existing)} tickers from SECTOR_MAP")

    all_candidates = []

    # ── Run scans ──
    if args.top_movers:
        print("\n── Top Gainers ─────────────────────────────────────")
        try:
            df_gain = screen_top_movers("gainers", args.limit)
            if not args.include_existing:
                df_gain = filter_new_candidates(df_gain, existing)
            candidates = format_candidates(df_gain, "top_gainer")
            all_candidates.extend(candidates)
            print(f"  Found {len(candidates)} new candidates")
        except Exception as e:
            print(f"  [ERROR] Gainers scan failed: {e}", file=sys.stderr)

        print("\n── Top Losers ──────────────────────────────────────")
        try:
            df_lose = screen_top_movers("losers", args.limit)
            if not args.include_existing:
                df_lose = filter_new_candidates(df_lose, existing)
            candidates = format_candidates(df_lose, "top_loser")
            all_candidates.extend(candidates)
            print(f"  Found {len(candidates)} new candidates")
        except Exception as e:
            print(f"  [ERROR] Losers scan failed: {e}", file=sys.stderr)

    elif args.weekly:
        print("\n── Weekly Momentum (8%+ week change) ───────────────")
        try:
            df = screen_weekly_momentum(
                min_market_cap=args.min_mcap * 1e9,
                limit=args.limit,
            )
            if not args.include_existing:
                df = filter_new_candidates(df, existing)
            all_candidates = format_candidates(df, "weekly_momentum")
            print(f"  Found {len(all_candidates)} new candidates")
        except Exception as e:
            print(f"  [ERROR] Weekly scan failed: {e}", file=sys.stderr)

    else:
        print(f"\n── Daily Momentum ({args.min_change}%+ change) ────────────────")
        try:
            df = screen_momentum_stocks(
                min_change_pct=args.min_change,
                min_market_cap=args.min_mcap * 1e9,
                limit=args.limit,
            )
            if not args.include_existing:
                df = filter_new_candidates(df, existing)
            all_candidates = format_candidates(df, "daily_momentum")
            print(f"  Found {len(all_candidates)} new candidates")
        except Exception as e:
            print(f"  [ERROR] Momentum scan failed: {e}", file=sys.stderr)

    # ── Filter by sector ──
    if args.sector:
        all_candidates = [
            c for c in all_candidates
            if args.sector.lower() in c.get("sector", "").lower()
        ]
        print(f"  Filtered to {len(all_candidates)} in sector '{args.sector}'")

    # ── Output ──
    if args.json:
        print(json.dumps(all_candidates, indent=2))
    else:
        print_table(all_candidates)

    # ── POST to Worker ──
    if args.post:
        if not args.api_key:
            print("\n[ERROR] --api-key or TIMED_API_KEY env var required for --post",
                  file=sys.stderr)
            sys.exit(1)
        post_candidates_to_worker(all_candidates, args.api_base, args.api_key)


if __name__ == "__main__":
    main()
