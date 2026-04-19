#!/usr/bin/env python3
"""
scripts/phase-e-pattern-miner.py

Pattern mining across 8 months of v4 trades (Jul 2025 - Feb 2026).
For every trade, reconstructs the Daily-EMA structural context at entry
(price vs D21/D48/D200, bull/bear stack, slope, distance from each EMA,
RSI context) and correlates each pattern with outcome.

Purpose: give the operator a clear, evidence-backed answer to
"what setups in what cohorts work" — so the entry engine's thresholds
and DA-key overrides can be tuned per-cohort rather than per-ticker.

Output: `data/trade-analysis/phase-e2-pattern-analysis-2026-04-19/`
  - patterns.md         operator-readable deep dive
  - patterns.json       machine-readable payload
"""

import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone, date
from pathlib import Path

ROOT = Path('/workspace')
CACHE = Path('/tmp/daily-cache')
OUT = ROOT / 'data' / 'trade-analysis' / 'phase-e2-pattern-analysis-2026-04-19'
OUT.mkdir(parents=True, exist_ok=True)

UNIVERSE = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA',
            'AGQ','CDNS','ETN','FIX','GRNY','HUBS','IESC','MTZ','ON','PH','RIOT','SGI','SWK','XLY']

COHORTS = {
    'Index_ETF': {'SPY', 'QQQ', 'IWM'},
    'Sector_ETF': {'XLY'},
    'MegaCap_Tech': {'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA'},
    'Industrial': {'ETN', 'FIX', 'IESC', 'MTZ', 'PH', 'SWK'},
    'Semi_Momentum': {'CDNS', 'ON', 'HUBS'},
    'Speculative': {'AGQ', 'GRNY', 'RIOT', 'SGI'},
}

def cohort_of(ticker):
    for name, members in COHORTS.items():
        if ticker in members:
            return name
    return 'other'

# ---------- Daily EMA/structure reconstruction ----------

def ema(values, period):
    if not values:
        return None
    k = 2 / (period + 1)
    e = values[0]
    for v in values[1:]:
        e = v * k + e * (1 - k)
    return e

def rsi_wilder(closes, period=14):
    if len(closes) < period + 1:
        return None
    gains = []
    losses = []
    for i in range(1, len(closes)):
        ch = closes[i] - closes[i - 1]
        gains.append(max(ch, 0))
        losses.append(max(-ch, 0))
    avg_g = sum(gains[:period]) / period
    avg_l = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        avg_g = (avg_g * (period - 1) + gains[i]) / period
        avg_l = (avg_l * (period - 1) + losses[i]) / period
    if avg_l == 0:
        return 100.0
    rs = avg_g / avg_l
    return 100 - 100 / (1 + rs)

_cache = {}
def bars_for(ticker):
    if ticker in _cache:
        return _cache[ticker]
    p = CACHE / f'{ticker}.json'
    if not p.exists():
        _cache[ticker] = []
        return []
    _cache[ticker] = json.loads(p.read_text())
    return _cache[ticker]

