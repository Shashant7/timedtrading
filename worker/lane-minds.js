// worker/lane-minds.js
//
// Each model lane trades with a different mind. Mixing them is how day-trade
// whipsaws eat Short Term and Investor P&L: the same clock, the same
// portfolio pause, or the same "try again" reflex applied to three horizons.
//
// This module is the closed set of lane policies. Callers pass the numbers
// they already have (stop streak, cooldown age); the mind decides the gate.

export const LANE_MINDS = Object.freeze({
  day_trade: Object.freeze({
    id: "day_trade",
    label: "Day trader",
    // Protective: cut losers fast, do not re-fire into the same print.
    protective: true,
    thesis_exit: true,
    or_break_buffer: true,
    reentry_cooldown_ms: 10 * 60 * 1000,
    // After this many STOP exits on one underlying in the NY session, stand
    // down. 2026-09-23/25 whipsaw days stacked 3+ stops on the same name
    // and the later rounds were the ones that paid the book.
    max_session_stops: 3,
    // Week ending 2026-09-25: first entry/underlying/day +$410 (50% WR);
    // re-entries −$1,224 (8% WR). One round per call/put side per NY day
    // unless the day lean flipped; never re-buy after a green profit_lock.
    one_round_per_side: true,
    block_rebuy_after_green_profit_lock: true,
    // Own daily loss budget — never the Short Term equity-curve breaker.
    shares_portfolio_risk: false,
  }),
  short_term: Object.freeze({
    id: "short_term",
    label: "Swing trader",
    protective: false,
    // Structural / conviction holds stay OFF until cv-* arms are re-run on
    // the post-look-ahead (barsAsOf) tape. Look-ahead itself is fixed
    // (aea91b5ec); the prior negative A/B was measured with the leak.
    conviction_structural: false,
    shares_portfolio_risk: true,
    ignore_dt_clock: true,
  }),
  investor: Object.freeze({
    id: "investor",
    label: "Investor",
    protective: false,
    zone_driven: true,
    ignore_dt_clock: true,
    shares_portfolio_risk: false,
  }),
});

export function laneMind(lane) {
  const key = String(lane || "").toLowerCase();
  if (key === "day_trade" || key === "index_dt" || key === "dt") return LANE_MINDS.day_trade;
  if (key === "short_term" || key === "trader" || key === "st") return LANE_MINDS.short_term;
  if (key === "investor" || key === "long_term" || key === "lt") return LANE_MINDS.investor;
  return null;
}

/**
 * Day-trade mind: stand down after too many stops on one name today.
 * Returns a block reason or null.
 */
export function dayTradeEntryBlock({
  sessionStopCount = 0,
  mind = LANE_MINDS.day_trade,
} = {}) {
  const max = Number(mind?.max_session_stops);
  const n = Math.max(0, Math.round(Number(sessionStopCount) || 0));
  if (Number.isFinite(max) && max > 0 && n >= max) {
    return "session_stop_stand_down";
  }
  return null;
}

/**
 * Normalize index day-trade side from a call/put flavor.
 * @returns {"call"|"put"|null}
 */
export function dayTradeSideFromFlavor(flavor) {
  const f = String(flavor || "").toLowerCase();
  if (f === "call" || f === "c" || f === "long_call") return "call";
  if (f === "put" || f === "p" || f === "long_put") return "put";
  return null;
}

/** Normalize a day-lean string for equality (bull/bear/neutral). */
export function normalizeDayLean(lean) {
  const s = String(lean || "").trim().toLowerCase();
  if (!s) return "";
  if (/(bull|long|call|up)/.test(s)) return "bull";
  if (/(bear|short|put|down)/.test(s)) return "bear";
  if (/neutral|flat|none/.test(s)) return "neutral";
  return s;
}

/**
 * Session re-entry policy for index day trades (beyond the 10m cooldown).
 * Returns a block reason or null.
 *
 * Week ending 2026-09-25: first entries paid; re-entries after a green
 * profit_lock or a second try on the same call/put side destroyed the day.
 *
 * @param {object} args
 * @param {string} args.side  "call" | "put" (or flavor synonym)
 * @param {string|null} args.leanNow  current day lean
 * @param {Array<{side?:string,lean?:string}>} args.sessionRounds
 * @param {{reason?:string,green?:boolean,ts?:number}|null} args.lastClose
 * @param {number} args.now
 * @param {object} args.mind
 */
export function dayTradeSessionReentryBlock({
  side = null,
  leanNow = null,
  sessionRounds = [],
  lastClose = null,
  now = Date.now(),
  mind = LANE_MINDS.day_trade,
} = {}) {
  const dayKey = nySessionDayKey(now);
  if (mind?.block_rebuy_after_green_profit_lock !== false) {
    const reason = String(lastClose?.reason || "").toLowerCase();
    const closeDay = lastClose?.ts ? nySessionDayKey(lastClose.ts) : null;
    if (reason === "profit_lock_stop" && lastClose?.green === true && closeDay === dayKey) {
      return "post_profit_lock_no_rebuy";
    }
  }
  if (mind?.one_round_per_side === false) return null;
  const resolvedSide = dayTradeSideFromFlavor(side);
  if (!resolvedSide) return null;
  const lean = normalizeDayLean(leanNow);
  const rounds = Array.isArray(sessionRounds) ? sessionRounds : [];
  const prior = rounds.find((r) => dayTradeSideFromFlavor(r?.side) === resolvedSide);
  if (!prior) return null;
  const priorLean = normalizeDayLean(prior.lean);
  if (lean && priorLean && lean !== priorLean) return null; // lean flipped — allow
  return "one_round_per_side_today";
}

/** NY calendar day key for per-session counters. */
export function nySessionDayKey(now = Date.now()) {
  return new Date(now).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function dayTradeStopStreakKey(ticker, now = Date.now()) {
  const sym = String(ticker || "").toUpperCase();
  return `timed:opt-dt:stop-streak:${sym}:${nySessionDayKey(now)}`;
}

export function dayTradeSessionRoundsKey(ticker, now = Date.now()) {
  const sym = String(ticker || "").toUpperCase();
  return `timed:opt-dt:rounds:${sym}:${nySessionDayKey(now)}`;
}
