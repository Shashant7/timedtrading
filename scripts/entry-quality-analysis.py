#!/usr/bin/env python3
"""
Entry Quality Analysis — Identifies winning formula across three backtest engines.
Reads trades.json from each backtest, classifies by MFE quality, and surfaces
the signal/path/direction/ticker combos that produce the best and worst trades.
"""

import json
import os
import sys
from collections import defaultdict, Counter
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ENGINES = {
    "ripster_core": "data/backtest-artifacts/10m-ltf-validation--2026-03-20T0108",
    "legacy":       "data/backtest-artifacts/legacy-baseline--2026-03-20T0156",
    "tt_core":      "data/backtest-artifacts/tt-core-context-v1--2026-03-20T0205",
}

MFE_TIERS = [
    ("DOA",       lambda m: m < 0.5),
    ("Weak",      lambda m: 0.5 <= m < 1.0),
    ("Decent",    lambda m: 1.0 <= m < 2.0),
    ("Strong",    lambda m: 2.0 <= m < 5.0),
    ("Home Run",  lambda m: m >= 5.0),
]

CUTOFF = "2026-03-01"

# ── helpers ──────────────────────────────────────────────────────────────────

def load_trades(engine_key):
    path = os.path.join(BASE, ENGINES[engine_key], "trades.json")
    with open(path) as f:
        raw = json.load(f)
    trades = []
    for t in raw:
        if t.get("entry_date", "9999") >= CUTOFF:
            continue
        t["engine"] = engine_key
        t["month"] = t["entry_date"][:7]
        t["mfe"] = t.get("mfe_pct", 0) or 0
        t["mae"] = t.get("mae_pct", 0) or 0
        trades.append(t)
    return trades


def tier_for(mfe):
    for name, fn in MFE_TIERS:
        if fn(mfe):
            return name
    return "Unknown"


def pct(n, d):
    return f"{100*n/d:.1f}%" if d else "—"


def avg(vals):
    return sum(vals)/len(vals) if vals else 0


def fmt(v, decimals=2):
    return f"{v:.{decimals}f}"


def bar(label, count, total, width=30):
    filled = int(width * count / total) if total else 0
    return f"  {label:<22} {'█'*filled}{'░'*(width-filled)} {count:>4} ({pct(count,total)})"


def table_header(*cols, widths=None):
    if widths is None:
        widths = [18]*len(cols)
    hdr = "│".join(c.center(w) for c, w in zip(cols, widths))
    sep = "┼".join("─"*w for w in widths)
    return f"┌{'┬'.join('─'*w for w in widths)}┐\n│{hdr}│\n├{sep}┤"


def table_row(*vals, widths=None):
    if widths is None:
        widths = [18]*len(vals)
    return "│" + "│".join(str(v).center(w) for v, w in zip(vals, widths)) + "│"


def table_footer(widths):
    return f"└{'┴'.join('─'*w for w in widths)}┘"


def top_n(counter, n=8):
    return counter.most_common(n)


def print_section(title):
    w = 90
    print(f"\n{'━'*w}")
    print(f"  {title}")
    print(f"{'━'*w}")


def print_subsection(title):
    print(f"\n  ── {title} {'─'*(70-len(title))}")

# ── load data ────────────────────────────────────────────────────────────────

all_trades = []
by_engine = {}
for eng in ENGINES:
    trades = load_trades(eng)
    by_engine[eng] = trades
    all_trades.extend(trades)

print(f"\n{'='*90}")
print(f"  ENTRY QUALITY ANALYSIS — Winning Formula Discovery")
print(f"  Trades before {CUTOFF} across 3 engines")
print(f"{'='*90}")

for eng, trades in by_engine.items():
    wins = sum(1 for t in trades if t["status"] == "WIN")
    print(f"  {eng:>14}: {len(trades):>4} trades  |  WR {pct(wins, len(trades)):>6}  |  avg MFE {fmt(avg([t['mfe'] for t in trades]))}%  |  avg MAE {fmt(avg([t['mae'] for t in trades]))}%")
