#!/usr/bin/env python3
"""
v11-entry-path-analysis.py

Post-run analysis that answers "which entry_path is actually generating alpha?"
Requires v11 to have persisted entry_path on every trade (see
tasks/v11-pre-flight-plan-2026-04-22.md).

Usage:
  python3 scripts/v11-entry-path-analysis.py <run_id>
  # or with an explicit trades.json:
  python3 scripts/v11-entry-path-analysis.py --trades data/trade-analysis/<run>/trades.json

Outputs:
  1. Table of WR + sum PnL + avg winner + avg loser per entry_path
  2. Cross-break by direction (LONG/SHORT)
  3. Cross-break by regime_class
  4. Monthly breakdown showing path-level consistency
  5. Rank distribution per path
  6. MFE patterns (does rank actually predict MFE?)
"""

import argparse
import datetime
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


def load_trades(arg):
    if arg.trades:
        return json.load(open(arg.trades))
    if arg.run_id:
        path = Path("data/trade-analysis") / arg.run_id / "trades.json"
        if not path.is_file():
            print(f"ERROR: no trades.json at {path}", file=sys.stderr)
            sys.exit(2)
        return json.load(open(path))
    print("ERROR: --run-id or --trades required", file=sys.stderr)
    sys.exit(2)


def fmt_dt(ts):
    if not ts:
        return "?"
    try:
        return datetime.datetime.fromtimestamp(int(ts)/1000, tz=datetime.timezone.utc).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return "?"


def month_key(ts):
    if not ts:
        return "unknown"
    try:
        return datetime.datetime.fromtimestamp(int(ts)/1000, tz=datetime.timezone.utc).strftime("%Y-%m")
    except Exception:
        return "unknown"


def stats(trades):
    closed = [t for t in trades if t.get("exit_ts")]
    if not closed:
        return None
    wins = [t for t in closed if (t.get("pnl_pct") or 0) > 0]
    losses = [t for t in closed if (t.get("pnl_pct") or 0) <= 0]
    sum_w = sum((w.get("pnl_pct") or 0) for w in wins)
    sum_l = abs(sum((l.get("pnl_pct") or 0) for l in losses))
    return {
        "n": len(closed),
        "wins": len(wins),
        "losses": len(losses),
        "wr": len(wins) / len(closed) * 100,
        "sum_pnl": sum_w - sum_l,
        "avg_winner": sum_w / len(wins) if wins else 0,
        "avg_loser": (-sum_l) / len(losses) if losses else 0,
        "pf": sum_w / sum_l if sum_l > 0 else 0,
        "big_losers": len([t for t in closed if (t.get("pnl_pct") or 0) <= -5]),
    }


