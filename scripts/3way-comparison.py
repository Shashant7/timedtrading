#!/usr/bin/env python3
"""
3-Way MFE/MAE Deep Comparison across ripster_core, legacy, and tt_core backtests.
Compares by: month, direction, entry path, hold time, MFE distribution, gave-back rate.
"""

import json, sys, os
from collections import defaultdict
from datetime import datetime

ARTIFACTS = os.path.join(os.path.dirname(__file__), "..", "data", "backtest-artifacts")

RUNS = {
    "A_ripster_core": os.path.join(ARTIFACTS, "10m-ltf-validation--2026-03-20T0108"),
    "B_legacy":       os.path.join(ARTIFACTS, "legacy-baseline--2026-03-20T0156"),
    "C_tt_core":      os.path.join(ARTIFACTS, "tt-core-context-v1--2026-03-20T0205"),
}

def load_trades(run_dir):
    with open(os.path.join(run_dir, "trades.json")) as f:
        return json.load(f)

def pct(n, d):
    return round(n / d * 100, 1) if d else 0

def avg(vals):
    return round(sum(vals) / len(vals), 2) if vals else 0

def median(vals):
    if not vals: return 0
    s = sorted(vals)
    n = len(s)
    return s[n // 2] if n % 2 else round((s[n // 2 - 1] + s[n // 2]) / 2, 2)

def bucket_month(entry_date):
    return entry_date[:7]

def bucket_hold(hours):
    if hours <= 4: return "0-4h"
    if hours <= 12: return "4-12h"
    if hours <= 24: return "12-24h"
    if hours <= 48: return "1-2d"
    if hours <= 120: return "2-5d"
    return "5d+"

HOLD_ORDER = ["0-4h", "4-12h", "12-24h", "1-2d", "2-5d", "5d+"]

def analyze_trades(trades, label):
    """Full dimensional analysis of a single run's trades."""
    result = {
        "label": label,
        "total": len(trades),
        "wins": sum(1 for t in trades if t["status"] == "WIN"),
        "losses": sum(1 for t in trades if t["status"] == "LOSS"),
        "flat": sum(1 for t in trades if t["status"] == "FLAT"),
        "total_pnl": round(sum(t["pnl"] for t in trades), 2),
        "avg_pnl": avg([t["pnl"] for t in trades]),
        "avg_mfe": avg([t["mfe_pct"] for t in trades]),
        "avg_mae": avg([t["mae_pct"] for t in trades]),
        "median_mfe": median([t["mfe_pct"] for t in trades]),
        "median_mae": median([t["mae_pct"] for t in trades]),
    }
    result["wr"] = pct(result["wins"], result["wins"] + result["losses"])

    # MFE distribution
    mfe_dead = [t for t in trades if t["mfe_pct"] < 0.5]
    mfe_low = [t for t in trades if 0.5 <= t["mfe_pct"] < 2]
    mfe_mid = [t for t in trades if 2 <= t["mfe_pct"] < 5]
    mfe_high = [t for t in trades if t["mfe_pct"] >= 5]
    result["mfe_dist"] = {
        "<0.5% (dead)": {"count": len(mfe_dead), "pct": pct(len(mfe_dead), len(trades)), "avg_pnl": avg([t["pnl"] for t in mfe_dead])},
        "0.5-2%": {"count": len(mfe_low), "pct": pct(len(mfe_low), len(trades)), "avg_pnl": avg([t["pnl"] for t in mfe_low])},
        "2-5%": {"count": len(mfe_mid), "pct": pct(len(mfe_mid), len(trades)), "avg_pnl": avg([t["pnl"] for t in mfe_mid])},
        ">=5%": {"count": len(mfe_high), "pct": pct(len(mfe_high), len(trades)), "avg_pnl": avg([t["pnl"] for t in mfe_high])},
    }

    # Gave-back: MFE >= 2% but ended LOSS
    gave_back = [t for t in trades if t["mfe_pct"] >= 2 and t["status"] == "LOSS"]
    gb_total_lost = sum(t["pnl"] for t in gave_back)
    result["gave_back"] = {
        "count": len(gave_back),
        "total_lost": round(gb_total_lost, 2),
        "avg_mfe": avg([t["mfe_pct"] for t in gave_back]),
        "avg_final_pnl_pct": avg([t["pnl_pct"] for t in gave_back]),
    }

    # By direction
    longs = [t for t in trades if t["direction"] == "LONG"]
    shorts = [t for t in trades if t["direction"] == "SHORT"]
    result["by_direction"] = {}
    for label_d, subset in [("LONG", longs), ("SHORT", shorts)]:
        w = sum(1 for t in subset if t["status"] == "WIN")
        l = sum(1 for t in subset if t["status"] == "LOSS")
        result["by_direction"][label_d] = {
            "trades": len(subset),
            "wr": pct(w, w + l),
            "pnl": round(sum(t["pnl"] for t in subset), 2),
            "avg_mfe": avg([t["mfe_pct"] for t in subset]),
            "gave_back": sum(1 for t in subset if t["mfe_pct"] >= 2 and t["status"] == "LOSS"),
        }

    # By month
    by_month = defaultdict(list)
    for t in trades:
        by_month[bucket_month(t["entry_date"])].append(t)
    result["by_month"] = {}
    for m in sorted(by_month.keys()):
        subset = by_month[m]
        w = sum(1 for t in subset if t["status"] == "WIN")
        l = sum(1 for t in subset if t["status"] == "LOSS")
        result["by_month"][m] = {
            "trades": len(subset),
            "wr": pct(w, w + l),
            "pnl": round(sum(t["pnl"] for t in subset), 2),
            "avg_mfe": avg([t["mfe_pct"] for t in subset]),
            "dead_entries": sum(1 for t in subset if t["mfe_pct"] < 0.5),
            "gave_back": sum(1 for t in subset if t["mfe_pct"] >= 2 and t["status"] == "LOSS"),
        }

    # By hold time
    by_hold = defaultdict(list)
    for t in trades:
        by_hold[bucket_hold(t["hold_hours"])].append(t)
    result["by_hold"] = {}
    for h in HOLD_ORDER:
        subset = by_hold.get(h, [])
        if not subset: continue
        w = sum(1 for t in subset if t["status"] == "WIN")
        l = sum(1 for t in subset if t["status"] == "LOSS")
        result["by_hold"][h] = {
            "trades": len(subset),
            "wr": pct(w, w + l),
            "pnl": round(sum(t["pnl"] for t in subset), 2),
            "avg_mfe": avg([t["mfe_pct"] for t in subset]),
        }

    # By entry path
    by_path = defaultdict(list)
    for t in trades:
        by_path[t.get("path", "unknown")].append(t)
    result["by_path"] = {}
    for p in sorted(by_path.keys(), key=lambda x: -len(by_path[x])):
        subset = by_path[p]
        w = sum(1 for t in subset if t["status"] == "WIN")
        l = sum(1 for t in subset if t["status"] == "LOSS")
        result["by_path"][p] = {
            "trades": len(subset),
            "wr": pct(w, w + l),
            "pnl": round(sum(t["pnl"] for t in subset), 2),
            "avg_mfe": avg([t["mfe_pct"] for t in subset]),
            "avg_mae": avg([t["mae_pct"] for t in subset]),
        }

    # Exit reason distribution
    by_exit = defaultdict(int)
    for t in trades:
        by_exit[t.get("exit_reason", "unknown")] += 1
    result["exit_reasons"] = dict(sorted(by_exit.items(), key=lambda x: -x[1]))

    return result


def print_comparison(analyses):
    """Print side-by-side comparison."""
    labels = [a["label"] for a in analyses]
    w = 25

    print("=" * 90)
    print("  3-WAY BACKTEST COMPARISON: Jul 2025 - Mar 2026")
    print("=" * 90)
    print()

    # Header
    print(f"{'Metric':<25}", end="")
    for a in analyses:
        print(f"{a['label']:>{w}}", end="")
    print()
    print("-" * (25 + w * len(analyses)))

    for key in ["total", "wins", "losses", "flat"]:
        print(f"{key.capitalize():<25}", end="")
        for a in analyses: print(f"{a[key]:>{w}}", end="")
        print()
    print(f"{'Win Rate':<25}", end="")
    for a in analyses: print(f"{a['wr']}%".rjust(w), end="")
    print()
    print(f"{'Total PnL':<25}", end="")
    for a in analyses: print(f"${a['total_pnl']:,.0f}".rjust(w), end="")
    print()
    print(f"{'Avg PnL/Trade':<25}", end="")
    for a in analyses: print(f"${a['avg_pnl']:.2f}".rjust(w), end="")
    print()
    print(f"{'Avg MFE %':<25}", end="")
    for a in analyses: print(f"{a['avg_mfe']:.2f}%".rjust(w), end="")
    print()
    print(f"{'Median MFE %':<25}", end="")
    for a in analyses: print(f"{a['median_mfe']:.2f}%".rjust(w), end="")
    print()
    print(f"{'Avg MAE %':<25}", end="")
    for a in analyses: print(f"{a['avg_mae']:.2f}%".rjust(w), end="")
    print()

    # MFE Distribution
    print()
    print("━" * 90)
    print("  MFE DISTRIBUTION")
    print("━" * 90)
    for bucket in ["<0.5% (dead)", "0.5-2%", "2-5%", ">=5%"]:
        print(f"\n  {bucket}:")
        print(f"  {'Count':<23}", end="")
        for a in analyses:
            d = a["mfe_dist"][bucket]
            print(f"{d['count']} ({d['pct']}%)".rjust(w), end="")
        print()
        print(f"  {'Avg PnL':<23}", end="")
        for a in analyses:
            d = a["mfe_dist"][bucket]
            print(f"${d['avg_pnl']:.0f}".rjust(w), end="")
        print()

    # Gave-back
    print()
    print("━" * 90)
    print("  GAVE-BACK TRADES (MFE >= 2% but ended LOSS)")
    print("━" * 90)
    for key, label in [("count", "Count"), ("total_lost", "Total Lost $"), ("avg_mfe", "Avg MFE %"), ("avg_final_pnl_pct", "Avg Final PnL %")]:
        print(f"  {label:<23}", end="")
        for a in analyses:
            v = a["gave_back"][key]
            if key == "total_lost": print(f"${v:,.0f}".rjust(w), end="")
            elif key in ("avg_mfe", "avg_final_pnl_pct"): print(f"{v:.2f}%".rjust(w), end="")
            else: print(f"{v}".rjust(w), end="")
        print()

    # Direction
    print()
    print("━" * 90)
    print("  BY DIRECTION")
    print("━" * 90)
    for d in ["LONG", "SHORT"]:
        print(f"\n  {d}:")
        for key, label in [("trades", "Trades"), ("wr", "WR"), ("pnl", "PnL"), ("avg_mfe", "Avg MFE"), ("gave_back", "Gave-back")]:
            print(f"  {label:<23}", end="")
            for a in analyses:
                v = a["by_direction"].get(d, {}).get(key, 0)
                if key == "pnl": print(f"${v:,.0f}".rjust(w), end="")
                elif key == "wr": print(f"{v}%".rjust(w), end="")
                elif key == "avg_mfe": print(f"{v:.2f}%".rjust(w), end="")
                else: print(f"{v}".rjust(w), end="")
            print()

    # Monthly
    print()
    print("━" * 90)
    print("  MONTHLY BREAKDOWN")
    print("━" * 90)
    all_months = sorted(set().union(*[a["by_month"].keys() for a in analyses]))
    for m in all_months:
        print(f"\n  {m}:")
        for key, label in [("trades", "Trades"), ("wr", "WR"), ("pnl", "PnL"), ("avg_mfe", "Avg MFE"), ("dead_entries", "Dead (<0.5% MFE)"), ("gave_back", "Gave-back")]:
            print(f"  {label:<23}", end="")
            for a in analyses:
                v = a["by_month"].get(m, {}).get(key, 0)
                if key == "pnl": print(f"${v:,.0f}".rjust(w), end="")
                elif key == "wr": print(f"{v}%".rjust(w), end="")
                elif key == "avg_mfe": print(f"{v:.2f}%".rjust(w), end="")
                else: print(f"{v}".rjust(w), end="")
            print()

    # Hold time
    print()
    print("━" * 90)
    print("  BY HOLD TIME")
    print("━" * 90)
    all_holds = HOLD_ORDER
    for h in all_holds:
        any_data = any(h in a["by_hold"] for a in analyses)
        if not any_data: continue
        print(f"\n  {h}:")
        for key, label in [("trades", "Trades"), ("wr", "WR"), ("pnl", "PnL"), ("avg_mfe", "Avg MFE")]:
            print(f"  {label:<23}", end="")
            for a in analyses:
                v = a["by_hold"].get(h, {}).get(key, 0)
                if key == "pnl": print(f"${v:,.0f}".rjust(w), end="")
                elif key == "wr": print(f"{v}%".rjust(w), end="")
                elif key == "avg_mfe": print(f"{v:.2f}%".rjust(w), end="")
                else: print(f"{v}".rjust(w), end="")
            print()

    # Entry paths (top 10 per engine)
    print()
    print("━" * 90)
    print("  TOP ENTRY PATHS BY ENGINE")
    print("━" * 90)
    for a in analyses:
        print(f"\n  {a['label']}:")
        print(f"  {'Path':<35} {'Trades':>7} {'WR':>7} {'PnL':>10} {'Avg MFE':>9} {'Avg MAE':>9}")
        for p, d in list(a["by_path"].items())[:10]:
            print(f"  {p[:35]:<35} {d['trades']:>7} {d['wr']:>6}% {('$' + str(round(d['pnl']))):>10} {d['avg_mfe']:>8.2f}% {d['avg_mae']:>8.2f}%")

    # Exit reasons
    print()
    print("━" * 90)
    print("  EXIT REASON DISTRIBUTION")
    print("━" * 90)
    for a in analyses:
        print(f"\n  {a['label']}:")
        for reason, count in list(a["exit_reasons"].items())[:8]:
            print(f"    {reason:<30} {count:>5} ({pct(count, a['total']):>5.1f}%)")


def build_cross_engine_insights(analyses):
    """Extract actionable insights from the comparison."""
    a_rc, a_lg, a_tt = analyses

    insights = []
    insights.append("\n" + "=" * 90)
    insights.append("  CROSS-ENGINE INSIGHTS & RECOMMENDATIONS")
    insights.append("=" * 90)

    # Best engine per month
    insights.append("\n  BEST ENGINE PER MONTH (by WR):")
    all_months = sorted(set().union(*[a["by_month"].keys() for a in analyses]))
    for m in all_months:
        best = max(analyses, key=lambda a: a["by_month"].get(m, {}).get("wr", 0))
        wr = best["by_month"].get(m, {}).get("wr", 0)
        insights.append(f"    {m}: {best['label']} ({wr}% WR)")

    # Best engine per direction
    insights.append("\n  BEST ENGINE PER DIRECTION:")
    for d in ["LONG", "SHORT"]:
        best = max(analyses, key=lambda a: a["by_direction"].get(d, {}).get("wr", 0))
        wr = best["by_direction"].get(d, {}).get("wr", 0)
        insights.append(f"    {d}: {best['label']} ({wr}% WR)")

    # Dead entry rate
    insights.append("\n  DEAD ENTRY RATE (<0.5% MFE):")
    for a in analyses:
        d = a["mfe_dist"]["<0.5% (dead)"]
        insights.append(f"    {a['label']}: {d['pct']}% of trades are dead entries")

    # Gave-back severity
    insights.append("\n  GAVE-BACK SEVERITY:")
    for a in analyses:
        gb = a["gave_back"]
        if gb["count"] > 0:
            insights.append(f"    {a['label']}: {gb['count']} trades lost ${abs(gb['total_lost']):,.0f} (avg MFE was {gb['avg_mfe']:.1f}%, ended {gb['avg_final_pnl_pct']:.1f}%)")

    # Key recommendations
    insights.append("\n  KEY FINDINGS:")
    
    # Compare dead entry rates
    rc_dead = a_rc["mfe_dist"]["<0.5% (dead)"]["pct"]
    tt_dead = a_tt["mfe_dist"]["<0.5% (dead)"]["pct"]
    if tt_dead < rc_dead:
        insights.append(f"    - tt_core reduces dead entries from {rc_dead}% to {tt_dead}% (context gates working)")
    else:
        insights.append(f"    - tt_core dead entries ({tt_dead}%) vs ripster_core ({rc_dead}%)")

    # Compare gave-back
    rc_gb = a_rc["gave_back"]["count"]
    tt_gb = a_tt["gave_back"]["count"]
    insights.append(f"    - Gave-back: ripster_core={rc_gb}, tt_core={tt_gb}, legacy={a_lg['gave_back']['count']}")
    
    total_gb_loss = sum(abs(a["gave_back"]["total_lost"]) for a in analyses)
    insights.append(f"    - Total recoverable PnL from gave-back trades: ${total_gb_loss:,.0f}")
    insights.append(f"    - MFE breakeven stop would recover most of this")

    # Short performance
    for a in analyses:
        sd = a["by_direction"].get("SHORT", {})
        if sd.get("wr", 0) < 35:
            insights.append(f"    - {a['label']} SHORT trades underperform ({sd.get('wr', 0)}% WR) - needs stricter gating")

    return "\n".join(insights)


def main():
    print("Loading trades from all three runs...")
    all_trades = {}
    for run_name, run_dir in RUNS.items():
        all_trades[run_name] = load_trades(run_dir)
        print(f"  {run_name}: {len(all_trades[run_name])} trades")

    analyses = []
    for run_name in RUNS:
        analyses.append(analyze_trades(all_trades[run_name], run_name))

    print_comparison(analyses)
    print(build_cross_engine_insights(analyses))

    # Save full analysis as JSON
    output_path = os.path.join(ARTIFACTS, "3way-comparison.json")
    with open(output_path, "w") as f:
        json.dump(analyses, f, indent=2)
    print(f"\n  Full analysis saved to: {output_path}")


if __name__ == "__main__":
    main()
