#!/usr/bin/env python3
"""
scripts/phase-g-golden-gate-analysis.py

Golden Gate completion probability analysis.

For every trade, reconstruct the TIMING of each ATR Fibonacci level crossing
(entry → 0.236 → 0.382 → 0.618 → 1.0 → 1.236 → 1.618 → 2.0 → 2.618 → 3.0)
on both the Day (Daily ATR) and Multiday (Weekly ATR) horizons.

The key question: given price CROSSED +0.382, what is the conditional
probability that it then reaches +0.618? And if it crossed -0.382, what
is the conditional probability of reaching -0.618?

Outputs:
  data/trade-analysis/<run_id>/forensics/golden-gate/
    completion-matrix.md       conditional probability tables
    completion-matrix.json     machine-readable
    timing-distributions.md    time-to-level distributions
    per-trade-crossings.json   raw crossings per trade

Usage:
  python3 scripts/phase-g-golden-gate-analysis.py --run-id=phase-f-continuous-v6b
"""

import argparse
import json
import os
import sys
import time
import urllib.request
from collections import defaultdict, Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/workspace')
API_BASE = os.environ.get("API_BASE", "https://timed-trading-ingest.shashant.workers.dev")
API_KEY = os.environ.get("TIMED_API_KEY") or "AwesomeSauce"  # pragma: allowlist secret

COHORTS = {
    'Index_ETF': {'SPY', 'QQQ', 'IWM'},
    'MegaCap': {'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA'},
    'Industrial': {'ETN', 'FIX', 'IESC', 'MTZ', 'PH', 'SWK'},
    'Speculative': {'AGQ', 'GRNY', 'RIOT', 'SGI'},
    'Semi': {'CDNS', 'ON', 'HUBS'},
    'Sector_ETF': {'XLY'},
}

# Fib ladder we track (both favorable and adverse directions)
FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.236, 1.618, 2.0, 2.618, 3.0]

def cohort_of(ticker):
    for name, members in COHORTS.items():
        if ticker in members:
            return name
    return 'Other'

def fetch_trail_payload(ticker, since_ts, until_ts, limit=3000):
    url = (f"{API_BASE}/timed/admin/trail-payload"
           f"?ticker={ticker}&since={since_ts}&until={until_ts}&limit={limit}&key={API_KEY}")
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'gg-analysis/1.0'})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read()).get('rows') or []
        except Exception as e:
            if attempt == 2:
                raise
            time.sleep(1 + attempt)
    return []

def fetch_trades(run_id):
    p = ROOT / 'data' / 'trade-analysis' / run_id / 'trades.json'
    return json.loads(p.read_text()).get('trades') or []

# ---------------------------------------------------------------------
# Core crossing detection
# ---------------------------------------------------------------------

def detect_crossings(entry_price, direction, trail_rows, entry_ts, exit_ts, atr_levels_at_entry):
    """
    For a given trade and its trail rows, detect when each fib ratio was first
    crossed in both favorable and adverse directions, for each horizon.

    Returns:
      {
        'day':   { 'favorable': {0.236: {ts, price, elapsed_min}, ...}, 'adverse': {...} },
        'week':  { same shape },
        'month': { same shape },
      }

    Only counts crossings BETWEEN entry_ts and exit_ts. Also tracks whether
    each level was "reached and held" (closed past it) vs "touched and rejected"
    (wicked but didn't close past).
    """
    result = {}
    if not entry_price or not atr_levels_at_entry:
        return result
    # Filter to trade window
    in_window = [r for r in trail_rows
                 if entry_ts <= (r.get('ts') or 0) <= (exit_ts or entry_ts + 30*86400*1000)]
    if not in_window:
        return result
    in_window.sort(key=lambda r: r.get('ts') or 0)

    for horizon in ['day', 'week', 'month']:
        al = atr_levels_at_entry.get(horizon) or {}
        pc = al.get('prevClose')
        atr = al.get('atr')
        if not (pc and atr and atr > 0):
            continue
        # For LONG: favorable = UP from prev_close, adverse = DOWN
        # For SHORT: favorable = DOWN from prev_close, adverse = UP
        horizon_result = {'favorable': {}, 'adverse': {}}
        for ratio in FIB_RATIOS:
            up_price = pc + ratio * atr
            dn_price = pc - ratio * atr
            # First-touch timestamps
            first_up_ts = None
            first_dn_ts = None
            for r in in_window:
                px = r.get('price')
                if not px:
                    continue
                ts = r.get('ts')
                if first_up_ts is None and px >= up_price:
                    first_up_ts = ts
                if first_dn_ts is None and px <= dn_price:
                    first_dn_ts = ts
                if first_up_ts and first_dn_ts:
                    break
            fav_key = first_up_ts if direction == 'LONG' else first_dn_ts
            adv_key = first_dn_ts if direction == 'LONG' else first_up_ts
            if fav_key:
                horizon_result['favorable'][ratio] = {
                    'ts': fav_key,
                    'elapsed_min': (fav_key - entry_ts) / 60000 if fav_key else None,
                }
            if adv_key:
                horizon_result['adverse'][ratio] = {
                    'ts': adv_key,
                    'elapsed_min': (adv_key - entry_ts) / 60000 if adv_key else None,
                }
        if horizon_result['favorable'] or horizon_result['adverse']:
            result[horizon] = horizon_result
    return result

