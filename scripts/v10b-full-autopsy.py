#!/usr/bin/env python3
"""
v10b-full-autopsy.py

Comprehensive post-mortem for the v10b backtest, stopped at day 92/210 (Nov 7).

Covers:
  1. Aggregate performance (closed + open)
  2. Open-positions audit (the 15 still-open trades, including TPL duplicates)
  3. Big-loser deep dive (AGYS, CSX, ORCL, 2x ISRG + Oct bleed)
  4. H.3 regression analysis: why 64.6% WR on v9 (40T) became 50.5% on v10b (215T)
  5. Per-month cohort + setup + direction patterns
  6. Winners-only pattern extraction (Aug = best month)
  7. Exit-reason performance table
  8. Concrete Phase-I refinement candidates
"""

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
import datetime as dt

ROOT = Path("/workspace/data/trade-analysis/phase-h-v10b-1776787446/final-snapshot")
LIVE = ROOT / "trades-live-premortem.json"
AUTO = ROOT / "trades-autopsy.json"

live_data = json.load(open(LIVE))
all_trades = [t for t in (live_data.get("trades") or []) if t.get("run_id") == "phase-h-v10b-1776787446"]

def ts_to_dt(ts):
    if not ts:
        return None
    return dt.datetime.fromtimestamp(int(ts) / 1000, tz=dt.timezone.utc)

def fmt_dt(ts):
    d = ts_to_dt(ts)
    return d.strftime("%Y-%m-%d %H:%M") if d else "?"

def month_key(ts):
    d = ts_to_dt(ts)
    return d.strftime("%Y-%m") if d else "?"

closed = [t for t in all_trades if t.get("exit_ts")]
open_t = [t for t in all_trades if not t.get("exit_ts")]

print("=" * 78)
print("V10B FULL AUTOPSY — stopped at day 92/210 (Nov 7, 2025)")
print("215-ticker universe, H.3 entry discipline + H.4.0/H.4.2 active")
print("=" * 78)

# ─────────────────────────────────────────────────────────────────
# 1. AGGREGATE
# ─────────────────────────────────────────────────────────────────
print("\n" + "=" * 78)
print("1. AGGREGATE PERFORMANCE")
print("=" * 78)

wins = [t for t in closed if (t.get("pnl_pct") or 0) > 0]
losses = [t for t in closed if (t.get("pnl_pct") or 0) <= 0]
wr = len(wins) / len(closed) * 100 if closed else 0

sum_pnl_usd = sum((t.get("pnl") or 0) for t in closed)
sum_pnl_pct = sum((t.get("pnl_pct") or 0) for t in closed)
avg_win = sum((w.get("pnl_pct") or 0) for w in wins) / len(wins) if wins else 0
avg_loss = sum((l.get("pnl_pct") or 0) for l in losses) / len(losses) if losses else 0
sum_wins = sum((w.get("pnl_pct") or 0) for w in wins)
sum_losses = abs(sum((l.get("pnl_pct") or 0) for l in losses))
pf = sum_wins / sum_losses if sum_losses > 0 else 0

print(f"\nTotal trades:     {len(all_trades)}")
print(f"  Closed:         {len(closed)}")
print(f"  Open (stranded): {len(open_t)}")
print(f"\nClosed-trade stats:")
print(f"  Win rate:       {wr:.1f}%   ({len(wins)}W / {len(losses)}L)")
print(f"  Sum PnL $:      ${sum_pnl_usd:+,.2f}")
print(f"  Sum PnL %:      {sum_pnl_pct:+.2f}%")
print(f"  Avg winner:     {avg_win:+.2f}%")
print(f"  Avg loser:      {avg_loss:+.2f}%")
print(f"  Profit factor:  {pf:.2f}")
print(f"  Payoff ratio:   {abs(avg_win/avg_loss) if avg_loss else 0:.2f}")

# ─────────────────────────────────────────────────────────────────
# 2. OPEN POSITIONS AUDIT
# ─────────────────────────────────────────────────────────────────
print("\n" + "=" * 78)
print("2. OPEN POSITIONS (15 stranded — potential position-duplication bug)")
print("=" * 78)

