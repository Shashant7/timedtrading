// worker/business-character.js
// -----------------------------------------------------------------------------
// Business character — fundamentals that change what technicals MEAN.
//
// The gap: McDonald's (steady value, low growth) and NVDA (growth compounder)
// can print the same TD9 / EMA21 reclaim / PDZ discount. A human reads those
// charts differently. This module classifies business character from the
// fundamentals snapshot + compounder signal, then produces a technical-context
// lens for the stitched sequence movie.
//
// Contract (same as fair-value / theme tilt):
//   • Pure — no I/O.
//   • NEVER an admission gate by itself in v1 — stamps the read + shadow
//     interpretation. Live entry/sizing promotion is a later attributed step.
//   • Freshness: stale fundamentals → unclassified (do not invent character).
// -----------------------------------------------------------------------------

import { extractFairValueSignal, FAIR_VALUE_MAX_AGE_DAYS } from "./fair-value.js";
import { classifyGrowthCompounder } from "./growth-compounder.js";

export const BUSINESS_CHARACTER_VERSION = 1;

export const ARCHETYPES = Object.freeze({
  GROWTH_COMPOUNDER: "growth_compounder",
  STEADY_VALUE: "steady_value",
  DEFENSIVE_LOW_GROWTH: "defensive_low_growth",
  CYCLICAL_VALUE: "cyclical_value",
  SPEC_HIGH_BETA: "spec_high_beta",
  INDEX_PROXY: "index_proxy",
  UNCLASSIFIED: "unclassified",
});

const DEFENSIVE_SECTORS = new Set([
  "Consumer Staples",
  "Utilities",
  "Healthcare",
  "Health Care",
  "Real Estate",
]);

const CYCLICAL_SECTORS = new Set([
  "Energy",
  "Materials",
  "Basic Materials",
  "Industrials",
  "Financials",
]);

const ETF_TYPES = new Set([
  "sector_etf",
  "broad_etf",
  "thematic_etf",
  "commodity_etf",
]);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function revClassRank(cls) {
  const c = String(cls || "unknown");
  if (c === "explosive" || c === "exploding") return 4;
  if (c === "strong") return 3;
  if (c === "positive") return 1;
  if (c === "declining") return -1;
  return 0;
}

/**
 * Classify business character from a fundamentals snapshot (+ optional
 * precomputed fair-value / compounder / ticker-type hints).
 */
