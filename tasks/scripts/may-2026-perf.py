#!/usr/bin/env python3
"""Multi-window performance analysis: May, April, last 30/90 days, last 7 days.

Usage:
    curl -s 'https://timed-trading-ingest.shashant.workers.dev/timed/ledger/trades?limit=1000' \
        -o /tmp/trades.json
    python3 tasks/scripts/may-2026-perf.py
"""
import json
from collections import defaultdict
import datetime as dt
import os

TRADES_PATH = os.environ.get('TRADES_JSON', '/tmp/trades.json')
with open(TRADES_PATH) as f:
    raw = json.load(f)
trades = raw.get('trades', []) or []

def ts_ms(t, *keys):
    for k in keys:
        v = t.get(k)
        if v is not None:
            try:
                n = float(v)
                return n if n > 1e11 else n * 1000
            except: pass
    return None

NOW = dt.datetime(2026, 5, 17, 21, 0).timestamp() * 1000  # User's current moment
def window(label, start_ms, end_ms):
    return label, start_ms, end_ms

windows = [
    window('Last 7 days',   NOW - 7 * 86400000,            NOW),
    window('May 2026',      dt.datetime(2026, 5, 1).timestamp() * 1000,
                            dt.datetime(2026, 6, 1).timestamp() * 1000),
    window('April 2026',    dt.datetime(2026, 4, 1).timestamp() * 1000,
                            dt.datetime(2026, 5, 1).timestamp() * 1000),
    window('March 2026',    dt.datetime(2026, 3, 1).timestamp() * 1000,
                            dt.datetime(2026, 4, 1).timestamp() * 1000),
    window('Feb 2026',      dt.datetime(2026, 2, 1).timestamp() * 1000,
                            dt.datetime(2026, 3, 1).timestamp() * 1000),
    window('Last 30 days',  NOW - 30 * 86400000,           NOW),
    window('Last 90 days',  NOW - 90 * 86400000,           NOW),
    window('All time',      0,                              float('inf')),
]

S = '$'
print('=' * 80)
print('PERFORMANCE BY WINDOW')
print('=' * 80)
print(f'  {"Window":15s} {"n":>5} {"W/L":>9} {"WR%":>6} {"Net P&L":>12} {"PF":>5} {"Exp":>7}')
print('-' * 80)

snapshots = {}
for label, lo, hi in windows:
    bucket = [t for t in trades if (ts := ts_ms(t, 'exit_ts', 'exitTs')) and lo <= ts < hi]
    if not bucket: continue
    w = [t for t in bucket if (t.get('pnl') or 0) > 0]
    l = [t for t in bucket if (t.get('pnl') or 0) < 0]
    pnl = sum(t.get('pnl') or 0 for t in bucket)
    gw = sum(t.get('pnl') or 0 for t in w)
    gl = abs(sum(t.get('pnl') or 0 for t in l))
    wr = len(w) / max(1, len(bucket)) * 100
    pf = gw / max(1e-9, gl)
    snapshots[label] = bucket
    print(f'  {label:15s} {len(bucket):>5} {len(w):>4}/{len(l):<3} {wr:>5.1f}% {S}{pnl:>+10,.0f}  {pf:>4.2f} {S}{pnl/max(1,len(bucket)):>+5.0f}')

# Direction balance
print()
print('=' * 80)
print('LONG vs SHORT BALANCE (by window)')
print('=' * 80)
for label in ['May 2026', 'April 2026', 'March 2026', 'Last 30 days', 'Last 90 days']:
    if label not in snapshots: continue
    bucket = snapshots[label]
    longs = [t for t in bucket if str(t.get('direction') or '').upper() == 'LONG']
    shorts = [t for t in bucket if str(t.get('direction') or '').upper() == 'SHORT']
    long_pnl = sum(t.get('pnl') or 0 for t in longs)
    short_pnl = sum(t.get('pnl') or 0 for t in shorts)
    print(f'  {label:15s} LONG: {len(longs):>3} ({S}{long_pnl:+,.0f})   SHORT: {len(shorts):>3} ({S}{short_pnl:+,.0f})')

# Setup performance over last 90 days
print()
print('=' * 80)
print('SETUP NAME — LAST 90 DAYS (n >= 5)')
print('=' * 80)
last90 = snapshots.get('Last 90 days', [])
def pretty_setup(s):
    if not s: return 'Other'
    s = str(s)
    for prefix in ('TT Tt ', 'TT ', 'Tt ', 'tt_', 'ripster_'):
        if s.startswith(prefix):
            s = s[len(prefix):]
            break
    return s.replace('_', ' ').title() or 'Other'

