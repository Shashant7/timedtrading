#!/usr/bin/env python3
"""
V16 Setup-Fitness Analyzer

Reads the setup_snapshot embedded in rank_trace_json on every trade,
joins it with trade outcomes, and surfaces:
  1. Per-setup performance (WR, PnL, PF) for each path
  2. Per-regime setup fitness — WHICH regime suits WHICH setup
  3. Counterfactual analysis — when multiple setups were eligible,
     did we pick the right one?
  4. Setup-eligibility distribution — how often does each setup fire?

Usage:
  python3 scripts/analyze-setup-fitness.py <run_id>
"""
import json
import sys
import urllib.request
import os
from collections import defaultdict, Counter
from datetime import datetime, timezone


def fetch_trades(run_id, api_key):
    url = f"https://timed-trading-ingest.shashant.workers.dev/timed/admin/runs/trades?run_id={run_id}&limit=1000&key={api_key}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read()).get('trades') or []


def load_snapshot(t):
    """Extract setup_snapshot from rank_trace_json."""
    rt = t.get('rank_trace_json')
    if not rt:
        return None
    try:
        parsed = json.loads(rt) if isinstance(rt, str) else rt
        return parsed.get('setup_snapshot')
    except Exception:
        return None


def stats_for(trades, label):
    if not trades:
        return None
    closed = [t for t in trades if t.get('status') in ('WIN', 'LOSS')]
    clean = [t for t in closed if t.get('exit_reason') != 'replay_end_close']
    if not clean:
        return None
    wins = [t for t in clean if (t.get('pnl_pct') or 0) > 0]
    losses = [t for t in clean if (t.get('pnl_pct') or 0) <= 0]
    sw = sum(t.get('pnl_pct') or 0 for t in wins)
    sl = sum(t.get('pnl_pct') or 0 for t in losses)
    pf = sw / abs(sl) if sl else 999
    wr = len(wins) / len(clean) * 100
    return {
        'label': label,
        'n_total': len(trades),
        'n_clean': len(clean),
        'wr': round(wr, 1),
        'pnl': round(sw + sl, 2),
        'pf': round(pf, 2),
        'avg_w': round(sw / len(wins), 2) if wins else 0,
        'avg_l': round(sl / len(losses), 2) if losses else 0,
    }


