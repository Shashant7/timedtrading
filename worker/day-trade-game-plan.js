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

import {
  addDays,
  etDateStr,
  isTradingDay,
  sessionBoundsUtc,
} from "./foundation/trading-calendar.js";

export const INDEX_DAY_TRADE_ETFS = new Set(["SPY", "QQQ", "IWM", "DIA"]);

export const SATY_FIBS = [0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.236, 1.618];

const OR_WINDOW_MINUTES = 30;

function rnd(v) {
  return Math.round(Number(v) * 100) / 100;
}

function candleTs(c) {
  return Number(c?.ts ?? c?.t);
}

function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  const n = Number(now);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

/** Next session date if `now` is a weekend/holiday; otherwise today's ET date. */
export function gamePlanSessionDate(now = new Date()) {
  const ds = etDateStr(nowMs(now));
  if (isTradingDay(ds)) return ds;
  let cur = ds;
  for (let i = 0; i < 6; i++) {
    cur = addDays(cur, 1);
    if (isTradingDay(cur)) return cur;
  }
  return ds;
}

export function priorTradingDate(dateStr) {
  let cur = addDays(dateStr, -1);
  for (let i = 0; i < 10; i++) {
    if (isTradingDay(cur)) return cur;
    cur = addDays(cur, -1);
  }
  return cur;
}

/**
 * DST-correct RTH bounds for the game-plan session.
 * Do not hardcode 14:30/21:00 UTC — that is EST only. In EDT the cash
 * open is 13:30 UTC and the close is 20:00 UTC.
 */
export function gamePlanSessionBounds(now = new Date()) {
  const sessionDate = gamePlanSessionDate(now);
  const today = sessionBoundsUtc(sessionDate);
  const priorDate = priorTradingDate(sessionDate);
  const prior = sessionBoundsUtc(priorDate);
  if (!today) return null;
  return {
    sessionDate,
    priorDate,
    openMs: today.openMs,
    closeMs: today.closeMs,
    priorCloseMs: prior?.closeMs ?? null,
  };
}

/**
 * Overnight / pre-market range: prior RTH close (16:00 ET, early-close aware)
 * → today's RTH open (09:30 ET). Monday uses Friday's close.
 *
 * Never fall back onto today's RTH bars — that classifies the cash-session
 * bounce as "overnight" and then the delayed OR votes the other way.
 */
export function computeOvernightRangeFromM5(fiveMinCandles, now = new Date()) {
  if (!Array.isArray(fiveMinCandles) || fiveMinCandles.length === 0) return null;
  const bounds = gamePlanSessionBounds(now);
  if (!bounds?.openMs) return null;

  const rthOpenTs = bounds.openMs;
  const rthCloseTs = bounds.priorCloseMs;
  const overnightCandles = rthCloseTs != null
    ? fiveMinCandles.filter((c) => {
      const ts = candleTs(c);
      return ts >= rthCloseTs && ts < rthOpenTs;
    })
    : [];
  // Thin AH/premarket 5m is common. Use bars *before* today's open only —
  // last-60-of-everything included the cash bounce (2026-09-02 SPY).
  const preOpen = fiveMinCandles.filter((c) => {
    const ts = candleTs(c);
    return Number.isFinite(ts) && ts < rthOpenTs;
  });
  const usedOvernight = overnightCandles.length >= 3;
  const m5ForRange = usedOvernight ? overnightCandles : preOpen.slice(-60);
  const m5Highs = m5ForRange.map((c) => Number(c.h)).filter(Number.isFinite);
  const m5Lows = m5ForRange.map((c) => Number(c.l)).filter(Number.isFinite);
  if (m5Highs.length === 0 || m5Lows.length === 0) return null;
  return {
    high: rnd(Math.max(...m5Highs)),
    low: rnd(Math.min(...m5Lows)),
    source: usedOvernight ? "overnight_session" : "pre_open_fallback",
    window_start_ts: usedOvernight ? rthCloseTs : candleTs(m5ForRange[0]),
    window_end_ts: rthOpenTs,
  };
}

/**
 * RTH opening range (default first 30 minutes from the 09:30 ET cash open).
 * Uses all post-open bars available; `resolved` once the OR window has elapsed.
 */
export function computeOpeningRangeFromM5(fiveMinCandles, now = new Date(), windowMinutes = OR_WINDOW_MINUTES) {
  if (!Array.isArray(fiveMinCandles) || fiveMinCandles.length === 0) return null;
  const bounds = gamePlanSessionBounds(now);
  if (!bounds?.openMs) return null;

  const rthOpenTs = bounds.openMs;
  const windowEndTs = rthOpenTs + Number(windowMinutes) * 60_000;
  const nowTs = nowMs(now);

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
    window_start_ts: rthOpenTs,
    window_end_ts: windowEndTs,
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
  researchBias = 0,
  snakeCase = false,
}) {
  const px = Number(curPrice);
  const anc = Number(anchor);
  const atr = Number(dayAtr);
  if (!(px > 0 && anc > 0 && atr > 0)) return null;

  const dayLean = computeDayLean({ curPrice: px, anchor: anc, dayAtr: atr, overnightRange, openingRange, trendBias, researchBias });

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
  researchBias = 0,
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

  // Research desk posture (CRO/FSD structural view, e.g. STRATEGY_PHASE
  // scenario weights). Tertiary, bounded weight: it tilts the lean and is
  // always surfaced as a reason, but intraday price evidence (gap / overnight
  // / OR break, up to ±3.5) dominates so a multi-month desk view never
  // overrides the tape on a given day.
  const rb = Math.max(-1, Math.min(1, Number(researchBias) || 0));
  if (Math.abs(rb) >= 0.2) {
    score += rb * 0.5;
    reasons.push(rb > 0 ? "research desk constructive" : "research desk defensive");
  }

  const lean = score <= -1.5 ? "SHORT" : score >= 1.5 ? "LONG" : "NEUTRAL";
  const mag = Math.abs(score);
  const conviction = mag >= 3 ? "high" : mag >= 1.5 ? "medium" : "low";
  return { lean, score: rnd(score), conviction, reasons };
}

export function isIndexDayTradeEtf(ticker) {
  return INDEX_DAY_TRADE_ETFS.has(String(ticker || "").toUpperCase());
}
