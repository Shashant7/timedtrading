// worker/harmonic-modifiers.js
// Soft Harmonic Wave overlays for ranking, sizing, trim, and investor lanes.
// All paths are CIO-vetted; rank tilt is bounded and calibration-weighted.

import { analyzeHarmonicCycle } from "./harmonic-cycle.js";

export const HARMONIC_RANK_GATE_KEY = "harmonic_rank_boost_enabled";
export const HARMONIC_CALIBRATION_WEIGHT_KEY = "harmonic_calibration_weight";

export const HARMONIC_TILT_MAX = 4; // softer than theme tilt (±6)
const clamp = (v, lim) => Math.max(-lim, Math.min(lim, v));
const rnd1 = (v) => Math.round(v * 10) / 10;

/** Default soft calibration weight — half-strength until accuracy data lands. */
export const DEFAULT_CALIBRATION_WEIGHT = 0.5;

export function resolveHarmonicGateConfig(deepAuditConfig = {}) {
  const cfg = deepAuditConfig && typeof deepAuditConfig === "object" ? deepAuditConfig : {};
  const enabled = String(cfg[HARMONIC_RANK_GATE_KEY] ?? "true") !== "false";
  const rawW = Number(cfg[HARMONIC_CALIBRATION_WEIGHT_KEY]);
  const calibrationWeight = Number.isFinite(rawW) && rawW > 0 ? Math.min(1, rawW) : DEFAULT_CALIBRATION_WEIGHT;
  return { enabled, calibrationWeight };
}

/**
 * Signed rank tilt magnitude (positive favors LONG-side candidates).
 * Uses harmonic label + phase/direction, clamped to ±HARMONIC_TILT_MAX.
 */
export function computeHarmonicTiltMagnitude(harmonic) {
  if (!harmonic || (harmonic.ok === false && !harmonic.label)) return 0;
  const label = String(harmonic.label || "");
  const rising = String(harmonic.direction || "") === "rising";
  const phase = Number(harmonic.phase_pct);

  let tilt = 0;
  if (label.includes("trough") || label.includes("early cycle")) {
    tilt = rising ? 3.5 : 1.5;
  } else if (label.includes("recovery")) {
    tilt = rising ? 2.5 : 0.5;
  } else if (label.includes("mid cycle / rising")) {
    tilt = 1.5;
  } else if (label.includes("mid cycle / rolling")) {
    tilt = -1.5;
  } else if (label.includes("late cycle")) {
    tilt = rising ? -1 : -2.5;
  } else if (label.includes("past peak") || label.includes("down-cycle")) {
    tilt = -3.5;
  } else {
    tilt = rising ? 0.5 : -0.5;
  }

  if (Number.isFinite(phase)) {
    if (phase < 0.25 && rising) tilt = Math.max(tilt, 2);
    if (phase > 0.7 && !rising) tilt = Math.min(tilt, -2);
  }

  return clamp(rnd1(tilt), HARMONIC_TILT_MAX);
}

/** Investor lane bias from cyclical inflection. */
export function computeHarmonicInvestorBias(harmonic) {
  if (!harmonic?.label) return "neutral";
  const label = String(harmonic.label);
  const rising = harmonic.direction === "rising";
  if (label.includes("trough") || label.includes("early cycle")) {
    return rising ? "accumulate_favor" : "neutral";
  }
  if (label.includes("recovery") && rising) return "accumulate_favor";
  if (label.includes("past peak") || label.includes("down-cycle")) return "reduce_favor";
  if (label.includes("late cycle") && !rising) return "reduce_favor";
  return "neutral";
}

/**
 * Soft position-size multiplier from harmonic alignment with trade direction.
 * Blends toward 1.0 using calibrationWeight.
 */
export function computeHarmonicSizeMult(harmonic, direction, calibrationWeight = DEFAULT_CALIBRATION_WEIGHT) {
  const baseTilt = Number(harmonic?.rank_tilt_base ?? computeHarmonicTiltMagnitude(harmonic));
  if (!Number.isFinite(baseTilt) || baseTilt === 0) return 1;
  const dir = String(direction || "LONG").toUpperCase();
  const side = dir === "SHORT" ? -1 : 1;
  const aligned = baseTilt * side;
  let raw = 1;
  if (aligned >= 2) raw = 1.08;
  else if (aligned >= 1) raw = 1.04;
  else if (aligned <= -2) raw = 0.92;
  else if (aligned <= -1) raw = 0.96;
  const w = Number.isFinite(Number(calibrationWeight)) && calibrationWeight > 0
    ? Math.min(1, Number(calibrationWeight))
    : DEFAULT_CALIBRATION_WEIGHT;
  return Math.round((1 + (raw - 1) * w) * 100) / 100;
}

