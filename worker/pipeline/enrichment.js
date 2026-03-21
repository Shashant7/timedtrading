// worker/pipeline/enrichment.js
// Post-entry enrichment: quality gates, sizing adjustments, precision metrics.
// Runs AFTER an engine returns qualifies:true, BEFORE sizing pipeline.

import { computePdzSizeMult } from "./sizing.js";

/**
 * Enrich an entry result with quality gates, confidence boosts, and sizing mults.
 * May downgrade qualifies:true to qualifies:false if quality is too low.
 *
 * @param {EntryResult} result - Raw engine output
 * @param {TradeContext} ctx
 * @returns {EntryResult} - Enriched (or rejected)
 */
export function enrichEntry(result, ctx) {
  if (!result || !result.qualifies) return result;

  const d = ctx.raw;
  const { side, scores, flags, support, regime, pdz } = ctx;

  // ── 1. PATH AUTO-DISABLE (learning loop) ──
  const pathPerfCache = d?._pathPerfCache;
  if (pathPerfCache && pathPerfCache.size > 0 && result.path) {
    const perf = pathPerfCache.get(result.path);
    if (perf && perf.enabled === 0) {
      return disqualify(result, "path_auto_disabled", { disableReason: perf.disable_reason });
    }
  }

  // ── 2. PULLBACK CONFIRMATION (regime entries only) ──
  const isRegimePath = result.path?.startsWith("ema_regime_confirmed")
    || result.path?.startsWith("ema_regime_early");
  if (isRegimePath && !d?.__pullback_confirmed) {
    return disqualify(result, "pullback_not_confirmed", { details: d?.__pullback_details });
  }

  // ── 3. ENTRY QUALITY GATE ──
  const eqScore = Number(d?.entry_quality?.score) || 0;
  const volTier = String(d?.volatility_tier || "MEDIUM");
  const entryThresholdAdj = Number(d?._ticker_profile?.entry_threshold_adj) || 0;
  const baseMin = volTier === "EXTREME" ? 70 : volTier === "HIGH" ? 65
    : volTier === "MEDIUM" ? 55 : 50;
  let minQuality = baseMin + entryThresholdAdj;

  if (isRegimePath) {
    result.entryQuality = eqScore;
    result.precision = buildPrecision(ctx);
    return applyPdzSizing(result, ctx);
  }

  const isGoldPath = result.path?.includes("gold") || result.path?.includes("pullback");
  if (isGoldPath) minQuality = Math.max(45, minQuality);

  const isLong = !result.path?.includes("short");
  const hasSqRelease = !!(flags.sq30_release || flags.sq1h_release);
  if (hasSqRelease && isLong && !isGoldPath) {
    minQuality = Math.max(minQuality, minQuality + 10);
  }

  if (eqScore > 0 && eqScore < minQuality && result.engine !== "tt_core") {
    return disqualify(result, "entry_quality_too_low", { eqScore, minQuality });
  }

  // ── 4. LIQUIDITY CONGESTION REJECTION ──
  const liq4h = d?.liq_4h;
  const liqD = d?.liq_D;
  const liqPrimary = liq4h || liqD;
  if (liqPrimary) {
    const liqDist = side === "LONG"
      ? liqPrimary.nearestBuysideDist
      : liqPrimary.nearestSellsideDist;
    if (liqDist > 0 && liqDist < 0.5) {
      const liqZones = side === "LONG" ? (liqPrimary.buyside || []) : (liqPrimary.sellside || []);
      const liqStrong = liqZones.some(z => z.count >= 3);
      if (liqStrong) {
        const liqFuel = scores.fuel30;
        const liqRsi1H = Number(ctx.tf.h1?.rsi?.r5) || 50;
        const momWeak = liqFuel < 50 || (side === "LONG" ? liqRsi1H > 65 : liqRsi1H < 35);
        if (momWeak && result.engine !== "tt_core") {
          return disqualify(result, "liq_congestion", { dist: liqDist, fuel: liqFuel, rsi1H: liqRsi1H });
        }
      }
    }
  }

  // ── 5. LIQUIDITY SWEEP + FVG BONUS ──
  let liqSweepBoost = 0;
  let liqSweepFlag = null;
  const fvgD = d?.fvg_D || {};
  if (liqPrimary) {
    if (side === "LONG") {
      const sslSwept = (liqPrimary.sellside || []).length === 0 && (liqPrimary.sellsideCount ?? 0) > 0;
      const sslSweptAlt = (liq4h?.sellside || []).some?.(z => z.swept)
        || (liqD?.sellside || []).some?.(z => z.swept);
      const hasBullFvg = fvgD.activeBull > 0 || fvgD.inBullGap;
      if ((sslSwept || sslSweptAlt) && hasBullFvg) {
        liqSweepBoost = 5;
        liqSweepFlag = "liq_sweep_fvg_long";
      }
      const bsDist = liqPrimary.nearestBuysideDist;
      if (bsDist > 0 && bsDist < 0.5 && liqSweepBoost === 0) {
        liqSweepBoost = -3;
        liqSweepFlag = "liq_into_bsl_penalty";
      }
    } else {
      const bslSwept = (liqPrimary.buyside || []).length === 0 && (liqPrimary.buysideCount ?? 0) > 0;
      const bslSweptAlt = (liq4h?.buyside || []).some?.(z => z.swept)
        || (liqD?.buyside || []).some?.(z => z.swept);
      const hasBearFvg = fvgD.activeBear > 0 || fvgD.inBearGap;
      if ((bslSwept || bslSweptAlt) && hasBearFvg) {
        liqSweepBoost = 5;
        liqSweepFlag = "liq_sweep_fvg_short";
      }
      const ssDist = liqPrimary.nearestSellsideDist;
      if (ssDist > 0 && ssDist < 0.5 && liqSweepBoost === 0) {
        liqSweepBoost = -3;
        liqSweepFlag = "liq_into_ssl_penalty";
      }
    }
  }
  if (liqSweepBoost !== 0) {
    result.liqSweepBoost = liqSweepBoost;
    result.liqSweepFlag = liqSweepFlag;
  }

  // ── 6. GOLDEN GATE CONFIDENCE BOOST ──
  const activeGates = support.activeGates || [];
  const hasActiveBullGate = activeGates.some(g => g.side === "bull" && !g.completed);
  const hasActiveBearGate = activeGates.some(g => g.side === "bear" && !g.completed);
  const multiHorizonGate = activeGates.filter(g => !g.completed).length >= 2;
  const gateMatch = isLong ? hasActiveBullGate : hasActiveBearGate;

  if (gateMatch) {
    if (result.confidence === "low") result.confidence = "medium";
    else if (result.confidence === "medium" && multiHorizonGate) result.confidence = "high";
    result.gate_boost = true;
  }
  if (multiHorizonGate) result.multi_horizon_gate = true;

  // ── 7. PRECISION METRICS ──
  result.precision = buildPrecision(ctx);
  result.entryQuality = eqScore;

  // ── 8. TIME-TO-TARGET ESTIMATION ──
  result.timeToTarget = computeTimeToTarget(ctx, result);

  // ── 9. PDZ SIZING ──
  return applyPdzSizing(result, ctx);
}

