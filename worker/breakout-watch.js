/**
 * Breakout watch — level + trendline + retest.
 *
 * Watch / setup only. Not a new auto-buy path. Setup grade and
 * `qualifiesForEnter` stay unchanged. Do not add `tt_trendline_breakout`.
 *
 * Setup promotion is narrow: trendline close-through (with volume),
 * daily-level break, or a pullback retest of a broken line.
 * ATR / EMA-stack hits stay on the payload for rank and the existing
 * entry path — they do not flood the Setup lane.
 */

const MIN_BARS = 15;
const SWING_LOOKBACK = 2;
const CANDIDATE_SWINGS = 8;
const MIN_SWING_SPAN = 5;
const FIT_EXCLUDE_RECENT = 4;
const LATE_ATR = 3;
const SLOPE_PCT_PER_BAR = 0.0004;
const BREAK_BUFFER_PCT = 0.0015;
const BREAK_BUFFER_ATR = 0.1;
const APPROACH_PCT = 0.012;
const APPROACH_ATR = 0.5;
const TOUCH_PCT = 0.0025;
const TOUCH_ATR = 0.15;
const RETEST_LOOKBACK = 15;
const RVOL_AVG_BARS = 20;

export const SETUP_BREAKOUT_KINDS = new Set(["trendline", "daily_level"]);
export const TRENDLINE_FIRE_MIN_RVOL = 1.15;

function _n(v) {
  if (v == null || v === "") return null;
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

function _barVol(bar) {
  return _n(bar?.v ?? bar?.volume) || 0;
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
      v: _barVol(bar),
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

function touchTol(price, atr14) {
  const pct = price * TOUCH_PCT;
  const atr = Number.isFinite(atr14) && atr14 > 0 ? atr14 * TOUCH_ATR : 0;
  return Math.max(pct, atr);
}

function slopeFloor(price) {
  return Math.max(price * SLOPE_PCT_PER_BAR, 1e-8);
}

/** Last-bar volume vs the prior 20-bar average. */
export function computeBarRvol(dailyBars) {
  const bars = Array.isArray(dailyBars) ? dailyBars : [];
  if (bars.length < 6) return null;
  const last = _barVol(bars[bars.length - 1]);
  if (!(last > 0)) return null;
  const prior = bars.slice(Math.max(0, bars.length - 1 - RVOL_AVG_BARS), -1);
  let sum = 0;
  let n = 0;
  for (const b of prior) {
    const v = _barVol(b);
    if (v > 0) {
      sum += v;
      n += 1;
    }
  }
  if (n < 5 || sum <= 0) return null;
  return last / (sum / n);
}

/**
 * Chart-style 2–3 touch line: pair recent swings, keep pairs that other
 * swings do not pierce, count extra touches. Prefer more touches, then
 * longer span, then a more recent last touch.
 */
export function fitVisualTrendline(points, {
  side,
  lastIdx,
  price,
  atr14 = null,
} = {}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  if (side !== "resistance" && side !== "support") return null;
  const cutoff = Number.isFinite(lastIdx) ? lastIdx - FIT_EXCLUDE_RECENT : Infinity;
  const pts = points.filter((p) => p.idx <= cutoff).slice(-CANDIDATE_SWINGS);
  if (pts.length < 2 || !Number.isFinite(lastIdx)) return null;
  const px = _n(price) || pts[pts.length - 1].price;
  const tol = touchTol(px, atr14);
  const minSlope = slopeFloor(px);
  let best = null;

  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i];
      const b = pts[j];
      const span = b.idx - a.idx;
      if (span < MIN_SWING_SPAN) continue;
      const slope = (b.price - a.price) / span;
      if (!Number.isFinite(slope)) continue;
      if (side === "resistance" && slope >= -minSlope) continue;
      if (side === "support" && slope <= minSlope) continue;
      const intercept = a.price - slope * a.idx;
      if (!Number.isFinite(intercept)) continue;

      let extraTouches = 0;
      let pierces = 0;
      for (const p of pts) {
        if (p.idx === a.idx || p.idx === b.idx) continue;
        const lv = intercept + slope * p.idx;
        const wrongSide = side === "resistance" ? (p.price - lv) : (lv - p.price);
        if (wrongSide > tol) pierces += 1;
        else if (Math.abs(p.price - lv) <= tol) extraTouches += 1;
      }
      if (pierces > 0) continue;

      const line = intercept + slope * lastIdx;
      if (!Number.isFinite(line) || line <= 0) continue;
      const touches = 2 + extraTouches;
      const score = touches * 10000 + span * 10 + b.idx;
      if (!best || score > best.score) {
        best = {
          slope,
          intercept,
          touches,
          span,
          line,
          score,
          lastTouchIdx: b.idx,
          side,
        };
      }
    }
  }
  return best;
}

