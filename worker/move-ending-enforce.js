// Move-ending enforce — convert advisory TRIM/EXIT into live manage actions
// only when family keep-rate clears the floor (weekly governor attribution).
// plans/wow-pnl-adaptive-governor.plan.md

import { computeMoveEndingSignal } from "./move-ending.js";

export const MOVE_ENDING_TRIM_REASON = "MOVE_ENDING_TRIM";
export const MOVE_ENDING_EXIT_REASON = "MOVE_ENDING_EXIT";

export function loadMoveEndingEnforceConfig(daCfg = {}) {
  const enabled = String(daCfg.deep_audit_move_ending_enforce_enabled ?? "false") === "true";
  const keepFloor = Number(daCfg.deep_audit_move_ending_keep_rate_floor);
  const minClosed = Number(daCfg.deep_audit_move_ending_min_closed_n);
  return {
    enabled,
    keepRateFloor: Number.isFinite(keepFloor) ? keepFloor : 0.35,
    minClosedN: Number.isFinite(minClosed) && minClosed > 0 ? minClosed : 30,
  };
}

/**
 * Gate from weekly governor / family attribution artifact.
 * @param {object|null} governorReport timed:weekly-governor:latest
 */
export function moveEndingEnforceGateOpen(governorReport, daCfg = {}) {
  const cfg = loadMoveEndingEnforceConfig(daCfg);
  if (!cfg.enabled) return { open: false, reason: "flag_off" };
  if (String(daCfg.deep_audit_weekly_governor_block_widen ?? "false") === "true") {
    // Block-widen still allows protect-side enforce; only blocks conviction widen.
  }
  const fam = governorReport?.family_attribution;
  if (!fam || fam.ok === false) return { open: false, reason: "no_family_attribution" };
  const closed = Number(fam.closed) || 0;
  const keep = Number(fam.avg_mfe_keep_rate);
  if (closed < cfg.minClosedN) {
    return { open: false, reason: "insufficient_closed_n", closed, need: cfg.minClosedN };
  }
  // Shadow-first: only enforce after the advisory has earned trust
  // (family keep-rate clears the floor on enough closed samples).
  if (!Number.isFinite(keep)) return { open: false, reason: "no_keep_rate" };
  if (keep < cfg.keepRateFloor) {
    return { open: false, reason: "keep_rate_below_floor", keep, floor: cfg.keepRateFloor };
  }
  return { open: true, reason: "keep_rate_cleared", keep, closed, floor: cfg.keepRateFloor };
}

/**
 * Pure decision: should we force trim/exit from move-ending advisory?
 * @returns {{ forceTrim:boolean, forceExit:boolean, reason:string|null, level:string, score:number, gate:object }}
 */
export function evaluateMoveEndingEnforce({
  tickerData,
  openTrade,
  daCfg = {},
  governorReport = null,
  signal = null,
} = {}) {
  const gate = moveEndingEnforceGateOpen(governorReport, daCfg);
  const me = signal || tickerData?._move_ending || computeMoveEndingSignal(tickerData, openTrade);
  const level = String(me?.level || "NONE").toUpperCase();
  const score = Number(me?.score) || 0;
  const base = { forceTrim: false, forceExit: false, reason: null, level, score, gate, signal: me };

  if (!openTrade) return { ...base, gate: { open: false, reason: "no_open_trade" } };
  if (!gate.open) return base;

  if (level === "EXIT" && score >= 60) {
    const trimmed = Number(openTrade.trimmedPct || openTrade.trimmed_pct || 0);
    // First hit: trim if still full size; full exit once already trimmed.
    if (trimmed < 0.35) {
      return { ...base, forceTrim: true, reason: MOVE_ENDING_TRIM_REASON };
    }
    return { ...base, forceExit: true, reason: MOVE_ENDING_EXIT_REASON };
  }
  if (level === "TRIM" && score >= 40) {
    return { ...base, forceTrim: true, reason: MOVE_ENDING_TRIM_REASON };
  }
  return base;
}