by_setup = defaultdict(list)
for t in last90:
    name = pretty_setup(t.get('setup_name') or t.get('entry_path') or t.get('entryPath') or 'unknown')
    by_setup[name].append(t)

rows = []
for name, trs in by_setup.items():
    if len(trs) < 5: continue
    w = [t for t in trs if (t.get('pnl') or 0) > 0]
    l = [t for t in trs if (t.get('pnl') or 0) < 0]
    pnl = sum(t.get('pnl') or 0 for t in trs)
    gw = sum(t.get('pnl') or 0 for t in w)
    gl = abs(sum(t.get('pnl') or 0 for t in l))
    rows.append({'name': name, 'n': len(trs), 'w': len(w), 'pnl': pnl, 'pf': gw / max(1e-9, gl), 'wr': len(w)/len(trs)*100})
rows.sort(key=lambda r: r['pnl'], reverse=True)
print(f'  {"Setup":30s} {"n":>4} {"WR%":>6} {"Net P&L":>10} {"PF":>5}')
print('-' * 70)
for r in rows:
    print(f'  {r["name"]:30s} {r["n"]:>4} {r["wr"]:>5.1f}% {S}{r["pnl"]:>+8,.0f}  {r["pf"]:>4.2f}')

# Exit reason — last 90 days
print()
print('=' * 80)
print('EXIT REASONS — LAST 90 DAYS (n >= 3)')
print('=' * 80)
by_exit = defaultdict(list)
for t in last90:
    er = str(t.get('exit_reason') or t.get('exitReason') or 'unknown').lower()
    by_exit[er].append(t)

erows = []
for er, trs in by_exit.items():
    if len(trs) < 3: continue
    w = [t for t in trs if (t.get('pnl') or 0) > 0]
    pnl = sum(t.get('pnl') or 0 for t in trs)
    avg = pnl / len(trs)
    erows.append({'er': er, 'n': len(trs), 'w': len(w), 'pnl': pnl, 'avg': avg, 'wr': len(w)/len(trs)*100})
erows.sort(key=lambda r: r['pnl'], reverse=True)
print(f'  {"Exit Reason":35s} {"n":>4} {"WR%":>6} {"P&L":>10} {"Avg":>7}')
print('-' * 75)
for r in erows:
    print(f'  {r["er"][:35]:35s} {r["n"]:>4} {r["wr"]:>5.1f}% {S}{r["pnl"]:>+8,.0f}  {S}{r["avg"]:>+5.0f}')

# Toxic tickers — last 30 days
print()
print('=' * 80)
print('TOXIC TICKERS — LAST 30 DAYS (cumR < -2.0, n >= 2)')
print('=' * 80)
last30 = snapshots.get('Last 30 days', [])
by_ticker = defaultdict(list)
for t in last30:
    by_ticker[(t.get('ticker') or '?').upper()].append(t)
toxic = []
for sym, trs in by_ticker.items():
    if len(trs) < 2: continue
    cumR = sum(t.get('pnl_pct') or t.get('pnlPct') or 0 for t in trs)
    pnl = sum(t.get('pnl') or 0 for t in trs)
    if cumR < -2.0:
        toxic.append({'sym': sym, 'n': len(trs), 'pnl': pnl, 'cumR': cumR})
toxic.sort(key=lambda r: r['cumR'])
print(f'  {"Ticker":8s} {"n":>3} {"P&L":>10} {"CumR%":>8}')
for r in toxic[:20]:
    print(f'  {r["sym"]:8s} {r["n"]:>3}   {S}{r["pnl"]:>+7,.0f}  {r["cumR"]:>+6.2f}%')

# Hot tickers — last 30 days
print()
print('=' * 80)
print('CONSISTENT WINNERS — LAST 30 DAYS (n >= 3, WR >= 60%, P&L > 0)')
print('=' * 80)
hot = []
for sym, trs in by_ticker.items():
    if len(trs) < 3: continue
    w = sum(1 for t in trs if (t.get('pnl') or 0) > 0)
    wr = w / len(trs) * 100
    pnl = sum(t.get('pnl') or 0 for t in trs)
    if wr >= 60 and pnl > 0:
        hot.append({'sym': sym, 'n': len(trs), 'wr': wr, 'pnl': pnl})
hot.sort(key=lambda r: r['pnl'], reverse=True)
for r in hot[:15]:
    print(f'  {r["sym"]:8s} n={r["n"]:>3} {r["wr"]:>5.1f}% WR  {S}{r["pnl"]:>+8,.0f}')