# ---------------------------------------------------------------------
# Conditional probability calculation
# ---------------------------------------------------------------------

def compute_completion_matrix(per_trade_crossings):
    """
    Given crossings for all trades, build:
      P(reached B | reached A) for each (A, B) pair of fib ratios,
      per horizon, per direction (favorable/adverse), per cohort.
    """
    # Flat dict keyed by tuple; value is {'reached': N, 'total': N}
    matrix = {}
    def bump(key, reached):
        if key not in matrix:
            matrix[key] = {'reached': 0, 'total': 0}
        matrix[key]['total'] += 1
        if reached:
            matrix[key]['reached'] += 1

    for pt in per_trade_crossings:
        cohort = pt.get('cohort')
        for horizon in ['day', 'week', 'month']:
            for side in ['favorable', 'adverse']:
                crossings = pt.get('crossings', {}).get(horizon, {}).get(side, {})
                if not crossings:
                    continue
                # Crossings keys are floats — stored as JSON numbers. Normalize.
                reached_ratios = set()
                for k in crossings.keys():
                    try:
                        reached_ratios.add(float(k))
                    except (TypeError, ValueError):
                        pass
                # For each pair (A, B) where A < B, check if A was reached, and if so, did B reach?
                for i, a in enumerate(FIB_RATIOS):
                    if a not in reached_ratios:
                        continue
                    for b in FIB_RATIOS[i+1:]:
                        b_reached = b in reached_ratios
                        bump((cohort, horizon, side, a, b), b_reached)
                        bump(('ALL', horizon, side, a, b), b_reached)
    return matrix

# ---------------------------------------------------------------------
# Time-of-day / day-of-week analysis
# ---------------------------------------------------------------------

def bucket_et_hour(ts_ms):
    """Return ET hour bucket (9=RTH open, 10, 11, 12, 13, 14, 15=last hour)."""
    dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    # NYSE RTH is UTC 13:30-20:00 (14:30-21:00 DST) — approximate ET as UTC - 5 (or -4 in DST)
    # Simple: March-Oct is EDT (UTC-4); Nov-Feb is EST (UTC-5)
    month = dt.month
    et_offset = 4 if 3 <= month <= 10 else 5
    et_hour = (dt.hour - et_offset) % 24
    return et_hour

def bucket_dow(ts_ms):
    dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][dt.weekday()]

def analyze_timing(per_trade_crossings):
    """For each cohort x horizon x side, bucket the crossing TS by ET hour and day-of-week."""
    timing = defaultdict(lambda: {'by_hour': Counter(), 'by_dow': Counter(), 'elapsed_mins': []})
    for pt in per_trade_crossings:
        cohort = pt.get('cohort')
        for horizon in ['day', 'week', 'month']:
            for side in ['favorable', 'adverse']:
                crossings = pt.get('crossings', {}).get(horizon, {}).get(side, {})
                for ratio, info in crossings.items():
                    ts = info.get('ts')
                    elapsed = info.get('elapsed_min')
                    if ts is None:
                        continue
                    hour = bucket_et_hour(ts)
                    dow = bucket_dow(ts)
                    key = (cohort, horizon, side, ratio)
                    timing[key]['by_hour'][hour] += 1
                    timing[key]['by_dow'][dow] += 1
                    if elapsed is not None:
                        timing[key]['elapsed_mins'].append(elapsed)
    return timing