print(f"  {'COMBINED':>14}: {len(all_trades):>4} trades")

# ══════════════════════════════════════════════════════════════════════════════
#  1. MFE QUALITY TIERS
# ══════════════════════════════════════════════════════════════════════════════
print_section("1. MFE QUALITY TIERS (all engines combined)")

tier_trades = defaultdict(list)
for t in all_trades:
    tier_trades[tier_for(t["mfe"])].append(t)

w = [14, 7, 9, 10, 10, 12]
print(table_header("Tier", "Count", "Win Rate", "Avg MFE%", "Avg MAE%", "Avg Hold(h)", widths=w))
for tier_name, _ in MFE_TIERS:
    grp = tier_trades[tier_name]
    if not grp:
        continue
    wins = sum(1 for t in grp if t["status"] == "WIN")
    print(table_row(
        tier_name,
        len(grp),
        pct(wins, len(grp)),
        fmt(avg([t["mfe"] for t in grp])),
        fmt(avg([t["mae"] for t in grp])),
        fmt(avg([t.get("hold_hours", 0) for t in grp]), 0),
        widths=w,
    ))
print(table_footer(w))

for tier_name, _ in MFE_TIERS:
    grp = tier_trades[tier_name]
    if not grp:
        continue
    print_subsection(f"{tier_name} tier breakdown (n={len(grp)})")

    dirs = Counter(t["direction"] for t in grp)
    paths = Counter(t["path"] for t in grp)
    months = Counter(t["month"] for t in grp)
    exits = Counter(t.get("exit_reason", "?") for t in grp)
    tickers = Counter(t["ticker"] for t in grp)

    print(f"    Direction:  {', '.join(f'{d} {c}({pct(c,len(grp))})' for d,c in dirs.most_common())}")
    print(f"    Top paths:  {', '.join(f'{p} {c}' for p,c in paths.most_common(6))}")
    print(f"    Top months: {', '.join(f'{m} {c}' for m,c in sorted(months.items()))}")
    print(f"    Exits:      {', '.join(f'{e} {c}' for e,c in exits.most_common())}")
    print(f"    Top tickers:{', '.join(f'{t} {c}' for t,c in tickers.most_common(8))}")

# ══════════════════════════════════════════════════════════════════════════════
#  2. PER-ENGINE TIER BREAKDOWN
# ══════════════════════════════════════════════════════════════════════════════
print_section("2. PER-ENGINE MFE TIER DISTRIBUTION")

w2 = [14, 14, 14, 14]
for tier_name, _ in MFE_TIERS:
    row_vals = [tier_name]
    for eng in ENGINES:
        eng_tier = [t for t in by_engine[eng] if tier_for(t["mfe"]) == tier_name]
        row_vals.append(f"{len(eng_tier)} ({pct(len(eng_tier), len(by_engine[eng]))})")
    if tier_name == MFE_TIERS[0][0]:
        print(table_header("Tier", *ENGINES.keys(), widths=w2))
    print(table_row(*row_vals, widths=w2))
print(table_footer(w2))

# ══════════════════════════════════════════════════════════════════════════════
#  3. SWEET SPOT: MFE >= 2% AND MAE <= 1% (MAE is negative, so >= -1)
# ══════════════════════════════════════════════════════════════════════════════
print_section("3. SWEET SPOT — MFE >= 2% AND MAE >= -1% (minimal pain, real move)")

sweet = [t for t in all_trades if t["mfe"] >= 2.0 and t["mae"] >= -1.0]
print(f"\n  Sweet-spot trades: {len(sweet)} / {len(all_trades)} = {pct(len(sweet), len(all_trades))} of all trades")
wins_s = sum(1 for t in sweet if t["status"] == "WIN")
print(f"  Win rate:          {pct(wins_s, len(sweet))}")
print(f"  Avg MFE:           {fmt(avg([t['mfe'] for t in sweet]))}%")
print(f"  Avg MAE:           {fmt(avg([t['mae'] for t in sweet]))}%")
print(f"  Avg PnL%:          {fmt(avg([t['pnl_pct'] for t in sweet]))}%")
print(f"  Avg Hold:          {fmt(avg([t.get('hold_hours',0) for t in sweet]),0)}h")