export function classifyBusinessCharacter(snapshot, opts = {}) {
  const ticker = String(opts.ticker || snapshot?.ticker || "").toUpperCase() || null;
  const tickerType = String(opts.tickerType || opts.ticker_type || "").toLowerCase() || null;
  const sector = opts.sector || snapshot?.profile?.sector || snapshot?.sector || null;

  if (tickerType && ETF_TYPES.has(tickerType)) {
    return lineage({
      ticker,
      archetype: ARCHETYPES.INDEX_PROXY,
      quality_grade: null,
      growth_class: "n/a",
      valuation_state: null,
      evidence: [`ticker_type=${tickerType}`],
      technical_lens: technicalLensFor(ARCHETYPES.INDEX_PROXY),
    });
  }
  if (tickerType === "crypto" || tickerType === "crypto_adj") {
    return lineage({
      ticker,
      archetype: ARCHETYPES.SPEC_HIGH_BETA,
      quality_grade: null,
      growth_class: "high_beta",
      valuation_state: null,
      evidence: [`ticker_type=${tickerType}`],
      technical_lens: technicalLensFor(ARCHETYPES.SPEC_HIGH_BETA),
    });
  }

  if (!snapshot || typeof snapshot !== "object") {
    return lineage({
      ticker,
      archetype: ARCHETYPES.UNCLASSIFIED,
      evidence: ["no_fundamentals_snapshot"],
      technical_lens: technicalLensFor(ARCHETYPES.UNCLASSIFIED),
    });
  }

  const fv = opts.fairValueSignal || extractFairValueSignal(snapshot, { nowMs: opts.nowMs });
  if (fv?.stale) {
    return lineage({
      ticker,
      archetype: ARCHETYPES.UNCLASSIFIED,
      quality_grade: fv.quality_grade,
      growth_class: snapshot?.growth?.rev_growth_class || null,
      valuation_state: fv.fv_class,
      evidence: [`stale_fundamentals age_days=${fv.age_days}`],
      technical_lens: technicalLensFor(ARCHETYPES.UNCLASSIFIED),
      stale: true,
    });
  }

  const compounder = opts.compounderSignal
    || snapshot.compounder
    || classifyGrowthCompounder(snapshot, fv);
  const grw = snapshot.growth || {};
  const revClass = String(grw.rev_growth_class || compounder?.rev_growth_class || "unknown");
  const epsClass = String(grw.eps_growth_class || "unknown");
  const quality = fv?.quality_grade || compounder?.quality_grade || null;
  const valuation = fv?.fv_class || null;
  const revRank = revClassRank(revClass);
  const evidence = [];

  // 1) Growth compounder — elite/strong tiers win when present.
  if (compounder?.tier === "growth_elite" || compounder?.tier === "growth_strong") {
    evidence.push(`compounder=${compounder.tier}`);
    if (quality) evidence.push(`quality=${quality}`);
    if (revClass !== "unknown") evidence.push(`rev=${revClass}`);
    return lineage({
      ticker,
      archetype: ARCHETYPES.GROWTH_COMPOUNDER,
      quality_grade: quality,
      growth_class: revClass,
      valuation_state: valuation,
      compounder_tier: compounder.tier,
      evidence,
      technical_lens: technicalLensFor(ARCHETYPES.GROWTH_COMPOUNDER, { quality, valuation }),
    });
  }

  // 2) Spec / high-beta — explosive growth OR low quality + high growth print.
  if (revRank >= 4 || (revRank >= 3 && (quality === "D" || quality === "F" || quality == null))) {
    evidence.push(`rev=${revClass}`, `eps=${epsClass}`);
    if (quality) evidence.push(`quality=${quality}`);
    return lineage({
      ticker,
      archetype: ARCHETYPES.SPEC_HIGH_BETA,
      quality_grade: quality,
      growth_class: revClass,
      valuation_state: valuation,
      evidence,
      technical_lens: technicalLensFor(ARCHETYPES.SPEC_HIGH_BETA, { quality, valuation }),
    });
  }

  const margin = num(grw.profit_margin_pct);
  const roe = num(grw.roe_ttm_pct);
  const stableQuality = quality === "A" || quality === "B";
  const lowGrowth = revRank <= 1 && revClassRank(epsClass) <= 1;
  const profitable = (margin != null && margin >= 8) || (roe != null && roe >= 12);

  // 3) Steady value — the McDonald's case: quality + low growth + profitable.
  if (stableQuality && lowGrowth && profitable) {
    evidence.push(`quality=${quality}`, `rev=${revClass}`, `eps=${epsClass}`);
    if (margin != null) evidence.push(`margin=${margin.toFixed(1)}%`);
    if (roe != null) evidence.push(`roe=${roe.toFixed(1)}%`);
    return lineage({
      ticker,
      archetype: ARCHETYPES.STEADY_VALUE,
      quality_grade: quality,
      growth_class: revClass,
      valuation_state: valuation,
      evidence,
      technical_lens: technicalLensFor(ARCHETYPES.STEADY_VALUE, { quality, valuation }),
    });
  }

  // 4) Defensive low-growth sectors without compounder growth.
  if (sector && DEFENSIVE_SECTORS.has(sector) && lowGrowth) {
    evidence.push(`sector=${sector}`, `rev=${revClass}`);
    if (quality) evidence.push(`quality=${quality}`);
    return lineage({
      ticker,
      archetype: ARCHETYPES.DEFENSIVE_LOW_GROWTH,
      quality_grade: quality,
      growth_class: revClass,
      valuation_state: valuation,
      evidence,
      technical_lens: technicalLensFor(ARCHETYPES.DEFENSIVE_LOW_GROWTH, { quality, valuation }),
    });
  }

  // 5) Cyclical value — cyclical sector + modest growth + not compounder.
  if (sector && CYCLICAL_SECTORS.has(sector) && revRank <= 2) {
    evidence.push(`sector=${sector}`, `rev=${revClass}`);
    if (quality) evidence.push(`quality=${quality}`);
    return lineage({
      ticker,
      archetype: ARCHETYPES.CYCLICAL_VALUE,
      quality_grade: quality,
      growth_class: revClass,
      valuation_state: valuation,
      evidence,
      technical_lens: technicalLensFor(ARCHETYPES.CYCLICAL_VALUE, { quality, valuation }),
    });
  }

  // 6) Growth watch / residual growth without full compounder eligibility.
  if (compounder?.tier === "growth_watch" || revRank >= 3) {
    evidence.push(compounder?.tier ? `compounder=${compounder.tier}` : `rev=${revClass}`);
    return lineage({
      ticker,
      archetype: ARCHETYPES.GROWTH_COMPOUNDER,
      quality_grade: quality,
      growth_class: revClass,
      valuation_state: valuation,
      compounder_tier: compounder?.tier || null,
      evidence,
      technical_lens: technicalLensFor(ARCHETYPES.GROWTH_COMPOUNDER, { quality, valuation }),
    });
  }

  // 7) Fallback steady value when quality is decent and growth is muted.
  if (stableQuality && lowGrowth) {
    evidence.push(`quality=${quality}`, `rev=${revClass}`, "fallback_steady_value");
    return lineage({
      ticker,
      archetype: ARCHETYPES.STEADY_VALUE,
      quality_grade: quality,
      growth_class: revClass,
      valuation_state: valuation,
      evidence,
      technical_lens: technicalLensFor(ARCHETYPES.STEADY_VALUE, { quality, valuation }),
    });
  }

  evidence.push("insufficient_character_signal");
  if (quality) evidence.push(`quality=${quality}`);
  if (revClass !== "unknown") evidence.push(`rev=${revClass}`);
  return lineage({
    ticker,
    archetype: ARCHETYPES.UNCLASSIFIED,
    quality_grade: quality,
    growth_class: revClass,
    valuation_state: valuation,
    evidence,
    technical_lens: technicalLensFor(ARCHETYPES.UNCLASSIFIED, { quality, valuation }),
  });
}

