/**
 * Day-trade game plan — overnight session + opening-range playbook.
 *
 * Shared by:
 *   - daily-brief.js `summarizeTechnical()` (morning archival + AI prompt)
 *   - ticker-scenario.js `buildTickerScenario()` (live Right Rail + Today page)
 *
 * Triggers:
 *   bull = max(overnight high, opening-range high, spot + 0.25 × day ATR)
 *   bear = min(overnight low,  opening-range low,  spot - 0.25 × day ATR)
 *
 * Targets: first Saty day-ATR fib past the trigger (min gap 0.4 × ATR or 0.3%),
 * with 0.75 × ATR projection fallback.
 */

export const INDEX_DAY_TRADE_ETFS = new Set(["SPY", "QQQ", "IWM", "DIA"]);

export const SATY_FIBS = [0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.236, 1.618];

const RTH_OPEN_UTC_H = 14;
const RTH_OPEN_UTC_M = 30;
const RTH_CLOSE_UTC_H = 21;
const OR_WINDOW_MINUTES = 30;

function rnd(v) {
  return Math.round(Number(v) * 100) / 100;
}

function candleTs(c) {
  return Number(c?.ts ?? c?.t);
}

/**
 * Overnight / pre-market range: prior RTH close (21:00 UTC) → today's RTH open (14:30 UTC).
 * Monday uses Friday's close as session start.
 */
export function computeOvernightRangeFromM5(fiveMinCandles, now = new Date()) {
  if (!Array.isArray(fiveMinCandles) || fiveMinCandles.length === 0) return null;

  const rthOpenToday = new Date(now);
  rthOpenToday.setUTCHours(RTH_OPEN_UTC_H, RTH_OPEN_UTC_M, 0, 0);
  const rthCloseYesterday = new Date(rthOpenToday);
  rthCloseYesterday.setUTCDate(rthCloseYesterday.getUTCDate() - 1);
  rthCloseYesterday.setUTCHours(RTH_CLOSE_UTC_H, 0, 0, 0);
  if (now.getUTCDay() === 1) {
    rthCloseYesterday.setUTCDate(rthCloseYesterday.getUTCDate() - 2);
  }

  const rthCloseTs = rthCloseYesterday.getTime();
  const rthOpenTs = rthOpenToday.getTime();
  const overnightCandles = fiveMinCandles.filter((c) => {
    const ts = candleTs(c);
    return ts >= rthCloseTs && ts < rthOpenTs;
  });
  const m5ForRange = overnightCandles.length >= 3
    ? overnightCandles
    : fiveMinCandles.slice(-60);
  const m5Highs = m5ForRange.map((c) => Number(c.h)).filter(Number.isFinite);
  const m5Lows = m5ForRange.map((c) => Number(c.l)).filter(Number.isFinite);
  if (m5Highs.length === 0 || m5Lows.length === 0) return null;
  return {
    high: rnd(Math.max(...m5Highs)),
    low: rnd(Math.min(...m5Lows)),
    source: overnightCandles.length >= 3 ? "overnight_session" : "m5_tail_fallback",
  };
}

/**
 * RTH opening range (default first 30 minutes). Uses all post-open bars available;
 * `resolved` once the OR window has elapsed.
 */
export function computeOpeningRangeFromM5(fiveMinCandles, now = new Date(), windowMinutes = OR_WINDOW_MINUTES) {
  if (!Array.isArray(fiveMinCandles) || fiveMinCandles.length === 0) return null;

  const rthOpenToday = new Date(now);
  rthOpenToday.setUTCHours(RTH_OPEN_UTC_H, RTH_OPEN_UTC_M, 0, 0);
  const windowEnd = new Date(rthOpenToday);
  windowEnd.setUTCMinutes(windowEnd.getUTCMinutes() + windowMinutes);

  const rthOpenTs = rthOpenToday.getTime();
  const windowEndTs = windowEnd.getTime();
  const nowTs = now.getTime();

  const postOpen = fiveMinCandles.filter((c) => {
    const ts = candleTs(c);
    return ts >= rthOpenTs && ts <= nowTs;
  });
  if (postOpen.length === 0) return null;

  const orSlice = postOpen.filter((c) => candleTs(c) < windowEndTs);
  const useCandles = nowTs >= windowEndTs && orSlice.length > 0 ? orSlice : postOpen;
  const highs = useCandles.map((c) => Number(c.h)).filter(Number.isFinite);
  const lows = useCandles.map((c) => Number(c.l)).filter(Number.isFinite);
  if (highs.length === 0 || lows.length === 0) return null;

  return {
    high: rnd(Math.max(...highs)),
    low: rnd(Math.min(...lows)),
    mid: rnd((Math.max(...highs) + Math.min(...lows)) / 2),
    resolved: nowTs >= windowEndTs,
    window_minutes: windowMinutes,
    bars: useCandles.length,
  };
}

/**
 * Build intraday bull/bear triggers + targets from overnight + opening range.
 *
 * @returns {object|null} camelCase (brief) or pass `snakeCase: true` for ticker-scenario
 */