def structure_at(ticker, entry_date_iso):
    bars = bars_for(ticker)
    if not bars:
        return None
    ed = date.fromisoformat(entry_date_iso)
    closes = []
    for b in bars:
        bd = datetime.fromtimestamp(b['ts'] / 1000, tz=timezone.utc).date()
        if bd > ed:
            break
        closes.append(b['c'])
    if len(closes) < 60:
        return None
    # To compute long EMAs (200) properly we'd want the full series but a
    # warm-start EMA over the last 200 bars is a close approximation.
    e21 = ema(closes[-60:], 21)
    e48 = ema(closes[-150:] if len(closes) >= 150 else closes, 48)
    e200 = ema(closes[-400:] if len(closes) >= 400 else closes, 200)
    px = closes[-1]
    # Slopes
    e21_5d_ago = ema(closes[-65:-5], 21) if len(closes) >= 65 else None
    e48_10d_ago = ema(closes[-160:-10], 48) if len(closes) >= 160 else None
    slope_e21 = ((e21 - e21_5d_ago) / e21_5d_ago * 100) if (e21_5d_ago and e21_5d_ago > 0) else None
    slope_e48 = ((e48 - e48_10d_ago) / e48_10d_ago * 100) if (e48_10d_ago and e48_10d_ago > 0) else None
    rsi_d = rsi_wilder(closes[-30:], 14) if len(closes) >= 30 else None

    def pct(ref):
        return ((px - ref) / ref * 100) if (ref and ref > 0) else None

    pct_above_e200 = pct(e200)
    pct_above_e48 = pct(e48)
    pct_above_e21 = pct(e21)
    bull_stack = (e21 is not None and e48 is not None and e200 is not None
                  and e21 > e48 > e200)
    bear_stack = (e21 is not None and e48 is not None and e200 is not None
                  and e21 < e48 < e200)
    above_e200 = (px > e200) if e200 else None

    # Regime label for human-friendly grouping
    if above_e200 and bull_stack:
        regime_label = 'bullish_stacked'
    elif above_e200 and not bear_stack:
        regime_label = 'bullish_mixed'  # above 200 but EMAs not fully stacked
    elif not above_e200 and bear_stack:
        regime_label = 'bearish_stacked'
    elif not above_e200:
        regime_label = 'bearish_mixed'
    else:
        regime_label = 'choppy'

    # Distance bucket vs D48 (the "sweet spot" signal from Phase-D analysis)
    if pct_above_e48 is None:
        dist_bucket = None
    elif pct_above_e48 < -3:
        dist_bucket = 'deep_below_e48'
    elif pct_above_e48 < 0:
        dist_bucket = 'below_e48'
    elif pct_above_e48 < 2:
        dist_bucket = 'just_above_e48_0_2'
    elif pct_above_e48 < 5:
        dist_bucket = 'healthy_2_5'
    elif pct_above_e48 < 8:
        dist_bucket = 'extended_5_8'
    else:
        dist_bucket = 'overextended_8plus'

    # Slope bucket
    if slope_e21 is None:
        slope_bucket = None
    elif slope_e21 < -0.5:
        slope_bucket = 'declining'
    elif slope_e21 < 0.3:
        slope_bucket = 'flat_or_slow'
    elif slope_e21 < 1.5:
        slope_bucket = 'healthy_rise'
    elif slope_e21 < 3.0:
        slope_bucket = 'strong_rise'
    else:
        slope_bucket = 'parabolic'

    # RSI bucket
    if rsi_d is None:
        rsi_bucket = None
    elif rsi_d < 30:
        rsi_bucket = 'oversold'
    elif rsi_d < 45:
        rsi_bucket = 'pullback_zone'
    elif rsi_d < 55:
        rsi_bucket = 'neutral'
    elif rsi_d < 70:
        rsi_bucket = 'trending_up'
    else:
        rsi_bucket = 'overbought'

    return {
        'px': round(px, 2) if px else None,
        'e21': round(e21, 2) if e21 else None,
        'e48': round(e48, 2) if e48 else None,
        'e200': round(e200, 2) if e200 else None,
        'pct_above_e21': round(pct_above_e21, 2) if pct_above_e21 is not None else None,
        'pct_above_e48': round(pct_above_e48, 2) if pct_above_e48 is not None else None,
        'pct_above_e200': round(pct_above_e200, 2) if pct_above_e200 is not None else None,
        'e21_slope_5d_pct': round(slope_e21, 2) if slope_e21 is not None else None,
        'e48_slope_10d_pct': round(slope_e48, 2) if slope_e48 is not None else None,
        'rsi_d': round(rsi_d, 1) if rsi_d else None,
        'bull_stack': bull_stack,
        'bear_stack': bear_stack,
        'above_e200': above_e200,
        'regime_label': regime_label,
        'dist_bucket': dist_bucket,
        'slope_bucket': slope_bucket,
        'rsi_bucket': rsi_bucket,
    }

# ---------- Load all v4 trades ----------

def load_v4_trades():
    trades = []
    months = ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11',
              '2025-12', '2026-01', '2026-02']
    for m in months:
        p = ROOT / 'data' / 'trade-analysis' / f'phase-e2-slice-{m}-v4' / 'trades.json'
        if not p.exists():
            continue
        for t in json.loads(p.read_text())['trades']:
            t['_month'] = m
            trades.append(t)
    return trades