# ---------------------------------------------------------------------
# Report writers
# ---------------------------------------------------------------------

def fmt_pct(reached, total):
    if total == 0:
        return "—"
    return f"{reached/total*100:.1f}%"

def write_completion_matrix_md(matrix, out_path):
    lines = []
    lines.append("# Golden Gate Completion Probability Matrix\n")
    lines.append("For every trade, once price crossed fib level **A**, what % of the time did it continue to cross **B**?")
    lines.append("")
    lines.append("**Shown per horizon** (Day = Daily ATR, Week = Weekly ATR, Month = Monthly ATR)")
    lines.append("**Side**: `favorable` = direction of trade was profitable, `adverse` = trade got stopped out direction")
    lines.append("")

    # Build tables per cohort+horizon+side
    # Key: (cohort, horizon, side, a, b) → {reached, total}
    KEY_PAIRS = [(0.236, 0.382), (0.236, 0.618), (0.236, 1.0),
                 (0.382, 0.618), (0.382, 1.0), (0.382, 1.236),
                 (0.5, 0.618), (0.5, 1.0),
                 (0.618, 1.0), (0.618, 1.236), (0.618, 1.618),
                 (1.0, 1.236), (1.0, 1.618), (1.0, 2.0)]

    for cohort in ['ALL', 'Index_ETF', 'MegaCap', 'Industrial', 'Speculative', 'Semi']:
        cohort_has_data = any(matrix.get((cohort, h, s, a, b), {}).get('total', 0) > 0
                              for h in ['day','week','month']
                              for s in ['favorable','adverse']
                              for a, b in KEY_PAIRS)
        if not cohort_has_data:
            continue
        lines.append(f"## {cohort}")
        lines.append("")
        for horizon in ['day', 'week', 'month']:
            lines.append(f"### {horizon}")
            lines.append("")
            lines.append("| A → B | Favorable n | Favorable P(B\\|A) | Adverse n | Adverse P(B\\|A) |")
            lines.append("|---|---:|---:|---:|---:|")
            for a, b in KEY_PAIRS:
                fav = matrix.get((cohort, horizon, 'favorable', a, b), {'reached':0,'total':0})
                adv = matrix.get((cohort, horizon, 'adverse', a, b), {'reached':0,'total':0})
                # Skip if both zero
                if fav['total'] == 0 and adv['total'] == 0:
                    continue
                lines.append(f"| {a} → {b} | {fav['total']} | {fmt_pct(fav['reached'], fav['total'])} | {adv['total']} | {fmt_pct(adv['reached'], adv['total'])} |")
            lines.append("")
    out_path.write_text('\n'.join(lines))