print_subsection("Sweet spot by direction")
for d, c in Counter(t["direction"] for t in sweet).most_common():
    sub = [t for t in sweet if t["direction"] == d]
    print(f"    {d:<8} {c:>4} trades  WR {pct(sum(1 for t in sub if t['status']=='WIN'), len(sub))}  avg MFE {fmt(avg([t['mfe'] for t in sub]))}%")

print_subsection("Sweet spot by entry path")
for p, c in Counter(t["path"] for t in sweet).most_common():
    sub = [t for t in sweet if t["path"] == p]
    print(f"    {p:<35} {c:>3} trades  WR {pct(sum(1 for t in sub if t['status']=='WIN'), len(sub))}  avg MFE {fmt(avg([t['mfe'] for t in sub]))}%")

print_subsection("Sweet spot by month")
for m in sorted(set(t["month"] for t in sweet)):
    sub = [t for t in sweet if t["month"] == m]
    print(f"    {m}  {len(sub):>3} trades  WR {pct(sum(1 for t in sub if t['status']=='WIN'), len(sub))}")

print_subsection("Sweet spot by confidence")
for c_val in sorted(set(t["confidence"] for t in sweet)):
    sub = [t for t in sweet if t["confidence"] == c_val]
    print(f"    conf={c_val:<5}  {len(sub):>3} trades  WR {pct(sum(1 for t in sub if t['status']=='WIN'), len(sub))}  avg MFE {fmt(avg([t['mfe'] for t in sub]))}%")

print_subsection("Sweet spot by engine")
for eng in ENGINES:
    sub = [t for t in sweet if t["engine"] == eng]
    if sub:
        print(f"    {eng:<14}  {len(sub):>3} trades  WR {pct(sum(1 for t in sub if t['status']=='WIN'), len(sub))}  avg MFE {fmt(avg([t['mfe'] for t in sub]))}%")

print_subsection("Sweet spot top tickers")
for tk, c in Counter(t["ticker"] for t in sweet).most_common(15):
    sub = [t for t in sweet if t["ticker"] == tk]
    print(f"    {tk:<8} {c:>3} trades  avg MFE {fmt(avg([t['mfe'] for t in sub]))}%  avg MAE {fmt(avg([t['mae'] for t in sub]))}%")

# ══════════════════════════════════════════════════════════════════════════════
#  4. TOXIC PATTERNS — DOA trades (MFE < 0.5%)
# ══════════════════════════════════════════════════════════════════════════════
print_section("4. TOXIC PATTERNS — DOA trades (MFE < 0.5%)")

doa = tier_trades["DOA"]
print(f"\n  DOA trades: {len(doa)} / {len(all_trades)} = {pct(len(doa), len(all_trades))} of all trades")
print(f"  Avg MAE:    {fmt(avg([t['mae'] for t in doa]))}%   (avg pain on dead trades)")
print(f"  Avg PnL%:   {fmt(avg([t['pnl_pct'] for t in doa]))}%")

print_subsection("DOA by entry path (with DOA rate)")
path_totals = Counter(t["path"] for t in all_trades)
path_doa = Counter(t["path"] for t in doa)
rows = []
for p in path_totals:
    d_count = path_doa.get(p, 0)
    total = path_totals[p]
    rate = d_count / total if total else 0
    rows.append((p, d_count, total, rate))
rows.sort(key=lambda r: -r[1])
w3 = [35, 8, 8, 10]
print(table_header("Path", "DOA", "Total", "DOA Rate", widths=w3))
for p, dc, tot, rate in rows:
    print(table_row(p, dc, tot, f"{rate*100:.1f}%", widths=w3))
print(table_footer(w3))

print_subsection("DOA by direction")
for d, c in Counter(t["direction"] for t in doa).most_common():
    total_d = sum(1 for t in all_trades if t["direction"] == d)
    print(f"    {d:<8} {c:>4} DOA / {total_d} total = DOA rate {pct(c, total_d)}")

