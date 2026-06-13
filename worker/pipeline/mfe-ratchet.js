// worker/pipeline/mfe-ratchet.js
// ─────────────────────────────────────────────────────────────────────────────
//  MFE GIVEBACK RATCHET (2026-06-12) — the one unsuppressible profit floor.
//
//  WHY THIS EXISTS (60-day exit-clip autopsy, tasks/2026-06-12-never-stale-
//  and-performance-review.md Part 4): avg MFE +2.38% vs avg realized -0.69%;
//  the HARD_LOSS_CAP cohort averaged +6.45% MFE before dying (HIMX peaked
//  +26.85%, closed -5.84%); SMART_RUNNER_SUPPORT_BREAK_CLOUD gave back ~10.8
//  points on average. Counterfactual on the same 55 trades: a 40%-of-peak
//  lock turns -$2,602 into +$436 and lifts WR 34.5% -> 41.8%.
//
//  WHY THE EXISTING PROTECTIONS DIDN'T DO THIS: as of 2026-06-12 the ledger
//  shows mfe_proportional_trail fired 0 times EVER, runner_mfe_trail 0,
//  peak_lock_exit_fallback 0, peak_lock_ema12_* last on 2026-01-26, and
//  winner_protect_big_mfe is disabled in model_config. The proportional
//  trail is suppressed by the peak-lock "cloud hold" flag whenever daily
//  EMA12 is intact — i.e. on nearly every bar of a trending trade — and the
//  EMA12-break exits that are supposed to take over fire too late or never.
//
//  CONTRACT:
//  - Pure function, no I/O, shared verbatim by the inline classifyKanbanStage
//    path (authoritative for tt_core, live + replay) and tt-core-exit.js
//    (authoritative for pipeline-handled engines). Keeping one module is the
//    point — do NOT fork the math into call sites.
//  - The ratchet is a BACKSTOP and is deliberately NOT suppressible by
//    cloud-hold / healthy-pullback / let-winners-run flags. Those flags
//    exist so runners can breathe near the peak; the ratchet only fires
//    after the giveback has already exceeded the lock allowance, at which
//    point "breathing room" is the failure mode being fixed.
//  - It self-maintains a peak high-water (`__ratchet_peak_pnl_pct`) on the
//    position object so it works even when upstream MFE plumbing
//    (maxFavorableExcursion fields) is missing — the 2026-04/05 era bugs
//    where MFE read as 0 silently no-op'd every MFE-gated rule.
//
//  Config (model_config, hot-reload; registered in the deep-audit lazy-load
//  list and REPLAY_DA_KEYS):
//    deep_audit_mfe_ratchet_enabled        default "true"
//    deep_audit_mfe_ratchet_activation_pct default 2.0  (peak MFE to arm)
//    deep_audit_mfe_ratchet_lock_frac      default 0.40 (fraction of peak kept)
// ─────────────────────────────────────────────────────────────────────────────

export const MFE_RATCHET_EXIT_REASON = "mfe_ratchet_giveback";

export function loadMfeRatchetConfig(daCfg) {
  const cfg = daCfg || {};
  const enabledRaw = cfg.deep_audit_mfe_ratchet_enabled;
  const enabled = enabledRaw == null
    ? true
    : String(enabledRaw).toLowerCase() !== "false" && enabledRaw !== false && enabledRaw !== 0;
  const actRaw = Number(cfg.deep_audit_mfe_ratchet_activation_pct);
  const activationPct = Number.isFinite(actRaw) && actRaw > 0 ? actRaw : 2.0;
  const lockRaw = Number(cfg.deep_audit_mfe_ratchet_lock_frac);
  const lockFrac = Number.isFinite(lockRaw) && lockRaw > 0 && lockRaw < 1 ? lockRaw : 0.40;
  return { enabled, activationPct, lockFrac };
}

/**
 * Resolve the peak favorable excursion (in pct points, >= 0) for a position,
 * tolerating every historical field spelling AND maintaining a self-owned
 * high-water mark so missing upstream plumbing can't zero the ratchet.
 *
 * MUTATES position.__ratchet_peak_pnl_pct (high-water).
 */
export function resolveRatchetPeak(position, pnlPct) {
  const candidates = [
    position?.maxFavorableExcursion,
    position?.max_favorable_excursion,
    position?.mfePct,
    position?.__tradeRef?.maxFavorableExcursion,
    position?.__tradeRef?.max_favorable_excursion,
    position?.__tradeRef?.mfePct,
    position?.__ratchet_peak_pnl_pct,
  ];
  let peak = 0;
  for (const c of candidates) {
    const v = Number(c);
    if (Number.isFinite(v) && v > peak) peak = v;
  }
  const cur = Number(pnlPct);
  if (Number.isFinite(cur) && cur > peak) peak = cur;
  if (position && typeof position === "object") {
    position.__ratchet_peak_pnl_pct = peak;
  }
  return peak;
}

/**
 * Evaluate the giveback ratchet.
 *
 * @param {Object} args
 * @param {number} args.pnlPct  current position P&L in pct points
 *                              (direction-adjusted: positive = favorable)
 * @param {Object} args.position open position object (mutated: high-water)
 * @param {Object} args.daCfg   deep-audit config blob
 * @returns {{ armed:boolean, fire:boolean, peakPct:number, floorPct:number,
 *             lockFrac:number, activationPct:number, enabled:boolean }}
 */
export function evaluateMfeRatchet({ pnlPct, position, daCfg }) {
  const { enabled, activationPct, lockFrac } = loadMfeRatchetConfig(daCfg);
  const peakPct = resolveRatchetPeak(position, pnlPct);
  const armed = enabled && peakPct >= activationPct;
  const floorPct = armed ? Math.round(lockFrac * peakPct * 10000) / 10000 : 0;
  const cur = Number(pnlPct);
  const fire = armed && Number.isFinite(cur) && cur < floorPct;
  return { armed, fire, peakPct, floorPct, lockFrac, activationPct, enabled };
}
