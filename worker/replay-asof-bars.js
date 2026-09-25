// worker/replay-asof-bars.js
//
// What the replay may know at an interval, per timeframe.
//
// Candles are keyed by bar START. Slicing with `ts <= intervalTs` therefore
// hands the scorer the bar still in progress with its FINAL OHLC: at 09:50 ET
// the D bundle held that session's 4:00 PM close, the 4H bundle the 1:30 PM
// close, the 1H bundle the 10:30 close (BRK-B 2026-08-03). Live never sees
// that; it sees completed bars plus a forming bar stitched from what has
// traded so far.
//
// The replay prices an interval at the close of the leading-LTF bar that
// starts at `intervalTs`, so the decision happens at that bar's end:
// asOf = intervalTs + leading-LTF length. For every other timeframe this
// module returns the bars completed by asOf plus the forming bar rebuilt from
// the leading-LTF bars up to asOf. The leading LTF itself is unchanged.
//
// Daily bars are dated by the UTC date of their timestamp (the stored stamps
// are 00:00, 04:00, 05:00 and 21:00 UTC — all the same session).

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const INTRADAY_MIN = { "1": 1, "3": 3, "5": 5, "10": 10, "15": 15, "30": 30, "60": 60, "240": 240 };

export function utcDate(ts) {
  return new Date(Number(ts)).toISOString().slice(0, 10);
}

function aggregate(bars) {
  if (!bars.length) return null;
  let h = -Infinity, l = Infinity, v = 0;
  for (const b of bars) {
    if (b.h > h) h = b.h;
    if (b.l < l) l = b.l;
    v += Number(b.v) || 0;
  }
  return { o: bars[0].o, h, l, c: bars[bars.length - 1].c, v };
}

/** Index of the last candle with ts <= t (candles ascending), -1 if none. */
function lastAtOrBefore(candles, t) {
  let lo = 0, hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].ts <= t) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi;
}

/** Leading-LTF bars that have CLOSED by asOf and started at/after fromTs. */
function ltfClosedBetween(ltf, fromTs, asOfMs, ltfMs) {
  const end = lastAtOrBefore(ltf, asOfMs - ltfMs);
  const out = [];
  for (let i = end; i >= 0 && ltf[i].ts >= fromTs; i--) out.push(ltf[i]);
  return out.reverse();
}

/**
 * Today's daily bar as of asOf, from the session's LTF bars (null before the
 * first LTF bar closes).
 */
export function formingDailyBar({ ltfCandles, asOfMs, ltfMinutes, sessionOpenMs }) {
  const ltfMs = ltfMinutes * MIN;
  const bars = ltfClosedBetween(ltfCandles || [], sessionOpenMs, asOfMs, ltfMs);
  const agg = aggregate(bars);
  return agg ? { ts: Date.parse(`${utcDate(sessionOpenMs)}T00:00:00Z`), ...agg } : null;
}

/**
 * Candles of `tf` knowable at asOf: completed bars plus the forming bar.
 *
 * @param {string} tf
 * @param {Array} candles       stored candles for tf, ascending
 * @param {object} ctx
 * @param {number} ctx.intervalTs
 * @param {string} ctx.leadingLtf
 * @param {Array}  ctx.ltfCandles   leading-LTF candles, ascending
 * @param {Array}  ctx.dailyCandles stored D candles (for W / M forming bars)
 * @param {number} ctx.sessionOpenMs
 */
export function barsAsOf(tf, candles, ctx) {
  const all = Array.isArray(candles) ? candles : [];
  const ltfMin = INTRADAY_MIN[ctx.leadingLtf] || 10;
  const ltfMs = ltfMin * MIN;
  if (tf === ctx.leadingLtf) return all.slice(0, lastAtOrBefore(all, ctx.intervalTs) + 1);
  const asOfMs = ctx.intervalTs + ltfMs;
  const ltf = ctx.ltfCandles || [];

  const tfMin = INTRADAY_MIN[tf];
  if (tfMin) {
    const idx = lastAtOrBefore(all, asOfMs - 1);
    if (idx < 0) return [];
    const last = all[idx];
    if (last.ts + tfMin * MIN <= asOfMs) return all.slice(0, idx + 1);
    const agg = aggregate(ltfClosedBetween(ltf, last.ts, asOfMs, ltfMs));
    const done = all.slice(0, idx);
    return agg ? [...done, { ts: last.ts, ...agg }] : done;
  }

  const today = utcDate(ctx.sessionOpenMs);
  const forming = formingDailyBar({ ltfCandles: ltf, asOfMs, ltfMinutes: ltfMin, sessionOpenMs: ctx.sessionOpenMs });

  if (tf === "D") {
    const done = all.filter((b) => utcDate(b.ts) < today);
    return forming ? [...done, forming] : done;
  }

  if (tf === "W" || tf === "M") {
    const inPeriod = tf === "W"
      ? (b) => asOfMs - b.ts < 7 * DAY
      : (b) => utcDate(b.ts).slice(0, 7) === today.slice(0, 7);
    const idx = lastAtOrBefore(all, asOfMs - 1);
    if (idx < 0) return [];
    const last = all[idx];
    if (!inPeriod(last)) return all.slice(0, idx + 1);
    const periodStart = utcDate(last.ts);
    const days = (ctx.dailyCandles || []).filter((b) => {
      const d = utcDate(b.ts);
      return d >= periodStart && d < today;
    });
    const seen = new Set();
    const uniqueDays = days.filter((b) => { const d = utcDate(b.ts); if (seen.has(d)) return false; seen.add(d); return true; });
    const agg = aggregate(forming ? [...uniqueDays, forming] : uniqueDays);
    const done = all.slice(0, idx);
    return agg ? [...done, { ts: last.ts, ...agg }] : done;
  }

  return all.slice(0, lastAtOrBefore(all, ctx.intervalTs) + 1);
}

/**
 * Last daily candle from a session BEFORE the replay day (prior close) —
 * for inputs with no intraday series (VIX, sector ETF daily % changes).
 */
export function lastPriorSessionIndex(dailyCandles, dateParam) {
  const c = Array.isArray(dailyCandles) ? dailyCandles : [];
  for (let i = c.length - 1; i >= 0; i--) if (utcDate(c[i].ts) < dateParam) return i;
  return -1;
}