def row(label, s, width=42):
    if not s:
        print(f"  {label:<{width}} n=0")
        return
    print(f"  {label:<{width}} n={s['n']:>4} WR={s['wr']:>5.1f}% "
          f"sum={s['sum_pnl']:>+8.2f}% avg_w={s['avg_winner']:>+5.2f}% "
          f"avg_l={s['avg_loser']:>+5.2f}% pf={s['pf']:>4.2f} bigL={s['big_losers']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_id", nargs="?", help="Run ID under data/trade-analysis/")
    ap.add_argument("--trades", help="Explicit path to trades.json")
    args = ap.parse_args()

    data = load_trades(args)
    trades = data.get("trades") or data
    if not isinstance(trades, list):
        print("ERROR: trades payload is not a list", file=sys.stderr)
        sys.exit(2)

    print("=" * 78)
    print(f"V11 ENTRY-PATH ANALYSIS ({len(trades)} entries)")
    print("=" * 78)

    base = stats(trades)
    if base:
        print(f"\nOverall: n={base['n']} WR={base['wr']:.1f}% sumPnL={base['sum_pnl']:+.2f}% "
              f"pf={base['pf']:.2f}")

    # ─────────────────────────────────────────────────────────
    # GROUP BY ENTRY PATH
    # ─────────────────────────────────────────────────────────
    print("\n" + "─" * 78)
    print("ENTRY PATH (closed trades) — sorted by contribution to sum PnL")
    print("─" * 78)
    by_path = defaultdict(list)
    for t in trades:
        if not t.get("exit_ts"):
            continue
        path = (t.get("entry_path") or "unknown").lower()
        by_path[path].append(t)

    rows = []
    for path, trades_in_path in by_path.items():
        s = stats(trades_in_path)
        if s:
            rows.append((path, s))
    for path, s in sorted(rows, key=lambda x: -x[1]["sum_pnl"]):
        row(path, s)

    # ─────────────────────────────────────────────────────────
    # PATH × DIRECTION
    # ─────────────────────────────────────────────────────────
    print("\n" + "─" * 78)
    print("ENTRY PATH × DIRECTION")
    print("─" * 78)
    for path in sorted(by_path.keys(), key=lambda p: -(stats(by_path[p]) or {"sum_pnl": 0})["sum_pnl"]):
        longs = [t for t in by_path[path] if (t.get("direction") or "").upper() == "LONG"]
        shorts = [t for t in by_path[path] if (t.get("direction") or "").upper() == "SHORT"]
        lst = stats(longs)
        sst = stats(shorts)
        if lst and lst["n"] >= 2:
            row(f"{path} / LONG", lst)
        if sst and sst["n"] >= 2:
            row(f"{path} / SHORT", sst)

    # ─────────────────────────────────────────────────────────
    # PATH × MONTH
    # ─────────────────────────────────────────────────────────
    print("\n" + "─" * 78)
    print("MONTHLY CONSISTENCY PER PATH (closed trades, paths with n>=5)")
    print("─" * 78)
    months = sorted({month_key(t.get("entry_ts")) for t in trades if t.get("exit_ts")})
    print(f"\n{'path':<32} " + " ".join(f"{m[-5:]:>10}" for m in months))
    for path in sorted(by_path.keys(), key=lambda p: -(stats(by_path[p]) or {"sum_pnl": 0})["sum_pnl"]):
        if len(by_path[path]) < 5:
            continue
        cells = []
        for m in months:
            month_trades = [t for t in by_path[path] if month_key(t.get("entry_ts")) == m]
            s = stats(month_trades)
            if s:
                cells.append(f"{s['wr']:>3.0f}%/{s['sum_pnl']:>+5.1f}")
            else:
                cells.append(f"{'-':>10}")
        print(f"  {path:<30} " + " ".join(f"{c:>10}" for c in cells))

    # ─────────────────────────────────────────────────────────
    # RANK DISTRIBUTION PER PATH (sanity check on V1 formula)
    # ─────────────────────────────────────────────────────────
    print("\n" + "─" * 78)
    print("RANK DISTRIBUTION PER PATH (is high-rank correlated with WR per path?)")
    print("─" * 78)
    for path in sorted(by_path.keys(), key=lambda p: -(stats(by_path[p]) or {"sum_pnl": 0})["sum_pnl"]):
        subset = [t for t in by_path[path] if t.get("rank") is not None]
        if len(subset) < 5:
            continue
        # Split by rank
        high = [t for t in subset if (t.get("rank") or 0) >= 90]
        mid = [t for t in subset if 70 <= (t.get("rank") or 0) < 90]
        low = [t for t in subset if (t.get("rank") or 0) < 70]
        hst = stats(high)
        mst = stats(mid)
        lst = stats(low)
        hlabel = f"{hst['wr']:.0f}%/{hst['sum_pnl']:+.1f}" if hst else "-"
        mlabel = f"{mst['wr']:.0f}%/{mst['sum_pnl']:+.1f}" if mst else "-"
        llabel = f"{lst['wr']:.0f}%/{lst['sum_pnl']:+.1f}" if lst else "-"
        print(f"  {path:<28} rank>=90: {hlabel:>14}  70-89: {mlabel:>14}  <70: {llabel:>14}")

    # ─────────────────────────────────────────────────────────
    # MFE PATTERN PER PATH
    # ─────────────────────────────────────────────────────────
    print("\n" + "─" * 78)
    print("MFE REACH PER PATH (does entry quality translate to MFE peak?)")
    print("─" * 78)
    for path in sorted(by_path.keys(), key=lambda p: -(stats(by_path[p]) or {"sum_pnl": 0})["sum_pnl"]):
        subset = [t for t in by_path[path] if t.get("max_favorable_excursion") is not None]
        if len(subset) < 3:
            continue
        mfe_vals = [float(t.get("max_favorable_excursion") or 0) for t in subset]
        med = sorted(mfe_vals)[len(mfe_vals) // 2]
        pct_over_1_5 = 100 * sum(1 for v in mfe_vals if v >= 1.5) / len(mfe_vals)
        pct_over_3 = 100 * sum(1 for v in mfe_vals if v >= 3) / len(mfe_vals)
        print(f"  {path:<28} n={len(subset):>3}  MFE median={med:>+5.2f}% "
              f"%>=1.5%={pct_over_1_5:>4.0f}%  %>=3%={pct_over_3:>4.0f}%")

    # ─────────────────────────────────────────────────────────
    # BIG WINNERS BY PATH
    # ─────────────────────────────────────────────────────────
    print("\n" + "─" * 78)
    print("TOP 5 WINNERS PER PATH")
    print("─" * 78)
    for path in sorted(by_path.keys(), key=lambda p: -(stats(by_path[p]) or {"sum_pnl": 0})["sum_pnl"]):
        trades_in_path = [t for t in by_path[path] if t.get("exit_ts") and (t.get("pnl_pct") or 0) > 0]
        if not trades_in_path:
            continue
        print(f"\n  [{path}]")
        for t in sorted(trades_in_path, key=lambda x: -(x.get("pnl_pct") or 0))[:5]:
            ein = fmt_dt(t.get("entry_ts"))
            print(f"    {t.get('ticker'):6} {t.get('direction'):6} {ein}  "
                  f"pnl={(t.get('pnl_pct') or 0):>+6.2f}%  "
                  f"rank={t.get('rank'):>3}  rr={t.get('rr') or 0:.1f}  "
                  f"exit={t.get('exit_reason')}")

    # ─────────────────────────────────────────────────────────
    # MISSING ENTRY_PATH CHECK
    # ─────────────────────────────────────────────────────────
    missing = [t for t in trades if not t.get("entry_path")]
    print("\n" + "─" * 78)
    print(f"COVERAGE CHECK: entry_path missing on {len(missing)} / {len(trades)} trades")
    if missing:
        print("  (V11 pre-flight should have persisted this field on every trade.)")
        print("  Sample missing:")
        for t in missing[:5]:
            print(f"    {t.get('ticker'):6} {t.get('direction'):6} "
                  f"{fmt_dt(t.get('entry_ts'))}  setup={t.get('setup_name')}")


if __name__ == "__main__":
    main()