def main(run_id):
    api_key = os.environ.get('TIMED_API_KEY')
    if not api_key:
        print("TIMED_API_KEY not set", file=sys.stderr)
        sys.exit(1)
    
    print(f"=== Setup Fitness Analysis: {run_id} ===\n")
    trades = fetch_trades(run_id, api_key)
    closed = [t for t in trades if t.get('status') in ('WIN', 'LOSS')]
    print(f"Total trades: {len(trades)} (closed: {len(closed)})\n")

    # ── 1. Per-path performance ──
    print("=" * 70)
    print("1. PER-PATH PERFORMANCE (which setups are profitable?)")
    print("=" * 70)
    by_path = defaultdict(list)
    for t in trades:
        by_path[t.get('entry_path', '?')].append(t)
    
    rows = []
    for path, ts in by_path.items():
        s = stats_for(ts, path)
        if s:
            rows.append(s)
    rows.sort(key=lambda x: -x['pnl'])
    
    print(f"{'Path':<30} {'N':>4} {'Clean':>6} {'WR%':>6} {'PnL%':>9} {'PF':>6} {'AvgW':>7} {'AvgL':>7}")
    print("-" * 80)
    for r in rows:
        print(f"{r['label']:<30} {r['n_total']:>4} {r['n_clean']:>6} {r['wr']:>5.1f}% {r['pnl']:>+8.2f}% {r['pf']:>5.2f} {r['avg_w']:>+6.2f}% {r['avg_l']:>+6.2f}%")

    # ── 2. Per-regime setup fitness ──
    print()
    print("=" * 70)
    print("2. PER-REGIME SETUP FITNESS (which setup works in which regime?)")
    print("=" * 70)
    by_regime_path = defaultdict(list)
    for t in trades:
        snap = load_snapshot(t)
        regime = snap.get('regime_class') if snap else (t.get('regime_class') or 'UNKNOWN')
        path = t.get('entry_path', '?')
        by_regime_path[(regime, path)].append(t)

    regimes = sorted(set(k[0] for k in by_regime_path.keys()))
    paths = sorted(set(k[1] for k in by_regime_path.keys()))
    
    print(f"{'Regime':<22} | " + " | ".join(f"{p[:14]:>14}" for p in paths))
    print("-" * (22 + 17 * len(paths)))
    for regime in regimes:
        cells = []
        for path in paths:
            ts = by_regime_path.get((regime, path), [])
            if not ts:
                cells.append(f"{'--':>14}")
                continue
            s = stats_for(ts, '')
            if s:
                cells.append(f"{s['wr']:>4.0f}%/{s['pnl']:>+5.1f}%/{s['n_clean']}")
            else:
                cells.append(f"{'--':>14}")
        print(f"{regime[:21]:<22} | " + " | ".join(cells))
    print(" (cell format: WR / PnL / count)")

    # ── 3. Setup eligibility distribution ──
    print()
    print("=" * 70)
    print("3. SETUP ELIGIBILITY — how often does each setup fire?")
    print("=" * 70)
    fired = Counter()
    eligible = Counter()
    for t in trades:
        snap = load_snapshot(t)
        if not snap: continue
        for key in ('ath_breakout', 'range_reversal', 'gap_reversal', 'n_test_support', 'index_etf_swing'):
            d = snap.get(key)
            if d and d.get('fired'):
                fired[key] += 1
            elif d:
                # Was eligible (data present) but didn't fire
                eligible[key] += 1
    
    print(f"{'Setup':<20} {'Fired':>6} {'Eligible*':>10}")
    print("-" * 40)
    for key in ('ath_breakout', 'range_reversal', 'gap_reversal', 'n_test_support', 'index_etf_swing'):
        print(f"{key:<20} {fired[key]:>6} {eligible[key]:>10}")
    print("(*Eligible = trigger evaluated but didn't fire)")

    # ── 4. Counterfactual: when multiple setups COULD have fired, which won? ──
    print()
    print("=" * 70)
    print("4. COUNTERFACTUAL — selected vs alternatives")
    print("=" * 70)
    multi_eligible = []
    for t in trades:
        snap = load_snapshot(t)
        if not snap: continue
        n_could = sum(1 for k in ('ath_breakout','range_reversal','gap_reversal','n_test_support','index_etf_swing')
                      if snap.get(k) and (snap[k].get('fired') or snap[k].get('long_setup_active') or snap[k].get('short_setup_active')))
        if n_could >= 2:
            multi_eligible.append((t, n_could))
    print(f"Trades where ≥2 setups were eligible: {len(multi_eligible)} / {len(trades)}")
    if multi_eligible:
        print("\nSelected path performance vs sample:")
        path_perf = defaultdict(list)
        for t, n in multi_eligible:
            path_perf[t.get('entry_path','?')].append(t)
        for path, ts in path_perf.items():
            s = stats_for(ts, path)
            if s:
                print(f"  {path:<30} N={s['n_clean']:<3} WR={s['wr']:>4.1f}% PnL={s['pnl']:>+6.2f}% PF={s['pf']:>5.2f}")

    # ── 5. Bull-stack vs not bull-stack ──
    print()
    print("=" * 70)
    print("5. BULL-STACK CONTEXT — does daily structure affect setup fitness?")
    print("=" * 70)
    by_stack_path = defaultdict(list)
    for t in trades:
        snap = load_snapshot(t)
        bs = snap.get('bull_stack') if snap else None
        path = t.get('entry_path', '?')
        ctx = 'bull_stack' if bs else ('bear_stack' if snap and snap.get('bear_stack') else 'mixed')
        by_stack_path[(ctx, path)].append(t)
    contexts = ['bull_stack', 'mixed', 'bear_stack']
    print(f"{'Path':<30} | " + " | ".join(f"{c:>20}" for c in contexts))
    print("-" * (30 + 23 * len(contexts)))
    paths_in_table = sorted(set(k[1] for k in by_stack_path.keys()))
    for path in paths_in_table:
        cells = []
        for ctx in contexts:
            ts = by_stack_path.get((ctx, path), [])
            s = stats_for(ts, '') if ts else None
            if s:
                cells.append(f"WR{s['wr']:>3.0f}% PnL{s['pnl']:>+5.1f}% N{s['n_clean']}")
            else:
                cells.append(f"{'--':>20}")
        print(f"{path:<30} | " + " | ".join(cells))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/analyze-setup-fitness.py <run_id>", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1])