def enrich(trades):
    out = []
    for t in trades:
        if not t.get('entry_ts'):
            continue
        ed = datetime.fromtimestamp(t['entry_ts'] / 1000, tz=timezone.utc).date().isoformat()
        s = structure_at(t['ticker'], ed)
        if not s:
            continue
        t2 = dict(t)
        t2.update(s)
        t2['_cohort'] = cohort_of(t.get('ticker'))
        t2['_entry_date'] = ed
        out.append(t2)
    return out

# ---------- Stats helpers ----------

def summarize(group):
    n = len(group)
    if n == 0:
        return {'n': 0}
    w = sum(1 for t in group if t.get('status') == 'WIN')
    l = sum(1 for t in group if t.get('status') == 'LOSS')
    other = n - w - l
    pnl = sum(float(t.get('pnl_pct') or 0) for t in group)
    big = sum(1 for t in group if float(t.get('pnl_pct') or 0) >= 5)
    clr = sum(1 for t in group if float(t.get('pnl_pct') or 0) <= -1.5)
    wr = w / max(1, w + l) * 100 if (w + l) else None
    avg = pnl / n
    return {
        'n': n, 'w': w, 'l': l, 'other': other,
        'wr': round(wr, 1) if wr is not None else None,
        'big': big, 'clr': clr,
        'sum_pnl': round(pnl, 2), 'avg_pnl': round(avg, 3),
    }

def group_by(trades, key):
    buckets = defaultdict(list)
    for t in trades:
        k = t.get(key)
        if k is None:
            continue
        buckets[k].append(t)
    return {k: summarize(v) for k, v in buckets.items()}

def cross_by(trades, k1, k2):
    buckets = defaultdict(lambda: defaultdict(list))
    for t in trades:
        a = t.get(k1)
        b = t.get(k2)
        if a is None or b is None:
            continue
        buckets[a][b].append(t)
    return {a: {b: summarize(v) for b, v in bb.items()} for a, bb in buckets.items()}

# ---------- Build report ----------

def fmt_row(name, s):
    if not s or s.get('n', 0) == 0:
        return f'| {name} | — | — | — | — | — | — |'
    wr = f"{s['wr']:.1f}%" if s.get('wr') is not None else '—'
    return (f"| {name} | {s['n']} | {wr} | {s.get('big', 0)} | "
            f"{s.get('clr', 0)} | {s.get('sum_pnl', 0):+.2f}% | {s.get('avg_pnl', 0):+.2f}% |")

