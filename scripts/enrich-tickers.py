#!/usr/bin/env python3
"""
Ticker Enrichment Script — fetches metadata for all tickers in our universe.

Uses tvscreener to look up Name, Sector, Industry, Market Cap, and Description
for all tickers in SECTOR_MAP, then POSTs the enrichment data to the Worker API.

Usage:
    pip install tvscreener pandas requests
    python scripts/enrich-tickers.py                     # Dry-run (print what would be enriched)
    python scripts/enrich-tickers.py --post              # POST enrichment to Worker API
    python scripts/enrich-tickers.py --missing-only      # Only enrich tickers missing context
    python scripts/enrich-tickers.py --post --missing-only
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from tvscreener import StockScreener, StockField, Market

# ── Configuration ──────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
SECTOR_MAP_PATH = SCRIPT_DIR.parent / "worker" / "index.js"

API_BASE = os.environ.get("TIMED_API_URL", "https://timed-trading.com")
API_KEY = os.environ.get("TIMED_API_KEY", "AwesomeSauce")

BATCH_SIZE = 50  # tvscreener batch size


# ── Load existing universe ─────────────────────────────────────────────────

def load_universe_tickers():
    """Parse SECTOR_MAP from worker/index.js to get all tickers."""
    if not SECTOR_MAP_PATH.exists():
        print(f"[WARN] index.js not found at {SECTOR_MAP_PATH}", file=sys.stderr)
        return []

    content = SECTOR_MAP_PATH.read_text()
    # Find the SECTOR_MAP object and extract tickers
    # Matches patterns like:   AAPL: "Consumer Discretionary",
    tickers = re.findall(r'^\s+([A-Z][A-Z0-9.]+):\s*"', content, re.MULTILINE)
    return sorted(set(tickers))


def get_missing_tickers():
    """Get list of tickers missing context via the API."""
    try:
        resp = requests.get(
            f"{API_BASE}/timed/enrich-metadata",
            params={"key": API_KEY},
            timeout=30,
        )
        if resp.ok:
            data = resp.json()
            return data.get("missingTickers", [])
    except Exception as e:
        print(f"[WARN] Could not fetch missing tickers: {e}", file=sys.stderr)
    return []


# ── TradingView Screener Lookup ────────────────────────────────────────────

def extract_ticker(symbol_str):
    """Extract clean ticker from TV symbol format (e.g., 'NASDAQ:AAPL' -> 'AAPL')."""
    if not symbol_str:
        return None
    parts = str(symbol_str).split(":")
    return parts[-1].strip() if parts else symbol_str


def safe_val(val, default=None):
    """Safely extract a value, handling NaN and None."""
    if val is None:
        return default
    try:
        s = str(val)
        if s.lower() in ("nan", "none", ""):
            return default
        return val
    except (ValueError, TypeError):
        return default


def lookup_ticker_metadata(tickers, batch_size=BATCH_SIZE):
    """Look up metadata for a list of tickers using tvscreener.
    
    Returns a dict of ticker -> metadata.
    """
    results = {}
    
    # tvscreener doesn't support filtering by specific tickers directly,
    # so we fetch a large set and filter. We use multiple strategies:
    # 1. Large universe scan with high limit
    # 2. Filter results to our tickers
    
    print(f"[INFO] Looking up metadata for {len(tickers)} tickers via TradingView screener...")
    
    try:
        ss = StockScreener()
        ss.select(
            StockField.NAME,
            StockField.SECTOR,
            StockField.INDUSTRY,
            StockField.MARKET_CAPITALIZATION,
            StockField.DESCRIPTION,
            StockField.PRICE,
        )
        # Broad filter to get a large universe
        ss.where(StockField.MARKET_CAPITALIZATION >= 1e8)  # $100M+ market cap
        ss.set_markets(Market.AMERICA)
        ss.set_range(0, 5000)  # Get top 5000 by market cap
        
        df = ss.get()
        
        if df is None or df.empty:
            print("[WARN] No results from screener", file=sys.stderr)
            return results
        
        print(f"[INFO] Screener returned {len(df)} results, columns: {list(df.columns)}")
        
        # Build a lookup map from the results
        ticker_set = set(t.upper() for t in tickers)
        
        for idx, row in df.iterrows():
            # tvscreener uses "Symbol" column with format "EXCHANGE:TICKER" (e.g. "NASDAQ:AAPL")
            # "Name" column contains the ticker symbol itself, not the company name
            sym_raw = row.get("Symbol") or row.get("Name") or str(idx)
            sym = extract_ticker(str(sym_raw))
            if not sym or sym.upper() not in ticker_set:
                continue
            
            sym = sym.upper()
            meta = {"ticker": sym}
            
            # Company name: "Description" field contains the company name (e.g., "Apple Inc.")
            desc = safe_val(row.get("Description"))
            if desc:
                meta["name"] = str(desc)
            
            # Sector
            sector = safe_val(row.get("Sector"))
            if sector:
                meta["sector"] = str(sector)
            
            # Industry
            industry = safe_val(row.get("Industry"))
            if industry:
                meta["industry"] = str(industry)
            
            # Market Cap
            mcap = safe_val(row.get("Market Capitalization"))
            if mcap is not None:
                try:
                    meta["market_cap"] = float(mcap)
                except (ValueError, TypeError):
                    pass
            
            if len(meta) > 1:  # Has more than just ticker
                results[sym] = meta
        
        print(f"[INFO] Found metadata for {len(results)}/{len(tickers)} tickers")
        
    except Exception as e:
        print(f"[ERROR] Screener lookup failed: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
    
    return results


def format_market_cap(cap):
    """Format market cap for display."""
    if cap is None:
        return "—"
    try:
        cap = float(cap)
        if cap >= 1e12:
            return f"${cap / 1e12:.1f}T"
        elif cap >= 1e9:
            return f"${cap / 1e9:.1f}B"
        elif cap >= 1e6:
            return f"${cap / 1e6:.0f}M"
        else:
            return f"${cap:,.0f}"
    except (ValueError, TypeError):
        return "—"


# ── Post to API ────────────────────────────────────────────────────────────

def post_enrichment(enriched_data):
    """POST enrichment data to the Worker API in batches."""
    items = list(enriched_data.values())
    total_updated = 0
    
    for i in range(0, len(items), BATCH_SIZE):
        batch = items[i:i + BATCH_SIZE]
        try:
            resp = requests.post(
                f"{API_BASE}/timed/enrich-metadata",
                params={"key": API_KEY},
                json={"tickers": batch},
                timeout=60,
            )
            if resp.ok:
                result = resp.json()
                updated = result.get("updated", 0)
                total_updated += updated
                print(f"  Batch {i // BATCH_SIZE + 1}: {updated} updated")
            else:
                print(f"  Batch {i // BATCH_SIZE + 1}: HTTP {resp.status_code} - {resp.text[:200]}", file=sys.stderr)
        except Exception as e:
            print(f"  Batch {i // BATCH_SIZE + 1}: Error - {e}", file=sys.stderr)
        
        # Small delay between batches
        if i + BATCH_SIZE < len(items):
            time.sleep(1)
    
    return total_updated


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Enrich ticker metadata from TradingView screener")
    parser.add_argument("--post", action="store_true", help="POST enrichment data to Worker API")
    parser.add_argument("--missing-only", action="store_true", help="Only enrich tickers missing context")
    args = parser.parse_args()
    
    # Get ticker list
    all_tickers = load_universe_tickers()
    print(f"[INFO] Universe: {len(all_tickers)} tickers")
    
    if args.missing_only:
        missing = get_missing_tickers()
        if missing:
            tickers = [t for t in all_tickers if t in missing]
            print(f"[INFO] Missing context: {len(missing)} tickers, {len(tickers)} in universe")
        else:
            tickers = all_tickers
            print("[INFO] Could not determine missing tickers, enriching all")
    else:
        tickers = all_tickers
    
    if not tickers:
        print("[INFO] No tickers to enrich")
        return
    
    # Look up metadata
    enriched = lookup_ticker_metadata(tickers)
    
    if not enriched:
        print("[INFO] No metadata found")
        return
    
    # Display results
    print(f"\n{'Ticker':<8} {'Name':<30} {'Sector':<25} {'Industry':<30} {'Market Cap':<12}")
    print("─" * 110)
    for sym in sorted(enriched.keys()):
        meta = enriched[sym]
        name = (meta.get("name") or "—")[:29]
        sector = (meta.get("sector") or "—")[:24]
        industry = (meta.get("industry") or "—")[:29]
        mcap = format_market_cap(meta.get("market_cap"))
        print(f"{sym:<8} {name:<30} {sector:<25} {industry:<30} {mcap:<12}")
    
    # Not found
    not_found = set(tickers) - set(enriched.keys())
    if not_found:
        print(f"\n[INFO] Not found in screener ({len(not_found)}): {', '.join(sorted(not_found)[:20])}")
        if len(not_found) > 20:
            print(f"  ... and {len(not_found) - 20} more")
    
    # Post if requested
    if args.post:
        print(f"\n[POST] Sending {len(enriched)} enrichment records to {API_BASE}...")
        updated = post_enrichment(enriched)
        print(f"[POST] Done: {updated} tickers enriched")
    else:
        print(f"\n[DRY RUN] Would enrich {len(enriched)} tickers. Use --post to send to API.")


if __name__ == "__main__":
    main()