function lineage(fields) {
  return {
    version: BUSINESS_CHARACTER_VERSION,
    ticker: fields.ticker || null,
    archetype: fields.archetype || ARCHETYPES.UNCLASSIFIED,
    quality_grade: fields.quality_grade ?? null,
    growth_class: fields.growth_class ?? null,
    valuation_state: fields.valuation_state ?? null,
    compounder_tier: fields.compounder_tier ?? null,
    evidence: Array.isArray(fields.evidence) ? fields.evidence.slice(0, 8) : [],
    technical_lens: fields.technical_lens || technicalLensFor(fields.archetype),
    stale: fields.stale === true,
    max_age_days: FAIR_VALUE_MAX_AGE_DAYS,
  };
}

/**
 * How technical setups should be READ for this business character.
 * This is the 10x lever: same chart print, different meaning.
 */
export function technicalLensFor(archetype, opts = {}) {
  const a = archetype || ARCHETYPES.UNCLASSIFIED;
  const valuation = opts.valuation || null;

  const lenses = {
    [ARCHETYPES.GROWTH_COMPOUNDER]: {
      posture_bias: "accumulate_dips",
      pullback_means: "add_on_opportunity",
      breakout_means: "continuation_ok",
      extension_means: "hold_if_structure_intact",
      atr_expectation: "elevated_ok",
      confirmation_need: "moderate",
      patience: "high",
      preferred_vehicle: "options_first_on_runners",
      summary: "Growth compounder — pullbacks/reclaims are dip-buy context when monthly structure holds; don't treat low ATR as a defect.",
    },
    [ARCHETYPES.STEADY_VALUE]: {
      posture_bias: "mean_reversion_range",
      pullback_means: "range_accumulation",
      breakout_means: "needs_volume_theme_confirm",
      extension_means: "fade_or_trim_bias",
      atr_expectation: "low_is_normal",
      confirmation_need: "high_for_momentum",
      patience: "medium",
      preferred_vehicle: "shares_primary",
      summary: "Steady value — pullback/reclaim is range/accumulation, not a momentum chase; breakouts need stronger volume/theme confirmation.",
    },
    [ARCHETYPES.DEFENSIVE_LOW_GROWTH]: {
      posture_bias: "defensive_accumulation",
      pullback_means: "income_style_add",
      breakout_means: "skeptical_without_breadth",
      extension_means: "trim_into_strength",
      atr_expectation: "low_is_normal",
      confirmation_need: "high_for_momentum",
      patience: "medium",
      preferred_vehicle: "shares_primary",
      summary: "Defensive low-growth — treat dips as accumulation; do not score like a high-beta runner.",
    },
    [ARCHETYPES.CYCLICAL_VALUE]: {
      posture_bias: "cycle_aware",
      pullback_means: "cycle_entry_if_sector_ok",
      breakout_means: "sector_confirm_required",
      extension_means: "respect_cycle_peaks",
      atr_expectation: "regime_dependent",
      confirmation_need: "high",
      patience: "medium",
      preferred_vehicle: "shares_or_defined_risk",
      summary: "Cyclical value — technicals only count with sector/cycle alignment; ignore lone stock prints against the sector.",
    },
    [ARCHETYPES.SPEC_HIGH_BETA]: {
      posture_bias: "confirm_then_press",
      pullback_means: "knife_until_reclaim",
      breakout_means: "volume_must_confirm",
      extension_means: "trail_aggressively",
      atr_expectation: "very_elevated",
      confirmation_need: "very_high",
      patience: "low_until_confirm",
      preferred_vehicle: "defined_risk_options",
      summary: "Spec high-beta — require confirmation stages and volume; size defined-risk; do not average into failed reclaim.",
    },
    [ARCHETYPES.INDEX_PROXY]: {
      posture_bias: "regime_first",
      pullback_means: "index_timing",
      breakout_means: "breadth_confirm",
      extension_means: "respect_index_levels",
      atr_expectation: "index_normal",
      confirmation_need: "moderate",
      patience: "medium",
      preferred_vehicle: "shares_or_index_options",
      summary: "Index/proxy — follow regime and breadth; single-name growth logic does not apply.",
    },
    [ARCHETYPES.UNCLASSIFIED]: {
      posture_bias: "neutral",
      pullback_means: "technicals_only",
      breakout_means: "technicals_only",
      extension_means: "technicals_only",
      atr_expectation: "unknown",
      confirmation_need: "high",
      patience: "medium",
      preferred_vehicle: "undefined",
      summary: "Unclassified — technicals stand alone until fundamentals character is known.",
    },
  };

  const lens = { ...(lenses[a] || lenses[ARCHETYPES.UNCLASSIFIED]) };
  if (valuation === "discount" && a === ARCHETYPES.STEADY_VALUE) {
    lens.summary += " Trading below fair value — favor accumulation on location.";
  }
  if (valuation === "premium" && a === ARCHETYPES.GROWTH_COMPOUNDER) {
    lens.summary += " Premium valuation is earned only while growth/quality holds.";
  }
  return lens;
}

