/**
 * Breakout watch — level + trendline.
 *
 * The model already detects swing / ATR / EMA-stack breaks in
 * `detectBreakout()`. Those land on `tickerData.breakout` and can
 * qualify an entry. A descending resistance (or ascending support)
 * trendline break was client-only overlay math and never became a
 * desk signal.
 *
 * This module watches both. When a break fires it is a SETUP signal
 * ("look for a good entry"), not a new auto-buy path. Setup grade and
 * `qualifiesForEnter` stay unchanged. Do not add `tt_trendline_breakout`.
 */

const MIN_BARS = 15;
const SWING_LOOKBACK = 2;
const RECENT_SWINGS = 5;
const MIN_SWING_SPAN = 5;
const LATE_ATR = 3;
const SLOPE_PCT_PER_BAR = 0.0004;
const BREAK_BUFFER_PCT = 0.0015;
const BREAK_BUFFER_ATR = 0.1;
const APPROACH_PCT = 0.012;
const APPROACH_ATR = 0.5;

function _n(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _barClose(bar) {
  return _n(bar?.c ?? bar?.close);
}

function _barHigh(bar) {
  return _n(bar?.h ?? bar?.high);
}

function _barLow(bar) {
  return _n(bar?.l ?? bar?.low);
}

function _barTs(bar) {
  return _n(bar?.ts ?? bar?.t) || 0;
}

export function normalizeDailyBars(dailyBars) {
  if (!Array.isArray(dailyBars) || dailyBars.length === 0) return [];
  const out = [];
  for (const bar of dailyBars) {
    const c = _barClose(bar);
    const h = _barHigh(bar);
    const l = _barLow(bar);
    if (!Number.isFinite(c) || c <= 0) continue;
    out.push({
      o: _n(bar?.o ?? bar?.open) ?? c,
      h: Number.isFinite(h) ? h : c,
      l: Number.isFinite(l) ? l : c,
      c,
      ts: _barTs(bar),
      v: _n(bar?.v ?? bar?.volume) || 0,
    });
  }
  return out;
}

/**
 * Local swing highs / lows. Same rule as the right-rail overlay
 * (`_rrDetectSwingPoints` in shared-right-rail.js).
 */
export function detectSwingPoints(candles, lookback = SWING_LOOKBACK) {
  const highs = [];
  const lows = [];
  if (!Array.isArray(candles) || candles.length < lookback * 2 + 1) {
    return { highs, lows };
  }
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].h >= c.h || candles[i + j].h >= c.h) isHigh = false;
      if (candles[i - j].l <= c.l || candles[i + j].l <= c.l) isLow = false;
    }
    if (isHigh) highs.push({ price: c.h, idx: i, ts: c.ts });
    if (isLow) lows.push({ price: c.l, idx: i, ts: c.ts });
  }
  return { highs, lows };
}

/** Ordinary-least-squares line through swing points `{idx, price}`. */
export function fitTrendline(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const n = points.length;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sx += p.idx;
    sy += p.price;
    sxy += p.idx * p.price;
    sxx += p.idx * p.idx;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-10) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null;
  return { slope, intercept };
}

export function lineValueAt(fit, idx) {
  if (!fit || !Number.isFinite(idx)) return null;
  const v = fit.intercept + fit.slope * idx;
  return Number.isFinite(v) ? v : null;
}

