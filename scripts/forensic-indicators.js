/**
 * Forensic indicator library — closes-only, deterministic, no I/O.
 * Used by scripts/forensic-timeline.js.
 *
 * All indicators follow the user-specified close-discipline principle:
 * trend status flips only on a bar CLOSE crossing the level, never on
 * intra-bar wicks.
 */

export function ema(closes, period) {
  if (!Array.isArray(closes) || closes.length === 0) return [];
  const k = 2 / (period + 1);
  const out = new Array(closes.length);
  out[0] = closes[0];
  for (let i = 1; i < closes.length; i++) out[i] = closes[i] * k + out[i - 1] * (1 - k);
  return out;
}

export function rsi(closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

export function atr(highs, lows, closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;
  const tr = new Array(n);
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < n; i++) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}

/**
 * SuperTrend (period=10, multiplier=3). Returns array of
 * { upperBand, lowerBand, value, dir } where dir = 1 (bull) or -1 (bear).
 * Direction flips on a CLOSE crossing the active band — close-discipline.
 */
export function supertrend(highs, lows, closes, period = 10, mult = 3) {
  const n = closes.length;
  const a = atr(highs, lows, closes, period);
  const out = new Array(n);
  let prevDir = 1, prevUpper = Infinity, prevLower = -Infinity, prevST = closes[0];
  for (let i = 0; i < n; i++) {
    if (a[i] == null) {
      out[i] = { upperBand: null, lowerBand: null, value: null, dir: null };
      continue;
    }
    const hl2 = (highs[i] + lows[i]) / 2;
    let upper = hl2 + mult * a[i];
    let lower = hl2 - mult * a[i];
    if (closes[i - 1] != null && closes[i - 1] <= prevUpper) upper = Math.min(upper, prevUpper);
    if (closes[i - 1] != null && closes[i - 1] >= prevLower) lower = Math.max(lower, prevLower);
    let dir = prevDir;
    if (prevDir === 1 && closes[i] < lower) dir = -1;
    else if (prevDir === -1 && closes[i] > upper) dir = 1;
    const value = dir === 1 ? lower : upper;
    out[i] = { upperBand: upper, lowerBand: lower, value, dir };
    prevDir = dir; prevUpper = upper; prevLower = lower; prevST = value;
  }
  return out;
}

/**
 * TD9 setup count — Tom DeMark sequential setup detection.
 * Returns array of { count, direction } per bar, where:
 *   direction = 'sell' (bullish exhaustion forming, close > close[4])
 *               'buy' (bearish exhaustion forming, close < close[4])
 *               null  (in transition / not enough history)
 *   count     = consecutive bars in current setup direction (1..9+)
 *
 * A "setup-complete" print (count >= 9 in same direction) is a textbook
 * exhaustion warning. We track up to 13 (TD13 countdown is more nuanced
 * and we don't compute it here).
 */
export function td9(closes) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  let count = 0, dir = null;
  for (let i = 0; i < n; i++) {
    if (i < 4) { out[i] = { count: 0, direction: null }; continue; }
    const c = closes[i], c4 = closes[i - 4];
    let bar = null;
    if (c > c4) bar = 'sell';        // bullish run — sell-setup forming
    else if (c < c4) bar = 'buy';
    if (bar === dir) count++;
    else { dir = bar; count = bar ? 1 : 0; }
    out[i] = { count, direction: dir };
  }
  return out;
}

/**
 * Aggregate daily candles into ISO-week weekly candles.
 * Weekly close = last daily close in the week (Mon-Sun bucketing).
 */
export function dailyToWeekly(daily) {
  const weeks = new Map();
  for (const c of daily) {
    const d = new Date(c.ts);
    const day = d.getUTCDay();
    const diffToMon = day === 0 ? -6 : 1 - day;
    const mon = new Date(d);
    mon.setUTCDate(d.getUTCDate() + diffToMon);
    mon.setUTCHours(0, 0, 0, 0);
    const k = mon.getTime();
    const prev = weeks.get(k);
    if (!prev) {
      weeks.set(k, { ts: k, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 });
    } else {
      prev.h = Math.max(prev.h, c.h);
      prev.l = Math.min(prev.l, c.l);
      prev.c = c.c;
      prev.v += (c.v || 0);
    }
  }
  return Array.from(weeks.values()).sort((a, b) => a.ts - b.ts);
}

/**
 * Aggregate daily candles into monthly candles.
 * Monthly close = last daily close of the calendar month.
 */
export function dailyToMonthly(daily) {
  const months = new Map();
  for (const c of daily) {
    const d = new Date(c.ts);
    const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const prev = months.get(k);
    if (!prev) {
      months.set(k, { ts: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
                       o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 });
    } else {
      prev.h = Math.max(prev.h, c.h);
      prev.l = Math.min(prev.l, c.l);
      prev.c = c.c;
      prev.v += (c.v || 0);
    }
  }
  return Array.from(months.values()).sort((a, b) => a.ts - b.ts);
}

/**
 * Find the largest index i in `bars` (sorted by ts asc) such that bars[i].ts <= ts.
 * Returns null if no such bar.
 */
export function findIndexAtOrBefore(bars, ts) {
  let lo = 0, hi = bars.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].ts <= ts) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

export function dateStr(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