/**
 * Interpret a setup/sequence stage through the business-character lens.
 * Used by diagnostics / right-rail shadow read — not an entry gate.
 */
export function interpretSetupThroughCharacter(character, setup = {}) {
  const archetype = character?.archetype || ARCHETYPES.UNCLASSIFIED;
  const lens = character?.technical_lens || technicalLensFor(archetype);
  const stage = Number(setup.stage) || 0;
  const posture = String(setup.posture || setup.status || "").toLowerCase();
  const seqType = String(setup.sequence_type || setup.kind || "technical");

  let read = lens.summary;
  if (stage >= 1 && stage <= 3) {
    if (archetype === ARCHETYPES.GROWTH_COMPOUNDER) {
      read = `Early sequence (stage ${stage}) on a growth compounder — stalk the dip; ${lens.pullback_means.replace(/_/g, " ")}.`;
    } else if (archetype === ARCHETYPES.STEADY_VALUE || archetype === ARCHETYPES.DEFENSIVE_LOW_GROWTH) {
      read = `Early sequence (stage ${stage}) on steady/defensive value — ${lens.pullback_means.replace(/_/g, " ")}, not a momentum entry.`;
    } else if (archetype === ARCHETYPES.SPEC_HIGH_BETA) {
      read = `Early sequence (stage ${stage}) on high-beta — knife risk until reclaim; confirmation need is ${lens.confirmation_need.replace(/_/g, " ")}.`;
    }
  } else if (stage >= 4 && stage <= 6) {
    if (archetype === ARCHETYPES.GROWTH_COMPOUNDER) {
      read = `Mid sequence (stage ${stage}) — reclaim/continuation context; patience=${lens.patience}; vehicle=${lens.preferred_vehicle.replace(/_/g, " ")}.`;
    } else if (archetype === ARCHETYPES.STEADY_VALUE) {
      read = `Mid sequence (stage ${stage}) on steady value — breakout still ${lens.breakout_means.replace(/_/g, " ")}.`;
    } else if (archetype === ARCHETYPES.SPEC_HIGH_BETA) {
      read = `Mid sequence (stage ${stage}) on high-beta — only press if volume confirms; trail aggressively on extension.`;
    }
  } else if (stage >= 7) {
    read = `Late sequence (stage ${stage}) — ${lens.extension_means.replace(/_/g, " ")} (${archetype}).`;
  }

  return {
    archetype,
    sequence_type: seqType,
    stage,
    posture: posture || null,
    pullback_means: lens.pullback_means,
    breakout_means: lens.breakout_means,
    confirmation_need: lens.confirmation_need,
    patience: lens.patience,
    preferred_vehicle: lens.preferred_vehicle,
    read,
  };
}

/** Compact block for timed:latest / trail / lineage. */
export function businessCharacterLineage(character) {
  if (!character) return null;
  return {
    version: character.version || BUSINESS_CHARACTER_VERSION,
    archetype: character.archetype,
    quality_grade: character.quality_grade,
    growth_class: character.growth_class,
    valuation_state: character.valuation_state,
    compounder_tier: character.compounder_tier ?? null,
    evidence: character.evidence || [],
    technical_lens: character.technical_lens
      ? {
          posture_bias: character.technical_lens.posture_bias,
          pullback_means: character.technical_lens.pullback_means,
          breakout_means: character.technical_lens.breakout_means,
          confirmation_need: character.technical_lens.confirmation_need,
          patience: character.technical_lens.patience,
          preferred_vehicle: character.technical_lens.preferred_vehicle,
          summary: character.technical_lens.summary,
        }
      : null,
    stale: character.stale === true,
  };
}