/**
 * Trim advisory for open winners when cyclical phase conflicts with direction.
 * Advisory only — CIO lifecycle gate weighs it; no auto-execution.
 */
export function computeHarmonicTrimAdvisory({
  harmonic,
  direction,
  pnlPct,
  trimmedPct = 0,
} = {}) {
  if (!harmonic?.label) return null;
  const dir = String(direction || "LONG").toUpperCase();
  const isLong = dir !== "SHORT";
  const label = String(harmonic.label);
  const rising = harmonic.direction === "rising";
  const pnl = Number(pnlPct) || 0;
  const trimmed = Math.max(0, Math.min(1, Number(trimmedPct) || 0));
  if (trimmed >= 0.5) return null;

  const reasons = [];
  let suggested = 0;
  let strength = null;

  if (isLong) {
    if ((label.includes("past peak") || label.includes("late cycle")) && !rising) {
      reasons.push("harmonic_late_cycle");
      if (pnl >= 1) {
        suggested = pnl >= 5 ? 0.25 : 0.15;
        strength = label.includes("past peak") ? "strong" : "standard";
      }
    } else if (label.includes("down-cycle") && pnl >= 2) {
      reasons.push("harmonic_down_cycle");
      suggested = 0.2;
      strength = "standard";
    }
  } else if ((label.includes("trough") || label.includes("early cycle") || label.includes("recovery")) && rising) {
    reasons.push("harmonic_trough_rising");
    if (pnl >= 1) {
      suggested = 0.2;
      strength = "standard";
    }
  }

  if (!reasons.length || suggested <= 0) return null;

  return {
    source: "harmonic_cycle",
    label: harmonic.label,
    phase_pct: harmonic.phase_pct,
    direction: harmonic.direction,
    suggested_trim_pct: suggested,
    strength,
    reasons,
    note: "Harmonic Wave advisory — soft overlay; CIO must weigh against technicals and timing overlay.",
  };
}

/** Run harmonic decomposition on D candles and return a compact payload for timed:latest. */
export function stampHarmonicCycleFromDCandles(dCandles, opts = {}) {
  const closes = [];
  for (const c of (dCandles || [])) {
    const close = Number(c?.c);
    if (Number.isFinite(close) && close > 0) closes.push(close);
  }
  const raw = analyzeHarmonicCycle(closes, {
    minBars: opts.minBars || 240,
    topN: opts.topN || 5,
  });
  if (!raw?.ok) return null;
  return compactHarmonicForPayload(raw, opts);
}

export function compactHarmonicForPayload(raw, opts = {}) {
  const w = Number(opts.calibrationWeight);
  const calibrationWeight = Number.isFinite(w) && w > 0 ? Math.min(1, w) : DEFAULT_CALIBRATION_WEIGHT;
  const rankTiltBase = computeHarmonicTiltMagnitude(raw);
  const rankTilt = rnd1(rankTiltBase * calibrationWeight);
  return {
    ok: true,
    primary_period: raw.primary_period,
    phase_pct: raw.phase_pct,
    direction: raw.direction,
    label: raw.label,
    composite_value: raw.composite_value,
    dominant_periods: raw.dominant_periods,
    bars: raw.bars,
    source: raw.source,
    rank_tilt_base: rankTiltBase,
    rank_tilt: rankTilt,
    calibration_weight: calibrationWeight,
    investor_bias: computeHarmonicInvestorBias(raw),
    stamped_at: Date.now(),
  };
}

/** CIO-friendly condensation from ticker payload fields. */
export function condenseHarmonicCycle(tickerData) {
  const h = tickerData?.harmonic_cycle;
  if (!h?.label && !Number.isFinite(Number(h?.phase_pct))) return null;
  const trim = tickerData?.__harmonic_trim_advisory;
  const out = {
    label: h.label || null,
    phase_pct: h.phase_pct ?? null,
    direction: h.direction || null,
    primary_period: h.primary_period ?? null,
    rank_tilt: h.rank_tilt ?? null,
    investor_bias: h.investor_bias || null,
    note: "Harmonic Wave — desk cyclical composite (180d/315d ladder). Reference when cycle phase supports or conflicts with the proposal.",
  };
  if (trim) {
    out.trim_advisory = {
      suggested_trim_pct: trim.suggested_trim_pct,
      strength: trim.strength,
      reasons: trim.reasons,
    };
  }
  return out;
}
