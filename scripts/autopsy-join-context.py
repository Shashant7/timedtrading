#!/usr/bin/env python3
"""
Autopsy Context Joiner — enriches trades with daily cross-asset / VIX /
sector / SPY context by joining against historical candles instead of
relying on the replay's setup_snapshot capture.

This is the post-flight version of what setup_snapshot tries to do at
trade-creation time. Treats trade.entry_ts as the lookup key into daily
candle data we already have in D1 (loaded via /timed/candles).

Usage:
    TIMED_API_KEY=... python3 scripts/autopsy-join-context.py <run_id>
    TIMED_API_KEY=... python3 scripts/autopsy-join-context.py <run_id> --output data/.../enriched-trades.json

Joined fields (added under trade.context):
    vix_close, vix_pct_change, vix_state ('low_fear'/'normal'/'elevated'/'fear')
    spy_close, spy_pct_change, spy_above_e21
    qqq_close, qqq_pct_change
    iwm_close, iwm_pct_change
    cross_asset:
        gold_pct, silver_pct, oil_pct, dollar_pct, energy_pct, btc_pct,
        offense_avg_pct (XLK+XLY+XLI), defense_avg_pct (XLU+XLP+XLV),
        sector_rotation ('risk_on'/'balanced'/'risk_off')
    sector_etf_pct (the trade's sector ETF for the day)
    upcoming_event: { event_type, hours_to_event, ticker } (from market_events)

Why join instead of stamping in snapshot?
  - Resilient: if the replay's marketInternals capture is incomplete,
    the autopsy still produces clean data from raw candles
  - Auditable: every value is reproducible from D1
  - Cheaper: snapshot only carries expensive-to-recompute fields
    (regime, MTF state, R:R, conviction breakdown)
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

WORKER_BASE = os.environ.get(
    "TIMED_WORKER_BASE",
    "https://timed-trading-ingest.shashant.workers.dev",
)
UA = "Mozilla/5.0 (compatible; TimedTrading-Autopsy/1.0)"

# Cross-asset symbols
# DATA GAPS in D1 for our backtest window:
#   * VIX  — no daily candles in ticker_candles. Fallback: VIXY (uses
#            same intraday move; daily pct change is a usable proxy
#            for VIX direction)
#   * UUP  — no daily candles. No proxy currently in D1. Coverage 0%.
#   * DXY/USD/UDN/FXE/EURUSD — none in D1.
# TODO: backfill VIX + UUP daily candles via TwelveData fetcher (one-off
# script). For live cron, ensure data-provider includes VIX+UUP in
# bar-fetch loop.
CROSS_ASSET_SYMS = ["VIX", "VIXY", "SPY", "QQQ", "IWM",
                    "GLD", "SLV", "USO", "UUP", "XLE", "BTCUSD",
                    "XLK", "XLY", "XLI", "XLU", "XLP", "XLV",
                    "XLB", "XLC", "XLF", "XLRE"]


def fetch_trades(api_key: str, run_id: str) -> list:
    url = f"{WORKER_BASE}/timed/admin/runs/trades?run_id={run_id}&limit=5000&key={api_key}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read()).get("trades") or []


def fetch_daily_candles(api_key: str, ticker: str, limit: int = 600) -> list:
    """Fetch daily candles for a ticker, sorted ascending by ts.
    Falls back to local backfill JSON in data/cross-asset-backfill/ if D1
    has no data (used for VIX, UUP which aren't in D1)."""
    params = {"ticker": ticker, "tf": "D", "limit": str(limit), "key": api_key}
    url = f"{WORKER_BASE}/timed/candles?{urllib.parse.urlencode(params)}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
    except Exception as e:
        print(f"[WARN] Failed to fetch daily candles for {ticker}: {e}", file=sys.stderr)
        data = {}
    bars = (data or {}).get("candles") or []
    # Fallback: local backfill (for VIX, UUP, etc. not in D1)
    if not bars:
        backfill_path = f"/workspace/data/cross-asset-backfill/{ticker}-daily.json"
        try:
            with open(backfill_path) as f:
                bf = json.load(f)
            bars = bf.get("candles") or []
            if bars:
                print(f"[INFO] {ticker}: using local backfill ({len(bars)} candles)", file=sys.stderr)
        except FileNotFoundError:
            pass
        except Exception as e:
            print(f"[WARN] {ticker} backfill load failed: {e}", file=sys.stderr)
    out = []
    for b in bars:
        ts = b.get("ts") or b.get("t")
        try:
            ts_ms = int(ts) if isinstance(ts, (int, float)) else int(
                datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() * 1000
            )
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


def build_daily_index(candles: list) -> dict:
    """Return {date_key: candle} where date_key is YYYY-MM-DD UTC."""
    out = {}
    for b in candles:
        d = datetime.fromtimestamp(b["ts"] / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        out[d] = b
    return out


def get_pct_change(idx: dict, dates_sorted: list, target_date: str) -> float | None:
    """Compute one-day percent change for target_date relative to prior trading day."""
    cur = idx.get(target_date)
    if not cur:
        return None
    # Find the index in sorted dates
    try:
        i = dates_sorted.index(target_date)
    except ValueError:
        return None
    if i == 0:
        return None
    prev = idx.get(dates_sorted[i - 1])
    if not prev or prev["c"] == 0:
        return None
    return round((cur["c"] - prev["c"]) / prev["c"] * 100, 4)


def vix_state(close: float | None) -> str | None:
    if close is None:
        return None
    if close < 15:
        return "low_fear"
    if close < 20:
        return "normal"
    if close < 25:
        return "elevated"
    return "fear"


def sector_rotation_state(offense_avg: float | None, defense_avg: float | None) -> str | None:
    if offense_avg is None or defense_avg is None:
        return "unknown"
    spread = offense_avg - defense_avg
    if spread >= 0.25:
        return "risk_on"
    if spread <= -0.25:
        return "risk_off"
    return "balanced"


def trade_date_key(trade: dict) -> str | None:
    ts = trade.get("entry_ts")
    if not ts:
        return None
    try:
        return datetime.fromtimestamp(int(ts) / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description="Autopsy Context Joiner")
    ap.add_argument("run_id")
    ap.add_argument("--output",
                    help="Output path for enriched trades JSON. "
                         "Defaults to data/trade-analysis/<run_id>/trades-enriched.json")
    args = ap.parse_args()

    api_key = os.environ.get("TIMED_API_KEY")
    if not api_key:
        print("TIMED_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    print(f"=== Autopsy context joiner: {args.run_id} ===", file=sys.stderr)

    # 1. Fetch trades
    print("Fetching trades ...", file=sys.stderr)
    trades = fetch_trades(api_key, args.run_id)
    print(f"  {len(trades)} trades", file=sys.stderr)

    # 2. Fetch daily candles for all cross-asset symbols
    print(f"Fetching daily candles for {len(CROSS_ASSET_SYMS)} cross-asset symbols ...", file=sys.stderr)
    daily_idx = {}
    daily_dates_sorted = {}
    for sym in CROSS_ASSET_SYMS:
        candles = fetch_daily_candles(api_key, sym)
        if candles:
            idx = build_daily_index(candles)
            daily_idx[sym] = idx
            daily_dates_sorted[sym] = sorted(idx.keys())
            print(f"  {sym}: {len(candles)} candles", file=sys.stderr)
        else:
            print(f"  {sym}: NO DATA", file=sys.stderr)

    # 3. Fetch market_events (earnings/macro) for ALL trades' window
    # Skip for now — would need a dedicated endpoint
    # TODO: extend with /timed/admin/market-events endpoint if/when needed

    # 4. Per-trade enrichment
    print("\nEnriching trades ...", file=sys.stderr)
    enriched = []
    for t in trades:
        date_key = trade_date_key(t)
        ctx = {"trade_date": date_key}

        # VIX (with VIXY fallback — VIX daily candles are not in D1)
        vix_source = None
        if date_key and "VIX" in daily_idx and daily_idx["VIX"]:
            vix_source = "VIX"
        elif date_key and "VIXY" in daily_idx and daily_idx["VIXY"]:
            vix_source = "VIXY"  # Use VIXY as proxy
        if vix_source:
            vix_bar = daily_idx[vix_source].get(date_key)
            if vix_bar:
                ctx["vix_close"] = round(vix_bar["c"], 2)
                # Note: VIXY close is not VIX level — only use vix_state if
                # we have actual VIX
                if vix_source == "VIX":
                    ctx["vix_state"] = vix_state(vix_bar["c"])
                else:
                    ctx["vix_proxy_source"] = "VIXY"
            ctx["vix_pct_change"] = get_pct_change(
                daily_idx[vix_source], daily_dates_sorted[vix_source], date_key
            )

        # Major indices
        for idx_name in ["SPY", "QQQ", "IWM"]:
            if idx_name in daily_idx and date_key:
                bar = daily_idx[idx_name].get(date_key)
                if bar:
                    ctx[f"{idx_name.lower()}_close"] = round(bar["c"], 2)
                ctx[f"{idx_name.lower()}_pct_change"] = get_pct_change(
                    daily_idx[idx_name], daily_dates_sorted[idx_name], date_key
                )

        # Cross-asset
        ca = {}
        sym_field = {
            "GLD": "gold_pct", "SLV": "silver_pct", "USO": "oil_pct",
            "UUP": "dollar_pct", "XLE": "energy_pct", "BTCUSD": "btc_pct",
        }
        for sym, field in sym_field.items():
            if sym in daily_idx and date_key:
                ca[field] = get_pct_change(
                    daily_idx[sym], daily_dates_sorted[sym], date_key
                )
            else:
                ca[field] = None
        # Offense/defense averages
        offense_pcts = []
        for sym in ["XLK", "XLY", "XLI"]:
            if sym in daily_idx and date_key:
                v = get_pct_change(daily_idx[sym], daily_dates_sorted[sym], date_key)
                if v is not None:
                    offense_pcts.append(v)
        defense_pcts = []
        for sym in ["XLU", "XLP", "XLV"]:
            if sym in daily_idx and date_key:
                v = get_pct_change(daily_idx[sym], daily_dates_sorted[sym], date_key)
                if v is not None:
                    defense_pcts.append(v)
        if offense_pcts:
            ca["offense_avg_pct"] = round(sum(offense_pcts) / len(offense_pcts), 3)
        if defense_pcts:
            ca["defense_avg_pct"] = round(sum(defense_pcts) / len(defense_pcts), 3)
        ca["sector_rotation"] = sector_rotation_state(
            ca.get("offense_avg_pct"), ca.get("defense_avg_pct")
        )
        ctx["cross_asset"] = ca

        # Per-sector daily move (rough — uses sector mapping from snapshot if available)
        # TODO: load sector mapping from worker/sector-mapping.js
        ctx["sector_pct_change"] = None  # placeholder

        t["context"] = ctx
        enriched.append(t)

    # 5. Write
    out_path = args.output or f"/workspace/data/trade-analysis/{args.run_id}/trades-enriched.json"
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump({"run_id": args.run_id, "trades": enriched, "n_trades": len(enriched)}, f, indent=2)

    print(f"\nWritten: {out_path}", file=sys.stderr)

    # Coverage summary
    n_with_vix = sum(1 for t in enriched if t.get("context", {}).get("vix_close") is not None)
    n_with_gold = sum(1 for t in enriched if t.get("context", {}).get("cross_asset", {}).get("gold_pct") is not None)
    n_with_dollar = sum(1 for t in enriched if t.get("context", {}).get("cross_asset", {}).get("dollar_pct") is not None)
    n_with_btc = sum(1 for t in enriched if t.get("context", {}).get("cross_asset", {}).get("btc_pct") is not None)
    print(f"\n=== Coverage ===")
    print(f"VIX:    {n_with_vix:>4}/{len(enriched)} ({n_with_vix/len(enriched)*100:.0f}%)")
    print(f"Gold:   {n_with_gold:>4}/{len(enriched)} ({n_with_gold/len(enriched)*100:.0f}%)")
    print(f"Dollar: {n_with_dollar:>4}/{len(enriched)} ({n_with_dollar/len(enriched)*100:.0f}%)")
    print(f"BTC:    {n_with_btc:>4}/{len(enriched)} ({n_with_btc/len(enriched)*100:.0f}%)")


if __name__ == "__main__":
    main()