function payloadFromLine({
  fit,
  dir,
  side,
  px,
  prevClose,
  atr,
  rvol,
  through,
  intactPrev,
  late,
  near,
  fromBreakoutSide,
  brokeIdx,
}) {
  const dist = dir === "SHORT" ? (fit.line - px) : (px - fit.line);
  const base = {
    dir,
    kind: "trendline",
    side,
    line: rnd(fit.line),
    slope: rnd(fit.slope, 4),
    intercept: rnd(fit.intercept, 4),
    touches: fit.touches,
    close: rnd(px),
    prev_close: rnd(prevClose),
    distance_pct: rnd((dist / px) * 100, 3),
    rvol: rvol != null ? rnd(rvol, 2) : null,
    promotes_setup: false,
    active: false,
    approaching: false,
    retest: false,
  };

  if (through && intactPrev && !late && rvol != null && rvol >= TRENDLINE_FIRE_MIN_RVOL) {
    return {
      ...base,
      active: true,
      promotes_setup: true,
      broken: true,
      reason: dir === "SHORT"
        ? "ascending_support_tl_broke"
        : "descending_resistance_tl_broke",
    };
  }

  if (through && intactPrev && !late && !(rvol >= TRENDLINE_FIRE_MIN_RVOL)) {
    return {
      ...base,
      approaching: true,
      reason: "tl_through_low_rvol",
    };
  }

  if (fromBreakoutSide && near && !through) {
    return {
      ...base,
      retest: true,
      promotes_setup: true,
      broken: true,
      broke_idx: brokeIdx,
      reason: dir === "SHORT"
        ? "broken_support_retest"
        : "broken_resistance_retest",
    };
  }

  if (near && !through) {
    return {
      ...base,
      approaching: true,
      reason: dir === "SHORT"
        ? "approaching_support_tl"
        : "approaching_resistance_tl",
    };
  }

  if (late && through) return null;
  return null;
}

function classifyAgainstLine(fit, {
  dir,
  side,
  px,
  prevClose,
  atr,
  rvol,
  lastIdx,
  bars,
  priorWatch,
}) {
  const buffer = breakBuffer(px, atr);
  const approach = approachWindow(px, atr);
  const through = dir === "SHORT" ? (px < fit.line - buffer) : (px > fit.line + buffer);
  const intactPrev = dir === "SHORT"
    ? (prevClose >= fit.line - buffer)
    : (prevClose <= fit.line + buffer);
  const dist = dir === "SHORT" ? (fit.line - px) : (px - fit.line);
  const late = Number.isFinite(atr) && atr > 0 && through && dist > LATE_ATR * atr;
  const near = Math.abs(px - fit.line) <= approach;

  let brokeIdx = null;
  const start = Math.max(0, lastIdx - RETEST_LOOKBACK);
  for (let i = lastIdx - 1; i >= start; i--) {
    const lv = lineValueAt(fit, i);
    const c = bars[i]?.c;
    if (!Number.isFinite(lv) || !Number.isFinite(c)) continue;
    if (dir === "LONG" && c > lv + buffer) {
      brokeIdx = i;
      break;
    }
    if (dir === "SHORT" && c < lv - buffer) {
      brokeIdx = i;
      break;
    }
  }
  if (brokeIdx == null && priorWatch?.broken === true && String(priorWatch.dir || "").toUpperCase() === dir) {
    brokeIdx = _n(priorWatch.broke_idx);
    if (brokeIdx == null) brokeIdx = lastIdx - 2;
  }

  const fromBreakoutSide = brokeIdx != null && (
    dir === "LONG" ? px >= fit.line - buffer : px <= fit.line + buffer
  );

  return payloadFromLine({
    fit,
    dir,
    side,
    px,
    prevClose,
    atr,
    rvol,
    through,
    intactPrev,
    late,
    near,
    fromBreakoutSide,
    brokeIdx,
  });
}

/**
 * Close through a 2–3 touch descending resistance (LONG) or ascending
 * support (SHORT). Low-volume pierces stay approaching. A pullback to
 * a recently broken line is a retest.
 */
