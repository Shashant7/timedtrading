// worker/conviction-management.js
//
// Conviction-aware management for Short Term trades.
//
// The model grades every entry Prime / Confirmed / Speculative, and the grade
// separates winners from losers far better than any exit rule does: over the
// 140 live trades since July, Prime won 61% at +1.18% per trade with an
// average peak of +7.42%, while Speculative won 34% at -0.46%. Yet every
// trade was managed the same way — the same flat -3% / time-scaled
// -2.5..-1.5% floors, the same -4.5% hard floor, the same MFE ratchet, the
// same stale-runner clock. P (2026-09-22) was a rank-100 Prime Cloud Pivot
// with its structural stop at $101.06 (-10.1%); the time-scaled floor cut it
// at -2.7% and it gapped to its target the next session.
//
// When enabled, a trade whose grade is in the configured set is managed on
// its own STRUCTURE rather than on flat percentages:
//   - the percentage floors (max_loss, max_loss_time_scaled, the v13 hard
//     pnl floor, HARD_LOSS_CAP's percent leg) stand down, provided the trade
//     has a structural stop on the protective side of entry — that stop, the
//     dollar cap and every thesis exit stay armed (the dollar cap can be
//     raised to the trade's planned risk with its own knob);
//   - the MFE ratchet gives back more before it locks;
//   - the stale-runner force close waits longer.
//
// Every knob defaults OFF. Replay A/B 2026-09-25 (Jul-Sep 2026, 24 tickers,
// skills/exit-rule-counterfactuals.md) was negative on both halves: the
// wider trail -$381 (every changed trade gave back more from the same peak),
// holding to plan risk -$1,408 realized (Prime +$641, rest of the book
// -$2,049). Kept for re-testing, not for enabling.

export const CONVICTION_DEFAULTS = Object.freeze({
  enabled: false,
  grades: ["Prime"],
  // MFE ratchet lock fractions for held-conviction trades. Live defaults are
  // 0.40 / 0.70 / 0.80: the floor is that fraction of the peak gain.
  mfeLockFrac: 0.25,
  mfeHiLockFrac: 0.55,
  mfeRunnerLockFrac: 0.70,
  // R6 proportional-trail ratios (stop at ratio x peak gain). Live defaults
  // are 0.40 below 6% MFE, 0.60 from 6%, 0.75 from 10%.
  r6RatioLow: 0.25,
  r6RatioMid: 0.45,
  r6RatioHigh: 0.60,
  // Multiplier on the stale-runner force-close clock.
  staleHoursMult: 2,
  // HARD_LOSS_CAP's dollar leg ($250) sits far inside a Prime trade's stop:
  // Prime sizes to 2% risk, so a $23k LITE/INTC position hits $250 at -1.1%
  // on an ~8% stop. When on, a held trade's dollar leg rises to what its own
  // sizing planned to lose at the stop (x 1.1 so it never front-runs it).
  hlcToPlan: false,
});

const HLC_PLAN_BUFFER = 1.1;

function cfgVal(daCfg, key) {
  const v = daCfg?.[key];
  return v == null || v === "" ? null : v;
}

