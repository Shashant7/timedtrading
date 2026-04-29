#!/usr/bin/env python3
"""
PFVG Trade Joiner — cross-reference v16-ctx trades against PFVG levels.

For every trade in a backtest run, find the most recent PFVG (within 5
trading days prior or same day) for that ticker. Then bucket:
  - distance_to_pfvg_atr: |entry - midpoint| / atr_d
  - position: at_zone | near_zone (<0.5 ATR) | far (>0.5 ATR) | none
  - alignment: aligned (LONG + bull PFVG below entry / SHORT + bear PFVG
    above entry) | opposed | unaligned

Then compute WR / PnL / PF per bucket and report whether PFVG-aligned
trades outperform the baseline.

Usage:
  TIMED_API_KEY=... python3 scripts/pfvg-trade-joiner.py \\
      --run-id v16-ctx-all5-jul-oct-1777388332 \\
      --levels data/pfvg/pfvg-levels-2025-jul-oct.json \\
      --output data/pfvg/pfvg-trade-join.json
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta

WORKER_BASE = os.environ.get(
    "TIMED_WORKER_BASE",
    "https://timed-trading-ingest.shashant.workers.dev",
)


UA = "Mozilla/5.0 (compatible; TimedTrading-PFVG/1.0)"


def fetch_trades(api_key: str, run_id: str) -> list:
    url = (
        f"{WORKER_BASE}/timed/admin/runs/trades?"
        f"run_id={run_id}&limit=5000&key={api_key}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read())
    return data.get("trades") or []


def trade_date(t: dict) -> str | None:
    ts = t.get("entry_ts") or t.get("entered_at_ts")
    if not ts:
        return None
    try:
        ts_ms = int(ts)
    except Exception:
        return None
    return datetime.fromtimestamp(ts_ms / 1000).strftime("%Y-%m-%d")


def index_pfvg_by_ticker(levels: dict) -> dict[str, list]:
    """ticker -> sorted list of PFVG records by date asc."""
    out = defaultdict(list)
    for rec in levels.values():
        out[rec["ticker"]].append(rec)
    for t in out:
        out[t].sort(key=lambda r: r["date"])
    return out


def find_relevant_pfvg(ticker: str, trade_dt: str, by_ticker: dict, max_back_days: int = 5):
    """Find the most recent PFVG for ticker on or before trade_dt within
    max_back_days trading days (approximated as 7 calendar days)."""
    if ticker not in by_ticker:
        return None
    trade_date_obj = datetime.strptime(trade_dt, "%Y-%m-%d").date()
    earliest = trade_date_obj - timedelta(days=max_back_days * 2)  # weekend buffer
    best = None
    for rec in by_ticker[ticker]:
        rec_date = datetime.strptime(rec["date"], "%Y-%m-%d").date()
        if rec_date > trade_date_obj:
            break
        if rec_date < earliest:
            continue
        best = rec
    return best


def stats_for(trades: list, label: str = "") -> dict | None:
    closed = [t for t in trades if t.get("status") in ("WIN", "LOSS")]
    clean = [t for t in closed if t.get("exit_reason") != "replay_end_close"]
    if not clean:
        return None
    wins = [t for t in clean if (t.get("pnl_pct") or 0) > 0]
    losses = [t for t in clean if (t.get("pnl_pct") or 0) <= 0]
    sw = sum(t.get("pnl_pct") or 0 for t in wins)
    sl = sum(t.get("pnl_pct") or 0 for t in losses)
    pf = sw / abs(sl) if sl else 999
    wr = len(wins) / len(clean) * 100
    return {
        "label": label,
        "n_total": len(trades),
        "n_clean": len(clean),
        "wr": round(wr, 1),
        "pnl": round(sw + sl, 2),
        "pf": round(pf, 2),
        "avg_w": round(sw / len(wins), 2) if wins else 0,
        "avg_l": round(sl / len(losses), 2) if losses else 0,
    }


def classify(trade: dict, pfvg: dict | None) -> dict:
    if not pfvg:
        return {"position": "none", "alignment": "unaligned",
                "distance_atr": None, "pfvg_age_days": None}
    entry_price = float(trade.get("entry_price") or 0)
    if not entry_price:
        return {"position": "none", "alignment": "unaligned",
                "distance_atr": None, "pfvg_age_days": None}

    top, bottom, mid = pfvg["top"], pfvg["bottom"], pfvg["midpoint"]
    direction = pfvg["direction"]

    # Use ATR from PFVG window as denominator (small but meaningful)
    atr = pfvg.get("atr_window") or 0.0
    if atr <= 0:
        atr = abs(top - bottom)  # fallback

    in_zone = bottom <= entry_price <= top
    if in_zone:
        position = "at_zone"
        distance = 0.0
    else:
        dist_to_mid = abs(entry_price - mid)
        distance = dist_to_mid / atr if atr > 0 else 0.0
        if distance < 0.5:
            position = "near_zone"
        elif distance < 2.0:
            position = "near_2atr"
        else:
            position = "far"

    # Alignment
    trade_dir = (trade.get("direction") or "LONG").upper()
    if trade_dir == "LONG" and direction == "bull" and entry_price >= bottom:
        alignment = "aligned"
    elif trade_dir == "SHORT" and direction == "bear" and entry_price <= top:
        alignment = "aligned"
    elif (trade_dir == "LONG" and direction == "bear") or (trade_dir == "SHORT" and direction == "bull"):
        alignment = "opposed"
    else:
        alignment = "unaligned"

    pfvg_date = datetime.strptime(pfvg["date"], "%Y-%m-%d").date()
    trade_date_obj = datetime.strptime(trade_date(trade) or pfvg["date"], "%Y-%m-%d").date()
    age_days = (trade_date_obj - pfvg_date).days

    return {
        "position": position,
        "alignment": alignment,
        "distance_atr": round(distance, 3),
        "pfvg_age_days": age_days,
        "pfvg_direction": direction,
        "pfvg_strength": pfvg.get("strength_score"),
    }


def main():
    ap = argparse.ArgumentParser(description="PFVG trade joiner")
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--levels", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    api_key = os.environ.get("TIMED_API_KEY")
    if not api_key:
        print("TIMED_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    print(f"=== PFVG trade joiner ===")
    print(f"Run: {args.run_id}")
    trades = fetch_trades(api_key, args.run_id)
    print(f"Trades fetched: {len(trades)}")

    with open(args.levels) as f:
        levels = json.load(f)
    by_ticker = index_pfvg_by_ticker(levels)
    print(f"PFVG levels by ticker: {len(by_ticker)} tickers, {len(levels)} levels")

    enriched = []
    no_pfvg = 0
    for t in trades:
        ticker = (t.get("ticker") or "").upper()
        td = trade_date(t)
        if not td:
            continue
        pfvg = find_relevant_pfvg(ticker, td, by_ticker, max_back_days=5)
        ctx = classify(t, pfvg)
        if not pfvg:
            no_pfvg += 1
        enriched.append({
            "trade_id": t.get("trade_id"),
            "ticker": ticker,
            "direction": t.get("direction"),
            "entry_path": t.get("entry_path"),
            "entry_price": t.get("entry_price"),
            "entry_date": td,
            "status": t.get("status"),
            "exit_reason": t.get("exit_reason"),
            "pnl_pct": t.get("pnl_pct"),
            "pfvg_context": ctx,
        })

    # Stats
    print(f"\n=== Coverage ===")
    print(f"Trades: {len(enriched)}")
    print(f"  with PFVG context: {len(enriched) - no_pfvg}")
    print(f"  without PFVG:      {no_pfvg}")

    # Position bucket
    by_pos = defaultdict(list)
    for e in enriched:
        by_pos[e["pfvg_context"]["position"]].append(e)
    print(f"\n=== By position bucket (entry vs PFVG zone) ===")
    print(f"{'Bucket':<12} {'N':>5} {'Clean':>6} {'WR%':>6} {'PnL%':>9} {'PF':>6} {'AvgW':>7} {'AvgL':>7}")
    print("-" * 65)
    for bucket in ("at_zone", "near_zone", "near_2atr", "far", "none"):
        ts = by_pos.get(bucket, [])
        s = stats_for(ts, bucket)
        if s:
            print(f"{s['label']:<12} {s['n_total']:>5} {s['n_clean']:>6} "
                  f"{s['wr']:>5.1f}% {s['pnl']:>+8.2f}% {s['pf']:>5.2f} "
                  f"{s['avg_w']:>+6.2f}% {s['avg_l']:>+6.2f}%")

    # Alignment
    by_align = defaultdict(list)
    for e in enriched:
        by_align[e["pfvg_context"]["alignment"]].append(e)
    print(f"\n=== By alignment ===")
    print(f"{'Bucket':<12} {'N':>5} {'Clean':>6} {'WR%':>6} {'PnL%':>9} {'PF':>6}")
    print("-" * 60)
    for bucket in ("aligned", "opposed", "unaligned"):
        ts = by_align.get(bucket, [])
        s = stats_for(ts, bucket)
        if s:
            print(f"{s['label']:<12} {s['n_total']:>5} {s['n_clean']:>6} "
                  f"{s['wr']:>5.1f}% {s['pnl']:>+8.2f}% {s['pf']:>5.2f}")

    # Cross: position × alignment
    print(f"\n=== Position x Alignment cross-table ===")
    print(f"{'Pos':<10} {'Align':<10} {'N':>5} {'WR%':>6} {'PnL%':>9} {'PF':>6}")
    print("-" * 55)
    cross = defaultdict(list)
    for e in enriched:
        c = e["pfvg_context"]
        cross[(c["position"], c["alignment"])].append(e)
    for (pos, align), ts in sorted(cross.items()):
        s = stats_for(ts, "")
        if s and s["n_clean"] >= 3:
            print(f"{pos:<10} {align:<10} {s['n_clean']:>5} "
                  f"{s['wr']:>5.1f}% {s['pnl']:>+8.2f}% {s['pf']:>5.2f}")

    with open(args.output, "w") as f:
        json.dump(enriched, f, indent=2)
    print(f"\nWritten: {args.output}")


if __name__ == "__main__":
    main()