print_subsection("DOA by month")
for m in sorted(set(t["month"] for t in doa)):
    sub = [t for t in doa if t["month"] == m]
    total_m = sum(1 for t in all_trades if t["month"] == m)
    print(f"    {m}  {len(sub):>3} DOA / {total_m} total = {pct(len(sub), total_m)}")

print_subsection("DOA by confidence")
for c_val in sorted(set(t["confidence"] for t in doa)):
    sub = [t for t in doa if t["confidence"] == c_val]
    total_c = sum(1 for t in all_trades if t["confidence"] == c_val)
    print(f"    conf={c_val:<5}  {len(sub):>3} DOA / {total_c} total = {pct(len(sub), total_c)}")

print_subsection("Tickers with highest DOA rate (min 3 trades)")
ticker_totals = Counter(t["ticker"] for t in all_trades)
ticker_doa = Counter(t["ticker"] for t in doa)
tk_rows = []
for tk in ticker_totals:
    tot = ticker_totals[tk]
    if tot < 3:
        continue
    dc = ticker_doa.get(tk, 0)
    tk_rows.append((tk, dc, tot, dc/tot))
tk_rows.sort(key=lambda r: (-r[3], -r[1]))
for tk, dc, tot, rate in tk_rows[:20]:
    print(f"    {tk:<8} {dc:>3} DOA / {tot:>3} total = {rate*100:.0f}%")

# ══════════════════════════════════════════════════════════════════════════════
#  5. CROSS-ENGINE COMPARISON BY DIMENSION
# ══════════════════════════════════════════════════════════════════════════════
print_section("5. CROSS-ENGINE COMPARISON")

print_subsection("By entry path — avg MFE% / avg MAE% / MFE:MAE ratio")
all_paths = sorted(set(t["path"] for t in all_trades))
w5 = [35, 18, 18, 18]
print(table_header("Path", *ENGINES.keys(), widths=w5))
for p in all_paths:
    vals = [p]
    for eng in ENGINES:
        sub = [t for t in by_engine[eng] if t["path"] == p]
        if not sub:
            vals.append("—")
            continue
        m = avg([t["mfe"] for t in sub])
        a = avg([t["mae"] for t in sub])
        ratio = abs(m / a) if a != 0 else float('inf')
        vals.append(f"{fmt(m)}/{fmt(a)} r={fmt(ratio,1)}")
    print(table_row(*vals, widths=w5))
print(table_footer(w5))

print_subsection("By direction — avg MFE / WR")
w5d = [10, 22, 22, 22]
print(table_header("Dir", *ENGINES.keys(), widths=w5d))
for d in ["LONG", "SHORT"]:
    vals = [d]
    for eng in ENGINES:
        sub = [t for t in by_engine[eng] if t["direction"] == d]
        if not sub:
            vals.append("—")
            continue
        m = avg([t["mfe"] for t in sub])
        wr = pct(sum(1 for t in sub if t["status"]=="WIN"), len(sub))
        vals.append(f"MFE {fmt(m)}% WR {wr} n={len(sub)}")
    print(table_row(*vals, widths=w5d))
print(table_footer(w5d))

print_subsection("LONG trades by month — which engine degrades least")
months_all = sorted(set(t["month"] for t in all_trades if t["direction"] == "LONG"))
w5m = [10, 22, 22, 22]
print(table_header("Month", *ENGINES.keys(), widths=w5m))
for m in months_all:
    vals = [m]
    for eng in ENGINES:
        sub = [t for t in by_engine[eng] if t["direction"]=="LONG" and t["month"]==m]
        if not sub:
            vals.append("—")
            continue
        mfe = avg([t["mfe"] for t in sub])
        wr = pct(sum(1 for t in sub if t["status"]=="WIN"), len(sub))
        vals.append(f"MFE {fmt(mfe)}% WR {wr} n={len(sub)}")
    print(table_row(*vals, widths=w5m))
print(table_footer(w5m))

