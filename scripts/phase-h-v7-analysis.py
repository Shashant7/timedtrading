#!/usr/bin/env python3
"""
Phase-H Analysis: v7 vs v6b head-to-head + Win-Rate deep dive.

Usage:
  python3 scripts/phase-h-v7-analysis.py <v7_run_dir>
  e.g. python3 scripts/phase-h-v7-analysis.py data/trade-analysis/phase-g-v7-1776708363

Focus: Win Rate first, macro-backdrop accuracy second (the two user priorities).
"""

import json
import sys
import datetime
from collections import defaultdict
from pathlib import Path

V6B_PATH = Path("data/trade-analysis/phase-f-continuous-v6b/trades.json")


def load_trades(path):
    with open(path) as f:
        d = json.load(f)
    if isinstance(d, dict):
        return d.get("trades", d.get("rows", []))
    return d


def is_closed(t):
    r = t.get("exit_reason")
    return r not in (None, "unknown", "", "null")


def dir_of(t):
    return str(t.get("direction") or "").upper()


def month_of(t):
    return datetime.datetime.fromtimestamp(int(t["entry_ts"]) / 1000, tz=datetime.timezone.utc).strftime("%Y-%m")


def hold_hours(t):
    if not t.get("exit_ts") or not t.get("entry_ts"):
        return None
    return (int(t["exit_ts"]) - int(t["entry_ts"])) / 3_600_000


def metrics(trades):
    closed = [t for t in trades if is_closed(t)]
    wins = [t for t in closed if t.get("pnl_pct", 0) > 0]
    losses = [t for t in closed if t.get("pnl_pct", 0) <= 0]
    sum_pnl = sum(t.get("pnl_pct", 0) for t in closed)
    avg_win = sum(t["pnl_pct"] for t in wins) / max(1, len(wins))
    avg_loss = sum(t["pnl_pct"] for t in losses) / max(1, len(losses))
    return {
        "total": len(trades),
        "closed": len(closed),
        "wins": len(wins),
        "losses": len(losses),
        "wr": len(wins) / max(1, len(closed)) * 100,
        "sum_pnl": sum_pnl,
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "profit_factor": (sum(t["pnl_pct"] for t in wins) / abs(sum(t["pnl_pct"] for t in losses))) if losses else float("inf"),
        "expectancy": sum_pnl / max(1, len(closed)),
        "longs": sum(1 for t in closed if dir_of(t) == "LONG"),
        "shorts": sum(1 for t in closed if dir_of(t) == "SHORT"),
    }


def print_header(s):
    print(f"\n{'═' * 80}\n{s}\n{'═' * 80}")


def print_summary(label, m):
    pf = f"{m['profit_factor']:.2f}" if m["profit_factor"] != float("inf") else "inf"
    print(
        f"{label:<10} trades={m['closed']:>4}  W/L={m['wins']}/{m['losses']}  "
        f"WR={m['wr']:.1f}%  sumPnL={m['sum_pnl']:+.2f}%  "
        f"avgW={m['avg_win']:+.2f}%  avgL={m['avg_loss']:+.2f}%  "
        f"PF={pf}  exp={m['expectancy']:+.3f}%  "
        f"L/S={m['longs']}/{m['shorts']}"
    )


def by_month(trades):
    bm = defaultdict(list)
    for t in trades:
        if not is_closed(t):
            continue
        bm[month_of(t)].append(t)
    return bm


def print_monthly(label, trades):
    bm = by_month(trades)
    print(f"\n--- {label} per-month ---")
    print(f"{'Month':<9} {'N':>4} {'W':>4} {'L':>4} {'WR%':>6} {'PnL%':>8}")
    for m in sorted(bm):
        ts = bm[m]
        w = sum(1 for t in ts if t.get("pnl_pct", 0) > 0)
        l = len(ts) - w
        pnl = sum(t.get("pnl_pct", 0) for t in ts)
        wr = w / max(1, len(ts)) * 100
        winner = "✓" if pnl > 0 else "✗"
        print(f"{m:<9} {len(ts):>4} {w:>4} {l:>4} {wr:>5.1f}% {pnl:>+7.2f}% {winner}")


def print_cohort_split(label, trades, sector_map):
    """Bucket trades by cohort and report WR + PnL per cohort."""
    buckets = defaultdict(list)
    for t in trades:
        if not is_closed(t):
            continue
        tk = t.get("ticker", "")
        sector = sector_map.get(tk, "Unknown")
        buckets[sector].append(t)
    print(f"\n--- {label} by cohort (sector) ---")
    print(f"{'Cohort':<28} {'N':>4} {'W':>4} {'L':>4} {'WR%':>6} {'PnL%':>8} {'avgW':>8} {'avgL':>8}")
    for sector in sorted(buckets, key=lambda s: -sum(t.get("pnl_pct", 0) for t in buckets[s])):
        ts = buckets[sector]
        w = [t for t in ts if t.get("pnl_pct", 0) > 0]
        l = [t for t in ts if t.get("pnl_pct", 0) <= 0]
        pnl = sum(t.get("pnl_pct", 0) for t in ts)
        wr = len(w) / max(1, len(ts)) * 100
        aw = sum(x["pnl_pct"] for x in w) / max(1, len(w))
        al = sum(x["pnl_pct"] for x in l) / max(1, len(l))
        print(f"{sector[:27]:<28} {len(ts):>4} {len(w):>4} {len(l):>4} {wr:>5.1f}% {pnl:>+7.2f}% {aw:>+7.2f}% {al:>+7.2f}%")


