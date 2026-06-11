// worker/fair-value.js
// ─────────────────────────────────────────────────────────────────────────────
//  Fair Value & Quality engine (B6, 2026-06-11) — "the Buffett layer."
//
//  The fundamentals snapshot pipeline already computes a multi-method fair
//  value (forward-PE / growth-PEG / conservative blend) and rich growth +
//  quality stats per ticker (see fetchAndCacheFundamentalsSnapshot in
//  worker/index.js, KV `timed:fundamentals_v4:{T}`) — but it was display-only.
//  This module turns that snapshot into a SCORED DECISION INPUT:
//
//    extractFairValueSignal(snapshot)  → compact signal with value gap +
//                                        quality grade (A-F)
//    computeFairValueTiltMagnitude()   → bounded ±5, +favors-LONG signed
//                                        magnitude (direction applied by the
//                                        caller like the CRO theme tilt)
//
//  Consumers: computeDynamicScore (bounded tilt, gated by
//  model_config fair_value_rank_boost_enabled — shadow-attached when off),
//  investor accumulation boost (gated), trade lineage (fair_value block),
//  nightly fundamentals refresh lane.
//
//  Doctrine notes:
//   • NEVER an admission gate by itself — it reorders and sizes conviction,
//     it does not admit trades (same contract as theme tilt).
//   • Freshness applies here too: snapshots older than MAX_AGE_DAYS are
//     stale → tilt 0 (a 3-week-old "discount" is not evidence).
//  Pure module — no I/O, no imports. Pinned by worker/fair-value.test.js.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86400000;
export const FAIR_VALUE_MAX_AGE_DAYS = 8;
export const FAIR_VALUE_TILT_CAP = 5;

/**
 * Quality score (0-100) from snapshot growth/earnings/margins:
 * is this a great business (growth, consistency, profitability)?
 */
export function computeQualityScore(snapshot) {
  const g = snapshot?.growth || {};
  const e = snapshot?.earnings || {};
  const c = snapshot?.capital_structure || {};
  let score = 0;
  const parts = {};

  const epsClass = String(g.eps_growth_class || "unknown");
  parts.eps_growth =
    epsClass === "explosive" ? 25
    : epsClass === "exploding" ? 20
    : epsClass === "strong" ? 15
    : epsClass === "positive" ? 8
    : 0;

  const revClass = String(g.rev_growth_class || "unknown");
  parts.rev_growth =
    revClass === "explosive" ? 15
    : revClass === "exploding" ? 12
    : revClass === "strong" ? 9
    : revClass === "positive" ? 5
    : 0;

  const beat = Number(e.beat_rate_pct);
  parts.beat_rate = Number.isFinite(beat)
    ? (beat >= 80 ? 20 : beat >= 60 ? 12 : beat >= 40 ? 5 : 0)
    : 0;

  const surprise = Number(e.avg_surprise_pct);
  parts.avg_surprise = Number.isFinite(surprise)
    ? (surprise >= 10 ? 10 : surprise >= 5 ? 6 : surprise > 0 ? 3 : 0)
    : 0;

  const roe = Number(g.roe_ttm_pct);
  parts.roe = Number.isFinite(roe)
    ? (roe >= 20 ? 15 : roe >= 10 ? 8 : roe > 0 ? 3 : 0)
    : 0;

  const margin = Number(g.profit_margin_pct);
  parts.margin = Number.isFinite(margin)
    ? (margin >= 15 ? 10 : margin >= 5 ? 5 : 0)
    : 0;

  const fcf = Number(c.free_cash_flow_ttm);
  parts.fcf = Number.isFinite(fcf) && fcf > 0 ? 5 : 0;

  for (const v of Object.values(parts)) score += v;
  return { score: Math.min(100, score), parts };
}

export function qualityGrade(score) {
  if (!Number.isFinite(Number(score))) return null;
  const s = Number(score);
  if (s >= 70) return "A";
  if (s >= 55) return "B";
  if (s >= 40) return "C";
  if (s >= 25) return "D";
  return "F";
}

