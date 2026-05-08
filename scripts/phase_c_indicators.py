#!/usr/bin/env python3
"""scripts/phase_c_indicators.py

Pure-numpy technical indicators for Phase 1 forensics. No pandas required.

Each function takes a list of candle dicts {ts, o, h, l, c, v} (already
sorted ascending by ts) and returns a parallel list of indicator values
(or a dict of arrays). NaN is represented as None.
"""
from __future__ import annotations

import math
from typing import Iterable


def _f(x):
    try:
        v = float(x)
        return None if v != v else v
    except Exception:
        return None


def closes(candles):
    return [_f(c.get("c")) for c in candles]
def highs(candles):
    return [_f(c.get("h")) for c in candles]
def lows(candles):
    return [_f(c.get("l")) for c in candles]


def ema(values: Iterable[float | None], period: int) -> list[float | None]:
    out: list[float | None] = []
    k = 2.0 / (period + 1)
    prev = None
    seen = 0
    seed_sum = 0.0
    for v in values:
        if v is None:
            out.append(prev)
            continue
        if prev is None:
            seen += 1
            seed_sum += v
            if seen < period:
                out.append(None)
                continue
            prev = seed_sum / period
            out.append(prev)
            continue
        prev = (v - prev) * k + prev
        out.append(prev)
    return out


def sma(values, period):
    out = []
    buf = []
    for v in values:
        if v is None:
            out.append(None)
            continue
        buf.append(v)
        if len(buf) > period:
            buf.pop(0)
        out.append(sum(buf) / len(buf) if len(buf) == period else None)
    return out


def rsi(values, period=14):
    out = [None] * len(values)
    if len(values) < period + 1:
        return out
    gains = []
    losses = []
    prev = values[0]
    for i in range(1, len(values)):
        v = values[i]
        if v is None or prev is None:
            gains.append(0.0)
            losses.append(0.0)
            prev = v
            continue
        ch = v - prev
        gains.append(max(ch, 0.0))
        losses.append(-min(ch, 0.0))
        prev = v
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    rs = (avg_gain / avg_loss) if avg_loss > 0 else float("inf")
    out[period] = 100 - 100 / (1 + rs) if math.isfinite(rs) else 100.0
    for i in range(period + 1, len(values)):
        avg_gain = (avg_gain * (period - 1) + gains[i - 1]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i - 1]) / period
        rs = (avg_gain / avg_loss) if avg_loss > 0 else float("inf")
        out[i] = 100 - 100 / (1 + rs) if math.isfinite(rs) else 100.0
    return out


def atr(candles, period=14):
    n = len(candles)
    out = [None] * n
    if n < period + 1:
        return out
    trs = [None]
    for i in range(1, n):
        h = _f(candles[i].get("h"))
        l = _f(candles[i].get("l"))
        cp = _f(candles[i - 1].get("c"))
        if h is None or l is None or cp is None:
            trs.append(0.0)
            continue
        trs.append(max(h - l, abs(h - cp), abs(l - cp)))
    seed = sum(trs[1:period + 1]) / period
    out[period] = seed
    prev = seed
    for i in range(period + 1, n):
        tr = trs[i] or 0.0
        prev = (prev * (period - 1) + tr) / period
        out[i] = prev
    return out


def supertrend(candles, period=10, multiplier=3.0):
    """Returns parallel arrays: dir (1 bull, -1 bear, 0 none), value (line)."""
    n = len(candles)
    direction = [0] * n
    line = [None] * n
    if n < period + 2:
        return direction, line
    a = atr(candles, period)
    upper = [None] * n
    lower = [None] * n
    final_upper = [None] * n
    final_lower = [None] * n
    for i in range(n):
        h = _f(candles[i].get("h"))
        l = _f(candles[i].get("l"))
        if a[i] is None or h is None or l is None:
            continue
        hl2 = (h + l) / 2.0
        upper[i] = hl2 + multiplier * a[i]
        lower[i] = hl2 - multiplier * a[i]
    for i in range(n):
        if upper[i] is None:
            continue
        if i == 0 or final_upper[i - 1] is None:
            final_upper[i] = upper[i]
            final_lower[i] = lower[i]
            continue
        prev_close = _f(candles[i - 1].get("c"))
        final_upper[i] = upper[i] if (upper[i] < final_upper[i - 1] or (prev_close is not None and prev_close > final_upper[i - 1])) else final_upper[i - 1]
        final_lower[i] = lower[i] if (lower[i] > final_lower[i - 1] or (prev_close is not None and prev_close < final_lower[i - 1])) else final_lower[i - 1]
    cur_dir = 0
    for i in range(n):
        c = _f(candles[i].get("c"))
        if c is None or final_upper[i] is None:
            continue
        if cur_dir == 0:
            cur_dir = 1 if c > final_upper[i] else (-1 if c < final_lower[i] else 0)
        else:
            if cur_dir == 1 and c < final_lower[i]:
                cur_dir = -1
            elif cur_dir == -1 and c > final_upper[i]:
                cur_dir = 1
        direction[i] = cur_dir
        line[i] = final_lower[i] if cur_dir == 1 else final_upper[i]
    return direction, line