export function detectTrendlineBreak(dailyBars, {
  price = null,
  atr14 = null,
  rvol = null,
  priorWatch = null,
} = {}) {
  const bars = normalizeDailyBars(dailyBars);
  if (bars.length < MIN_BARS) return null;

  const lastIdx = bars.length - 1;
  const px = _n(price) || bars[lastIdx].c;
  if (!Number.isFinite(px) || px <= 0) return null;
  const prevClose = bars[lastIdx - 1]?.c;
  if (!Number.isFinite(prevClose) || prevClose <= 0) return null;

  const { highs, lows } = detectSwingPoints(bars, SWING_LOOKBACK);
  const atr = _n(atr14);
  const resolvedRvol = _n(rvol) ?? computeBarRvol(bars);

  const resistance = fitVisualTrendline(highs, {
    side: "resistance",
    lastIdx,
    price: px,
    atr14: atr,
  });
  const support = fitVisualTrendline(lows, {
    side: "support",
    lastIdx,
    price: px,
    atr14: atr,
  });

  const candidates = [];
  if (resistance) {
    const hit = classifyAgainstLine(resistance, {
      dir: "LONG",
      side: "resistance",
      px,
      prevClose,
      atr,
      rvol: resolvedRvol,
      lastIdx,
      bars,
      priorWatch,
    });
    if (hit) candidates.push(hit);
  }
  if (support) {
    const hit = classifyAgainstLine(support, {
      dir: "SHORT",
      side: "support",
      px,
      prevClose,
      atr,
      rvol: resolvedRvol,
      lastIdx,
      bars,
      priorWatch,
    });
    if (hit) candidates.push(hit);
  }

  const rank = (h) => {
    if (h.retest) return 3;
    if (h.active) return 2;
    if (h.approaching) return 1;
    return 0;
  };
  candidates.sort((a, b) => rank(b) - rank(a));
  return candidates[0] || null;
}

function fromExistingBreakout(existingBreakout) {
  if (!existingBreakout || typeof existingBreakout !== "object") return null;
  const dir = String(existingBreakout.dir || "").toUpperCase();
  if (dir !== "LONG" && dir !== "SHORT") return null;
  const kind = String(existingBreakout.type || "daily_level");
  const promotes = SETUP_BREAKOUT_KINDS.has(kind);
  return {
    active: true,
    approaching: false,
    retest: false,
    promotes_setup: promotes,
    dir,
    kind,
    side: dir === "SHORT" ? "support" : "resistance",
    reason: `level_breakout:${kind}`,
    line: rnd(existingBreakout.level) || null,
    slope: null,
    intercept: null,
    touches: null,
    close: null,
    prev_close: null,
    rvol: _n(existingBreakout.rvol),
    distance_atr: _n(existingBreakout.distance_atr),
    informational: !promotes,
  };
}

/**
 * Merge `detectBreakout()` with the visual trendline event.
 * Daily-level and trendline fire/retest promote to Setup.
 * ATR / EMA stack remain informational.
 */
export function evaluateBreakoutWatch({
  dailyBars = [],
  price = null,
  existingBreakout = null,
  atr14 = null,
  rvol = null,
  priorWatch = null,
} = {}) {
  const level = fromExistingBreakout(existingBreakout);
  const trend = detectTrendlineBreak(dailyBars, {
    price,
    atr14,
    rvol,
    priorWatch,
  });

  if (level?.promotes_setup) {
    const out = {
      ...level,
      also_trendline: !!(trend && (trend.active || trend.retest)),
      trendline: trend && (trend.active || trend.approaching || trend.retest) ? {
        line: trend.line,
        slope: trend.slope,
        intercept: trend.intercept,
        touches: trend.touches,
        side: trend.side,
        reason: trend.reason,
        approaching: !!trend.approaching,
        retest: !!trend.retest,
      } : null,
    };
    if (trend?.retest && !level.active) {
      return { ...trend, also_daily_level: true };
    }
    return out;
  }

  if (trend && (trend.retest || trend.active || trend.approaching)) {
    return {
      ...trend,
      also_trendline: false,
      informational_breakout: level?.informational ? {
        kind: level.kind,
        dir: level.dir,
        reason: level.reason,
      } : null,
    };
  }

  if (level) return level;
  return null;
}