# Group open by ticker
by_ticker = defaultdict(list)
for t in open_t:
    by_ticker[t.get("ticker")].append(t)

print("\nDuplicate open positions (same ticker, >1 open):")
dups = {k: v for k, v in by_ticker.items() if len(v) > 1}
if dups:
    for tk, items in sorted(dups.items()):
        print(f"  {tk}: {len(items)} positions")
        for t in sorted(items, key=lambda x: x.get("entry_ts") or 0):
            print(f"    {t.get('direction'):6} entered {fmt_dt(t.get('entry_ts'))}  "
                  f"@ ${t.get('entry_price')}  shares={t.get('shares'):.1f}  "
                  f"setup={t.get('setup_name','?')} grade={t.get('setup_grade','?')}")
else:
    print("  None.")

print("\nAll open positions (sorted by entry date):")
print(f"  {'Ticker':<6} {'Dir':<6} {'Entry':<18} {'Price':>10} {'Shares':>8}  {'Setup'}")
for t in sorted(open_t, key=lambda x: x.get("entry_ts") or 0):
    print(f"  {t.get('ticker',''):<6} {t.get('direction',''):<6} "
          f"{fmt_dt(t.get('entry_ts')):<18} "
          f"${t.get('entry_price',0):>8.2f} "
          f"{(t.get('shares') or 0):>8.1f}  "
          f"{t.get('setup_name','?')} ({t.get('setup_grade','?')})")

# Compute age in replay days — since last completed day was Nov 7, 2025
stop_day = dt.datetime(2025, 11, 7, tzinfo=dt.timezone.utc)
print(f"\nReplay 'now' = Nov 7, 2025. Position age in replay trading days:")
for t in sorted(open_t, key=lambda x: x.get("entry_ts") or 0):
    entry = ts_to_dt(t.get("entry_ts"))
    age = (stop_day - entry).days
    print(f"  {t.get('ticker'):6} {t.get('direction'):6} — {age} calendar days open")

# ─────────────────────────────────────────────────────────────────
# 3. BIG LOSER DEEP DIVE
# ─────────────────────────────────────────────────────────────────
print("\n" + "=" * 78)
print("3. BIG LOSERS (<= -5%) — DEEP DIVE")
print("=" * 78)

big_losers = sorted([t for t in closed if (t.get("pnl_pct") or 0) <= -5], key=lambda x: x.get("pnl_pct") or 0)
for t in big_losers:
    entry_dt = ts_to_dt(t.get("entry_ts"))
    exit_dt = ts_to_dt(t.get("exit_ts"))
    hold_hours = ((exit_dt - entry_dt).total_seconds() / 3600) if (entry_dt and exit_dt) else 0
    print(f"\n  {t.get('ticker'):6} {t.get('direction'):6}  {entry_dt.strftime('%Y-%m-%d %H:%M'):<16} → {exit_dt.strftime('%Y-%m-%d %H:%M'):<16}")
    print(f"    PnL:    {t.get('pnl_pct'):+.2f}%  (${t.get('pnl'):+.2f})")
    print(f"    Setup:  {t.get('setup_name','?')} (grade: {t.get('setup_grade','?')})")
    print(f"    Exit:   {t.get('exit_reason','?')}")
    print(f"    Hold:   {hold_hours:.1f} hrs ({hold_hours/24:.1f} days)")
    print(f"    Entry:  ${t.get('entry_price')}  Exit: ${t.get('exit_price')}")

# ─────────────────────────────────────────────────────────────────
# 4. PER-MONTH BREAKDOWN
# ─────────────────────────────────────────────────────────────────
print("\n" + "=" * 78)
print("4. PER-MONTH PERFORMANCE")
print("=" * 78)

monthly = defaultdict(lambda: {"n": 0, "wins": 0, "losses": 0, "sum_pnl": 0.0, "big_losers": 0,
                               "longs": 0, "shorts": 0, "long_wins": 0, "short_wins": 0})
