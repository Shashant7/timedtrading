// worker/pipeline/tt-core-entry.js
// TT Core hybrid entry engine — ripster cloud structure + enhanced quality + mean reversion.
// Primary engine: takes ripster cloud alignment as structural foundation,
// adds ticker-profile-aware quality filters, and mean reversion path.

import { signalFreshness } from "../indicators.js";
import { getEasternParts } from "../market-calendar.js";
import { computePdzSizeMult } from "./sizing.js";

const FRESHNESS_MIN = 0.3;

/**
 * Evaluate entry using TT Core hybrid engine.
 * @param {TradeContext} ctx
 * @returns {EntryResult}
 */
export function evaluateEntry(ctx) {
  const { side, tf, scores, flags, config, raw, pdz, regime } = ctx;
  const d = raw;
  if (!side) return reject("no_inferred_side");

  const m10 = tf.m10;
  const m30 = tf.m30;
  const h1 = tf.h1;
  const h4 = tf.h4;
  const D = tf.D;

  const emaRegimeDaily = Number(d?.ema_regime_daily) || 0;
  const daCfg = config.deepAudit || {};

  // ── 1. CLOUD BIAS ALIGNMENT (D + 1H + LTF 34/50) ──
  const cD_34 = D?.ripster?.c34_50;
  const c1h_34 = h1?.ripster?.c34_50;
  const c10_34 = m10?.ripster?.c34_50;
  const c10_5 = m10?.ripster?.c5_12;
  const c10_8 = m10?.ripster?.c8_9;

  const dAligned = side === "LONG" ? !!cD_34?.bull : !!cD_34?.bear;
  const h1Aligned = side === "LONG" ? !!c1h_34?.bull : !!c1h_34?.bear;
  const m10Aligned = side === "LONG" ? !!c10_34?.bull : !!c10_34?.bear;
  const alignedCount = [dAligned, h1Aligned, m10Aligned].filter(Boolean).length;
  const strongDailyTrend = (side === "LONG" && emaRegimeDaily >= 2)
    || (side === "SHORT" && emaRegimeDaily <= -2);

  const biasAligned = config.ripsterTuneV2
    ? (dAligned && h1Aligned && (strongDailyTrend ? alignedCount >= 2 : m10Aligned))
    : (dAligned && h1Aligned && m10Aligned);

  if (!biasAligned) {
    return reject("tt_bias_not_aligned", {
      cloudAlignment: {
        D: cD_34?.bull ? "bull" : cD_34?.bear ? "bear" : "na",
        h1: c1h_34?.bull ? "bull" : c1h_34?.bear ? "bear" : "na",
        m10: c10_34?.bull ? "bull" : c10_34?.bear ? "bear" : "na",
      },
      alignedCount,
      strongDailyTrend,
    });
  }

  // ── 2. CONFIRMATION SIGNALS (with freshness) ──
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

  // ── 3. ENTRY TRIGGERS ──
  const momentumTrigger = side === "LONG"
    ? !!(c10_5?.crossUp || (c10_5?.bull && c10_5?.above && c10_5?.fastSlope >= 0))
    : !!(c10_5?.crossDn || (c10_5?.bear && c10_5?.below && c10_5?.fastSlope <= 0));

  const pullbackTrigger = side === "LONG"
    ? !!((c10_8?.inCloud || c10_8?.above) && c10_8?.fastSlope >= 0 && ltfConfirm)
    : !!((c10_8?.inCloud || c10_8?.below) && c10_8?.fastSlope <= 0 && ltfConfirm);

  const reclaimTrigger = config.ripsterTuneV2 && (side === "LONG"
    ? !!((c10_8?.crossUp || (c10_8?.bull && c10_8?.above)) && hasStFlipBull && ltfRecovering && c10_8?.fastSlope >= 0)
    : !!((c10_8?.crossDn || (c10_8?.bear && c10_8?.below)) && hasStFlipBear && ltfConfirm && c10_8?.fastSlope <= 0));

  // ── 4. QUALITY REJECTION GATES ──
  const rsi10m = Number(m10?.rsi?.r5) || 50;
  const rsi30m = Number(m30?.rsi?.r5) || 50;
  const rsi1h = Number(h1?.rsi?.r5) || 50;
  const rsi4h = Number(h4?.rsi?.r5) || 50;
  const rsiD = Number(D?.rsi?.r5) || 50;
  const stDir10m = Number(m10?.stDir) || 0;
  const stDir30m = Number(m30?.stDir) || 0;
  const stDirD = Number(D?.stDir) || 0;
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
    const chasingLong = side === "LONG" && rsi10m >= chaseRsi10L
      && rsi30m >= chaseRsi30L && trendExtensionPct >= chaseDistPct;
    const chasingShort = side === "SHORT" && rsi10m <= chaseRsi10S
      && rsi30m <= chaseRsi30S && trendExtensionPct >= chaseDistPct;
    if (chasingLong || chasingShort) {
      return reject("tt_chasing_extension", { rsi10m, rsi30m, distToCloudPct: trendExtensionPct });
    }

    // ── 10m–30m BIAS SPREAD (trend maturity) ──
    // Analysis: perfect entries had spread ~+0.12, chasers had ~0.005.
    // When 30m has caught up to 10m (spread near zero), the move is mature.
    const tfStack = d?.swing_consensus?.tf_stack;
    if (Array.isArray(tfStack)) {
      const bias10m = tfStack.find(e => e.tf === "10m")?.biasScore;
      const bias30m = tfStack.find(e => e.tf === "30m")?.biasScore;
      if (bias10m != null && bias30m != null) {
        const spread = Math.abs(bias10m) - Math.abs(bias30m);
        const minSpread = Number(daCfg.deep_audit_bias_spread_min) || 0.05;
        if (spread < minSpread) {
          return reject("tt_trend_mature_bias_spread", {
            bias10m, bias30m, spread, minSpread,
          });
        }
      }
    }

    const rsiDailyHeat = (side === "LONG" && rsi10m >= 77 && rsiD >= 80)
      || (side === "SHORT" && rsi10m <= 23 && rsiD <= 20);
    if (rsiDailyHeat) {
      return reject("tt_rsi_daily_heat", { rsi10m, rsiD });
    }

    const momHeat = (side === "LONG" && rsi30m >= heatRsi30 && rsi1h >= heatRsi1H)
      || (side === "SHORT" && rsi30m <= (100 - heatRsi30) && rsi1h <= (100 - heatRsi1H));
    if (momHeat) {
      return reject("tt_momentum_rsi_heat", { rsi30m, rsi1h });
    }

    const dailyStConflict = (side === "LONG" && stDirD === 1)
      || (side === "SHORT" && stDirD === -1);
    if (dailyStConflict) {
      return reject("tt_daily_st_conflict", { stDirD });
    }

    const ltfOpposed = (side === "LONG" && stDir10m === 1 && stDir30m === 1)
      || (side === "SHORT" && stDir10m === -1 && stDir30m === -1);
    if (ltfOpposed) {
      return reject("tt_ltf_st_opposed", { stDir10m, stDir30m });
    }

    if (inOpeningNoise) {
      return reject("tt_opening_noise", { hour: nowEt.hour, minute: nowEt.minute });
    }

    const htfRsiExtreme = (side === "LONG" && (rsi4h >= 80 || rsiD >= 82))
      || (side === "SHORT" && (rsi4h <= 20 || rsiD <= 18));
    if (htfRsiExtreme) {
      return reject("tt_htf_rsi_extreme", { rsi4h, rsiD });
    }

    const allTfHigh = Number(daCfg.deep_audit_rsi_all_tf_high) || 70;
    const allTfLow = Number(daCfg.deep_audit_rsi_all_tf_low) || 30;
    const allTfExtreme = (side === "LONG" && [rsi10m, rsi30m, rsi1h, rsi4h, rsiD].every(v => v >= allTfHigh))
      || (side === "SHORT" && [rsi10m, rsi30m, rsi1h, rsi4h, rsiD].every(v => v <= allTfLow));
    if (allTfExtreme && !isProfileExtremeFriendly(d, side)) {
      return reject("tt_all_tf_rsi_extreme", { rsi10m, rsi30m, rsi1h, rsi4h, rsiD });
    }
  }

  if (config.ripsterTuneV2 && pullbackTrigger && !reclaimTrigger
    && side === "LONG" && rsiD >= 85 && rsi4h >= 75 && !hasEmaCrossBull) {
    return reject("tt_pullback_daily_rsi_exhausted", { rsi4h, rsiD });
  }

  // ── 5. MEAN REVERSION TRIGGER ──
  const pdzZoneD = pdz.zoneD;
  const pdz4h = h4?.pdz || {};
  const pdzZone4h = String(pdz4h.zone || d?.pdz_zone_4h || "unknown");
  const fvgD = d?.fvg_D || {};
  const liqD = d?.liq_D || {};
  const td9 = d?.mean_revert_td9 || {};
  const phaseD = Number(D?.ph?.v) || 0;
  const phase4h = Number(h4?.ph?.v) || 0;
  const phaseDLeaving = Math.abs(phaseD) < 10 && Math.abs(Number(D?.ph?.prev) || 0) > 20;
  const phase4hLeaving = Math.abs(phase4h) < 10 && Math.abs(Number(h4?.ph?.prev) || 0) > 20;
  const phaseOrTd9 = phaseDLeaving || phase4hLeaving || !!td9?.active;

  const mrPdzLong = pdzZoneD === "discount" || pdzZoneD === "discount_approach";
  const mrPdzShort = pdzZoneD === "premium" || pdzZoneD === "premium_approach";
  const mrPdzValid = (side === "LONG" && mrPdzLong) || (side === "SHORT" && mrPdzShort);

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

  // ── 6. BUILD ENTRY RESULT ──
  const cloudMeta = {
    D: cD_34?.bull ? "bull" : cD_34?.bear ? "bear" : "na",
    h1: c1h_34?.bull ? "bull" : c1h_34?.bear ? "bear" : "na",
    m10: c10_34?.bull ? "bull" : c10_34?.bear ? "bear" : "na",
  };

  const pdzSizeMult = computePdzSizeMult(pdzZoneD, side);

  const baseSizing = {
    pdz: pdzSizeMult,
    meanRevert: 1.0,
    regime: Number(regime.params?.positionSizeMultiplier) || 1.0,
    danger: 1.0,
    rvol: 1.0,
    spy: 1.0,
    orb: 1.0,
    internals: 1.0,
  };

  if (momentumTrigger) {
    return qualify("tt_momentum", "medium", "tt_5_12_trend_trigger", {
      ...baseSizing,
    }, {
      cloudAlignment: cloudMeta,
      triggerType: "momentum_5_12_cross",
      pdzZone: { D: pdzZoneD, h4: pdzZone4h },
      rsiHeat: { m10: rsi10m, m30: rsi30m, h1: rsi1h },
    });
  }
  if (pullbackTrigger) {
    return qualify("tt_pullback", "medium", "tt_8_9_bounce", {
      ...baseSizing,
    }, {
      cloudAlignment: cloudMeta,
      triggerType: "pullback_8_9_bounce",
      pdzZone: { D: pdzZoneD, h4: pdzZone4h },
      rsiHeat: { m10: rsi10m, m30: rsi30m, h1: rsi1h },
    });
  }
  if (reclaimTrigger) {
    return qualify("tt_reclaim", "medium", "tt_8_9_reclaim_st_flip", {
      ...baseSizing,
    }, {
      cloudAlignment: cloudMeta,
      triggerType: "reclaim_8_9_st_flip",
      pdzZone: { D: pdzZoneD, h4: pdzZone4h },
      rsiHeat: { m10: rsi10m, m30: rsi30m, h1: rsi1h },
    });
  }
  if (meanReversionTrigger) {
    return qualify("tt_mean_revert", td9?.active ? "medium" : "low",
      `pdz_exhaustion_reversal_${pdzZoneD}`, {
        ...baseSizing,
        meanRevert: 0.5,
      }, {
        cloudAlignment: cloudMeta,
        triggerType: "mean_reversion_pdz",
        pdzZone: { D: pdzZoneD, h4: pdzZone4h },
        meanRevert: {
          pdzZoneD, pdzZone4h,
          rsiExtremeCount: rsiExtremes.filter(r => side === "LONG" ? r < 30 : r > 70).length,
          phaseLeaving: phaseDLeaving || phase4hLeaving,
          td9Active: !!td9?.active,
          fvgReclaim: mrFvgReclaim,
          liqSwept: mrLiqSwept,
        },
      });
  }

  return reject("tt_no_trigger", { cloudAlignment: cloudMeta });
}

function isProfileExtremeFriendly(d, side) {
  const learn = d?._ticker_profile?.learning;
  if (!learn?.entry_params) return false;
  const ep = learn.entry_params;
  const dirProfile = side === "LONG" ? learn.long_profile : learn.short_profile;
  const rsiAtOrigin = dirProfile?.rsi_at_origin || {};
  const minPct = 40;
  return side === "LONG"
    ? (String(ep.long_rsi_sweet_spot || "").toLowerCase() === "high" && Number(rsiAtOrigin.high_zone_pct) >= minPct)
    : (String(ep.short_rsi_sweet_spot || "").toLowerCase() === "low" && Number(rsiAtOrigin.low_zone_pct) >= minPct);
}

function reject(reason, metadata = {}) {
  return {
    qualifies: false,
    reason,
    engine: "tt_core",
    path: null,
    confidence: null,
    direction: null,
    sizing: null,
    metadata,
  };
}

function qualify(path, confidence, reason, sizing, metadata) {
  return {
    qualifies: true,
    path,
    confidence,
    direction: null,
    engine: "tt_core",
    reason,
    sizing,
    metadata,
  };
}