export function watchPromotesToSetup(watch) {
  if (!watch || typeof watch !== "object") return false;
  if (watch.promotes_setup === true) return true;
  if (watch.retest === true) return true;
  if (watch.active === true && SETUP_BREAKOUT_KINDS.has(String(watch.kind || ""))) {
    return true;
  }
  return false;
}

export function stampBreakoutWatchOnTicker(tickerData, watch) {
  if (!tickerData || typeof tickerData !== "object") return tickerData;
  if (!watch) return tickerData;
  tickerData._breakout_watch = watch;
  tickerData.breakout_watch = watch;
  tickerData.flags = tickerData.flags && typeof tickerData.flags === "object"
    ? tickerData.flags
    : {};
  const promote = watchPromotesToSetup(watch);
  tickerData.flags.breakout_watch = promote;
  tickerData.flags.breakout_approaching = !!(watch.approaching && !promote);
  tickerData.flags.breakout_retest = watch.retest === true;
  if (promote || watch.approaching) {
    tickerData.flags.breakout_watch_dir = watch.dir;
    tickerData.flags.breakout_watch_kind = watch.kind;
  }
  return tickerData;
}

export function readBreakoutWatch(tickerData) {
  return tickerData?._breakout_watch || tickerData?.breakout_watch || null;
}

/** Fired daily-level / trendline, or a retest. Approaching stays watch. */
export function shouldPromoteBreakoutWatchToSetup(tickerData) {
  const watch = readBreakoutWatch(tickerData);
  if (watch) return watchPromotesToSetup(watch);
  const kind = String(tickerData?.flags?.breakout_watch_kind || "");
  if (tickerData?.flags?.breakout_retest === true) return true;
  if (tickerData?.flags?.breakout_watch === true) {
    return !kind || SETUP_BREAKOUT_KINDS.has(kind);
  }
  return false;
}

export function breakoutWatchSetupReason(tickerData) {
  const watch = readBreakoutWatch(tickerData);
  if (!watchPromotesToSetup(watch) && !tickerData?.flags?.breakout_watch) return null;
  if (watch?.retest) {
    return `breakout_watch:retest:${String(watch.dir || "").toUpperCase()}`;
  }
  const kind = watch?.kind || tickerData?.flags?.breakout_watch_kind || "unknown";
  const dir = String(watch?.dir || tickerData?.flags?.breakout_watch_dir || "").toUpperCase();
  return `breakout_watch:${kind}:${dir}`;
}

/** Operator-facing kanban / explain / badge copy. No second-person. */
export function breakoutWatchLookForEntryCopy(watch) {
  if (!watch) return null;
  if (watch.retest) {
    return watch.dir === "SHORT"
      ? "Broken support retest — look for a good entry"
      : "Broken resistance retest — look for a good entry";
  }
  if (watchPromotesToSetup(watch) && watch.kind === "trendline") {
    return watch.dir === "SHORT"
      ? "Ascending support trendline broke — look for a good entry"
      : "Descending resistance trendline broke — look for a good entry";
  }
  if (watchPromotesToSetup(watch) && watch.also_trendline) {
    return "Level and trendline breakout — look for a good entry";
  }
  if (watchPromotesToSetup(watch)) {
    return "Level breakout — look for a good entry";
  }
  if (watch.reason === "tl_through_low_rvol") {
    return "Trendline pierced without volume — watching for a real break";
  }
  if (watch.approaching) {
    return watch.dir === "SHORT"
      ? "Ascending support trendline nearby — watching for a break"
      : "Descending resistance trendline nearby — watching for a break";
  }
  return null;
}

export function breakoutWatchDeskBadge(tickerData) {
  const watch = readBreakoutWatch(tickerData) || {};
  const flags = tickerData?.flags || {};
  if (flags.breakout_retest || watch.retest) {
    return {
      label: "Retest",
      title: breakoutWatchLookForEntryCopy({ ...watch, retest: true }) || "Broken trendline retest — look for a good entry",
      phase: "retest",
    };
  }
  if (watchPromotesToSetup(watch) || flags.breakout_watch) {
    return {
      label: "Breakout",
      title: breakoutWatchLookForEntryCopy(watch) || "Level or trendline breakout — look for a good entry",
      phase: "fired",
    };
  }
  if (flags.breakout_approaching || watch.approaching) {
    return {
      label: "TL Watch",
      title: breakoutWatchLookForEntryCopy(watch) || "Trendline nearby — watching for a break",
      phase: "approaching",
    };
  }
  return null;
}