print_subsection("SHORT trades by month")
months_short = sorted(set(t["month"] for t in all_trades if t["direction"] == "SHORT"))
print(table_header("Month", *ENGINES.keys(), widths=w5m))
for m in months_short:
    vals = [m]
    for eng in ENGINES:
        sub = [t for t in by_engine[eng] if t["direction"]=="SHORT" and t["month"]==m]
        if not sub:
            vals.append("—")
            continue
        mfe = avg([t["mfe"] for t in sub])
        wr = pct(sum(1 for t in sub if t["status"]=="WIN"), len(sub))
        vals.append(f"MFE {fmt(mfe)}% WR {wr} n={len(sub)}")
    print(table_row(*vals, widths=w5m))
print(table_footer(w5m))

# ══════════════════════════════════════════════════════════════════════════════
#  6. WINNING FORMULA & BLOCK LIST
# ══════════════════════════════════════════════════════════════════════════════
print_section("6. WINNING FORMULA & BLOCK LIST")

# Score each (direction, path, month-bucket) combo
combos = defaultdict(list)
for t in all_trades:
    key = (t["direction"], t["path"])
    combos[key].append(t)

print_subsection("Best combos (direction × path) — sorted by sweet-spot rate")
combo_stats = []
for (d, p), grp in combos.items():
    n = len(grp)
    if n < 5:
        continue
    sweet_n = sum(1 for t in grp if t["mfe"] >= 2.0 and t["mae"] >= -1.0)
    doa_n = sum(1 for t in grp if t["mfe"] < 0.5)
    wr = sum(1 for t in grp if t["status"] == "WIN") / n
    mfe = avg([t["mfe"] for t in grp])
    mae = avg([t["mae"] for t in grp])
    combo_stats.append({
        "dir": d, "path": p, "n": n,
        "sweet_rate": sweet_n / n, "sweet_n": sweet_n,
        "doa_rate": doa_n / n, "doa_n": doa_n,
        "wr": wr, "mfe": mfe, "mae": mae,
    })

combo_stats.sort(key=lambda r: -r["sweet_rate"])
w6 = [8, 35, 6, 9, 9, 9, 9, 9]
print(table_header("Dir", "Path", "N", "Sweet%", "DOA%", "WR", "MFE%", "MAE%", widths=w6))
for r in combo_stats[:20]:
    print(table_row(
        r["dir"], r["path"], r["n"],
        f"{r['sweet_rate']*100:.0f}%", f"{r['doa_rate']*100:.0f}%",
        f"{r['wr']*100:.0f}%", fmt(r["mfe"]), fmt(r["mae"]),
        widths=w6,
    ))
print(table_footer(w6))

print_subsection("BLOCK LIST — combos with DOA rate > 50% (min 5 trades)")
combo_stats.sort(key=lambda r: -r["doa_rate"])
print(table_header("Dir", "Path", "N", "Sweet%", "DOA%", "WR", "MFE%", "MAE%", widths=w6))
for r in combo_stats:
    if r["doa_rate"] <= 0.50:
        continue
    print(table_row(
        r["dir"], r["path"], r["n"],
        f"{r['sweet_rate']*100:.0f}%", f"{r['doa_rate']*100:.0f}%",
        f"{r['wr']*100:.0f}%", fmt(r["mfe"]), fmt(r["mae"]),
        widths=w6,
    ))
print(table_footer(w6))

# Monthly quality trend
print_subsection("Monthly quality trend (sweet-spot rate / DOA rate)")
months_sorted = sorted(set(t["month"] for t in all_trades))
w6m = [10, 8, 12, 12, 10, 10]
print(table_header("Month", "N", "Sweet-spot%", "DOA%", "Avg MFE%", "Avg MAE%", widths=w6m))
for m in months_sorted:
    sub = [t for t in all_trades if t["month"] == m]
    sweet_n = sum(1 for t in sub if t["mfe"] >= 2.0 and t["mae"] >= -1.0)
    doa_n = sum(1 for t in sub if t["mfe"] < 0.5)
    print(table_row(
        m, len(sub),
        pct(sweet_n, len(sub)), pct(doa_n, len(sub)),
        fmt(avg([t["mfe"] for t in sub])), fmt(avg([t["mae"] for t in sub])),
        widths=w6m,
    ))
