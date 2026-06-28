// Bleeder guard — stop the soft forced-exits that empirically bleed.
// -----------------------------------------------------------------------------
// Slice B Part 2. The live ledger is unambiguous: patient/structural exits win
// (TP_FULL, HARD_FUSE_RSI, ST_FLIP_4H, peak_lock, mfe_decay) while soft
// "force"/"fast-cut" exits bleed money:
//   doctrine_force_exit          -$8.5k   4W / 54L
//   phase_i_mfe_fast_cut_*        -$3.5k   0W / 27L  (0% win rate)
//   atr_day_adverse_382_cut      -$1.8k   3W / 23L
//   tape_capitulation_force_exit -$1.1k   5W / 10L
// These fire on noise WHILE the higher-timeframe structure still supports the
// trade — exactly the mistiming the owner feels. When structure is intact, we
// shield the trade (hold/defend) instead of force-exiting on the soft signal.
//
// HARD CONSTRAINT: never shields a hard exit (SL / max-loss / HARD_LOSS_CAP /
// v13 nets) — capital protection always fires. Flag-gated (default OFF) and
// floored on PnL so a genuinely failing trade still exits. Pure + tested.
// -----------------------------------------------------------------------------

export const BLEEDER_REASON_PATTERNS = Object.freeze([
  "doctrine_force_exit",
  "phase_i_mfe_fast_cut",          // _2h and _zero_mfe (0% WR)
  "atr_day_adverse",               // atr_day_adverse_382_cut
  "tape_capitulation_force_exit",
]);

export function isBleederReason(reason) {
  const r = String(reason || "").toLowerCase();
  return BLEEDER_REASON_PATTERNS.some((p) => r.includes(p));
}

export const BLEEDER_SHIELD_DEFAULTS = Object.freeze({
  // Don't shield a trade already bleeding past this — let it exit (max-loss /
  // SL are hard exits and excluded anyway; this is a belt-and-suspenders floor).
  minPnlFloorPct: -4,
});

/**
 * Decide whether to shield (hold/defend) a soft bleeder exit because structure
 * still supports the trade.
 * @returns {{ shield: boolean, reason: string }}
 */
export function shouldShieldBleederExit(opts = {}) {
  const cfg = { ...BLEEDER_SHIELD_DEFAULTS, ...(opts.cfg || {}) };
  if (!opts.flagEnabled) return { shield: false, reason: "flag_off" };
  if (opts.isHardExit) return { shield: false, reason: "hard_exit_never_shielded" };
  if (!isBleederReason(opts.exitReason)) return { shield: false, reason: "not_a_bleeder" };

  const th = opts.trendHealth || {};
  const structureHealthy = th.htfIntact === true
    && th.isReversal !== true
    && (th.structuralSupport === true || th.isPullback === true);
  if (!structureHealthy) return { shield: false, reason: "structure_not_healthy" };

  const pnl = Number(opts.pnlPct);
  if (Number.isFinite(pnl) && pnl < cfg.minPnlFloorPct) {
    return { shield: false, reason: "below_pnl_floor" };
  }
  return { shield: true, reason: `shielded:${String(opts.exitReason)}` };
}