/**
 * Compact decision signal from a fundamentals_v4 snapshot.
 * Returns null when the snapshot has no usable fair value AND no quality
 * inputs (e.g. ETFs / synthetic instruments).
 */
export function extractFairValueSignal(snapshot, opts = {}) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const nowMs = Number(opts.nowMs) > 0 ? Number(opts.nowMs) : Date.now();
  const v = snapshot.valuation || {};
  const asOf = Number(snapshot.as_of) || 0;
  const ageDays = asOf > 0 ? (nowMs - asOf) / DAY_MS : null;
  const stale = ageDays == null || ageDays > FAIR_VALUE_MAX_AGE_DAYS;

  const fairValue = Number(v.fair_value_price) || null;
  const premiumPct = Number.isFinite(Number(v.fair_value_premium_pct))
    ? Number(v.fair_value_premium_pct)
    : null;
  const fvClass = v.fair_value_class || null;

  const { score: qualityScore, parts } = computeQualityScore(snapshot);
  const grade = qualityGrade(qualityScore);

  if (fairValue == null && qualityScore === 0) return null;

  const g = snapshot.growth || {};
  const e = snapshot.earnings || {};
  // "Certain type of growth detected" — accelerating + consistently beating.
  const growthDetected =
    ["strong", "exploding", "explosive"].includes(String(g.eps_growth_class)) &&
    ["positive", "strong", "exploding", "explosive"].includes(String(g.rev_growth_class)) &&
    (Number(e.beat_rate_pct) || 0) >= 70;

  return {
    ticker: snapshot.ticker || null,
    as_of: asOf || null,
    age_days: ageDays != null ? Math.round(ageDays * 10) / 10 : null,
    stale,
    fair_value: fairValue,
    // premium_pct semantics match the snapshot: NEGATIVE = trading below
    // fair value (discount), POSITIVE = above (premium).
    fv_premium_pct: premiumPct,
    fv_class: fvClass,
    fv_basis: v.fair_value_basis || null,
    quality_score: qualityScore,
    quality_grade: grade,
    quality_parts: parts,
    growth_detected: growthDetected,
  };
}

/**
 * Bounded tilt magnitude, SIGNED with +favors-LONG semantics (the caller
 * applies direction by multiplying with side = sign(htf_score), exactly
 * like the CRO theme tilt).
 *
 * Below fair value + great business → strong LONG tailwind.
 * Rich premium + weak quality → LONG headwind (and SHORT tailwind via sign).
 * Stale snapshot → 0 (freshness doctrine applies to fundamentals too).
 */
export function computeFairValueTiltMagnitude(signal) {
  if (!signal || signal.stale) return 0;
  const premium = Number(signal.fv_premium_pct);
  const grade = signal.quality_grade;
  let tilt = 0;

  if (signal.fv_class === "discount" && Number.isFinite(premium)) {
    // Deeper discount + better business = bigger boost.
    const depth = Math.min(2, Math.abs(premium) / 25); // ≥25% below FV maxes depth
    const qualityMult = grade === "A" ? 2 : grade === "B" ? 1.5 : grade === "C" ? 0.75 : 0.25;
    tilt += depth * qualityMult;
  } else if (signal.fv_class === "premium" && Number.isFinite(premium) && premium >= 25) {
    // Rich valuation only penalizes when the business doesn't earn it.
    tilt -= grade === "D" || grade === "F" ? 3 : grade === "C" ? 1.5 : 0.5;
  }

  if (signal.growth_detected) tilt += 1;

  return Math.max(-FAIR_VALUE_TILT_CAP, Math.min(FAIR_VALUE_TILT_CAP, Math.round(tilt * 10) / 10));
}

/** Compact block for trade lineage / payload attachment. */
export function fairValueLineage(signal) {
  if (!signal) return null;
  return {
    fair_value: signal.fair_value,
    fv_premium_pct: signal.fv_premium_pct,
    fv_class: signal.fv_class,
    quality_score: signal.quality_score,
    quality_grade: signal.quality_grade,
    growth_detected: signal.growth_detected,
    age_days: signal.age_days,
    stale: signal.stale,
  };
}
