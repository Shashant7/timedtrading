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

    # ── 6. VIX regime ──
    print()
    print("=" * 70)
    print("6. VIX REGIME — does volatility regime matter per setup?")
    print("=" * 70)
    by_vix_path = defaultdict(list)
    for t in trades:
        snap = load_snapshot(t)
        if not snap: continue
        vix_state = (snap.get('market_internals') or {}).get('vix_state') or 'unknown'
        path = t.get('entry_path', '?')
        by_vix_path[(vix_state, path)].append(t)
    vix_states = ['low_fear', 'normal', 'elevated', 'fear', 'unknown']
    print(f"{'Path':<30} | " + " | ".join(f"{v:>16}" for v in vix_states))
    print("-" * (30 + 19 * len(vix_states)))
    paths_in_v = sorted(set(k[1] for k in by_vix_path.keys()))
    for path in paths_in_v:
        cells = []
        for vs in vix_states:
            ts = by_vix_path.get((vs, path), [])
            s = stats_for(ts, '') if ts else None
            cells.append(f"WR{s['wr']:>3.0f}% N{s['n_clean']}" if s else f"{'--':>16}")
        print(f"{path[:29]:<30} | " + " | ".join(cells))

    # ── 7. Sector rotation ──
    print()
    print("=" * 70)
    print("7. SECTOR ROTATION — risk_on / risk_off / balanced")
    print("=" * 70)
    by_rot_path = defaultdict(list)
    for t in trades:
        snap = load_snapshot(t)
        if not snap: continue
        rot = (snap.get('market_internals') or {}).get('sector_rotation') or 'unknown'
        path = t.get('entry_path', '?')
        by_rot_path[(rot, path)].append(t)
    rots = ['risk_on', 'balanced', 'risk_off', 'unknown']
    print(f"{'Path':<30} | " + " | ".join(f"{r:>16}" for r in rots))
    print("-" * (30 + 19 * len(rots)))
    paths_in_r = sorted(set(k[1] for k in by_rot_path.keys()))
    for path in paths_in_r:
        cells = []
        for r in rots:
            ts = by_rot_path.get((r, path), [])
            s = stats_for(ts, '') if ts else None
            cells.append(f"WR{s['wr']:>3.0f}% N{s['n_clean']}" if s else f"{'--':>16}")
        print(f"{path[:29]:<30} | " + " | ".join(cells))

    # ── 8. Cross-asset correlation ──
    print()
    print("=" * 70)
    print("8. CROSS-ASSET BACKDROP — are winners clustered around USD/Gold/Oil?")
    print("=" * 70)
    closed_with_snap = [(t, load_snapshot(t)) for t in trades if load_snapshot(t)]
    closed_with_snap = [(t, s) for t, s in closed_with_snap if t.get('status') in ('WIN','LOSS')]
    if closed_with_snap:
        def avg(lst): return round(sum(lst)/len(lst), 3) if lst else None
        def by_outcome(field):
            wins = []
            losses = []
            for t, s in closed_with_snap:
                ca = s.get('cross_asset') or {}
                v = ca.get(field)
                if v is None: continue
                if (t.get('pnl_pct') or 0) > 0: wins.append(v)
                else: losses.append(v)
            return avg(wins), avg(losses), len(wins), len(losses)
        print(f"{'Asset':<14} {'Wins avg %':>12} {'Losses avg %':>14} {'Spread':>10}")
        print("-" * 55)
        for field in ('gold_pct','silver_pct','oil_pct','dollar_pct','energy_pct','btc_pct'):
            w, l, nw, nl = by_outcome(field)
            spread = (w - l) if (w is not None and l is not None) else None
            w_s = f"{w:>+8.2f}% (N{nw})" if w is not None else f"{'--':>12}"
            l_s = f"{l:>+8.2f}% (N{nl})" if l is not None else f"{'--':>14}"
            sp_s = f"{spread:>+8.2f}%" if spread is not None else f"{'--':>10}"
            print(f"{field:<14} {w_s} {l_s} {sp_s}")
    else:
        print("(no cross-asset data on closed trades)")

    # ── 9. Event proximity ──
    print()
    print("=" * 70)
    print("9. EVENT PROXIMITY — entries near earnings/macro")
    print("=" * 70)
    near_buckets = defaultdict(list)  # (bucket_label) -> list of trades
    for t in trades:
        snap = load_snapshot(t)
        if not snap: continue
        e = snap.get('upcoming_risk_event')
        if not e:
            bucket = 'no_event'
        else:
            h = e.get('hours_to_event')
            etype = e.get('event_type', '?')
            if h is None: bucket = f'{etype}_unknown_h'
            elif h < 24: bucket = f'{etype}_<24h'
            elif h < 72: bucket = f'{etype}_24-72h'
            elif h < 168: bucket = f'{etype}_3-7d'
            else: bucket = f'{etype}_>7d'
        near_buckets[bucket].append(t)
    rows = []
    for bucket, ts in near_buckets.items():
        s = stats_for(ts, bucket)
        if s: rows.append(s)
    rows.sort(key=lambda x: x['label'])
    print(f"{'Event proximity':<25} {'N':>4} {'WR%':>6} {'PnL%':>9} {'PF':>6}")
    print("-" * 55)
    for r in rows:
        print(f"{r['label']:<25} {r['n_clean']:>4} {r['wr']:>5.1f}% {r['pnl']:>+8.2f}% {r['pf']:>5.2f}")

    # ── 10. R:R distribution ──
    print()
    print("=" * 70)
    print("10. R:R AT ENTRY — is higher R:R correlated with better outcomes?")
    print("=" * 70)
    rr_buckets = defaultdict(list)
    for t in trades:
        snap = load_snapshot(t)
        if not snap: continue
        rr = snap.get('rr')
        if rr is None: bucket = 'unknown'
        elif rr < 1.5: bucket = '<1.5'
        elif rr < 2.0: bucket = '1.5-2.0'
        elif rr < 3.0: bucket = '2.0-3.0'
        elif rr < 5.0: bucket = '3.0-5.0'
        else: bucket = '>=5.0'
        rr_buckets[bucket].append(t)
    print(f"{'R:R bucket':<14} {'N':>4} {'WR%':>6} {'PnL%':>9} {'PF':>6} {'AvgW':>7} {'AvgL':>7}")
    print("-" * 60)
    rows = [stats_for(ts, b) for b, ts in rr_buckets.items()]
    rows = [r for r in rows if r]
    order = ['<1.5','1.5-2.0','2.0-3.0','3.0-5.0','>=5.0','unknown']
    rows.sort(key=lambda x: order.index(x['label']) if x['label'] in order else 99)
    for r in rows:
        print(f"{r['label']:<14} {r['n_clean']:>4} {r['wr']:>5.1f}% {r['pnl']:>+8.2f}% {r['pf']:>5.2f} {r['avg_w']:>+6.2f}% {r['avg_l']:>+6.2f}%")

    # ── 11. MTF concordance ──
    print()
    print("=" * 70)
    print("11. MTF CONCORDANCE — do aligned multi-TF stDir improve outcomes?")
    print("=" * 70)
    by_concord = defaultdict(list)
    for t in trades:
        snap = load_snapshot(t)
        if not snap: continue
        sd = snap.get('st_dir') or {}
        direction = (t.get('direction') or 'LONG').upper()
        wanted = 1 if direction == 'LONG' else -1
        sigs = [sd.get('m30'), sd.get('h1'), sd.get('h4'), sd.get('D')]
        sigs = [s for s in sigs if s is not None]
        aligned = sum(1 for s in sigs if s == wanted)
        total = len(sigs)
        if total == 0:
            bucket = 'unknown'
        else:
            ratio = aligned / total
            if ratio == 1.0: bucket = 'all_aligned'
            elif ratio >= 0.75: bucket = 'mostly_aligned'
            elif ratio >= 0.5: bucket = 'half_aligned'
            else: bucket = 'misaligned'
        by_concord[bucket].append(t)
    rows = [stats_for(ts, b) for b, ts in by_concord.items()]
    rows = [r for r in rows if r]
    order = ['all_aligned','mostly_aligned','half_aligned','misaligned','unknown']
    rows.sort(key=lambda x: order.index(x['label']) if x['label'] in order else 99)
    print(f"{'MTF concordance':<20} {'N':>4} {'WR%':>6} {'PnL%':>9} {'PF':>6}")
    print("-" * 50)
    for r in rows:
        print(f"{r['label']:<20} {r['n_clean']:>4} {r['wr']:>5.1f}% {r['pnl']:>+8.2f}% {r['pf']:>5.2f}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/analyze-setup-fitness.py <run_id>", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1])
