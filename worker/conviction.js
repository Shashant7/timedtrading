// Conviction fusion — one tradable number from the edge we already detect.
// -----------------------------------------------------------------------------
// Slice B. The live engine trades textbook Ripster + rank while our developed
// edge sits in shadow (move-discovery shows ~4.8% capture). This fuses the
// signals we ALREADY compute every tick — the confirm-stack gate (the
// promotable +5.5% win-lift / 59.9% win-share edge), focus conviction (TA),
// daily-EMA21 structure (the MU bounce pattern), and the MR sequence as a
// wrong-way veto-context (NOT a positive driver — it's ubiquitous, ~33% WR on
// live captures) — into a single conviction tier + size multiplier.
//
// Pure + deterministic so it is unit-tested and corpus-replayable. Discipline:
// the raw MR sequence never drives a positive boost (tier-A+B verdict:
// "no production entry/sizing from sequences until validated"); only the
// confirm-stack gate and structure do. Live effect is flag-gated in index.js
// (gates.conviction_fusion_enabled, default OFF) — validated on the corpus
// (Slice E) before it touches sizing.
// -----------------------------------------------------------------------------

export const CONVICTION_FUSION_VERSION = 1;

export const FUSION_DEFAULTS = Object.freeze({
  base: 50,
  confirmStack: 14,   // stack_full_confirm fires (ST flip + squeeze + EMA21)
  runwayFull: 8,      // gate_runway_full fires (TD9+div+confirm) — strong but n=10, capped
  ema21Hold: 6,       // price holding/reclaiming daily EMA21 in-trend (MU pattern)
  fsdSupport: 6,      // research stance supportive (optional — only if present)
  fsdOppose: -6,
  mrOppose: -8,       // forming MR sequence opposed to trade direction = wrong-way tell
  tierA: 72,
  tierB: 52,
  sizeMultA: 1.25,
  sizeMultB: 1.0,
  sizeMultC: 0.6,
  sizeMultMin: 0.5,
  sizeMultMax: 1.5,
});

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Trade/move direction from explicit opt or the payload's own fields. */
export function resolveDirection(tickerData = {}, opts = {}) {
  const explicit = String(opts.direction || "").toUpperCase();
  if (explicit === "LONG" || explicit === "SHORT") return explicit;
  const d = String(tickerData?.trigger_dir || tickerData?.direction || "").toUpperCase();
  if (d === "LONG" || d === "SHORT") return d;
  const state = String(tickerData?.state || "").toUpperCase();
  if (state.includes("BEAR") || state.includes("SHORT")) return "SHORT";
  if (state.includes("BULL") || state.includes("LONG")) return "LONG";
  return null;
}

/** True when price is constructively holding/reclaiming the daily EMA21 in-trend. */
export function ema21StructureHolds(ds = {}, direction) {
  if (!ds || typeof ds !== "object") return false;
  const pctAbove21 = Number(ds.pct_above_e21);
  if (direction === "LONG") {
    // Above E200 + bull stack, and within a sane band above E21 (reclaimed,
    // not overextended). Tolerate a small dip below (recent reclaim).
    if (ds.above_e200 !== true && ds.bull_stack !== true) return false;
    return Number.isFinite(pctAbove21) ? pctAbove21 >= -1.5 && pctAbove21 <= 5 : ds.bull_stack === true;
  }
  if (direction === "SHORT") {
    if (ds.above_e200 !== false && ds.bear_stack !== true) return false;
    return Number.isFinite(pctAbove21) ? pctAbove21 <= 1.5 && pctAbove21 >= -5 : ds.bear_stack === true;
  }
  return false;
}

/** Forming MR sequence opposed to our trade direction (wrong-way context). */
export function mrSequenceOpposed(sequences, direction) {
  if (!Array.isArray(sequences) || !direction) return false;
  for (const s of sequences) {
    const seqDir = String(s?.direction || "").toUpperCase();
    const stage = Number(s?.stage) || 0;
    const status = String(s?.status || "").toLowerCase();
    if (stage > 0 && status !== "invalidated" && seqDir && seqDir !== direction) return true;
  }
  return false;
}