function numOr(v, d) {
  if (v == null || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function loadConvictionMgmtConfig(daCfg = {}) {
  const d = CONVICTION_DEFAULTS;
  const rawGrades = cfgVal(daCfg, "deep_audit_conviction_mgmt_grades");
  const grades = rawGrades == null
    ? d.grades
    : String(rawGrades).split(",").map((g) => g.trim()).filter(Boolean);
  return {
    enabled: String(cfgVal(daCfg, "deep_audit_conviction_mgmt_enabled") ?? d.enabled).toLowerCase() === "true",
    grades: grades.map((g) => g.toLowerCase()),
    mfeLockFrac: numOr(cfgVal(daCfg, "deep_audit_conviction_mfe_lock_frac"), d.mfeLockFrac),
    mfeHiLockFrac: numOr(cfgVal(daCfg, "deep_audit_conviction_mfe_hi_lock_frac"), d.mfeHiLockFrac),
    mfeRunnerLockFrac: numOr(cfgVal(daCfg, "deep_audit_conviction_mfe_runner_lock_frac"), d.mfeRunnerLockFrac),
    r6RatioLow: numOr(cfgVal(daCfg, "deep_audit_conviction_r6_ratio_low"), d.r6RatioLow),
    r6RatioMid: numOr(cfgVal(daCfg, "deep_audit_conviction_r6_ratio_mid"), d.r6RatioMid),
    r6RatioHigh: numOr(cfgVal(daCfg, "deep_audit_conviction_r6_ratio_high"), d.r6RatioHigh),
    staleHoursMult: Math.max(1, numOr(cfgVal(daCfg, "deep_audit_conviction_stale_hours_mult"), d.staleHoursMult)),
    hlcToPlan: String(cfgVal(daCfg, "deep_audit_conviction_hlc_to_plan") ?? d.hlcToPlan).toLowerCase() === "true",
  };
}

/** The entry grade of an open position, from wherever it was carried. */
export function resolveTradeGrade(pos) {
  const g = pos?.setup_grade ?? pos?.setupGrade
    ?? pos?.__tradeRef?.setup_grade ?? pos?.__tradeRef?.setupGrade ?? null;
  return g == null ? null : String(g);
}

function isGradeHeld(pos, cfg) {
  if (!cfg?.enabled) return false;
  const g = resolveTradeGrade(pos);
  return !!g && cfg.grades.includes(g.toLowerCase());
}

/**
 * Should the flat percentage floors stand down for this trade?
 *
 * Only when conviction management is on, the grade is held, AND the trade
 * carries a structural stop on the protective side of entry. Without that
 * stop there is nothing to hold to, and the percentage floors are the only
 * protection left — so they stay.
 */
export function holdsToStructure(pos, daCfg, { direction = null, entryPrice = null } = {}) {
  const cfg = loadConvictionMgmtConfig(daCfg);
  if (!isGradeHeld(pos, cfg)) return false;
  const sl = Number(pos?.sl ?? pos?.stop_loss ?? pos?.__tradeRef?.sl);
  const entry = Number(entryPrice ?? pos?.entryPrice ?? pos?.avgEntry ?? pos?.__tradeRef?.entryPrice);
  const dir = String(direction ?? pos?.direction ?? "").toUpperCase();
  if (!(sl > 0) || !(entry > 0)) return false;
  if (dir === "LONG") return sl < entry;
  if (dir === "SHORT") return sl > entry;
  return false;
}

/**
 * Trail config for this trade: the live `daCfg` with wider give-back merged
 * in for a held-conviction trade, unchanged otherwise. Covers both pure
 * give-back trails — the MFE ratchet's lock fractions and R6's proportional
 * ratios. Activation thresholds are untouched: only how much of the peak a
 * trade may give back once a trail is armed. The MFE-decay guard is left
 * alone on purpose — it also needs the 1H SuperTrend to flip, which is a
 * thesis signal, not a patience setting.
 */
export function trailConfigFor(pos, daCfg = {}) {
  const cfg = loadConvictionMgmtConfig(daCfg);
  if (!isGradeHeld(pos, cfg)) return daCfg;
  return {
    ...daCfg,
    deep_audit_mfe_ratchet_lock_frac: cfg.mfeLockFrac,
    deep_audit_mfe_ratchet_hi_lock_frac: cfg.mfeHiLockFrac,
    deep_audit_mfe_ratchet_runner_lock_frac: cfg.mfeRunnerLockFrac,
    deep_audit_mfe_trail_ratio_low: cfg.r6RatioLow,
    deep_audit_mfe_trail_ratio_mid: cfg.r6RatioMid,
    deep_audit_mfe_trail_ratio_high: cfg.r6RatioHigh,
  };
}

/** Stale-runner force-close hours for this trade. */
export function staleRunnerHoursFor(pos, daCfg, baseHours) {
  const cfg = loadConvictionMgmtConfig(daCfg);
  const base = Number(baseHours);
  if (!Number.isFinite(base)) return baseHours;
  return isGradeHeld(pos, cfg) ? base * cfg.staleHoursMult : base;
}

/**
 * HARD_LOSS_CAP dollar leg for this trade: `baseCap` unless the plan-risk
 * knob is on and the trade is held to structure, in which case the cap is
 * the planned loss to the stop on the shares still open.
 */
export function hardLossCapDollarFor(pos, daCfg, baseCap, { direction = null, entryPrice = null, activeShares = null } = {}) {
  const cfg = loadConvictionMgmtConfig(daCfg);
  if (!cfg.hlcToPlan || !holdsToStructure(pos, daCfg, { direction, entryPrice })) return baseCap;
  const sl = Number(pos?.sl ?? pos?.stop_loss ?? pos?.__tradeRef?.sl);
  const entry = Number(entryPrice ?? pos?.entryPrice ?? pos?.avgEntry);
  const shares = Number(activeShares ?? pos?.shares);
  const planned = Math.abs(entry - sl) * shares * HLC_PLAN_BUFFER;
  return Number.isFinite(planned) && planned > baseCap ? planned : baseCap;
}

/** Keys for the replay allowlist (`REPLAY_DA_KEYS`). */
export const CONVICTION_DA_KEYS = [
  "deep_audit_conviction_mgmt_enabled",
  "deep_audit_conviction_mgmt_grades",
  "deep_audit_conviction_mfe_lock_frac",
  "deep_audit_conviction_mfe_hi_lock_frac",
  "deep_audit_conviction_mfe_runner_lock_frac",
  "deep_audit_conviction_r6_ratio_low",
  "deep_audit_conviction_r6_ratio_mid",
  "deep_audit_conviction_r6_ratio_high",
  "deep_audit_conviction_stale_hours_mult",
  "deep_audit_conviction_hlc_to_plan",
];