print(table_footer(w6m))

# Confidence analysis
print_subsection("Confidence level impact")
conf_vals = sorted(set(t["confidence"] for t in all_trades))
w6c = [10, 8, 12, 12, 10, 10]
print(table_header("Conf", "N", "Sweet-spot%", "DOA%", "Avg MFE%", "WR", widths=w6c))
for cv in conf_vals:
    sub = [t for t in all_trades if t["confidence"] == cv]
    sweet_n = sum(1 for t in sub if t["mfe"] >= 2.0 and t["mae"] >= -1.0)
    doa_n = sum(1 for t in sub if t["mfe"] < 0.5)
    wr = sum(1 for t in sub if t["status"] == "WIN") / len(sub)
    print(table_row(
        cv, len(sub),
        pct(sweet_n, len(sub)), pct(doa_n, len(sub)),
        fmt(avg([t["mfe"] for t in sub])), f"{wr*100:.0f}%",
        widths=w6c,
    ))
print(table_footer(w6c))

# ══════════════════════════════════════════════════════════════════════════════
#  7. GAVE-BACK ANALYSIS: MFE >= 2% but ended LOSS
# ══════════════════════════════════════════════════════════════════════════════
print_section("7. GAVE-BACK ANALYSIS — MFE >= 2% that ended LOSS")

gave_back = [t for t in all_trades if t["mfe"] >= 2.0 and t["status"] == "LOSS"]
strong_wins = [t for t in all_trades if t["mfe"] >= 2.0 and t["status"] == "WIN"]
print(f"\n  Gave-back trades: {len(gave_back)}")
print(f"  Strong winners:   {len(strong_wins)}")
print(f"  Give-back rate:   {pct(len(gave_back), len(gave_back)+len(strong_wins))} of MFE>=2% trades end in LOSS")

if gave_back:
    print(f"\n  Avg MFE of gave-back:  {fmt(avg([t['mfe'] for t in gave_back]))}%  (they DID have the move)")
    print(f"  Avg MAE of gave-back:  {fmt(avg([t['mae'] for t in gave_back]))}%  (how deep they went)")
    print(f"  Avg PnL% of gave-back: {fmt(avg([t['pnl_pct'] for t in gave_back]))}%")
    print(f"  Avg hold of gave-back: {fmt(avg([t.get('hold_hours',0) for t in gave_back]),0)}h")

    print_subsection("Gave-back by exit_reason")
    for e, c in Counter(t.get("exit_reason","?") for t in gave_back).most_common():
        print(f"    {e:<20} {c:>3} trades")

    print_subsection("Gave-back by entry path")
    for p, c in Counter(t["path"] for t in gave_back).most_common():
        sub = [t for t in gave_back if t["path"] == p]
        total_path = sum(1 for t in all_trades if t["path"] == p and t["mfe"] >= 2.0)
        print(f"    {p:<35} {c:>3} gave-back / {total_path:>3} MFE>=2% = {pct(c, total_path)}")

    print_subsection("Gave-back by direction")
    for d, c in Counter(t["direction"] for t in gave_back).most_common():
        total_d = sum(1 for t in all_trades if t["direction"] == d and t["mfe"] >= 2.0)
        print(f"    {d:<8} {c:>3} gave-back / {total_d:>3} MFE>=2% = {pct(c, total_d)}")

    print_subsection("Gave-back by engine")
    for eng in ENGINES:
        sub = [t for t in gave_back if t["engine"] == eng]
        total_eng = sum(1 for t in by_engine[eng] if t["mfe"] >= 2.0)
        if total_eng:
            print(f"    {eng:<14} {len(sub):>3} gave-back / {total_eng:>3} MFE>=2% = {pct(len(sub), total_eng)}  avg MAE {fmt(avg([t['mae'] for t in sub]) if sub else 0)}%")

    print_subsection("Gave-back top tickers")
    for tk, c in Counter(t["ticker"] for t in gave_back).most_common(10):
        sub = [t for t in gave_back if t["ticker"] == tk]
        print(f"    {tk:<8} {c:>2}x  avg MFE {fmt(avg([t['mfe'] for t in sub]))}%  avg MAE {fmt(avg([t['mae'] for t in sub]))}%  avg PnL {fmt(avg([t['pnl_pct'] for t in sub]))}%")