export function buildOvernightDayTradeGamePlan({
  curPrice,
  anchor,
  dayAtr,
  overnightRange = null,
  openingRange = null,
  trendBias = 0,
  snakeCase = false,
}) {
  const px = Number(curPrice);
  const anc = Number(anchor);
  const atr = Number(dayAtr);
  if (!(px > 0 && anc > 0 && atr > 0)) return null;

  const dayLean = computeDayLean({ curPrice: px, anchor: anc, dayAtr: atr, overnightRange, openingRange, trendBias });

  const oHi = Number(overnightRange?.high) || px;
  const oLo = Number(overnightRange?.low) || px;
  const orHi = openingRange ? (Number(openingRange.high) || oHi) : oHi;
  const orLo = openingRange ? (Number(openingRange.low) || oLo) : oLo;

  const bullTrig = Math.max(rnd(oHi), rnd(orHi), rnd(px + atr * 0.25));
  const bearTrig = Math.min(rnd(oLo), rnd(orLo), rnd(px - atr * 0.25));

  const allUpFibs = SATY_FIBS.map((f) => rnd(anc + atr * f));
  const allDnFibs = SATY_FIBS.map((f) => rnd(anc - atr * f));
  const minGap = Math.max(atr * 0.40, px * 0.003);

  const bullTargetFib = allUpFibs.find((t) => t >= bullTrig + minGap);
  const bearTargetFib = allDnFibs.slice().reverse().find((t) => t <= bearTrig - minGap);
  const bullTgt = bullTargetFib != null
    ? bullTargetFib
    : rnd(bullTrig + Math.max(atr * 0.75, minGap));
  const bearTgt = bearTargetFib != null
    ? bearTargetFib
    : rnd(bearTrig - Math.max(atr * 0.75, minGap));

  const plan = {
    bullTrigger: bullTrig,
    bullTarget: Math.max(bullTgt, rnd(bullTrig + minGap)),
    bearTrigger: bearTrig,
    bearTarget: Math.min(bearTgt, rnd(bearTrig - minGap)),
    min_gap: rnd(minGap),
    playbook: "overnight_or",
    overnight_range: overnightRange,
    opening_range: openingRange,
    // Directional lean so the brief leads with the favored side instead of
    // presenting bull/bear symmetrically.
    lean: dayLean.lean,
    lean_score: dayLean.score,
    lean_conviction: dayLean.conviction,
    lean_reasons: dayLean.reasons,
  };

  if (!snakeCase) return plan;

  return {
    bull_trigger: plan.bullTrigger,
    bull_target: plan.bullTarget,
    bear_trigger: plan.bearTrigger,
    bear_target: plan.bearTarget,
    min_gap: plan.min_gap,
    playbook: plan.playbook,
    overnight_range: plan.overnight_range,
    opening_range: plan.opening_range,
    lean: plan.lean,
    lean_score: plan.lean_score,
    lean_conviction: plan.lean_conviction,
    lean_reasons: plan.lean_reasons,
  };
}

/**
 * Day-trade directional LEAN — answers "which way is the tape leaning TODAY?"
 *
 * The Day Trader only cares about today/tomorrow, distinct from the
 * Active Trader's multi-day `state` bias (HTF_BULL/BEAR). The prior game plan
 * emitted bull AND bear triggers symmetrically, leaving the reader with no
 * edge ("too many competing layers"). This collapses the near-term evidence
 * into a single favored side so the brief can LEAD with it.
 *
 * Evidence (each contributes to a signed score):
 *   - gap vs prior close (normalized by day ATR)
 *   - position vs the overnight-range midpoint
 *   - opening-range break (only once the OR window has resolved) — strongest
 *   - `trendBias` from the caller: daily structure / regime (−1..+1)
 *
 * @returns {{ lean: "LONG"|"SHORT"|"NEUTRAL", score:number, conviction:"high"|"medium"|"low", reasons:string[] }}
 */
export function computeDayLean({
  curPrice,
  anchor,
  dayAtr,
  overnightRange = null,
  openingRange = null,
  trendBias = 0,
} = {}) {
  const px = Number(curPrice);
  const anc = Number(anchor);
  const atr = Number(dayAtr);
  let score = 0;
  const reasons = [];

  if (px > 0 && anc > 0 && atr > 0) {
    const gapAtr = (px - anc) / atr;
    if (gapAtr <= -0.12) { score -= 1; reasons.push("trading below the prior close"); }
    else if (gapAtr >= 0.12) { score += 1; reasons.push("trading above the prior close"); }
  }

  if (overnightRange && Number.isFinite(Number(overnightRange.high)) && Number.isFinite(Number(overnightRange.low))) {
    const hi = Number(overnightRange.high);
    const lo = Number(overnightRange.low);
    const mid = (hi + lo) / 2;
    const band = Math.max((hi - lo) * 0.1, 1e-9);
    if (px < mid - band) { score -= 1; reasons.push("under the overnight midpoint"); }
    else if (px > mid + band) { score += 1; reasons.push("over the overnight midpoint"); }
  }

  // Opening-range break is the highest-conviction intraday tell, but only
  // once the OR window has resolved (otherwise it's noise).
  if (openingRange && openingRange.resolved) {
    const orHi = Number(openingRange.high);
    const orLo = Number(openingRange.low);
    if (Number.isFinite(orLo) && px < orLo) { score -= 1.5; reasons.push("broke the opening range low"); }
    else if (Number.isFinite(orHi) && px > orHi) { score += 1.5; reasons.push("broke the opening range high"); }
  }

  const tb = Math.max(-1, Math.min(1, Number(trendBias) || 0));
  if (tb <= -0.34) { score += tb; reasons.push("daily structure is down"); }
  else if (tb >= 0.34) { score += tb; reasons.push("daily structure is up"); }

  const lean = score <= -1.5 ? "SHORT" : score >= 1.5 ? "LONG" : "NEUTRAL";
  const mag = Math.abs(score);
  const conviction = mag >= 3 ? "high" : mag >= 1.5 ? "medium" : "low";
  return { lean, score: rnd(score), conviction, reasons };
}

export function isIndexDayTradeEtf(ticker) {
  return INDEX_DAY_TRADE_ETFS.has(String(ticker || "").toUpperCase());
}
