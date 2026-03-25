// worker/pipeline/tt-core-entry.js
// TT Core hybrid entry engine — ripster cloud structure + enhanced quality + mean reversion.
// Primary engine: takes ripster cloud alignment as structural foundation,
// adds ticker-profile-aware quality filters, and mean reversion path.

import { signalFreshness } from "../indicators.js";
import { getEasternParts } from "../market-calendar.js";
import { computePdzSizeMult } from "./sizing.js";

const FRESHNESS_MIN = 0.3;
const TT_CORE_TRACE_CASES = new Map([
  ["FIX:1751378400000", "fix_bad_pullback_hard_cap"],
  ["FIX:1751392800000", "fix_bad_pullback_doa"],
  ["FIX:1751895000000", "fix_bad_momentum_breakeven"],
  ["FIX:1752160800000", "fix_good_pullback_control"],
  ["FIX:1753108200000", "fix_bad_pullback_late"],
  ["FIX:1753380000000", "fix_good_momentum_control"],
  ["RBLX:1751376600000", "rblx_bad_momentum_hard_cap"],
  ["RBLX:1751994000000", "rblx_good_pullback_remote_0708"],
  ["RBLX:1751895000000", "rblx_good_momentum_control"],
  ["RBLX:1752162000000", "rblx_good_pullback_control"],
  ["RBLX:1752674400000", "rblx_bad_momentum_soft_fuse"],
  ["RBLX:1752761400000", "rblx_bad_momentum_confirmed"],
  ["RBLX:1752846000000", "rblx_bad_momentum_late"],
  ["RBLX:1753201800000", "rblx_remaining_remote_loss_0722"],
  ["RBLX:1753118400000", "rblx_bad_pullback_hard_cap"],
]);

/**
 * Evaluate entry using TT Core hybrid engine.
 * @param {TradeContext} ctx
 * @returns {EntryResult}
 */