for t in closed:
    m = month_key(t.get("entry_ts"))
    s = monthly[m]
    s["n"] += 1
    pnl = t.get("pnl_pct") or 0
    s["sum_pnl"] += pnl
    if pnl > 0:
        s["wins"] += 1
    else:
        s["losses"] += 1
    if pnl <= -5:
        s["big_losers"] += 1
    direction = (t.get("direction") or "").upper()
    if direction == "LONG":
        s["longs"] += 1
        if pnl > 0:
            s["long_wins"] += 1
    elif direction == "SHORT":
        s["shorts"] += 1
        if pnl > 0:
            s["short_wins"] += 1

print(f"\n{'Month':<10} {'N':>4} {'WR%':>6} {'Sum%':>8} {'Avg%':>7} {'BigL':>5} "
      f"{'Longs':>7} {'L_WR%':>6} {'Shorts':>7} {'S_WR%':>6}")
for m, s in sorted(monthly.items()):
    avg = s['sum_pnl'] / s['n'] if s['n'] else 0
    l_wr = (s['long_wins'] / s['longs'] * 100) if s['longs'] else 0
    s_wr = (s['short_wins'] / s['shorts'] * 100) if s['shorts'] else 0
    print(f"  {m:<8} {s['n']:>4} {(s['wins']/s['n']*100):>5.1f}% {s['sum_pnl']:>7.2f}% "
          f"{avg:>+6.2f}% {s['big_losers']:>5} "
          f"{s['longs']:>7} {l_wr:>5.1f}% {s['shorts']:>7} {s_wr:>5.1f}%")

# ─────────────────────────────────────────────────────────────────
# 5. DIRECTION BREAKDOWN (all months)
# ─────────────────────────────────────────────────────────────────
print("\n" + "=" * 78)
print("5. DIRECTION BREAKDOWN (all closed trades)")
print("=" * 78)

dir_stats = defaultdict(lambda: {"n": 0, "wins": 0, "sum_pnl": 0.0})
for t in closed:
    d = (t.get("direction") or "?").upper()
    dir_stats[d]["n"] += 1
    pnl = t.get("pnl_pct") or 0
    dir_stats[d]["sum_pnl"] += pnl
    if pnl > 0:
        dir_stats[d]["wins"] += 1

print(f"\n{'Dir':<6} {'N':>4} {'WR%':>6} {'Sum%':>9} {'Avg%':>7}")
for d, s in dir_stats.items():
    wr_d = (s['wins'] / s['n'] * 100) if s['n'] else 0
    avg = s['sum_pnl'] / s['n'] if s['n'] else 0
    print(f"  {d:<4} {s['n']:>4} {wr_d:>5.1f}% {s['sum_pnl']:>+8.2f}% {avg:>+6.2f}%")

# ─────────────────────────────────────────────────────────────────
# 6. SETUP PERFORMANCE
# ─────────────────────────────────────────────────────────────────
print("\n" + "=" * 78)
print("6. SETUP / TRIGGER PERFORMANCE")
print("=" * 78)

setup_stats = defaultdict(lambda: {"n": 0, "wins": 0, "sum_pnl": 0.0, "big_losers": 0})
for t in closed:
    name = t.get("setup_name") or "?"
    setup_stats[name]["n"] += 1
    pnl = t.get("pnl_pct") or 0
    setup_stats[name]["sum_pnl"] += pnl
    if pnl > 0:
        setup_stats[name]["wins"] += 1
    if pnl <= -5:
        setup_stats[name]["big_losers"] += 1

print(f"\n{'Setup':<30} {'N':>4} {'WR%':>6} {'Sum%':>9} {'Avg%':>7} {'BigL':>5}")
for name, s in sorted(setup_stats.items(), key=lambda x: -x[1]["n"]):
    if s["n"] < 2:
        continue
    wr_s = (s['wins'] / s['n'] * 100) if s['n'] else 0
    avg = s['sum_pnl'] / s['n'] if s['n'] else 0
    print(f"  {name:<28} {s['n']:>4} {wr_s:>5.1f}% {s['sum_pnl']:>+8.2f}% {avg:>+6.2f}% {s['big_losers']:>5}")