function tierFromScore(score, cfg) {
  if (score >= cfg.tierA) return "A";
  if (score >= cfg.tierB) return "B";
  return "C";
}

function sizeMultForTier(tier, cfg) {
  const m = tier === "A" ? cfg.sizeMultA : tier === "B" ? cfg.sizeMultB : cfg.sizeMultC;
  return clamp(m, cfg.sizeMultMin, cfg.sizeMultMax);
}

/**
 * Fuse the available signals into a conviction verdict.
 * @returns {{ tier, score, sizeMult, rankBoost, veto, components, reasons, version }}
 */
export function fuseConviction(tickerData = {}, opts = {}) {
  const cfg = { ...FUSION_DEFAULTS, ...(opts.cfg || {}) };
  const direction = resolveDirection(tickerData, opts);
  const reasons = [];

  const focusRaw = Number(tickerData?.__focus_conviction_score);
  const base = Number.isFinite(focusRaw) ? clamp(focusRaw, 0, 100) : cfg.base;
  if (Number.isFinite(focusRaw)) reasons.push(`focus_conviction=${Math.round(base)}`);

  const gates = tickerData?.setup_gates || {};
  const confirmStack = gates?.stack_full_confirm?.fires === true;
  const runwayFull = gates?.gate_runway_full?.fires === true;
  const ema21Hold = ema21StructureHolds(tickerData?.daily_structure, direction);
  const mrOppose = mrSequenceOpposed(tickerData?.setup_sequences, direction);

  // FSD/research alignment is optional — only applied when present on payload.
  const fsd = tickerData?.fsd_alignment ?? tickerData?.__fsd_alignment ?? null;
  const fsdStance = typeof fsd === "string" ? fsd.toLowerCase()
    : (fsd && typeof fsd === "object" ? String(fsd.stance || fsd.alignment || "").toLowerCase() : "");
  const fsdSupport = fsdStance.includes("support") || fsdStance.includes("aligned") || fsdStance.includes("bull") && direction === "LONG";
  const fsdOppose = fsdStance.includes("oppose") || fsdStance.includes("risk_off") || (fsdStance.includes("bear") && direction === "LONG");

  let score = base;
  if (confirmStack) { score += cfg.confirmStack; reasons.push("stack_full_confirm"); }
  if (runwayFull) { score += cfg.runwayFull; reasons.push("gate_runway_full(unproven_n)"); }
  if (ema21Hold) { score += cfg.ema21Hold; reasons.push("ema21_structure_hold"); }
  if (fsdSupport) { score += cfg.fsdSupport; reasons.push("fsd_support"); }
  if (fsdOppose) { score += cfg.fsdOppose; reasons.push("fsd_oppose"); }
  if (mrOppose) { score += cfg.mrOppose; reasons.push("mr_sequence_opposed"); }

  score = Math.round(clamp(score, 0, 100));
  const tier = tierFromScore(score, cfg);
  const sizeMult = sizeMultForTier(tier, cfg);

  // Rank boost (stamped for measurement; applied live only behind the flag).
  let rankBoost = tier === "A" ? 10 : tier === "B" ? 4 : 0;
  if (confirmStack) rankBoost += 2;
  if (mrOppose) rankBoost -= 6;
  rankBoost = clamp(rankBoost, -10, 12);

  // Veto is advisory: a wrong-way MR tell with weak conviction.
  const veto = mrOppose && score < 50;
  if (veto) reasons.push("veto_wrongway_low_conviction");

  return {
    tier,
    score,
    sizeMult,
    rankBoost,
    veto,
    direction,
    components: { base, confirmStack, runwayFull, ema21Hold, fsdSupport, fsdOppose, mrOppose },
    reasons,
    version: CONVICTION_FUSION_VERSION,
  };
}