export function evaluateEntry(ctx) {
  const { side, tf, scores, flags, config, raw, pdz, regime, movePhase } = ctx;
  const d = raw;
  const traceCase = resolveTraceCase(ctx);

  let momentumTrigger = false;
  let pullbackTrigger = false;
  let reclaimTrigger = false;
  let c10FiveTwelveConfirmed = false;
  let c30FiveTwelveConfirmed = false;
  let c30FiveTwelveOpposed = false;
  let hasStFlipBull = false;
  let hasStFlipBear = false;
  let hasEmaCrossBull = false;
  let hasEmaCrossBear = false;
  let hasSqRelease = false;
  let ltfRecovering = false;
  let ltfConfirm = false;
  let rsi10m = null;
  let rsi30m = null;
  let rsi1h = null;
  let rsi4h = null;
  let rsiD = null;
  let stDir10m = 0;
  let stDir15m = 0;
  let stDir30m = 0;
  let stDirD = 0;
  let trendExtensionPct = 0;
  let bearishPullbackCount = 0;
  let emaStructure15m = 0;

  const traceDecision = (decision, payload = {}) => {
    if (!traceCase) return;
    emitTrace(traceCase, decision, {
      ticker: ctx.ticker,
      side,
      asOfTs: ctx.asOfTs,
      state: ctx.state || null,
      scores: {
        htf: scores?.htf ?? null,
        ltf: scores?.ltf ?? null,
        rank: scores?.rank ?? null,
      },
      triggers: {
        momentumTrigger,
        pullbackTrigger,
        reclaimTrigger,
      },
      confirmations: {
        hasStFlipBull,
        hasStFlipBear,
        hasEmaCrossBull,
        hasEmaCrossBear,
        hasSqRelease,
        ltfRecovering,
        ltfConfirm,
        c10FiveTwelveConfirmed,
        c30FiveTwelveConfirmed,
        c30FiveTwelveOpposed,
      },
      clouds: {
        c10_5: summarizeCloud(c10_5),
        c10_8: summarizeCloud(c10_8),
        c30_5: summarizeCloud(c30_5),
        c10_34: summarizeCloud(c10_34),
        c30_34: summarizeCloud(c30_34),
      },
      st: {
        m10: stDir10m,
        m15: stDir15m,
        m30: stDir30m,
        D: stDirD,
        bearishPullbackCount,
      },
      rsi: {
        m10: rsi10m,
        m30: rsi30m,
        h1: rsi1h,
        h4: rsi4h,
        D: rsiD,
      },
      emaStructure15m,
      trendExtensionPct,
      movePhase: summarizeMovePhase(movePhase),
      ...payload,
    });
  };
  const rejectEntry = (reason, metadata = {}) => {
    traceDecision("reject", { reason, metadata });
    return reject(reason, metadata);
  };
  const qualifyEntry = (path, confidence, reason, sizing, metadata) => {
    traceDecision("qualify", { path, confidence, reason, metadata });
    return qualify(path, confidence, reason, sizing, metadata);
  };

  if (!side) return rejectEntry("no_inferred_side");

  const m10 = tf.m10;
  const m15 = tf.m15;
  const m30 = tf.m30;
  const h1 = tf.h1;
  const h4 = tf.h4;
  const D = tf.D;

  const emaRegimeDaily = Number(d?.ema_regime_daily) || 0;
  const daCfg = config.deepAudit || {};

  // ── 1. CLOUD BIAS ALIGNMENT (D + 1H + LTF 34/50) ──
  const cD_34 = D?.ripster?.c34_50;
  const c1h_34 = h1?.ripster?.c34_50;
  const c30_34 = m30?.ripster?.c34_50;
  const c10_34 = m10?.ripster?.c34_50;
  const c10_5 = m10?.ripster?.c5_12;
  const c10_8 = m10?.ripster?.c8_9;
  const c30_5 = m30?.ripster?.c5_12;

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

  traceDecision("entry", {
    bias: {
      aligned: biasAligned,
      alignedCount,
      strongDailyTrend,
      dAligned,
      structuralAligned,
      m10Aligned,
      h1Available,
    },
  });

  if (!biasAligned) {
    return rejectEntry("tt_bias_not_aligned", {
      cloudAlignment: {
        D: cD_34?.bull ? "bull" : cD_34?.bear ? "bear" : "na",
        h1: c1h_34?.bull ? "bull" : c1h_34?.bear ? "bear" : "na",
        m30: c30_34?.bull ? "bull" : c30_34?.bear ? "bear" : "na",
        m10: c10_34?.bull ? "bull" : c10_34?.bear ? "bear" : "na",
      },
      alignedCount,
      strongDailyTrend,
      h1Available,
      h1FallbackUsed: !h1Available,
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

  hasStFlipBull = triggerSet.has("ST_FLIP_30M") || triggerSet.has("ST_FLIP_1H")
    || triggerSet.has("ST_FLIP_10M") || triggerSet.has("ST_FLIP_3M")
    || flagFresh(flags.st_flip_30m, flags.st_flip_30m_ts, "momentum")
    || flagFresh(flags.st_flip_1h, flags.st_flip_1h_ts, "structural")
    || flagFresh(flags.st_flip_10m, flags.st_flip_10m_ts, "momentum");
  hasStFlipBear = triggerSet.has("ST_FLIP_30M_BEAR") || triggerSet.has("ST_FLIP_1H_BEAR")
    || triggerSet.has("ST_FLIP_10M_BEAR") || triggerSet.has("ST_FLIP_3M_BEAR")
    || flagFresh(flags.st_flip_bear, flags.st_flip_bear_ts, "momentum");
  hasEmaCrossBull = triggerSet.has("EMA_CROSS_1H_13_48_BULL")
    || triggerSet.has("EMA_CROSS_30M_13_48_BULL") || triggerSet.has("EMA_CROSS_10M_13_48_BULL")
    || flagFresh(flags.ema_cross_1h_13_48, flags.ema_cross_1h_13_48_ts, "entry")
    || flagFresh(flags.ema_cross_30m_13_48, flags.ema_cross_30m_13_48_ts, "entry");
  hasEmaCrossBear = triggerSet.has("EMA_CROSS_1H_13_48_BEAR")
    || triggerSet.has("EMA_CROSS_30M_13_48_BEAR") || triggerSet.has("EMA_CROSS_10M_13_48_BEAR");
  hasSqRelease = triggerSet.has("SQUEEZE_RELEASE_30M") || triggerSet.has("SQUEEZE_RELEASE_1H")
    || flagFresh(flags.sq30_release, flags.sq30_release_ts, "momentum")
    || flagFresh(flags.sq1h_release, flags.sq1h_release_ts, "entry");

  ltfRecovering = scores.ltf > -10 || hasStFlipBull || hasEmaCrossBull || hasSqRelease;
  const hasRsiDivBull = hasActiveRsiDivergence([m10, m30, h1], "bull");
  const hasRsiDivBear = hasActiveRsiDivergence([m10, m30, h1], "bear");
  const adverseRsiDiv = side === "LONG"
    ? collectActiveRsiDivergence([m10, m30, h1, h4, D], "bear")
    : collectActiveRsiDivergence([m10, m30, h1, h4, D], "bull");
  ltfConfirm = side === "LONG"
    ? (ltfRecovering || hasRsiDivBull)
    : (scores.ltf < 10 || hasStFlipBear || hasEmaCrossBear || hasSqRelease || hasRsiDivBear);

  // ── 3. ENTRY TRIGGERS ──
  momentumTrigger = side === "LONG"
    ? !!(c10_5?.crossUp || (c10_5?.bull && c10_5?.above && c10_5?.fastSlope >= 0))
    : !!(c10_5?.crossDn || (c10_5?.bear && c10_5?.below && c10_5?.fastSlope <= 0));

  pullbackTrigger = side === "LONG"
    ? !!((c10_8?.inCloud || c10_8?.above) && c10_8?.fastSlope >= 0 && ltfConfirm)
    : !!((c10_8?.inCloud || c10_8?.below) && c10_8?.fastSlope <= 0 && ltfConfirm);

  reclaimTrigger = config.ripsterTuneV2 && (side === "LONG"
    ? !!((c10_8?.crossUp || (c10_8?.bull && c10_8?.above)) && hasStFlipBull && ltfRecovering && c10_8?.fastSlope >= 0)
    : !!((c10_8?.crossDn || (c10_8?.bear && c10_8?.below)) && hasStFlipBear && ltfConfirm && c10_8?.fastSlope <= 0));

  c10FiveTwelveConfirmed = side === "LONG"
    ? !!(c10_5?.bull && c10_5?.above)
    : !!(c10_5?.bear && c10_5?.below);
  c30FiveTwelveConfirmed = side === "LONG"
    ? !!(c30_5?.bull && c30_5?.above)
    : !!(c30_5?.bear && c30_5?.below);
  c30FiveTwelveOpposed = side === "LONG"
    ? !!c30_5?.below
    : !!c30_5?.above;

  // ── 4. QUALITY REJECTION GATES ──
  rsi10m = Number(m10?.rsi?.r5) || 50;
  rsi30m = Number(m30?.rsi?.r5) || 50;
  rsi1h = Number(h1?.rsi?.r5) || 50;
  rsi4h = Number(h4?.rsi?.r5) || 50;
  rsiD = Number(D?.rsi?.r5) || 50;
  stDir10m = Number(m10?.stDir) || 0;
  stDir30m = Number(m30?.stDir) || 0;
  stDirD = Number(D?.stDir) || 0;
  trendExtensionPct = Number(c10_5?.distToCloudPct) || 0;

  const chaseRsi10L = Number(daCfg.deep_audit_ripster_chase_rsi10_long) || 74;
  const chaseRsi30L = Number(daCfg.deep_audit_ripster_chase_rsi30_long) || 68;
  const chaseRsi10S = Number(daCfg.deep_audit_ripster_chase_rsi10_short) || 26;
  const chaseRsi30S = Number(daCfg.deep_audit_ripster_chase_rsi30_short) || 32;
  const chaseDistPct = Number(daCfg.deep_audit_ripster_chase_dist_to_cloud_pct) || 0.0045;
  const heatRsi30 = Number(daCfg.deep_audit_ripster_momentum_heat_rsi30) || 70;
  const heatRsi1H = Number(daCfg.deep_audit_ripster_momentum_heat_rsi1h) || 70;
  const executionProfileName = String(d?.execution_profile?.active_profile || "");
  const tickerPersonality = String(d?._ticker_profile?.learning?.personality || "");
  const correctionTransitionProfile = executionProfileName === "correction_transition";
  const pullbackPlayerPersonality = tickerPersonality === "PULLBACK_PLAYER"
    || tickerPersonality === "MEAN_REVERT";
  const volatileRunnerPersonality = tickerPersonality === "VOLATILE_RUNNER";

  const openNoiseEndMin = Number(daCfg.deep_audit_ripster_opening_noise_end_minute) || 45;
  const nowEt = getEasternParts(new Date(now));
  const inOpeningNoise = nowEt.hour === 9 && nowEt.minute < openNoiseEndMin;

  if (config.ripsterTuneV2 && momentumTrigger && !pullbackTrigger && !reclaimTrigger) {
    const chasingLong = side === "LONG" && rsi10m >= chaseRsi10L
      && rsi30m >= chaseRsi30L && trendExtensionPct >= chaseDistPct;
    const chasingShort = side === "SHORT" && rsi10m <= chaseRsi10S
      && rsi30m <= chaseRsi30S && trendExtensionPct >= chaseDistPct;
    if (chasingLong || chasingShort) {
      return rejectEntry("tt_chasing_extension", { rsi10m, rsi30m, distToCloudPct: trendExtensionPct });
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
          return rejectEntry("tt_trend_mature_bias_spread", {
            bias10m, bias30m, spread, minSpread,
          });
        }
      }
    }

    const rsiDailyHeat = (side === "LONG" && rsi10m >= 77 && rsiD >= 80)
      || (side === "SHORT" && rsi10m <= 23 && rsiD <= 20);
    if (rsiDailyHeat) {
      return rejectEntry("tt_rsi_daily_heat", { rsi10m, rsiD });
    }

    const momHeat = (side === "LONG" && rsi30m >= heatRsi30 && rsi1h >= heatRsi1H)
      || (side === "SHORT" && rsi30m <= (100 - heatRsi30) && rsi1h <= (100 - heatRsi1H));
    if (momHeat) {
      return rejectEntry("tt_momentum_rsi_heat", { rsi30m, rsi1h });
    }

    const dailyStConflict = (side === "LONG" && stDirD === 1)
      || (side === "SHORT" && stDirD === -1);
    if (dailyStConflict) {
      return rejectEntry("tt_daily_st_conflict", { stDirD });
    }

    const ltfOpposed = (side === "LONG" && stDir10m === 1 && stDir30m === 1)
      || (side === "SHORT" && stDir10m === -1 && stDir30m === -1);
    if (ltfOpposed) {
      return rejectEntry("tt_ltf_st_opposed", { stDir10m, stDir30m });
    }

    if (inOpeningNoise) {
      return rejectEntry("tt_opening_noise", { hour: nowEt.hour, minute: nowEt.minute });
    }

    const htfRsiExtreme = (side === "LONG" && (rsi4h >= 80 || rsiD >= 82))
      || (side === "SHORT" && (rsi4h <= 20 || rsiD <= 18));
    if (htfRsiExtreme) {
      return rejectEntry("tt_htf_rsi_extreme", { rsi4h, rsiD });
    }

    const allTfHigh = Number(daCfg.deep_audit_rsi_all_tf_high) || 70;
    const allTfLow = Number(daCfg.deep_audit_rsi_all_tf_low) || 30;
    const allTfExtreme = (side === "LONG" && [rsi10m, rsi30m, rsi1h, rsi4h, rsiD].every(v => v >= allTfHigh))
      || (side === "SHORT" && [rsi10m, rsi30m, rsi1h, rsi4h, rsiD].every(v => v <= allTfLow));
    if (allTfExtreme && !isProfileExtremeFriendly(d, side)) {
      return rejectEntry("tt_all_tf_rsi_extreme", { rsi10m, rsi30m, rsi1h, rsi4h, rsiD });
    }
  }

  if (config.ripsterTuneV2 && momentumTrigger && c30_5 && !c30FiveTwelveConfirmed) {
    return rejectEntry("tt_momentum_30m_5_12_unconfirmed", {
      c10_5: summarizeCloud(c10_5),
      c30_5: summarizeCloud(c30_5),
    });
  }

  if (config.ripsterTuneV2 && pullbackTrigger && !reclaimTrigger
    && c30FiveTwelveOpposed && !c10FiveTwelveConfirmed) {
    return rejectEntry("tt_pullback_5_12_not_reclaimed", {
      c10_5: summarizeCloud(c10_5),
      c10_8: summarizeCloud(c10_8),
      c30_5: summarizeCloud(c30_5),
    });
  }

  if (config.ripsterTuneV2 && (pullbackTrigger || reclaimTrigger)
    && c30FiveTwelveOpposed && !c10FiveTwelveConfirmed) {
    return rejectEntry("tt_pullback_reclaim_5_12_unconfirmed", {
      c10_5: summarizeCloud(c10_5),
      c10_8: summarizeCloud(c10_8),
      c30_5: summarizeCloud(c30_5),
      reclaimTrigger,
    });
  }

  stDir15m = Number(m15?.stDir) || 0;
  bearishPullbackCount = [stDir15m, stDir30m, Number(h1?.stDir) || 0]
    .filter((dir) => dir === 1)
    .length;
  if (config.ripsterTuneV2 && side === "LONG"
    && (pullbackTrigger || reclaimTrigger)
    && bearishPullbackCount < 2) {
    return rejectEntry("tt_pullback_not_deep_enough", {
      stDir15m,
      stDir30m,
      stDir1h: Number(h1?.stDir) || 0,
      bearishPullbackCount,
      reclaimTrigger,
    });
  }

  emaStructure15m = Number(m15?.ema?.structure) || 0;
  if (config.ripsterTuneV2 && side === "LONG" && momentumTrigger
    && stDir30m === 1 && emaStructure15m < 0) {
    return rejectEntry("tt_momentum_ltf_fractured", {
      stDir15m,
      stDir30m,
      emaStructure15m,
    });
  }

  const impulseChaseDistPct = Number(daCfg.deep_audit_ripster_impulse_chase_dist_to_cloud_pct) || 0.0035;
  if (config.ripsterTuneV2 && side === "LONG" && momentumTrigger
    && stDir15m === 1
    && trendExtensionPct >= impulseChaseDistPct
    && rsi1h >= 60) {
    return rejectEntry("tt_momentum_impulse_chase", {
      stDir15m,
      distToCloudPct: trendExtensionPct,
      impulseChaseDistPct,
      rsi1h,
    });
  }

  if (config.ripsterTuneV2 && pullbackTrigger && !reclaimTrigger
    && side === "LONG" && rsiD >= 85 && rsi4h >= 75 && !hasEmaCrossBull) {
    return rejectEntry("tt_pullback_daily_rsi_exhausted", { rsi4h, rsiD });
  }

  if (config.ripsterTuneV2 && correctionTransitionProfile && pullbackPlayerPersonality
    && pullbackTrigger && !reclaimTrigger) {
    const shallowPullbackDistPct = Number(daCfg.deep_audit_ripster_shallow_pullback_dist_to_cloud_pct) || 0.0032;
    const shallowPullback = side === "LONG"
      ? !!(c10_8?.above && !c10_8?.inCloud && trendExtensionPct >= shallowPullbackDistPct)
      : !!(c10_8?.below && !c10_8?.inCloud && trendExtensionPct >= shallowPullbackDistPct);
    const higherTfHeat = side === "LONG"
      ? (rsi30m >= heatRsi30 && rsi1h >= heatRsi1H && (rsi4h >= 68 || rsiD >= 72))
      : (rsi30m <= (100 - heatRsi30) && rsi1h <= (100 - heatRsi1H) && (rsi4h <= 32 || rsiD <= 28));
    const freshStructureImpulse = side === "LONG"
      ? (hasStFlipBull || hasEmaCrossBull)
      : (hasStFlipBear || hasEmaCrossBear);
    if (shallowPullback && higherTfHeat && !freshStructureImpulse) {
      return rejectEntry("tt_pullback_player_hot_shallow_pullback", {
        executionProfileName,
        tickerPersonality,
        distToCloudPct: trendExtensionPct,
        shallowPullbackDistPct,
        rsi30m,
        rsi1h,
        rsi4h,
        rsiD,
      });
    }
  }

  if (config.ripsterTuneV2 && correctionTransitionProfile
    && side === "LONG" && pullbackTrigger && !reclaimTrigger) {
    const shallowPullbackDistPct = Number(daCfg.deep_audit_ripster_shallow_pullback_dist_to_cloud_pct) || 0.0032;
    const movePhaseScores = movePhase?.scores || {};
    const hotShallowPullback = !!(
      c10_5?.above && !c10_5?.inCloud
      && c10_8?.above && !c10_8?.inCloud
      && trendExtensionPct >= shallowPullbackDistPct
    );
    const exhaustedMove = (Number(movePhaseScores.atrExhaustedCount) || 0) >= 1
      || (Number(movePhaseScores.phaseExtremeCount) || 0) >= 1;
    if (hotShallowPullback && exhaustedMove) {
      return rejectEntry("tt_pullback_correction_transition_hot_extension", {
        executionProfileName,
        distToCloudPct: trendExtensionPct,
        shallowPullbackDistPct,
        atrExhaustedCount: Number(movePhaseScores.atrExhaustedCount) || 0,
        phaseExtremeCount: Number(movePhaseScores.phaseExtremeCount) || 0,
        c10_5: summarizeCloud(c10_5),
        c10_8: summarizeCloud(c10_8),
      });
    }
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
  const movePhaseSummary = summarizeMovePhase(movePhase);
  const adverseRsiDivSummary = summarizeDivergence(adverseRsiDiv);
  const shouldBlockMomentumPeak = config.ripsterTuneV2 && momentumTrigger
    && (
      movePhase?.profile === "countertrend_peak_risk"
      || (
        movePhase?.profile === "exhausted"
        && !!adverseRsiDivSummary
        && Number(movePhase?.pdz?.unfavorableCount || 0) > 0
      )
    );
  const shouldBlockReclaimPeak = config.ripsterTuneV2 && reclaimTrigger
    && movePhase?.profile === "countertrend_peak_risk"
    && !!adverseRsiDivSummary;

  if (shouldBlockMomentumPeak) {
    return rejectEntry("tt_move_phase_peak_risk", {
      triggerType: "momentum_5_12_cross",
      movePhase: movePhaseSummary,
      adverseRsiDivergence: adverseRsiDivSummary,
    });
  }
  if (shouldBlockReclaimPeak) {
    return rejectEntry("tt_reclaim_move_phase_peak_risk", {
      triggerType: "reclaim_8_9_st_flip",
      movePhase: movePhaseSummary,
      adverseRsiDivergence: adverseRsiDivSummary,
    });
  }

  // ── 6. BUILD ENTRY RESULT ──
  const cloudMeta = {
    D: cD_34?.bull ? "bull" : cD_34?.bear ? "bear" : "na",
    h1: c1h_34?.bull ? "bull" : c1h_34?.bear ? "bear" : "na",
    m10: c10_34?.bull ? "bull" : c10_34?.bear ? "bear" : "na",
  };

  const pdzSizeMult = computePdzSizeMult(pdzZoneD, side);
  const profileRegimeMult = correctionTransitionProfile ? 0.9 : 1.0;
  const volatileMomentumMult = momentumTrigger && volatileRunnerPersonality ? 0.9 : 1.0;
  const regimeSizeMult = (Number(regime.params?.positionSizeMultiplier) || 1.0)
    * profileRegimeMult * volatileMomentumMult;

  const baseSizing = {
    pdz: pdzSizeMult,
    meanRevert: 1.0,
    regime: regimeSizeMult,
    danger: 1.0,
    rvol: 1.0,
    spy: 1.0,
    orb: 1.0,
    internals: 1.0,
  };

  if (momentumTrigger) {
    return qualifyEntry("tt_momentum", "medium", "tt_5_12_trend_trigger", {
      ...baseSizing,
    }, {
      cloudAlignment: cloudMeta,
      triggerType: "momentum_5_12_cross",
      pdzZone: { D: pdzZoneD, h4: pdzZone4h },
      rsiHeat: { m10: rsi10m, m30: rsi30m, h1: rsi1h },
      movePhase: movePhaseSummary,
      adverseRsiDivergence: adverseRsiDivSummary,
      executionProfile: {
        name: executionProfileName || null,
        personality: tickerPersonality || null,
        profileRegimeMult,
        volatileMomentumMult,
      },
    });
  }
  if (pullbackTrigger) {
    return qualifyEntry("tt_pullback", "medium", "tt_8_9_bounce", {
      ...baseSizing,
    }, {
      cloudAlignment: cloudMeta,
      triggerType: "pullback_8_9_bounce",
      pdzZone: { D: pdzZoneD, h4: pdzZone4h },
      rsiHeat: { m10: rsi10m, m30: rsi30m, h1: rsi1h },
      movePhase: movePhaseSummary,
      adverseRsiDivergence: adverseRsiDivSummary,
      executionProfile: {
        name: executionProfileName || null,
        personality: tickerPersonality || null,
        profileRegimeMult,
        volatileMomentumMult,
      },
    });
  }
  if (reclaimTrigger) {
    return qualifyEntry("tt_reclaim", "medium", "tt_8_9_reclaim_st_flip", {
      ...baseSizing,
    }, {
      cloudAlignment: cloudMeta,
      triggerType: "reclaim_8_9_st_flip",
      pdzZone: { D: pdzZoneD, h4: pdzZone4h },
      rsiHeat: { m10: rsi10m, m30: rsi30m, h1: rsi1h },
      movePhase: movePhaseSummary,
      adverseRsiDivergence: adverseRsiDivSummary,
      executionProfile: {
        name: executionProfileName || null,
        personality: tickerPersonality || null,
        profileRegimeMult,
        volatileMomentumMult,
      },
    });
  }
  if (meanReversionTrigger) {
    return qualifyEntry("tt_mean_revert", td9?.active ? "medium" : "low",
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
        movePhase: movePhaseSummary,
        adverseRsiDivergence: adverseRsiDivSummary,
      });
  }

  return rejectEntry("tt_no_trigger", { cloudAlignment: cloudMeta });
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

function summarizeMovePhase(movePhase) {
  if (!movePhase) return null;
  return {
    profile: movePhase.profile || "neutral",
    blockMomentum: !!movePhase.blockMomentum,
    blockReclaim: !!movePhase.blockReclaim,
    reasons: Array.isArray(movePhase.reasons) ? movePhase.reasons.slice(0, 5) : [],
    scores: movePhase.scores || null,
  };
}

function hasActiveRsiDivergence(tfs, side) {
  return !!collectActiveRsiDivergence(tfs, side);
}

function collectActiveRsiDivergence(tfs, side) {
  const hits = [];
  for (const [idx, tf] of (tfs || []).entries()) {
    const div = tf?.rsiDiv?.[side];
    if (!div?.active) continue;
    const strength = Number(div.strength) || 0;
    const barsSince = Number(div.barsSince);
    if (strength < 1.5) continue;
    if (Number.isFinite(barsSince) && barsSince > 8) continue;
    hits.push({
      tf: tfLabelForIndex(idx),
      strength,
      barsSince: Number.isFinite(barsSince) ? barsSince : null,
    });
  }
  return hits.length ? hits : null;
}

function summarizeDivergence(hits) {
  if (!hits || !hits.length) return null;
  return {
    count: hits.length,
    strongest: hits.reduce((best, hit) => !best || hit.strength > best.strength ? hit : best, null),
    tfs: hits.map((hit) => hit.tf),
  };
}

function tfLabelForIndex(idx) {
  return ["10m", "30m", "1h", "4h", "D"][idx] || `tf_${idx}`;
}

function summarizeCloud(cloud) {
  if (!cloud) return null;
  return {
    bull: !!cloud.bull,
    bear: !!cloud.bear,
    above: !!cloud.above,
    below: !!cloud.below,
    inCloud: !!cloud.inCloud,
    distToCloudPct: Number(cloud.distToCloudPct) || 0,
    fastSlope: Number(cloud.fastSlope) || 0,
    slowSlope: Number(cloud.slowSlope) || 0,
  };
}

function resolveTraceCase(ctx) {
  if (!ctx?.isReplay) return null;
  const ticker = String(ctx?.ticker || ctx?.raw?.ticker || ctx?.raw?.sym || "").toUpperCase();
  const ts = Number(ctx?.asOfTs);
  if (!ticker || !Number.isFinite(ts)) return null;
  const label = TT_CORE_TRACE_CASES.get(`${ticker}:${ts}`);
  return label ? { ticker, ts, label } : null;
}

function emitTrace(traceCase, phase, payload) {
  if (!traceCase) return;
  try {
    console.log(`[TT-TRACE] ${JSON.stringify({
      label: traceCase.label,
      ticker: traceCase.ticker,
      ts: traceCase.ts,
      phase,
      ...payload,
    })}`);
  } catch (err) {
    console.log(`[TT-TRACE] ${traceCase.label} ${phase} serialization_failed: ${err?.message || String(err)}`);
  }
}
