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
    // Own daily loss budget — never the Short Term equity-curve breaker.
    shares_portfolio_risk: false,
  }),
  short_term: Object.freeze({
    id: "short_term",
    label: "Swing trader",
    protective: false,
    // Structural / conviction holds stay OFF until replay look-ahead is fixed.
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

/** NY calendar day key for per-session counters. */
export function nySessionDayKey(now = Date.now()) {
  return new Date(now).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function dayTradeStopStreakKey(ticker, now = Date.now()) {
  const sym = String(ticker || "").toUpperCase();
  return `timed:opt-dt:stop-streak:${sym}:${nySessionDayKey(now)}`;
}