function rnd(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

function breakBuffer(price, atr14) {
  const pct = price * BREAK_BUFFER_PCT;
  const atr = Number.isFinite(atr14) && atr14 > 0 ? atr14 * BREAK_BUFFER_ATR : 0;
  return Math.max(pct, atr);
}

function approachWindow(price, atr14) {
  const pct = price * APPROACH_PCT;
  const atr = Number.isFinite(atr14) && atr14 > 0 ? atr14 * APPROACH_ATR : 0;
  return Math.max(pct, atr);
}

function slopeFloor(price) {
  return Math.max(price * SLOPE_PCT_PER_BAR, 1e-8);
}

function spanOk(points) {
  if (!points || points.length < 2) return false;
  return (points[points.length - 1].idx - points[0].idx) >= MIN_SWING_SPAN;
}

/**
 * Close through a descending resistance (LONG) or ascending support (SHORT).
 * Returns null when there is no structured line or no this-bar event.
 */
export function detectTrendlineBreak(dailyBars, {
  price = null,
  atr14 = null,
} = {}) {
  const bars = normalizeDailyBars(dailyBars);
  if (bars.length < MIN_BARS) return null;

  const lastIdx = bars.length - 1;
  const px = _n(price) || bars[lastIdx].c;
  if (!Number.isFinite(px) || px <= 0) return null;
  const prevClose = bars[lastIdx - 1]?.c;
  if (!Number.isFinite(prevClose) || prevClose <= 0) return null;

  const { highs, lows } = detectSwingPoints(bars, SWING_LOOKBACK);
  const recentHighs = highs.slice(-RECENT_SWINGS);
  const recentLows = lows.slice(-RECENT_SWINGS);
  const atr = _n(atr14);
  const buffer = breakBuffer(px, atr);
  const approach = approachWindow(px, atr);
  const minSlope = slopeFloor(px);

  const candidates = [];

  if (spanOk(recentHighs)) {
    const fit = fitTrendline(recentHighs);
    const line = lineValueAt(fit, lastIdx);
    if (fit && Number.isFinite(line) && line > 0 && fit.slope < -minSlope) {
      const through = px > line + buffer;
      const intactPrev = prevClose <= line + buffer;
      const dist = px - line;
      const late = Number.isFinite(atr) && atr > 0 && dist > LATE_ATR * atr;
      const near = !through && px >= line - approach && px <= line + buffer;
      candidates.push({
        side: "resistance",
        dir: "LONG",
        fit,
        line,
        touches: recentHighs.length,
        through,
        intactPrev,
        late,
        near,
        dist,
      });
    }
  }

  if (spanOk(recentLows)) {
    const fit = fitTrendline(recentLows);
    const line = lineValueAt(fit, lastIdx);
    if (fit && Number.isFinite(line) && line > 0 && fit.slope > minSlope) {
      const through = px < line - buffer;
      const intactPrev = prevClose >= line - buffer;
      const dist = line - px;
      const late = Number.isFinite(atr) && atr > 0 && dist > LATE_ATR * atr;
      const near = !through && px <= line + approach && px >= line - buffer;
      candidates.push({
        side: "support",
        dir: "SHORT",
        fit,
        line,
        touches: recentLows.length,
        through,
        intactPrev,
        late,
        near,
        dist,
      });
    }
  }

  const fired = candidates.find((c) => c.through && c.intactPrev && !c.late);
  if (fired) {
    return {
      active: true,
      approaching: false,
      dir: fired.dir,
      kind: "trendline",
      side: fired.side,
      reason: fired.dir === "SHORT"
        ? "ascending_support_tl_broke"
        : "descending_resistance_tl_broke",
      line: rnd(fired.line),
      slope: rnd(fired.fit.slope, 4),
      touches: fired.touches,
      close: rnd(px),
      prev_close: rnd(prevClose),
      distance_pct: rnd((fired.dist / px) * 100, 3),
    };
  }

  const approaching = candidates
    .filter((c) => c.near)
    .sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist))[0];
  if (approaching) {
    return {
      active: false,
      approaching: true,
      dir: approaching.dir,
      kind: "trendline",
      side: approaching.side,
      reason: approaching.dir === "SHORT"
        ? "approaching_support_tl"
        : "approaching_resistance_tl",
      line: rnd(approaching.line),
      slope: rnd(approaching.fit.slope, 4),
      touches: approaching.touches,
      close: rnd(px),
      prev_close: rnd(prevClose),
      distance_pct: rnd((approaching.dist / px) * 100, 3),
    };
  }

  return null;
}