# ══════════════════════════════════════════════════════════════════════════════
#  SUMMARY RECOMMENDATION
# ══════════════════════════════════════════════════════════════════════════════
print_section("8. EXECUTIVE SUMMARY — WINNING FORMULA")

# Compute best combos
best = [r for r in combo_stats if r["sweet_rate"] >= 0.30 and r["n"] >= 5]
best.sort(key=lambda r: -r["sweet_rate"])
worst = [r for r in combo_stats if r["doa_rate"] >= 0.50 and r["n"] >= 5]
worst.sort(key=lambda r: -r["doa_rate"])

# Best months
month_sweet = {}
for m in months_sorted:
    sub = [t for t in all_trades if t["month"] == m]
    sw = sum(1 for t in sub if t["mfe"] >= 2.0 and t["mae"] >= -1.0)
    month_sweet[m] = sw / len(sub) if sub else 0

best_months = sorted(month_sweet.items(), key=lambda x: -x[1])[:3]
worst_months = sorted(month_sweet.items(), key=lambda x: x[1])[:3]

print(f"""
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  TAKE THESE TRADES (high sweet-spot rate, low DOA)                     │
  ├─────────────────────────────────────────────────────────────────────────┤""")
for r in best[:8]:
    print(f"  │  {r['dir']:<6} {r['path']:<32} sweet={r['sweet_rate']*100:.0f}% doa={r['doa_rate']*100:.0f}% WR={r['wr']*100:.0f}% n={r['n']:<4}│")
print(f"""  ├─────────────────────────────────────────────────────────────────────────┤
  │  BEST MONTHS: {', '.join(f'{m} ({v*100:.0f}%)' for m,v in best_months):<56}│
  ├─────────────────────────────────────────────────────────────────────────┤
  │  BLOCK THESE (high DOA, poor risk/reward)                              │
  ├─────────────────────────────────────────────────────────────────────────┤""")
for r in worst[:8]:
    print(f"  │  {r['dir']:<6} {r['path']:<32} sweet={r['sweet_rate']*100:.0f}% doa={r['doa_rate']*100:.0f}% WR={r['wr']*100:.0f}% n={r['n']:<4}│")
print(f"""  ├─────────────────────────────────────────────────────────────────────────┤
  │  WORST MONTHS: {', '.join(f'{m} ({v*100:.0f}%)' for m,v in worst_months):<55}│
  └─────────────────────────────────────────────────────────────────────────┘""")

# Engine recommendation
print("\n  ENGINE COMPARISON SUMMARY:")
for eng in ENGINES:
    trades_e = by_engine[eng]
    sw = sum(1 for t in trades_e if t["mfe"] >= 2.0 and t["mae"] >= -1.0)
    doa_e = sum(1 for t in trades_e if t["mfe"] < 0.5)
    wr = sum(1 for t in trades_e if t["status"] == "WIN") / len(trades_e)
    mfe = avg([t["mfe"] for t in trades_e])
    gb = sum(1 for t in trades_e if t["mfe"] >= 2.0 and t["status"] == "LOSS")
    gb_total = sum(1 for t in trades_e if t["mfe"] >= 2.0)
    print(f"    {eng:<14}  WR={wr*100:.0f}%  sweet={pct(sw,len(trades_e))}  DOA={pct(doa_e,len(trades_e))}  avg MFE={fmt(mfe)}%  gave-back={pct(gb,gb_total) if gb_total else '—'}")

print(f"\n{'='*90}")
print(f"  Analysis complete. {len(all_trades)} trades analyzed across 3 engines.")
print(f"{'='*90}\n")