def write_timing_md(timing, out_path):
    lines = []
    lines.append("# Golden Gate Timing Distributions\n")
    lines.append("When (ET hour) and which day-of-week does each fib ratio get crossed?")
    lines.append("Also: how long (market minutes) elapsed from entry to crossing?")
    lines.append("")
    lines.append("Focus on the +0.382 / −0.382 levels (user's question): these are the 'commit-to-hold' threshold.")
    lines.append("")

    # Focus on the most-watched ratios across ALL and per cohort
    for cohort in ['ALL', 'Index_ETF', 'MegaCap', 'Industrial', 'Speculative', 'Semi']:
        for horizon in ['day', 'week']:
            for side in ['favorable', 'adverse']:
                for ratio in [0.236, 0.382, 0.618, 1.0]:
                    # We don't have 'ALL' key in timing — it aggregates per-trade, so we need to do it
                    key = (cohort, horizon, side, ratio)
                    info = timing.get(key)
                    if not info or info['by_hour'].total() == 0:
                        continue
                    lines.append(f"## {cohort} — {horizon} / {side} / {ratio}")
                    lines.append("")
                    lines.append(f"**Total crossings**: {info['by_hour'].total()}")
                    # ET hour distribution
                    hour_entries = sorted(info['by_hour'].items())
                    hour_line = " | ".join(f"{h:02d}:{info['by_hour'][h]}" for h, _ in hour_entries)
                    lines.append(f"- ET-hour distribution: {hour_line}")
                    # DOW
                    dow_order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
                    dow_line = " | ".join(f"{d}:{info['by_dow'].get(d,0)}" for d in dow_order)
                    lines.append(f"- Day-of-week: {dow_line}")
                    # elapsed_mins summary
                    em = info['elapsed_mins']
                    if em:
                        em_sorted = sorted(em)
                        median = em_sorted[len(em_sorted)//2]
                        q25 = em_sorted[len(em_sorted)//4]
                        q75 = em_sorted[len(em_sorted)*3//4]
                        lines.append(f"- Elapsed-min from entry: median={median:.0f} | q25={q25:.0f} | q75={q75:.0f} | max={max(em):.0f}")
                    lines.append("")
    out_path.write_text('\n'.join(lines))

# ---------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--run-id', required=True)
    p.add_argument('--sample', type=int, default=0)
    args = p.parse_args()

    run_id = args.run_id
    trades = fetch_trades(run_id)
    if args.sample > 0:
        trades = trades[:args.sample]
    print(f'Analyzing Golden Gate crossings for {len(trades)} trades in {run_id}...')

    # For each trade, fetch trail and detect crossings
    per_trade = []
    t0 = time.time()
    for i, t in enumerate(trades):
        ticker = t.get('ticker')
        entry_ts = t.get('entry_ts')
        exit_ts = t.get('exit_ts')
        entry_price = float(t.get('entry_price') or 0)
        direction = t.get('direction', 'LONG')
        if not (entry_ts and entry_price):
            continue
        # Pull trail rows
        since = entry_ts - 3600000
        until = (exit_ts or entry_ts) + 5*86400*1000
        try:
            rows = fetch_trail_payload(ticker, since, until, limit=3000)
        except Exception as e:
            print(f'  fetch fail {ticker}: {e}')
            continue
        if not rows:
            continue
        # Get ATR levels from the bar closest to entry
        entry_bar = min(rows, key=lambda r: abs((r.get('ts') or 0) - entry_ts))
        atr_levels = (entry_bar.get('payload') or {}).get('atr_levels') or {}
        # Detect crossings
        crossings = detect_crossings(entry_price, direction, rows, entry_ts, exit_ts, atr_levels)
        per_trade.append({
            'trade_id': t.get('trade_id'),
            'ticker': ticker,
            'cohort': cohort_of(ticker),
            'direction': direction,
            'entry_ts': entry_ts,
            'exit_ts': exit_ts,
            'pnl_pct': t.get('pnl_pct'),
            'crossings': crossings,
        })
        if (i+1) % 20 == 0:
            dt = time.time() - t0
            rate = (i+1)/max(1,dt)
            remaining = (len(trades)-i-1)/max(1,rate)
            print(f'  {i+1}/{len(trades)} ({rate:.1f}/s, ~{remaining:.0f}s remaining)')

    # Output paths
    out_dir = ROOT / 'data' / 'trade-analysis' / run_id / 'forensics' / 'golden-gate'
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'per-trade-crossings.json').write_text(json.dumps(per_trade, indent=2, default=str))

    # Completion matrix
    print('Computing completion matrix...')
    matrix = compute_completion_matrix(per_trade)
    # Convert to list for JSON
    matrix_list = [{'cohort': k[0], 'horizon': k[1], 'side': k[2], 'from': k[3], 'to': k[4],
                    'reached': v['reached'], 'total': v['total'],
                    'prob': v['reached']/v['total'] if v['total'] else None}
                   for k, v in matrix.items()]
    (out_dir / 'completion-matrix.json').write_text(json.dumps(matrix_list, indent=2))
    write_completion_matrix_md(matrix, out_dir / 'completion-matrix.md')

    # Timing distribution
    print('Computing timing distributions...')
    timing = analyze_timing(per_trade)
    # Convert to JSON-safe form
    timing_list = [{'cohort': k[0], 'horizon': k[1], 'side': k[2], 'ratio': k[3],
                    'by_hour': dict(v['by_hour']), 'by_dow': dict(v['by_dow']),
                    'elapsed_mins_count': len(v['elapsed_mins']),
                    'elapsed_mins_median': sorted(v['elapsed_mins'])[len(v['elapsed_mins'])//2]
                        if v['elapsed_mins'] else None}
                   for k, v in timing.items()]
    (out_dir / 'timing.json').write_text(json.dumps(timing_list, indent=2))
    write_timing_md(timing, out_dir / 'timing-distributions.md')

    print(f'\nDone. Outputs:')
    print(f'  {out_dir}/completion-matrix.md')
    print(f'  {out_dir}/timing-distributions.md')
    print(f'  {out_dir}/per-trade-crossings.json')

if __name__ == '__main__':
    main()