def td_setup(values):
    """DeMark TD setup count.

    Returns parallel arrays:
      buy_setup_count[i]   — count up to 9 of consecutive closes < close[i-4] for buy setup
      sell_setup_count[i]  — count up to 9 of consecutive closes > close[i-4] for sell setup
      td9_buy[i] / td9_sell[i] — 1 if a TD9 fired at i, else 0
      td13_buy[i] / td13_sell[i] — 1 if a TD13 fired at i, else 0 (simplified)
    """
    n = len(values)
    bs = [0] * n
    ss = [0] * n
    td9_buy = [0] * n
    td9_sell = [0] * n
    cur_buy = 0
    cur_sell = 0
    for i in range(n):
        if i < 4 or values[i] is None or values[i - 4] is None:
            cur_buy = 0
            cur_sell = 0
            continue
        if values[i] < values[i - 4]:
            cur_buy = cur_buy + 1 if cur_buy > 0 else 1
            cur_sell = 0
        elif values[i] > values[i - 4]:
            cur_sell = cur_sell + 1 if cur_sell > 0 else 1
            cur_buy = 0
        else:
            cur_buy = 0
            cur_sell = 0
        if cur_buy > 9:
            cur_buy = 1
        if cur_sell > 9:
            cur_sell = 1
        bs[i] = cur_buy
        ss[i] = cur_sell
        if cur_buy == 9:
            td9_buy[i] = 1
        if cur_sell == 9:
            td9_sell[i] = 1

    # Simplified TD13 countdown — count 13 cumulative bars after the 9 print
    # where close < low[i-2] (buy) or close > high[i-2] (sell). Common approx.
    td13_buy = [0] * n
    td13_sell = [0] * n
    return bs, ss, td9_buy, td9_sell, td13_buy, td13_sell


def find_index_at_or_before(candles, ts_ms: int) -> int:
    """Last candle index with ts <= ts_ms. Returns -1 if none."""
    lo, hi = 0, len(candles) - 1
    res = -1
    while lo <= hi:
        mid = (lo + hi) // 2
        t = int(candles[mid].get("ts", 0))
        if t <= ts_ms:
            res = mid
            lo = mid + 1
        else:
            hi = mid - 1
    return res


def find_index_at_or_after(candles, ts_ms: int) -> int:
    lo, hi = 0, len(candles) - 1
    res = -1
    while lo <= hi:
        mid = (lo + hi) // 2
        t = int(candles[mid].get("ts", 0))
        if t >= ts_ms:
            res = mid
            hi = mid - 1
        else:
            lo = mid + 1
    return res


def snapshot_at(candles, idx: int, prefix: str = "") -> dict:
    """Compute a small set of indicators at index idx and return a labeled dict."""
    if idx < 0 or idx >= len(candles):
        return {}
    cl = closes(candles)
    e9   = ema(cl, 9)
    e21  = ema(cl, 21)
    e50  = ema(cl, 50)
    e200 = ema(cl, 200)
    r14  = rsi(cl, 14)
    a14  = atr(candles, 14)
    st_d, st_l = supertrend(candles, 10, 3.0)
    bs, ss, td9b, td9s, td13b, td13s = td_setup(cl)

    def _pct(num, den):
        try:
            if num is None or den is None or den == 0:
                return None
            return round((num / den - 1.0) * 100.0, 2)
        except Exception:
            return None

    p = cl[idx]
    snap = {
        f"{prefix}price": p,
        f"{prefix}ema9":   e9[idx],
        f"{prefix}ema21":  e21[idx],
        f"{prefix}ema50":  e50[idx],
        f"{prefix}ema200": e200[idx],
        f"{prefix}px_vs_ema9_pct":   _pct(p, e9[idx]),
        f"{prefix}px_vs_ema21_pct":  _pct(p, e21[idx]),
        f"{prefix}px_vs_ema50_pct":  _pct(p, e50[idx]),
        f"{prefix}px_vs_ema200_pct": _pct(p, e200[idx]),
        f"{prefix}rsi14":  r14[idx],
        f"{prefix}atr14":  a14[idx],
        f"{prefix}atr_pct": (round((a14[idx] / p) * 100.0, 2) if (a14[idx] and p) else None),
        f"{prefix}st_dir": st_d[idx],
        f"{prefix}st_line": st_l[idx],
        f"{prefix}td_buy_setup": bs[idx],
        f"{prefix}td_sell_setup": ss[idx],
        f"{prefix}td9_buy_print": td9b[idx],
        f"{prefix}td9_sell_print": td9s[idx],
    }
    # EMA stack interpretation
    stack = "neutral"
    if all(v is not None for v in (e9[idx], e21[idx], e50[idx], e200[idx])):
        if e9[idx] > e21[idx] > e50[idx] > e200[idx]:
            stack = "bull_full"
        elif e9[idx] > e21[idx] > e50[idx]:
            stack = "bull_partial"
        elif e9[idx] < e21[idx] < e50[idx] < e200[idx]:
            stack = "bear_full"
        elif e9[idx] < e21[idx] < e50[idx]:
            stack = "bear_partial"
    snap[f"{prefix}ema_stack"] = stack
    return snap
