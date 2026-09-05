// worker/execution-window.js
//
// One answer to "may a SHARE lane act right now?" for every paper book that
// mirrors to a broker as shares (Short Term equities, Index Swings LETFs).
//
// Why this exists (2026-09-04, UDOW W36): the index-trend lane classified a
// trail EXIT on the */15 operating-hours tick at 7:01 PM ET. The Webull
// share mirror stops following through at 7:00 PM ET (AH_BROKER_END) and
// never takes fractional orders outside RTH, so the paper book closed
// "+1.79% (filled)" while the broker still held the shares. The same lane
// had opened the book on the 9:30:00 open print.
//
// Rules (pure, no I/O):
//   ENTER   — RTH only, after the open print settles (09:45) and before the
//             last half hour (15:30). Never premarket / AH.
//   REDUCE  — profit management (trim, target, trail, ratchet) is RTH only,
//             skipping the 09:30 print minute. EXT prints on a 3x LETF are
//             not a trend signal.
//   STOP    — hard invalidation may fire whenever the broker can still take
//             a share order (PM 04:00 → 19:00 ET, 17:00 on early-close days).
//             Outside that, it waits for the next window; the book is NOT
//             closed on paper while the broker cannot act.
//   RATCHET — peak / MFE bookkeeping only advances on RTH prints so an AH
//             spike cannot arm a giveback exit that fires at the open.

import {
  getETMinutes,
  isNyRegularMarketOpenStatic,
  isEquityBrokerFollowThroughStatic,
  RTH_OPEN,
  RTH_CLOSE,
} from "./market-calendar.js";

export const ENTER_OPEN_ET = RTH_OPEN + 15;   // 09:45
export const ENTER_CLOSE_ET = RTH_CLOSE - 30; // 15:30
export const REDUCE_OPEN_ET = RTH_OPEN + 1;   // 09:31

/**
 * @param {number|Date} now
 * @returns {{
 *   et_minutes: number, rth: boolean, broker_follow_through: boolean,
 *   can_enter: boolean, can_reduce: boolean, can_stop: boolean,
 *   can_ratchet: boolean, blocked_reason: string|null
 * }}
 */
export function shareLaneExecutionWindow(now = Date.now()) {
  const d = now instanceof Date ? now : new Date(Number(now));
  const et = getETMinutes(d);
  const rth = isNyRegularMarketOpenStatic(d);
  const follow = isEquityBrokerFollowThroughStatic(d);
  const canEnter = rth && et >= ENTER_OPEN_ET && et < ENTER_CLOSE_ET;
  const canReduce = rth && et >= REDUCE_OPEN_ET;
  const canStop = follow;
  let blocked = null;
  if (!rth) blocked = follow ? "outside_rth" : "broker_closed";
  else if (et < REDUCE_OPEN_ET) blocked = "open_print";
  return {
    et_minutes: et,
    rth,
    broker_follow_through: follow,
    can_enter: canEnter,
    can_reduce: canReduce,
    can_stop: canStop,
    can_ratchet: rth,
    blocked_reason: blocked,
  };
}

/**
 * Peak-anchored giveback floor for a share lane, in R (or %) units.
 * Returns null when the peak has not yet earned protection.
 *
 *   peak >= 1.0  -> floor  0.20          (a +1R winner never goes red)
 *   peak >= 1.5  -> floor  0.50 * peak
 *   peak >= 2.0  -> floor  0.60 * peak
 *   peak >= 3.0  -> floor  0.70 * peak
 */
export function peakGivebackFloor(peak) {
  const p = Number(peak);
  if (!Number.isFinite(p) || p < 1) return null;
  if (p >= 3) return Math.round(p * 0.70 * 1000) / 1000;
  if (p >= 2) return Math.round(p * 0.60 * 1000) / 1000;
  if (p >= 1.5) return Math.round(p * 0.50 * 1000) / 1000;
  return 0.2;
}