def write_report():
    raw = load_v4_trades()
    enriched = enrich(raw)
    all_v4 = len(raw)
    enriched_count = len(enriched)
    print(f'Loaded {all_v4} v4 trades, enriched {enriched_count} with daily structure')

    lines = []
    lines.append('# Phase-E.2 Pattern Mining — 2026-04-19')
    lines.append('')
    lines.append(f'Scope: **{enriched_count} v4 trades** across 8 months (Jul 2025 – Feb 2026) on the 24-ticker universe.')
    lines.append('')
    lines.append('For every trade we reconstruct the **Daily EMA structural context at entry**:')
    lines.append('- Price vs D21, D48, D200 EMAs')
    lines.append('- EMA stack alignment (bull/bear/mixed)')
    lines.append('- D21 5-day slope (momentum of the swing EMA)')
    lines.append('- D48 10-day slope (structural trend)')
    lines.append('- Daily RSI-14 regime')
    lines.append('')
    lines.append('The goal is a playbook: "For ticker cohort X, our system works when structure Y; avoid when structure Z."')
    lines.append('')

    # ============================================================
    # Section 1: Cohort baselines
    # ============================================================
    lines.append('## 1. Cohort baselines')
    lines.append('')
    lines.append('| Cohort | n | WR | Big W | Clear L | Sum PnL | Avg PnL |')
    lines.append('|---|---:|---:|---:|---:|---:|---:|')
    cohort_summary = group_by(enriched, '_cohort')
    # Sort by sum_pnl descending
    for c in sorted(cohort_summary, key=lambda x: -cohort_summary[x].get('sum_pnl', 0)):
        lines.append(fmt_row(c, cohort_summary[c]))
    lines.append('')

    # ============================================================
    # Section 2: Regime label × cohort
    # ============================================================
    lines.append('## 2. Daily regime × cohort')
    lines.append('')
    lines.append('Regime labels:')
    lines.append('- **bullish_stacked**: price > D200 AND D21 > D48 > D200 (textbook bull)')
    lines.append('- **bullish_mixed**: price > D200 but EMAs not fully stacked (early bull / consolidation)')
    lines.append('- **bearish_stacked**: price < D200 AND D21 < D48 < D200 (textbook bear)')
    lines.append('- **bearish_mixed**: price < D200, EMAs not fully stacked')
    lines.append('')

    for cohort in ['Index_ETF', 'Sector_ETF', 'MegaCap_Tech', 'Industrial', 'Semi_Momentum', 'Speculative']:
        c_trades = [t for t in enriched if t['_cohort'] == cohort]
        if not c_trades:
            continue
        lines.append(f'### {cohort} (n={len(c_trades)})')
        lines.append('')
        lines.append('| Regime | n | WR | Big W | Clear L | Sum PnL | Avg PnL |')
        lines.append('|---|---:|---:|---:|---:|---:|---:|')
        r_summary = group_by(c_trades, 'regime_label')
        for reg in sorted(r_summary, key=lambda x: -r_summary[x].get('sum_pnl', 0)):
            lines.append(fmt_row(reg, r_summary[reg]))
        lines.append('')

    # ============================================================
    # Section 3: D48 distance bucket × cohort (the key signal from Phase-D)
    # ============================================================
    lines.append('## 3. Distance from D48 × cohort')
    lines.append('')
    lines.append('Does the "price band above D48 matters" insight from Phase-D hold per cohort?')
    lines.append('')

    dist_order = ['deep_below_e48', 'below_e48', 'just_above_e48_0_2',
                  'healthy_2_5', 'extended_5_8', 'overextended_8plus']
    for cohort in ['Index_ETF', 'MegaCap_Tech', 'Industrial', 'Semi_Momentum', 'Speculative']:
        c_trades = [t for t in enriched if t['_cohort'] == cohort]
        if not c_trades:
            continue
        lines.append(f'### {cohort}')
        lines.append('')
        lines.append('| Distance from D48 | n | WR | Big W | Clear L | Sum PnL | Avg PnL |')
        lines.append('|---|---:|---:|---:|---:|---:|---:|')
        d_summary = group_by(c_trades, 'dist_bucket')
        for b in dist_order:
            if b in d_summary:
                lines.append(fmt_row(b, d_summary[b]))
        lines.append('')

    # ============================================================
    # Section 4: D21 slope × cohort
    # ============================================================
    lines.append('## 4. D21 5-day slope × cohort')
    lines.append('')
    lines.append('Slope is "momentum of the swing EMA". Too-flat = fakeout risk; too-parabolic = late-cycle risk.')
    lines.append('')

    slope_order = ['declining', 'flat_or_slow', 'healthy_rise', 'strong_rise', 'parabolic']
    for cohort in ['Index_ETF', 'MegaCap_Tech', 'Industrial', 'Semi_Momentum', 'Speculative']:
        c_trades = [t for t in enriched if t['_cohort'] == cohort]
        if not c_trades:
            continue
        lines.append(f'### {cohort}')
        lines.append('')
        lines.append('| D21 slope band | n | WR | Big W | Clear L | Sum PnL | Avg PnL |')
        lines.append('|---|---:|---:|---:|---:|---:|---:|')
        s_summary = group_by(c_trades, 'slope_bucket')
        for b in slope_order:
            if b in s_summary:
                lines.append(fmt_row(b, s_summary[b]))
        lines.append('')

    # ============================================================
    # Section 5: RSI-D × cohort
    # ============================================================
    lines.append('## 5. Daily RSI at entry × cohort')
    lines.append('')
    rsi_order = ['oversold', 'pullback_zone', 'neutral', 'trending_up', 'overbought']
    for cohort in ['Index_ETF', 'MegaCap_Tech', 'Industrial', 'Semi_Momentum', 'Speculative']:
        c_trades = [t for t in enriched if t['_cohort'] == cohort]
        if not c_trades:
            continue
        lines.append(f'### {cohort}')
        lines.append('')
        lines.append('| RSI-D zone | n | WR | Big W | Clear L | Sum PnL | Avg PnL |')
        lines.append('|---|---:|---:|---:|---:|---:|---:|')
        r_summary = group_by(c_trades, 'rsi_bucket')
        for b in rsi_order:
            if b in r_summary:
                lines.append(fmt_row(b, r_summary[b]))
        lines.append('')

    # ============================================================
    # Section 6: Combined "A+ sweet spot" vs "reject zone"
    # ============================================================
    lines.append('## 6. Combined setup quality per cohort')
    lines.append('')
    lines.append('A+ Sweet Spot (per cohort): bullish_stacked regime AND slope in healthy/strong_rise range AND dist in just_above/healthy band.')
    lines.append('')
    lines.append('| Cohort | Zone | n | WR | Big W | Clear L | Sum PnL | Avg PnL |')
    lines.append('|---|---|---:|---:|---:|---:|---:|---:|')

    def is_sweet(t):
        return (t.get('regime_label') == 'bullish_stacked'
                and t.get('slope_bucket') in ('healthy_rise', 'strong_rise')
                and t.get('dist_bucket') in ('just_above_e48_0_2', 'healthy_2_5'))
    def is_extended(t):
        return (t.get('dist_bucket') in ('extended_5_8', 'overextended_8plus')
                or t.get('slope_bucket') == 'parabolic')
    def is_fakeout_risk(t):
        return (t.get('regime_label') in ('bullish_mixed', 'choppy')
                and t.get('slope_bucket') in ('declining', 'flat_or_slow'))

    for cohort in ['Index_ETF', 'MegaCap_Tech', 'Industrial', 'Semi_Momentum', 'Speculative', 'Sector_ETF']:
        ct = [t for t in enriched if t['_cohort'] == cohort]
        if not ct:
            continue
        sweet = [t for t in ct if is_sweet(t)]
        extended = [t for t in ct if is_extended(t)]
        fake = [t for t in ct if is_fakeout_risk(t)]
        neutral = [t for t in ct if not (is_sweet(t) or is_extended(t) or is_fakeout_risk(t))]
        lines.append(fmt_row(f'{cohort} → A+ sweet', summarize(sweet)))
        lines.append(fmt_row(f'{cohort} → extended / parabolic', summarize(extended)))
        lines.append(fmt_row(f'{cohort} → fakeout risk', summarize(fake)))
        lines.append(fmt_row(f'{cohort} → neutral', summarize(neutral)))
    lines.append('')

    # ============================================================
    # Section 7: Winners vs losers at key percentile thresholds
    # ============================================================
    lines.append('## 7. Winner vs loser distributions (per cohort)')
    lines.append('')
    lines.append('Where is the dividing line inside each cohort? (medians / percentiles)')
    lines.append('')

    import statistics as st
    def pct_stats(vals):
        if not vals:
            return None
        s = sorted(vals)
        return {
            'min': round(s[0], 2),
            'q1': round(s[len(s) // 4], 2),
            'median': round(s[len(s) // 2], 2),
            'q3': round(s[len(s) * 3 // 4], 2),
            'max': round(s[-1], 2),
            'mean': round(st.mean(s), 2),
        }

    for cohort in ['Index_ETF', 'MegaCap_Tech', 'Industrial', 'Semi_Momentum', 'Speculative']:
        ct = [t for t in enriched if t['_cohort'] == cohort]
        if not ct:
            continue
        wins = [t for t in ct if t.get('status') == 'WIN' or float(t.get('pnl_pct') or 0) > 0]
        losses = [t for t in ct if t.get('status') == 'LOSS' or float(t.get('pnl_pct') or 0) <= -1.5]
        lines.append(f'### {cohort}')
        lines.append('')
        for metric in ['pct_above_e48', 'e21_slope_5d_pct', 'rsi_d']:
            w_stats = pct_stats([t[metric] for t in wins if t.get(metric) is not None])
            l_stats = pct_stats([t[metric] for t in losses if t.get(metric) is not None])
            if w_stats and l_stats:
                lines.append(f'**{metric}**:')
                lines.append(f'  - Winners: min={w_stats["min"]} q1={w_stats["q1"]} median={w_stats["median"]} q3={w_stats["q3"]} max={w_stats["max"]} mean={w_stats["mean"]}')
                lines.append(f'  - Losers: min={l_stats["min"]} q1={l_stats["q1"]} median={l_stats["median"]} q3={l_stats["q3"]} max={l_stats["max"]} mean={l_stats["mean"]}')
                lines.append('')

    # ============================================================
    # Section 8: Operator playbook
    # ============================================================
    lines.append('## 8. Operator playbook (what works / what doesn\'t)')
    lines.append('')
    lines.append('For each cohort, the evidence-backed "when to trust the signal, when to stand down" rules.')
    lines.append('')

    for cohort in ['Index_ETF', 'MegaCap_Tech', 'Industrial', 'Semi_Momentum', 'Speculative']:
        ct = [t for t in enriched if t['_cohort'] == cohort]
        if not ct:
            continue
        lines.append(f'### {cohort}')
        lines.append('')
        sweet = summarize([t for t in ct if is_sweet(t)])
        ext = summarize([t for t in ct if is_extended(t)])
        fake = summarize([t for t in ct if is_fakeout_risk(t)])
        bs_only = summarize([t for t in ct if t.get('regime_label') == 'bullish_stacked'])
        mixed_only = summarize([t for t in ct if t.get('regime_label') == 'bullish_mixed'])
        if sweet['n']:
            lines.append(f'- **A+ sweet spot** (bullish stack + healthy slope + 0-5% above D48): '
                         f'{sweet["n"]} trades / WR {sweet.get("wr","—")}% / '
                         f'avg pnl {sweet["avg_pnl"]:+.2f}%')
        if ext['n']:
            lines.append(f'- **Extended** (>5% above D48 OR parabolic slope): '
                         f'{ext["n"]} trades / WR {ext.get("wr","—")}% / '
                         f'avg pnl {ext["avg_pnl"]:+.2f}%')
        if fake['n']:
            lines.append(f'- **Fakeout risk** (mixed regime + flat slope): '
                         f'{fake["n"]} trades / WR {fake.get("wr","—")}% / '
                         f'avg pnl {fake["avg_pnl"]:+.2f}%')
        if bs_only['n']:
            lines.append(f'- **All bullish_stacked entries**: {bs_only["n"]} trades / WR {bs_only.get("wr","—")}% / sum pnl {bs_only["sum_pnl"]:+.2f}%')
        if mixed_only['n']:
            lines.append(f'- **All bullish_mixed entries**: {mixed_only["n"]} trades / WR {mixed_only.get("wr","—")}% / sum pnl {mixed_only["sum_pnl"]:+.2f}%')
        lines.append('')

    # ============================================================
    # Write outputs
    # ============================================================
    (OUT / 'patterns.md').write_text('\n'.join(lines))

    # JSON snapshot
    snapshot = {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'n_trades': enriched_count,
        'cohort_baselines': cohort_summary,
        'regime_by_cohort': {
            c: group_by([t for t in enriched if t['_cohort'] == c], 'regime_label')
            for c in COHORTS
        },
        'dist_by_cohort': {
            c: group_by([t for t in enriched if t['_cohort'] == c], 'dist_bucket')
            for c in COHORTS
        },
        'slope_by_cohort': {
            c: group_by([t for t in enriched if t['_cohort'] == c], 'slope_bucket')
            for c in COHORTS
        },
        'rsi_by_cohort': {
            c: group_by([t for t in enriched if t['_cohort'] == c], 'rsi_bucket')
            for c in COHORTS
        },
    }
    (OUT / 'patterns.json').write_text(json.dumps(snapshot, indent=2, default=str))
    print(f'Wrote {OUT / "patterns.md"}')
    print(f'Wrote {OUT / "patterns.json"}')

if __name__ == '__main__':
    write_report()
