// Entry-time evidence contracts, not a new score or admission policy.
export const SETUP_EVIDENCE_VERSION = "setup-evidence-v1";

export function finiteSetupNumber(value) {
  if (value == null || typeof value === "boolean" || typeof value === "object"
      || (typeof value === "string" && !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Use observed volume only; TradeContext's legacy 1.0 defaults are not evidence. */
export function observedSetupVolume(d = {}) {
  const measurements = [
    ["rvol_map.30.vr", d?.rvol_map?.["30"]?.vr],
    ["rvol_map.60.vr", d?.rvol_map?.["60"]?.vr],
  ].map(([source, raw]) => ({ source, value: finiteSetupNumber(raw) }))
    .filter(m => m.value != null && m.value >= 0);
  if (measurements.length) {
    const best = measurements.reduce((a, b) => b.value > a.value ? b : a);
    return { value: best.value, source: best.source, observations: measurements.length };
  }
  for (const [source, raw] of [["rvol_best", d?.rvol_best], ["rvol.best", d?.rvol?.best]]) {
    const value = finiteSetupNumber(raw);
    if (value != null && value >= 0) return { value, source, observations: 1 };
  }
  return { value: null, source: null, observations: 0 };
}

export function meetsSetupVolume(volume, floor) {
  const min = finiteSetupNumber(floor);
  if (min == null || min < 0) return false;
  if (min === 0) return true; // explicit disabled floor, not missing evidence
  const value = finiteSetupNumber(volume?.value);
  return value != null && value >= min;
}

export function setupBarPosition(bar) {
  const high = finiteSetupNumber(bar?.h ?? bar?.high);
  const low = finiteSetupNumber(bar?.l ?? bar?.low);
  const close = finiteSetupNumber(bar?.c ?? bar?.close);
  if (!(high > low && low > 0) || close == null || close < low || close > high) return null;
  return (close - low) / (high - low);
}

export function priorDeclineBlocksGap(prior, minDays, maxDropPct) {
  const n = finiteSetupNumber(minDays);
  const limit = finiteSetupNumber(maxDropPct);
  const count = finiteSetupNumber(prior?.consecutive_down);
  const drop = finiteSetupNumber(prior?.drop_pct_by_days?.[n]);
  return Number.isInteger(n) && n > 0 && limit != null && count != null
    && count >= n && drop != null && drop <= limit;
}

/** A prior wick is not a held breakout; prior-day progress is a separate fact. */
export function breakoutEvidence(ath = {}, price, side, requireFollowThrough = true) {
  const px = finiteSetupNumber(price);
  const level = finiteSetupNumber(side === "SHORT" ? ath?.prev_low : ath?.prev_high);
  const prev = finiteSetupNumber(ath?.prev_close);
  const prev2 = finiteSetupNumber(ath?.prev_prev_close);
  const validSide = side === "LONG" || side === "SHORT";
  const holds = validSide && px > 0 && level > 0
    ? (side === "SHORT" ? px < level : px > level) : null;
  const preceding = validSide && prev > 0 && prev2 > 0
    ? (side === "SHORT" ? prev < prev2 : prev > prev2) : null;
  return {
    holds_level: holds,
    preceding_session_aligned: preceding,
    follow_through_required: requireFollowThrough,
    eligible: holds === true && (!requireFollowThrough || preceding === true),
    level, price: px,
  };
}

const STALE_DIAGNOSTICS = [
  "__ath_breakout_diag", "__range_reversal_diag", "__gap_reversal_diag",
  "__n_test_support_diag", "__index_etf_swing_diag", "__gap_reversal_force_short",
  "__gap_reversal_knife_block", "__ja_ltf_struct_diag", "__entry_divergence_summary",
  "__entry_setup_snapshot",
];
const observedBool = v => typeof v === "boolean" ? v : null;

/**
 * Independent raw shapes are NOT independent admitted setups. The engine's
 * short-circuits are retained and reported, not replayed or silently bypassed.
 */
export function beginSetupEvaluation(d, { side, asOfTs } = {}) {
  if (!d || typeof d !== "object") return null;
  for (const key of STALE_DIAGNOSTICS) delete d[key];
  const ds = d.daily_structure || {};
  const short = side === "SHORT";
  const validSide = side === "LONG" || short;
  const audit = {
    version: SETUP_EVIDENCE_VERSION,
    engine: "tt_core",
    scope: "core_evaluation_not_paper_admission",
    as_of_ts: finiteSetupNumber(asOfTs),
    side: validSide ? side : null,
    raw_shapes: {
      ath: validSide ? observedBool(short ? ds.ath52w?.breakdown_below_prev_low : ds.ath52w?.breakout_above_prev_high) : null,
      range: validSide ? observedBool(short ? ds.range_box?.short_setup_active : ds.range_box?.long_setup_active) : null,
      gap: validSide ? observedBool(short ? ds.gap_reversal?.short_setup_active : ds.gap_reversal?.long_setup_active) : null,
      n_test: validSide ? observedBool(short ? ds.n_test_support?.resistance?.short_setup_active : ds.n_test_support?.support?.long_setup_active) : null,
    },
    structural_evaluation: { ath: "not_reached", range: "not_reached", gap: "not_reached", n_test: "not_reached" },
    cloud_triggers: null,
    cloud_trigger_stage: "initial_after_quality_checks_not_final_admission",
    volume: observedSetupVolume(d),
    attempted_path: null,
    selected_path: null,
    result: null,
    reason: null,
    // A simultaneous state snapshot is not proof of an ordered sequence.
    sequence_evidence: "not_evaluated_by_this_trace",
  };
  d.__setup_evaluation = audit;
  return audit;
}
