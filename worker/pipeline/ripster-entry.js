// worker/pipeline/ripster-entry.js
// Frozen A/B reference: Pure ripster cloud entry engine.
// Exact reproduction of the ripster_core block from qualifiesForEnter.
// Do NOT modify — kept for historical comparison only.

import { signalFreshness } from "../indicators.js";
import { getEasternParts } from "../market-calendar.js";
import { computePdzSizeMult } from "./sizing.js";

const FRESHNESS_MIN = 0.3;

export function evaluateEntry(ctx) {
  const { side, tf, scores, flags, config, raw, pdz } = ctx;
  const d = raw;
  if (!side) return reject("no_inferred_side");

  const m10 = tf.m10;
  const m30 = tf.m30;
  const h1 = tf.h1;
  const h4 = tf.h4;
  const D = tf.D;

  const emaRegimeDaily = Number(d?.ema_regime_daily) || 0;
  const daCfg = config.deepAudit || {};

  // ── CLOUD BIAS ALIGNMENT ──
  const cD_34 = D?.ripster?.c34_50;
  const c1h_34 = h1?.ripster?.c34_50;
  const c30_34 = m30?.ripster?.c34_50;
  const c10_34 = m10?.ripster?.c34_50;
  const c10_5 = m10?.ripster?.c5_12;
  const c10_8 = m10?.ripster?.c8_9;

  const dAligned = side === "LONG" ? !!cD_34?.bull : !!cD_34?.bear;
  const h1Aligned = side === "LONG" ? !!c1h_34?.bull : !!c1h_34?.bear;
  const h1Available = !!c1h_34 && (typeof c1h_34?.bull === "boolean" || typeof c1h_34?.bear === "boolean");
  const m30Aligned = side === "LONG" ? !!c30_34?.bull : !!c30_34?.bear;
  const structuralAligned = h1Available ? h1Aligned : m30Aligned;
  const m10Aligned = side === "LONG" ? !!c10_34?.bull : !!c10_34?.bear;
  const alignedCount = [dAligned, structuralAligned, m10Aligned].filter(Boolean).length;
  const strongDailyTrend = (side === "LONG" && emaRegimeDaily >= 2)
    || (side === "SHORT" && emaRegimeDaily <= -2);

  const biasAligned = config.ripsterTuneV2
    ? (dAligned && structuralAligned && (strongDailyTrend ? alignedCount >= 2 : m10Aligned))
    : (dAligned && structuralAligned && m10Aligned);

  if (!biasAligned) {
    return reject("ripster_bias_not_aligned", {
      c10_34: c10_34?.bull ? "bull" : c10_34?.bear ? "bear" : "na",
      c1h_34: c1h_34?.bull ? "bull" : c1h_34?.bear ? "bear" : "na",
      c30_34: c30_34?.bull ? "bull" : c30_34?.bear ? "bear" : "na",
      cD_34: cD_34?.bull ? "bull" : cD_34?.bear ? "bear" : "na",
      aligned_count: alignedCount,
      strong_daily_trend: strongDailyTrend,
      h1_available: h1Available,
      h1_fallback_used: !h1Available,
    });
  }

  // ── CONFIRMATION SIGNALS ──
  const now = ctx.asOfTs;
  const triggerSet = new Set((d?.triggers || []).map(t => String(t).toUpperCase()));
  const flagFresh = (flag, flagTs, signalType) => {
    if (!flag) return false;
    if (!flagTs || flagTs <= 0) return true;
    return signalFreshness(flagTs, now, signalType) >= FRESHNESS_MIN;
  };

  const hasStFlipBull = triggerSet.has("ST_FLIP_30M") || triggerSet.has("ST_FLIP_1H")
    || triggerSet.has("ST_FLIP_10M") || triggerSet.has("ST_FLIP_3M")
    || flagFresh(flags.st_flip_30m, flags.st_flip_30m_ts, "momentum")
    || flagFresh(flags.st_flip_1h, flags.st_flip_1h_ts, "structural")
    || flagFresh(flags.st_flip_10m, flags.st_flip_10m_ts, "momentum");
  const hasStFlipBear = triggerSet.has("ST_FLIP_30M_BEAR") || triggerSet.has("ST_FLIP_1H_BEAR")
    || triggerSet.has("ST_FLIP_10M_BEAR") || triggerSet.has("ST_FLIP_3M_BEAR")
    || flagFresh(flags.st_flip_bear, flags.st_flip_bear_ts, "momentum");
  const hasEmaCrossBull = triggerSet.has("EMA_CROSS_1H_13_48_BULL")
    || triggerSet.has("EMA_CROSS_30M_13_48_BULL") || triggerSet.has("EMA_CROSS_10M_13_48_BULL")
    || flagFresh(flags.ema_cross_1h_13_48, flags.ema_cross_1h_13_48_ts, "entry")
    || flagFresh(flags.ema_cross_30m_13_48, flags.ema_cross_30m_13_48_ts, "entry");
  const hasEmaCrossBear = triggerSet.has("EMA_CROSS_1H_13_48_BEAR")
    || triggerSet.has("EMA_CROSS_30M_13_48_BEAR") || triggerSet.has("EMA_CROSS_10M_13_48_BEAR");
  const hasSqRelease = triggerSet.has("SQUEEZE_RELEASE_30M") || triggerSet.has("SQUEEZE_RELEASE_1H")
    || flagFresh(flags.sq30_release, flags.sq30_release_ts, "momentum")
    || flagFresh(flags.sq1h_release, flags.sq1h_release_ts, "entry");

  const ltfRecovering = scores.ltf > -10 || hasStFlipBull || hasEmaCrossBull || hasSqRelease;
  const hasRsiDivBull = !!(m10?.rsiDiv?.bull || m30?.rsiDiv?.bull || h1?.rsiDiv?.bull);
  const hasRsiDivBear = !!(m10?.rsiDiv?.bear || m30?.rsiDiv?.bear || h1?.rsiDiv?.bear);
  const ltfConfirm = side === "LONG"
    ? (ltfRecovering || hasRsiDivBull)
    : (scores.ltf < 10 || hasStFlipBear || hasEmaCrossBear || hasSqRelease || hasRsiDivBear);

  // ── TRIGGERS ──
  const momentumTrigger = side === "LONG"
    ? !!(c10_5?.crossUp || (c10_5?.bull && c10_5?.above && c10_5?.fastSlope >= 0))
    : !!(c10_5?.crossDn || (c10_5?.bear && c10_5?.below && c10_5?.fastSlope <= 0));

  const pullbackTrigger = side === "LONG"
    ? !!((c10_8?.inCloud || c10_8?.above) && c10_8?.fastSlope >= 0 && ltfConfirm)
    : !!((c10_8?.inCloud || c10_8?.below) && c10_8?.fastSlope <= 0 && ltfConfirm);

  const reclaimTrigger = config.ripsterTuneV2 && (side === "LONG"
    ? !!((c10_8?.crossUp || (c10_8?.bull && c10_8?.above)) && hasStFlipBull && ltfRecovering && c10_8?.fastSlope >= 0)
    : !!((c10_8?.crossDn || (c10_8?.bear && c10_8?.below)) && hasStFlipBear && ltfConfirm && c10_8?.fastSlope <= 0));

  // ── REJECTION GATES ──
  const rsi10m = Number(m10?.rsi?.r5) || 50;
  const rsi30m = Number(m30?.rsi?.r5) || 50;
  const rsi1h = Number(h1?.rsi?.r5) || 50;
  const rsi4h = Number(h4?.rsi?.r5) || 50;
  const rsiD = Number(D?.rsi?.r5) || 50;
  const stDirD = Number(D?.stDir) || 0;
  const stDir10m = Number(m10?.stDir) || 0;
  const stDir30m = Number(m30?.stDir) || 0;
  const trendExtensionPct = Number(c10_5?.distToCloudPct) || 0;

  const chaseRsi10L = Number(daCfg.deep_audit_ripster_chase_rsi10_long) || 74;
  const chaseRsi30L = Number(daCfg.deep_audit_ripster_chase_rsi30_long) || 68;
  const chaseRsi10S = Number(daCfg.deep_audit_ripster_chase_rsi10_short) || 26;
  const chaseRsi30S = Number(daCfg.deep_audit_ripster_chase_rsi30_short) || 32;
  const chaseDistPct = Number(daCfg.deep_audit_ripster_chase_dist_to_cloud_pct) || 0.0045;
  const heatRsi30 = Number(daCfg.deep_audit_ripster_momentum_heat_rsi30) || 70;
  const heatRsi1H = Number(daCfg.deep_audit_ripster_momentum_heat_rsi1h) || 70;
  const openNoiseEndMin = Number(daCfg.deep_audit_ripster_opening_noise_end_minute) || 45;
  const nowEt = getEasternParts(new Date(now));
  const inOpeningNoise = nowEt.hour === 9 && nowEt.minute < openNoiseEndMin;

  if (config.ripsterTuneV2 && momentumTrigger && !pullbackTrigger && !reclaimTrigger) {
    if ((side === "LONG" && rsi10m >= chaseRsi10L && rsi30m >= chaseRsi30L && trendExtensionPct >= chaseDistPct)
      || (side === "SHORT" && rsi10m <= chaseRsi10S && rsi30m <= chaseRsi30S && trendExtensionPct >= chaseDistPct)) {
      return reject("ripster_chasing_extension", { rsi10m, rsi30m, distToCloudPct: trendExtensionPct });
    }
    if ((side === "LONG" && rsi10m >= 77 && rsiD >= 80) || (side === "SHORT" && rsi10m <= 23 && rsiD <= 20)) {
      return reject("ripster_rsi_10m_daily_heat", { rsi10m, rsiD });
    }
    if ((side === "LONG" && rsi30m >= heatRsi30 && rsi1h >= heatRsi1H)
      || (side === "SHORT" && rsi30m <= (100 - heatRsi30) && rsi1h <= (100 - heatRsi1H))) {
      return reject("ripster_rsi_heat_block", { rsi30m, rsi1h });
    }
    if ((side === "LONG" && stDirD === 1) || (side === "SHORT" && stDirD === -1)) {
      return reject("ripster_daily_st_conflict", { stDirD });
    }
    if ((side === "LONG" && stDir10m === 1 && stDir30m === 1)
      || (side === "SHORT" && stDir10m === -1 && stDir30m === -1)) {
      return reject("ripster_ltf_st_opposed", { stDir10m, stDir30m });
    }
    if (inOpeningNoise) {
      return reject("ripster_opening_chase_guard", { hour: nowEt.hour, minute: nowEt.minute });
    }
    if ((side === "LONG" && (rsi4h >= 80 || rsiD >= 82))
      || (side === "SHORT" && (rsi4h <= 20 || rsiD <= 18))) {
      return reject("ripster_htf_rsi_extreme", { rsi4h, rsiD });
    }
  }

  if (config.ripsterTuneV2 && pullbackTrigger && !reclaimTrigger
    && side === "LONG" && rsiD >= 85 && rsi4h >= 75 && !hasEmaCrossBull) {
    return reject("ripster_pullback_daily_rsi_exhausted", { rsi4h, rsiD });
  }

  // ── MEAN REVERSION TRIGGER ──
  const pdzD = D?.pdz || d?.pdz_D || {};
  const pdzZoneD = String(pdzD.zone || d?.pdz_zone_D || "unknown");
  const pdz4h = h4?.pdz || {};
  const pdzZone4h = String(pdz4h.zone || d?.pdz_zone_4h || "unknown");
  const fvgD = d?.fvg_D || {};
  const liqD = d?.liq_D || {};
  const td9 = d?.mean_revert_td9 || {};
  const phaseDLeaving = Math.abs(Number(D?.ph?.v) || 0) < 10 && Math.abs(Number(D?.ph?.prev) || 0) > 20;
  const phase4hLeaving = Math.abs(Number(h4?.ph?.v) || 0) < 10 && Math.abs(Number(h4?.ph?.prev) || 0) > 20;
  const phaseOrTd9 = phaseDLeaving || phase4hLeaving || !!td9?.active;

  const mrPdzValid = (side === "LONG" && (pdzZoneD === "discount" || pdzZoneD === "discount_approach"))
    || (side === "SHORT" && (pdzZoneD === "premium" || pdzZoneD === "premium_approach"));
  const rsiExtremes = [rsi30m, rsi1h, rsi4h, rsiD];
  const mrRsiValid = (side === "LONG" && rsiExtremes.filter(r => r < 30).length >= 2)
    || (side === "SHORT" && rsiExtremes.filter(r => r > 70).length >= 2);
  const mrFvgReclaim = side === "LONG"
    ? !!(fvgD.inBullGap || fvgD.activeBull > 0)
    : !!(fvgD.inBearGap || fvgD.activeBear > 0);
  const mrLiqSwept = side === "LONG"
    ? ((liqD?.sellside || []).some?.(z => z.swept) || ((liqD?.sellsideCount ?? 0) > 0 && (liqD?.sellside || []).length === 0))
    : ((liqD?.buyside || []).some?.(z => z.swept) || ((liqD?.buysideCount ?? 0) > 0 && (liqD?.buyside || []).length === 0));

  const meanReversionTrigger = mrPdzValid && mrRsiValid && phaseOrTd9 && (mrFvgReclaim || mrLiqSwept);

  // ── RESULTS ──
  if (momentumTrigger) {
    return qualify("ripster_momentum", "medium", "ripster_5_12_trend_trigger", pdzZoneD);
  }
  if (pullbackTrigger) {
    return qualify("ripster_pullback", "medium", "ripster_8_9_bounce", pdzZoneD);
  }
  if (reclaimTrigger) {
    return qualify("ripster_reclaim", "medium", "ripster_8_9_reclaim_st_flip", pdzZoneD);
  }
  if (meanReversionTrigger) {
    if (d) d.__da_mean_revert_size_mult = 0.5;
    return qualify("mean_reversion_pdz", td9?.active ? "medium" : "low",
      `pdz_exhaustion_reversal_${pdzZoneD}`, pdzZoneD);
  }

  return reject("ripster_no_trigger", { ripster_bias_state: "aligned_34_50_d_1h_10m" });
}

function reject(reason, metadata = {}) {
  return { qualifies: false, reason, engine: "ripster_core", path: null, confidence: null, direction: null, sizing: null, metadata };
}

function qualify(path, confidence, reason, pdzZoneD) {
  return {
    qualifies: true,
    path,
    confidence,
    direction: null,
    engine: "ripster_core",
    reason,
    ripster_bias_state: "aligned_34_50_d_1h_10m",
    pdz_zone_D: pdzZoneD,
    sizing: null,
    metadata: {},
  };
}