function fromExistingBreakout(existingBreakout) {
  if (!existingBreakout || typeof existingBreakout !== "object") return null;
  const dir = String(existingBreakout.dir || "").toUpperCase();
  if (dir !== "LONG" && dir !== "SHORT") return null;
  const kind = String(existingBreakout.type || "daily_level");
  return {
    active: true,
    approaching: false,
    dir,
    kind,
    side: dir === "SHORT" ? "support" : "resistance",
    reason: `level_breakout:${kind}`,
    line: rnd(existingBreakout.level) || null,
    slope: null,
    touches: null,
    close: null,
    prev_close: null,
    rvol: _n(existingBreakout.rvol),
    distance_atr: _n(existingBreakout.distance_atr),
  };
}

/**
 * Merge the existing `detectBreakout()` hit with a trendline event.
 * Level/ATR/EMA stack wins the `kind` when both fire; the trendline is
 * noted on `also_trendline` so the desk still sees the structure break.
 */
export function evaluateBreakoutWatch({
  dailyBars = [],
  price = null,
  existingBreakout = null,
  atr14 = null,
} = {}) {
  const level = fromExistingBreakout(existingBreakout);
  const trend = detectTrendlineBreak(dailyBars, { price, atr14 });

  if (level && trend?.active) {
    return {
      ...level,
      also_trendline: true,
      trendline: {
        line: trend.line,
        slope: trend.slope,
        touches: trend.touches,
        side: trend.side,
        reason: trend.reason,
      },
    };
  }
  if (level) {
    return {
      ...level,
      also_trendline: false,
      trendline: trend && (trend.active || trend.approaching) ? {
        line: trend.line,
        slope: trend.slope,
        touches: trend.touches,
        side: trend.side,
        reason: trend.reason,
        approaching: !!trend.approaching,
      } : null,
    };
  }
  return trend;
}

export function stampBreakoutWatchOnTicker(tickerData, watch) {
  if (!tickerData || typeof tickerData !== "object") return tickerData;
  if (!watch) return tickerData;
  tickerData._breakout_watch = watch;
  tickerData.breakout_watch = watch;
  tickerData.flags = tickerData.flags && typeof tickerData.flags === "object"
    ? tickerData.flags
    : {};
  if (watch.active) {
    tickerData.flags.breakout_watch = true;
    tickerData.flags.breakout_watch_dir = watch.dir;
    tickerData.flags.breakout_watch_kind = watch.kind;
  } else {
    tickerData.flags.breakout_watch = false;
  }
  return tickerData;
}

export function readBreakoutWatch(tickerData) {
  return tickerData?._breakout_watch || tickerData?.breakout_watch || null;
}

/** Fired watch only. Approaching stays in the watch lane. */
export function shouldPromoteBreakoutWatchToSetup(tickerData) {
  const watch = readBreakoutWatch(tickerData);
  if (watch?.active === true) {
    const dir = String(watch.dir || "").toUpperCase();
    return dir === "LONG" || dir === "SHORT";
  }
  return tickerData?.flags?.breakout_watch === true;
}

export function breakoutWatchSetupReason(tickerData) {
  const watch = readBreakoutWatch(tickerData);
  if (!watch?.active) return null;
  const kind = watch.kind || "unknown";
  const dir = String(watch.dir || "").toUpperCase();
  return `breakout_watch:${kind}:${dir}`;
}

/** Operator-facing kanban / explain copy. No second-person. */
export function breakoutWatchLookForEntryCopy(watch) {
  if (!watch?.active) return null;
  if (watch.kind === "trendline") {
    return watch.dir === "SHORT"
      ? "Ascending support trendline broke — look for a good entry"
      : "Descending resistance trendline broke — look for a good entry";
  }
  if (watch.also_trendline) {
    return "Level and trendline breakout — look for a good entry";
  }
  return "Level breakout — look for a good entry";
}