def print_exit_reasons(label, trades):
    reasons = defaultdict(list)
    for t in trades:
        if not is_closed(t):
            continue
        r = t.get("exit_reason") or "unknown"
        reasons[r].append(t)
    print(f"\n--- {label} by exit reason ---")
    print(f"{'Reason':<35} {'N':>4} {'W':>4} {'L':>4} {'WR%':>6} {'avg%':>7} {'sum%':>8}")
    for r in sorted(reasons, key=lambda k: -sum(t.get("pnl_pct", 0) for t in reasons[k])):
        ts = reasons[r]
        w = sum(1 for t in ts if t.get("pnl_pct", 0) > 0)
        l = len(ts) - w
        pnl = sum(t.get("pnl_pct", 0) for t in ts)
        avg = pnl / max(1, len(ts))
        wr = w / max(1, len(ts)) * 100
        print(f"{r[:34]:<35} {len(ts):>4} {w:>4} {l:>4} {wr:>5.1f}% {avg:>+6.2f}% {pnl:>+7.2f}%")


def print_direction_split(label, trades):
    longs = [t for t in trades if is_closed(t) and dir_of(t) == "LONG"]
    shorts = [t for t in trades if is_closed(t) and dir_of(t) == "SHORT"]
    print(f"\n--- {label} by direction ---")
    for lbl, ts in [("LONG", longs), ("SHORT", shorts)]:
        w = sum(1 for t in ts if t.get("pnl_pct", 0) > 0)
        l = len(ts) - w
        pnl = sum(t.get("pnl_pct", 0) for t in ts)
        wr = w / max(1, len(ts)) * 100
        avg = pnl / max(1, len(ts))
        print(f"  {lbl:<6} {len(ts):>4} trades  WR={wr:.1f}%  sum={pnl:+.2f}%  avg={avg:+.3f}%")


def load_sector_map():
    """Parse worker/index.js SECTOR_MAP to bucket trades."""
    import re
    content = open("worker/index.js").read()
    m = re.search(r"const SECTOR_MAP = \{(.*?)\n\};", content, re.DOTALL)
    if not m:
        return {}
    mp = {}
    for line in m.group(1).split("\n"):
        mm = re.match(r'\s*"?([A-Z0-9!.-]+)"?\s*:\s*"([^"]+)"', line)
        if mm:
            mp[mm.group(1).upper()] = mm.group(2)
    return mp


def main():
    if len(sys.argv) < 2:
        print("Usage: phase-h-v7-analysis.py <v7_run_dir>")
        sys.exit(1)
    v7_dir = Path(sys.argv[1])
    v7_trades_path = v7_dir / "trades.json"
    if not v7_trades_path.exists():
        print(f"ERROR: {v7_trades_path} not found")
        sys.exit(1)

    v7 = load_trades(v7_trades_path)
    v6b = load_trades(V6B_PATH)
    sector_map = load_sector_map()

    print_header("PHASE-H v7 ANALYSIS")
    print(f"v7 run:  {v7_dir.name}")
    print(f"v6b ref: {V6B_PATH.parent.name}")
    print(f"v7 trades: {len(v7)} | v6b trades: {len(v6b)}")
    print(f"SECTOR_MAP members loaded: {len(sector_map)}")

    print_header("HEAD-TO-HEAD SUMMARY")
    mv6b = metrics(v6b)
    mv7 = metrics(v7)
    print_summary("v6b", mv6b)
    print_summary("v7 ", mv7)

    print(f"\nDelta: trades={mv7['closed'] - mv6b['closed']:+d}  "
          f"WR={mv7['wr'] - mv6b['wr']:+.1f}pp  "
          f"sumPnL={mv7['sum_pnl'] - mv6b['sum_pnl']:+.2f}pp  "
          f"PF={mv7['profit_factor'] - mv6b['profit_factor']:+.2f}")

    print_header("MONTH-BY-MONTH")
    print_monthly("v6b", v6b)
    print_monthly("v7", v7)

    print_header("COHORT BREAKDOWN")
    print_cohort_split("v7", v7, sector_map)

    print_header("EXIT REASON BREAKDOWN")
    print_exit_reasons("v7", v7)

    print_header("DIRECTION SPLIT")
    print_direction_split("v7", v7)
    print_direction_split("v6b", v6b)

    # Key winning-month check — user priority
    print_header("WINNING-MONTH CHECK (user priority)")
    for label, ts in [("v6b", v6b), ("v7", v7)]:
        bm = by_month(ts)
        months_total = len(bm)
        months_won = sum(1 for m in bm if sum(t.get("pnl_pct", 0) for t in bm[m]) > 0)
        high_wr_months = sum(1 for m in bm if len(bm[m]) > 0 and
                             sum(1 for t in bm[m] if t.get("pnl_pct", 0) > 0) / len(bm[m]) >= 0.60)
        print(f"{label}: {months_won}/{months_total} winning months  |  "
              f"{high_wr_months}/{months_total} months with WR >= 60%")


if __name__ == "__main__":
    main()