/**
 * Estimate time to target based on available signals at entry.
 * Uses TD Sequential prep counts, Phase zone, ATR range exhaustion,
 * and backtest-calibrated median durations.
 *
 * @returns {{ estimatedPeakBars: number, estimatedPeakHours: number, factors: object }}
 */
function computeTimeToTarget(ctx, result) {
  const d = ctx.raw;
  const { side, scores, regime, tf } = ctx;

  const factors = {};
  let estimatedHours = 85; // backtest median hours-to-peak

  // Factor 1: TD Sequential prep count (bars remaining to TD9)
  // Higher prep count = closer to exhaustion = less time remaining
  const tdD = d?.td_daily || d?.tf_tech?.D?.td;
  if (tdD) {
    const prepCount = side === "LONG"
      ? (tdD.bearish_prep_count || tdD.bear_prep || 0)
      : (tdD.bullish_prep_count || tdD.bull_prep || 0);
    if (prepCount >= 6) {
      factors.td_near_exhaustion = true;
      estimatedHours *= 0.6; // closer to exhaustion, less time to peak
    } else if (prepCount >= 3) {
      factors.td_mid_cycle = true;
      estimatedHours *= 0.85;
    }
    factors.td_prep_d = prepCount;
  }

  // Factor 2: Phase oscillator zone
  // If already in extreme zone, peak is imminent
  const phaseD = d?.tf_tech?.D?.ph?.v ?? d?.tf_tech?.D?.saty?.v;
  if (phaseD != null) {
    const absPhase = Math.abs(phaseD);
    if (absPhase > 80) {
      factors.phase_extreme = true;
      estimatedHours *= 0.5;
    } else if (absPhase > 50) {
      factors.phase_high = true;
      estimatedHours *= 0.7;
    } else if (absPhase < 20) {
      factors.phase_early = true;
      estimatedHours *= 1.3; // early in move, more time
    }
    factors.phase_D_value = phaseD;
  }

  // Factor 3: ATR range exhaustion
  // rangeOfATR > 1.5 = most of period's move already consumed
  const atrBandD = d?.tf_tech?.D?.atr;
  if (atrBandD) {
    const zone = Number(atrBandD.lo) || 0;
    if (zone >= 1.5) {
      factors.atr_range_exhausted = true;
      estimatedHours *= 0.6;
    } else if (zone >= 1.0) {
      factors.atr_range_mid = true;
      estimatedHours *= 0.8;
    } else if (zone < 0.5) {
      factors.atr_range_early = true;
      estimatedHours *= 1.2;
    }
  }

  // Factor 4: Regime-based adjustment
  // Trending regimes: moves last longer. Choppy: shorter.
  const regimeClass = regime?.class || "";
  if (regimeClass.includes("TREND")) {
    factors.regime_trending = true;
    estimatedHours *= 1.2;
  } else if (regimeClass.includes("CHOP") || regimeClass.includes("RANGE")) {
    factors.regime_choppy = true;
    estimatedHours *= 0.7;
  }

  // Factor 5: Fuel gauge (momentum remaining)
  const fuelPct = scores?.primaryFuel ?? 0;
  if (fuelPct > 70) {
    factors.fuel_high = true;
    estimatedHours *= 1.1; // more fuel = longer move
  } else if (fuelPct < 30) {
    factors.fuel_low = true;
    estimatedHours *= 0.7;
  }

  // Factor 6: Engine-specific calibration
  // tt_core reaches peak faster (86h median vs 100h for ripster_core)
  if (result?.engine === "tt_core") {
    estimatedHours *= 0.86;
    factors.engine_tt_core = true;
  }

  // Clamp to reasonable range (2h to 300h)
  estimatedHours = Math.max(2, Math.min(300, estimatedHours));
  const estimatedPeakBars = Math.round(estimatedHours / 0.167); // 10-min bars

  return {
    estimatedPeakBars,
    estimatedPeakHours: Math.round(estimatedHours * 10) / 10,
    factors,
  };
}

function buildPrecision(ctx) {
  const { scores, ema, support, regime, rvol } = ctx;
  return {
    fuelPct: scores.primaryFuel,
    supportScore: support.stScore,
    emaDepth30: ema.depth30,
    emaDepthD: ema.depthD,
    emaStruct30: ema.struct30,
    emaStructD: ema.structD,
    emaMom30: ema.mom30,
    emaMomD: ema.momD,
    activeGateCount: (support.activeGates || []).length,
    regime: regime.class,
    rvolBest: rvol.best,
    positionSizeMultiplier: Number(regime.params?.positionSizeMultiplier) || 1.0,
  };
}

function applyPdzSizing(result, ctx) {
  const { side, pdz } = ctx;
  const pdzZone = String(pdz.zoneD || result?.pdz_zone_D || "unknown");
  const pathSide = result.path?.includes("short") ? "SHORT" : side;
  const mult = computePdzSizeMult(pdzZone, pathSide);
  if (mult !== 1.0) {
    result.pdz_size_mult = mult;
    if (ctx.raw) ctx.raw.__pdz_size_mult = mult;
  }
  return result;
}

function disqualify(result, reason, extra = {}) {
  return { qualifies: false, reason, path: result.path, engine: result.engine, ...extra };
}
