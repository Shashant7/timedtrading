#!/usr/bin/env python3
"""
scripts/phase-g-trade-forensics.py

Per-trade forensic analysis with ATR Level pattern discovery.

For every trade in a run_id, reconstructs:
  1. Entry context (MTF indicators + ATR Levels at entry bar)
  2. Trade lifecycle (MFE/MAE timeline, first-peak indicator, trim events)
  3. Exit + counterfactual (MFE-vs-exit gap, which ATR Level capped the move)
  4. Classification tags (clean_winner / leaky_winner / fakeout / chop_scratch / etc.)
  5. ATR Level pattern discovery (support/resistance/peak/exhaustion)

Outputs:
  data/trade-analysis/<run_id>/forensics/
    summary.md              operator-readable report
    summary.json            machine-readable totals
    cohort-rollup.md        cohort x classification rollup
    atr-patterns.md         ATR Level pattern findings per cohort
    per-trade/<trade_id>.json   drill-down per trade

Usage:
  python3 scripts/phase-g-trade-forensics.py --run-id=phase-f-continuous-v6b
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/workspace')
API_BASE = os.environ.get("API_BASE", "https://timed-trading-ingest.shashant.workers.dev")
API_KEY = os.environ.get("TIMED_API_KEY") or "AwesomeSauce"  # pragma: allowlist secret

ETF = {'SPY', 'QQQ', 'IWM'}
MEGACAP = {'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA'}
INDUSTRIAL = {'ETN', 'FIX', 'IESC', 'MTZ', 'PH', 'SWK'}
SPECULATIVE = {'AGQ', 'GRNY', 'RIOT', 'SGI'}
SEMI = {'CDNS', 'ON', 'HUBS'}
SECTOR_ETF = {'XLY'}

def cohort_of(ticker):
    if ticker in ETF: return 'Index_ETF'
    if ticker in MEGACAP: return 'MegaCap'
    if ticker in INDUSTRIAL: return 'Industrial'
    if ticker in SPECULATIVE: return 'Speculative'
    if ticker in SEMI: return 'Semi'
    if ticker in SECTOR_ETF: return 'Sector_ETF'
    return 'Other'

def fetch_json(url, retries=3, timeout=60):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'phase-g-forensics/1.0'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except Exception as e:
            if i == retries - 1:
                raise
            time.sleep(1 + i)

def fetch_trail_payload(ticker, since_ts, until_ts, limit=3000):
    url = (f"{API_BASE}/timed/admin/trail-payload"
           f"?ticker={ticker}&since={since_ts}&until={until_ts}&limit={limit}&key={API_KEY}")
    d = fetch_json(url, retries=2, timeout=120)
    return d.get('rows') or []

# ---------------------------------------------------------------------
# Per-trade analysis
# ---------------------------------------------------------------------

def analyze_trade(trade, candle_cache=None):
    """Return the forensic record for a single trade."""
    ticker = trade.get('ticker')
    direction = trade.get('direction', 'LONG')
    entry_ts = trade.get('entry_ts')
    exit_ts = trade.get('exit_ts')
    entry_price = float(trade.get('entry_price') or 0)
    exit_price = float(trade.get('exit_price') or 0)
    pnl_pct = float(trade.get('pnl_pct') or 0)

    rec = {
        'trade_id': trade.get('trade_id'),
        'ticker': ticker,
        'cohort': cohort_of(ticker),
        'direction': direction,
        'entry_ts': entry_ts,
        'exit_ts': exit_ts,
        'entry_price': entry_price,
        'exit_price': exit_price,
        'pnl_pct': pnl_pct,
        'status': trade.get('status'),
        'exit_reason': trade.get('exit_reason'),
        'rank': trade.get('rank'),
        'rr': trade.get('rr'),
        'entry_path': trade.get('entry_path'),
        'hold_hours': None,
    }
    if entry_ts and exit_ts:
        rec['hold_hours'] = (exit_ts - entry_ts) / 3600000

    # Pull trail payloads from entry - 1h through exit + 3 trading days
    # 3 trading days ≈ 5 calendar days given weekends
    if not entry_ts:
        rec['forensics_available'] = False
        return rec
    since = entry_ts - 3600 * 1000
    until = (exit_ts or entry_ts) + 5 * 86400 * 1000
    try:
        rows = fetch_trail_payload(ticker, since, until, limit=3000)
    except Exception as e:
        rec['forensics_available'] = False
        rec['fetch_error'] = str(e)[:200]
        return rec
    if not rows:
        rec['forensics_available'] = False
        return rec
    rec['forensics_available'] = True
    rec['trail_rows'] = len(rows)

    # Find the entry bar (closest to entry_ts)
    entry_bar = min(rows, key=lambda r: abs((r.get('ts') or 0) - entry_ts))
    ep = entry_bar.get('payload') or {}
    rec['entry_context'] = summarize_bar_context(ep, direction)

    # MFE / MAE timeline within trade window
    mfe_pct = 0
    mae_pct = 0
    mfe_bar = None
    mae_bar = None
    trade_rows = [r for r in rows if entry_ts <= (r.get('ts') or 0) <= (exit_ts or entry_ts + 14*86400*1000)]
    for r in trade_rows:
        px = r.get('price')
        if not (entry_price > 0 and px):
            continue
        if direction == 'LONG':
            pct = (px - entry_price) / entry_price * 100
        else:
            pct = (entry_price - px) / entry_price * 100
        if pct > mfe_pct:
            mfe_pct = pct
            mfe_bar = r
        if pct < mae_pct:
            mae_pct = pct
            mae_bar = r
    rec['mfe_pct'] = round(mfe_pct, 2)
    rec['mae_pct'] = round(mae_pct, 2)
    rec['mfe_ts'] = mfe_bar.get('ts') if mfe_bar else None
    rec['mae_ts'] = mae_bar.get('ts') if mae_bar else None
    rec['mfe_exit_gap_pct'] = round(mfe_pct - pnl_pct, 2)

    # ATR Level reach during the trade — which fib levels did price reach?
    if entry_bar.get('payload') and entry_bar['payload'].get('atr_levels'):
        atr = entry_bar['payload']['atr_levels']
        # For each horizon, which +/- level did price reach?
        rec['atr_reach'] = analyze_atr_reach(entry_price, mfe_pct, mae_pct, direction, atr)

    # Classification tags
    rec['tags'] = classify_trade(rec)

    # Post-exit price (3 trading days after exit): did move continue?
    if exit_ts:
        post_rows = [r for r in rows if (r.get('ts') or 0) > exit_ts]
        if post_rows:
            post_rows.sort(key=lambda r: r.get('ts'))
            # Find bar ~3 trading days after (5 calendar = 432000000 ms)
            target_ts = exit_ts + 3*86400*1000
            post_bar = min(post_rows, key=lambda r: abs(r.get('ts') - target_ts))
            pp = post_bar.get('price')
            if pp and entry_price > 0:
                if direction == 'LONG':
                    continuation_pct = (pp - entry_price) / entry_price * 100 - pnl_pct
                else:
                    continuation_pct = -((pp - entry_price) / entry_price * 100) - pnl_pct
                rec['post_exit_3d_continuation_pct'] = round(continuation_pct, 2)

    return rec

def summarize_bar_context(payload, direction):
    """Extract the relevant MTF context at a single bar."""
    if not payload:
        return None
    out = {
        'score': payload.get('score'),
        'rank': payload.get('rank'),
        'state': payload.get('state'),
        'kanban_stage': payload.get('kanban_stage'),
        'entry_path': payload.get('entry_path'),
        'regime_class': payload.get('regime_class'),
        'regime_score': payload.get('regime_score'),
        'ema_regime_daily': payload.get('ema_regime_daily'),
        'ema_regime_4h': payload.get('ema_regime_4h'),
        'ema_regime_1h': payload.get('ema_regime_1h'),
        'pdz_zone_D': payload.get('pdz_zone_D'),
        'pdz_pct_D': payload.get('pdz_pct_D'),
        'st_bars_since_flip_D': payload.get('st_bars_since_flip_D'),
    }
    # Daily structure (the key structural info)
    ds = payload.get('daily_structure') or {}
    out['daily'] = {
        'px': ds.get('px'),
        'e21': ds.get('e21'),
        'e48': ds.get('e48'),
        'e200': ds.get('e200'),
        'pct_above_e21': ds.get('pct_above_e21'),
        'pct_above_e48': ds.get('pct_above_e48'),
        'pct_above_e200': ds.get('pct_above_e200'),
        'e21_slope_5d_pct': ds.get('e21_slope_5d_pct'),
        'e48_slope_10d_pct': ds.get('e48_slope_10d_pct'),
        'bull_stack': ds.get('bull_stack'),
        'bear_stack': ds.get('bear_stack'),
        'above_e200': ds.get('above_e200'),
    }
    # MTF indicator snapshot
    tf = payload.get('tf_tech') or {}
    mtf = {}
    for tfk in ['10', '15', '30', '1H', '4H', 'D']:
        b = tf.get(tfk) or {}
        if not b:
            continue
        mtf[tfk] = {
            'stDir': b.get('stDir'),
            'rsi': b.get('rsi'),
            'ema_depth': b.get('ema_depth'),
            'ema_structure': b.get('ema_structure'),
            'phase_zone': b.get('phase_zone'),
            'saty_zone': b.get('saty_zone'),
            'c8_9': b.get('ripster_c8_9'),
            'c5_12': b.get('ripster_c5_12'),
        }
    out['mtf'] = mtf
    # ATR Levels at entry
    atr = payload.get('atr_levels') or {}
    atr_summary = {}
    for horizon in ['day', 'week', 'month', 'quarter', 'longterm']:
        al = atr.get(horizon) or {}
        atr_summary[horizon] = {
            'prevClose': al.get('prevClose'),
            'atr': al.get('atr'),
            'disp': al.get('disp'),
            'band': al.get('band'),
            'rangeOfATR': al.get('rangeOfATR'),
            'gate': al.get('gate'),
        }
    out['atr_levels'] = atr_summary
    return out

def analyze_atr_reach(entry_price, mfe_pct, mae_pct, direction, atr_levels):
    """Determine which ATR fib levels price reached during the trade (from entry)."""
    reach = {}
    if direction == 'LONG':
        favorable_price = entry_price * (1 + mfe_pct / 100)
        adverse_price = entry_price * (1 + mae_pct / 100)
    else:
        favorable_price = entry_price * (1 - mfe_pct / 100)
        adverse_price = entry_price * (1 - mae_pct / 100)
    for horizon, al in atr_levels.items():
        if not al:
            continue
        pc = al.get('prevClose')
        atr = al.get('atr')
        if not (pc and atr and atr > 0):
            continue
        # Which fib ratios did favorable price reach?
        levels_up = al.get('levels_up') or []
        levels_dn = al.get('levels_dn') or []
        reached = {'up': [], 'dn': []}
        for lvl in levels_up:
            px = lvl.get('price')
            if not px:
                continue
            if direction == 'LONG' and favorable_price >= px:
                reached['up'].append({'ratio': lvl.get('ratio'), 'price': px})
            elif direction == 'SHORT' and adverse_price >= px:
                # For SHORT, "up" levels acted as resistance
                reached['up'].append({'ratio': lvl.get('ratio'), 'price': px})
        for lvl in levels_dn:
            px = lvl.get('price')
            if not px:
                continue
            if direction == 'LONG' and adverse_price <= px:
                reached['dn'].append({'ratio': lvl.get('ratio'), 'price': px})
            elif direction == 'SHORT' and favorable_price <= px:
                reached['dn'].append({'ratio': lvl.get('ratio'), 'price': px})
        if reached['up'] or reached['dn']:
            reach[horizon] = reached
    return reach

def classify_trade(rec):
    """Assign descriptive tags to the trade."""
    tags = []
    pnl = rec.get('pnl_pct') or 0
    mfe = rec.get('mfe_pct') or 0
    mae = rec.get('mae_pct') or 0
    mfe_gap = rec.get('mfe_exit_gap_pct') or 0
    status = rec.get('status')
    hold = rec.get('hold_hours') or 0

    if pnl >= 5:
        tags.append('big_winner')
    if pnl <= -1.5:
        tags.append('clear_loser')
    if status == 'WIN' and mfe >= 2 and mfe_gap > mfe * 0.5 and mfe_gap > 1.5:
        tags.append('leaky_winner')
    if status == 'WIN' and mfe_gap < 0.5:
        tags.append('clean_winner')
    if status == 'WIN' and pnl > 0 and mfe > 3 and mfe_gap < 1:
        tags.append('runner_success')
    if pnl > 0 and mfe > 3 and mfe_gap > 2:
        tags.append('runner_give_back')
    if status == 'LOSS' and mfe < 1 and mae < -2:
        tags.append('never_worked')
    if abs(pnl) < 0.5:
        tags.append('chop_scratch')
    reason = str(rec.get('exit_reason') or '').upper()
    if 'PRE_EVENT' in reason or 'PRE_EARNINGS' in reason:
        tags.append('event_clipped')
    if 'MAX_LOSS' in reason:
        tags.append('stopped_out')
    if 'RUNNER_DRAWDOWN' in reason:
        tags.append('runner_drawdown_cap')
    if 'DEAD_MONEY' in reason:
        tags.append('dead_money_flat')
    if 'TIME_SCALED' in reason:
        tags.append('time_scaled_stop')

    # ATR-specific tags
    entry_ctx = rec.get('entry_context') or {}
    daily = entry_ctx.get('daily') or {}
    p48 = daily.get('pct_above_e48')
    if rec.get('direction') == 'LONG' and isinstance(p48, (int, float)):
        if p48 > 7:
            tags.append('entry_extended_above_e48')
        if p48 < 0 and daily.get('bull_stack') is True:
            tags.append('entry_pullback_bull_stack')
    if rec.get('direction') == 'SHORT' and isinstance(p48, (int, float)):
        if p48 < -7:
            tags.append('entry_extended_below_e48')
        if p48 > 0 and daily.get('bear_stack') is True:
            tags.append('entry_bounce_bear_stack')

    return tags

# ---------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------

def aggregate(records):
    out = {
        'n_trades': len(records),
        'by_cohort': defaultdict(lambda: defaultdict(list)),
        'by_tag': defaultdict(list),
        'atr_reach_by_cohort': defaultdict(lambda: defaultdict(Counter)),
    }
    for r in records:
        if not r.get('forensics_available'):
            continue
        cohort = r.get('cohort')
        for tag in r.get('tags', []):
            out['by_cohort'][cohort][tag].append(r)
            out['by_tag'][tag].append(r)
        # ATR reach: for each horizon x highest ratio reached
        for horizon, reach in (r.get('atr_reach') or {}).items():
            ratios_up = [l['ratio'] for l in reach.get('up', [])]
            if ratios_up:
                max_ratio = max(ratios_up)
                out['atr_reach_by_cohort'][cohort][horizon][max_ratio] += 1
    return out

# ---------------------------------------------------------------------
# Report writers
# ---------------------------------------------------------------------

def stats(rows):
    if not rows:
        return {'n': 0}
    n = len(rows)
    w = sum(1 for r in rows if r.get('status') == 'WIN')
    l = sum(1 for r in rows if r.get('status') == 'LOSS')
    pnl = sum(float(r.get('pnl_pct') or 0) for r in rows)
    avg_pnl = pnl / n
    avg_mfe = sum(float(r.get('mfe_pct') or 0) for r in rows) / n
    avg_gap = sum(float(r.get('mfe_exit_gap_pct') or 0) for r in rows) / n
    wr = w / max(1, w + l) * 100 if (w + l) else None
    return {
        'n': n, 'w': w, 'l': l,
        'wr': round(wr, 1) if wr else None,
        'sum_pnl': round(pnl, 2),
        'avg_pnl': round(avg_pnl, 2),
        'avg_mfe': round(avg_mfe, 2),
        'avg_mfe_gap': round(avg_gap, 2),
    }

def write_summary(records, agg, out_dir):
    lines = []
    lines.append("# Phase-G Trade Forensics Summary\n")
    lines.append(f"**Trades analyzed**: {agg['n_trades']}")
    analyzed = [r for r in records if r.get('forensics_available')]
    lines.append(f"**With forensic data**: {len(analyzed)}")
    lines.append("")

    lines.append("## Tag distribution\n")
    lines.append("| Tag | Count | WR | Sum PnL | Avg PnL | Avg MFE | Avg MFE-exit gap |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|")
    for tag, rs in sorted(agg['by_tag'].items(), key=lambda x: -len(x[1])):
        s = stats(rs)
        wr = f"{s['wr']:.1f}%" if s.get('wr') is not None else "—"
        lines.append(f"| `{tag}` | {s['n']} | {wr} | {s['sum_pnl']:+.2f}% | {s['avg_pnl']:+.2f}% | {s['avg_mfe']:+.2f}% | {s['avg_mfe_gap']:+.2f}% |")
    lines.append("")

    lines.append("## Cohort × tag rollup\n")
    for cohort in ['Index_ETF', 'MegaCap', 'Industrial', 'Speculative', 'Semi', 'Sector_ETF', 'Other']:
        buckets = agg['by_cohort'].get(cohort) or {}
        if not buckets:
            continue
        lines.append(f"### {cohort}")
        lines.append("")
        lines.append("| Tag | Count | WR | Sum PnL | Avg PnL | Avg MFE | Avg MFE-exit gap |")
        lines.append("|---|---:|---:|---:|---:|---:|---:|")
        for tag, rs in sorted(buckets.items(), key=lambda x: -len(x[1])):
            s = stats(rs)
            wr = f"{s['wr']:.1f}%" if s.get('wr') is not None else "—"
            lines.append(f"| `{tag}` | {s['n']} | {wr} | {s['sum_pnl']:+.2f}% | {s['avg_pnl']:+.2f}% | {s['avg_mfe']:+.2f}% | {s['avg_mfe_gap']:+.2f}% |")
        lines.append("")

    lines.append("## ATR Level reach by cohort × horizon\n")
    lines.append("How far along the Fib-ATR ladder each cohort's trades actually reach at their favorable peak.")
    lines.append("")
    for cohort, horizons in agg['atr_reach_by_cohort'].items():
        lines.append(f"### {cohort}")
        lines.append("")
        lines.append("| Horizon | Max ratio | Count |")
        lines.append("|---|---:|---:|")
        for horizon in ['day', 'week', 'month', 'quarter', 'longterm']:
            if horizon not in horizons:
                continue
            counter = horizons[horizon]
            for ratio, n in sorted(counter.items()):
                lines.append(f"| {horizon} | {ratio} | {n} |")
        lines.append("")

    (out_dir / 'summary.md').write_text('\n'.join(lines))

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--run-id', required=True)
    p.add_argument('--sample', type=int, default=0, help='Limit trades (0=all)')
    args = p.parse_args()

    run_id = args.run_id
    trade_path = ROOT / 'data' / 'trade-analysis' / run_id / 'trades.json'
    if not trade_path.exists():
        print(f'trades.json not found at {trade_path}')
        sys.exit(1)
    trades = json.loads(trade_path.read_text())['trades']
    if args.sample > 0:
        trades = trades[:args.sample]
    print(f'Analyzing {len(trades)} trades from {run_id}...')

    out_dir = ROOT / 'data' / 'trade-analysis' / run_id / 'forensics'
    out_dir.mkdir(parents=True, exist_ok=True)
    per_trade_dir = out_dir / 'per-trade'
    per_trade_dir.mkdir(exist_ok=True)

    records = []
    t0 = time.time()
    for i, t in enumerate(trades):
        rec = analyze_trade(t)
        records.append(rec)
        tid = (rec.get('trade_id') or f'trade-{i}').replace('/', '_')
        (per_trade_dir / f'{tid}.json').write_text(json.dumps(rec, indent=2, default=str))
        if (i + 1) % 20 == 0:
            dt = time.time() - t0
            rate = (i + 1) / dt
            remaining = (len(trades) - i - 1) / max(1, rate)
            print(f'  {i+1}/{len(trades)} ({rate:.1f}/s, ~{remaining:.0f}s remaining)')

    # Aggregation + report
    agg = aggregate(records)
    write_summary(records, agg, out_dir)
    # Machine-readable
    (out_dir / 'all-trades.json').write_text(json.dumps(records, indent=2, default=str))
    print(f'Wrote {out_dir}/summary.md')
    print(f'Wrote {out_dir}/all-trades.json')
    print(f'Wrote {len(records)} per-trade JSONs to {per_trade_dir}/')

if __name__ == '__main__':
    main()