# ─────────────────────────────────────────────────────────────────
# 7. EXIT REASONS
# ─────────────────────────────────────────────────────────────────
print("\n" + "=" * 78)
print("7. EXIT REASON PERFORMANCE (closed only)")
print("=" * 78)

exit_stats = defaultdict(lambda: {"n": 0, "sum_pnl": 0.0, "wins": 0})
for t in closed:
    r = t.get("exit_reason") or "?"
    exit_stats[r]["n"] += 1
    pnl = t.get("pnl_pct") or 0
    exit_stats[r]["sum_pnl"] += pnl
    if pnl > 0:
        exit_stats[r]["wins"] += 1

print(f"\n{'Exit Reason':<38} {'N':>4} {'Sum%':>9} {'Avg%':>7} {'WR%':>6}")
for r, s in sorted(exit_stats.items(), key=lambda x: -x[1]["n"]):
    avg = s['sum_pnl'] / s['n']
    wr_r = (s['wins'] / s['n'] * 100) if s['n'] else 0
    print(f"  {r:<36} {s['n']:>4} {s['sum_pnl']:>+8.2f}% {avg:>+6.2f}% {wr_r:>5.1f}%")

# ─────────────────────────────────────────────────────────────────
# 8. BEST MONTH DEEP DIVE (August)
# ─────────────────────────────────────────────────────────────────
print("\n" + "=" * 78)
print("8. AUGUST DEEP DIVE (best month: 60% WR, +26.95%)")
print("=" * 78)

aug = [t for t in closed if month_key(t.get("entry_ts")) == "2025-08"]
aug_wins = [t for t in aug if (t.get("pnl_pct") or 0) > 0]
print(f"\nAug winners ({len(aug_wins)}):")
for t in sorted(aug_wins, key=lambda x: -(x.get("pnl_pct") or 0)):
    entry_dt = ts_to_dt(t.get("entry_ts"))
    exit_dt = ts_to_dt(t.get("exit_ts"))
    hold_h = ((exit_dt - entry_dt).total_seconds() / 3600) if (entry_dt and exit_dt) else 0
    print(f"  {t.get('ticker'):6} {t.get('direction'):6}  {entry_dt.strftime('%m-%d %H:%M')}  "
          f"{(t.get('pnl_pct') or 0):>+6.2f}%  hold={hold_h:>5.1f}h  "
          f"setup={t.get('setup_name','?')} grade={t.get('setup_grade','?')} "
          f"exit={t.get('exit_reason','?')}")

# ─────────────────────────────────────────────────────────────────
# 9. OCTOBER AUTOPSY (worst closed month)
# ─────────────────────────────────────────────────────────────────
print("\n" + "=" * 78)
print("9. OCTOBER AUTOPSY (worst month: 46.2% WR, -11.51%)")
print("=" * 78)

oct_trades = [t for t in closed if month_key(t.get("entry_ts")) == "2025-10"]
oct_losers = [t for t in oct_trades if (t.get("pnl_pct") or 0) <= 0]
print(f"\nOct losers ({len(oct_losers)}):")
for t in sorted(oct_losers, key=lambda x: x.get("pnl_pct") or 0):
    entry_dt = ts_to_dt(t.get("entry_ts"))
    exit_dt = ts_to_dt(t.get("exit_ts"))
    hold_h = ((exit_dt - entry_dt).total_seconds() / 3600) if (entry_dt and exit_dt) else 0
    print(f"  {t.get('ticker'):6} {t.get('direction'):6}  {entry_dt.strftime('%m-%d %H:%M')}  "
          f"{(t.get('pnl_pct') or 0):>+6.2f}%  hold={hold_h:>5.1f}h  "
          f"setup={t.get('setup_name','?')} grade={t.get('setup_grade','?')} "
          f"exit={t.get('exit_reason','?')}")
