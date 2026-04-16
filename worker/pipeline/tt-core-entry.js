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
  ["INTU:1751388300000", "intu_jul1_bad_pullback_confirmation"],
  ["JCI:1751388300000", "jci_jul1_pullback_doa_entry"],
  ["SOFI:1751376600000", "sofi_bad_pullback_unconfirmed_st_0701"],
  ["RBLX:1751376600000", "rblx_bad_momentum_hard_cap"],
  ["RBLX:1751994000000", "rblx_good_pullback_remote_0708"],
  ["RBLX:1751895000000", "rblx_good_momentum_control"],
  ["RBLX:1752162000000", "rblx_good_pullback_control"],
  ["RBLX:1752674400000", "rblx_bad_momentum_soft_fuse"],
  ["RBLX:1752761400000", "rblx_bad_momentum_confirmed"],
  ["RBLX:1752846000000", "rblx_bad_momentum_late"],
  ["RBLX:1753201800000", "rblx_remaining_remote_loss_0722"],
  ["RBLX:1753118400000", "rblx_bad_pullback_hard_cap"],
  ["GDX:1753373700000", "gdx_initial_entry_0724"],
  ["GDX:1754058600000", "gdx_aug1_breakout_probe_1030"],
  ["GDX:1754317800000", "gdx_aug4_breakout_probe_1030"],
  ["GDX:1754326800000", "gdx_aug4_breakout_probe_1300"],
  ["GDX:1754404200000", "gdx_aug5_breakout_probe_1030"],
  ["GDX:1754413200000", "gdx_aug5_breakout_probe_1300"],
  ["GDX:1754490600000", "gdx_aug6_breakout_probe_1030"],
  ["GDX:1768923000000", "gdx_reentry_probe_0120_1030"],
  ["GDX:1769009400000", "gdx_reentry_probe_0121_1030"],
  ["GDX:1769095800000", "gdx_reentry_probe_0122_1030"],
  ["GDX:1769182200000", "gdx_reentry_probe_0123_1030"],
  ["GDX:1769441400000", "gdx_reentry_probe_0126_1030"],
  ["PPG:1753464600000", "ppg_earnings_loss_entry_0725"],
  ["AA:1753718400000", "aa_bear_div_entry_0728"],
  ["INTU:1752003600000", "intu_jul8_regression_entry"],
  ["XLB:1772479200000", "xlb_mar2_premium_exhaustion_entry"],
  ["CW:1772656200000", "cw_mar3_ltf_exhaustion_entry"],
  ["APP:1755527400000", "app_aug18_hard_loss_cap"],
  ["APP:1755528000000", "app_aug18_hard_loss_cap_retry"],
  ["APP:1761767400000", "app_oct29_pre_pce_loss"],
  ["APP:1765822200000", "app_dec15_pre_earnings_reclaim"],
  ["APP:1766523000000", "app_dec23_mtf_loss"],
  ["NKE:1753904400000", "nke_jul30_late_pullback_loss"],
  ["XYZ:1753972200000", "xyz_jul31_divergent_pullback_loss"],
  ["RIOT:1759345200000", "riot_oct01_pullback_selective"],
  ["AGQ:1754678400000", "agq_aug8_speculative_pullback_loss"],
  ["WMT:1755008400000", "wmt_aug12_speculative_pullback_loss"],
  ["FIX:1755181800000", "fix_aug14_speculative_momentum_loss"],
  ["IESC:1753378800000", "iesc_regression_entry_0724"],
  ["IREN:1753299000000", "iren_timing_entry_0723"],
  ["KWEB:1753731000000", "kweb_pullback_entry_0728"],
  ["TSM:1753799400000", "tsm_timing_entry_0729"],
]);

function deepAuditTickerSet(rawValue) {
  return new Set(
    String(rawValue || "")
      .split(",")
      .map((v) => v.trim().toUpperCase())
      .filter(Boolean),
  );
}

function continuationProofActive({
  ticker,
  daCfg,
  side,
  currentState,
  rankScore,
  completionPct,
  phasePct,
}) {
  const enabled = String(daCfg.deep_audit_continuation_trigger_enabled ?? "false") === "true";
  if (!enabled) return false;

  const includeTickers = deepAuditTickerSet(daCfg.deep_audit_continuation_trigger_include_tickers);
  const tickerUpper = String(ticker || "").toUpperCase();
  if (includeTickers.size > 0 && !includeTickers.has(tickerUpper)) return false;

  const alignedLong = side === "LONG" && currentState === "HTF_BULL_LTF_BULL";
  const alignedShort = side === "SHORT" && currentState === "HTF_BEAR_LTF_BEAR";
  if (!alignedLong && !alignedShort) return false;

  const minRank = Number(daCfg.deep_audit_continuation_trigger_min_rank) || 60;
  if (rankScore < minRank) return false;

  const maxCompletion = Number(daCfg.deep_audit_continuation_trigger_max_completion) || 0.45;
  if (!Number.isFinite(completionPct) || completionPct > maxCompletion) return false;

  const maxPhase = Number(daCfg.deep_audit_continuation_trigger_max_phase) || 0.55;
  if (!Number.isFinite(phasePct) || phasePct > maxPhase) return false;

  return true;
}

/**
 * Evaluate entry using TT Core hybrid engine.
 * @param {TradeContext} ctx
 * @returns {EntryResult}
 */
export function evaluateEntry(ctx) {
  const { side, tf, scores, flags, config, raw, pdz, regime, movePhase, gap, cvg, entrySupport } = ctx;
  const d = raw;
  const traceCase = resolveTraceCase(ctx);
  const gapContext = gap || d?.overnight_gap || null;
  const cvgContext = cvg || d?.intraday_cvg || null;
  const entrySupportProfile = entrySupport || d?.entry_support_profile || null;

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
  let rsiW = null;
  let stDir10m = 0;
  let stDir15m = 0;
  let stDir30m = 0;
  let stDirD = 0;
  let trendExtensionPct = 0;
  let bearishPullbackCount = 0;
  let emaStructure15m = 0;
  let adverseRsiDivSummary = null;
  let adversePhaseDivSummary = null;
  let dailyBearDivergenceSummary = null;
  let phaseContext = null;

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
      rawInputs: {
        rankFromScores: scores?.rank ?? null,
        rankFromRaw: d?.rank ?? null,
        scoreField: d?.score ?? null,
        setupGrade: d?.setup_grade ?? d?.setupGrade ?? null,
        entryQualityScore: d?.entry_quality_score ?? d?.entryQualityScore ?? d?.entry_quality?.score ?? null,
      },
      rankContext: {
        rr: d?.rr ?? null,
        completion: d?.completion ?? null,
        phasePct: d?.phase_pct ?? null,
        moveStatus: d?.move_status?.status ?? null,
        completenessScore: d?.data_completeness?.score ?? null,
        tfSummaryScore: d?.tf_summary?.score ?? null,
        triggerSummaryScore: d?.trigger_summary?.score ?? null,
        regimeCombined: d?.regime?.combined ?? d?.regime_combined ?? null,
        executionProfileName: d?.execution_profile?.active_profile ?? d?.execution_profile_name ?? d?.executionProfileName ?? d?.execution_profile?.name ?? null,
        sq30Release: d?.flags?.sq30_release ?? null,
        sq30On: d?.flags?.sq30_on ?? null,
        phaseZoneChange: d?.flags?.phase_zone_change ?? null,
        momentumElite: d?.flags?.momentum_elite ?? null,
        emaCross1H1348: d?.flags?.ema_cross_1h_13_48 ?? null,
        buyableDip1H1348: d?.flags?.buyable_dip_1h_13_48 ?? null,
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
        W: rsiW,
      },
      emaStructure15m,
      trendExtensionPct,
      gapContext: summarizeGapContext(gapContext),
      cvgContext: summarizeCvgContext(cvgContext),
      entrySupport: summarizeEntrySupport(entrySupportProfile),
      entrySupportRaw: entrySupportProfile ? {
        profile: entrySupportProfile.profile ?? null,
        score: entrySupportProfile.score ?? null,
        regimeAligned: entrySupportProfile.regimeAligned ?? null,
        htfAligned: entrySupportProfile.htfAligned ?? null,
        ltfAligned: entrySupportProfile.ltfAligned ?? null,
        supportFlags: entrySupportProfile.supportFlags ?? null,
      } : null,
      movePhase: summarizeMovePhase(movePhase),
      movePhaseScores: movePhase?.scores || null,
      divergence: {
        adverse: adverseRsiDivSummary,
        adversePhase: adversePhaseDivSummary,
        dailyBear: dailyBearDivergenceSummary,
      },
      phaseContext,
      carryState: {
        entryTs: d?.entry_ts ?? null,
        entryPrice: d?.entry_price ?? null,
        prevKanbanStage: d?.prev_kanban_stage ?? null,
        kanbanCycleEnterTs: d?.kanban_cycle_enter_now_ts ?? null,
        kanbanCycleTriggerTs: d?.kanban_cycle_trigger_ts ?? null,
        kanbanCycleSide: d?.kanban_cycle_side ?? null,
        setupReason: d?.__setup_reason ?? null,
        entryBlockReason: d?.__entry_block_reason ?? null,
      },
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
  const W = tf.W;

  const emaRegimeDaily = Number(d?.ema_regime_daily) || 0;
  const emaRegime4h = Number(d?.ema_regime_4h) || 0;
  const emaRegime1h = Number(d?.ema_regime_1H ?? d?.ema_regime_1h) || 0;
  const daCfg = config.deepAudit || {};
  const currentState = String(ctx.state || d?.state || "");
  const completionPct = Number(d?.completion);
  const phasePct = Number(d?.phase_pct);

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
  const rankScore = Number(scores?.rank ?? d?.rank) || 0;
  const scopedContinuationProof = continuationProofActive({
    ticker: ctx.ticker,
    daCfg,
    side,
    currentState,
    rankScore,
    completionPct,
    phasePct,
  });
  const consensusDirection = String(d?.swing_consensus?.dir ?? d?.consensus_direction ?? "").toUpperCase();
  const laggingH1BreakoutLong = config.ripsterTuneV2
    && side === "LONG"
    && strongDailyTrend
    && dAligned
    && m10Aligned
    && h1Available
    && !h1Aligned
    && !!(c10_5?.bull || c10_5?.inCloud)
    && !c10_5?.below
    && !!c30_5?.bull
    && !!c30_5?.above
    && rankScore >= 90
    && !!entrySupportProfile
    && Number(entrySupportProfile.score) >= 2
    && movePhase?.profile !== "countertrend_peak_risk"
    && movePhase?.profile !== "exhausted"
    && gapContext?.direction === "up"
    && Number(gapContext?.absGapPct) >= 1
    && Number(gapContext?.absGapPct) <= 2.5
    && !!gapContext?.halfGapHeld;

  const baseBiasAligned = config.ripsterTuneV2
    ? (dAligned && structuralAligned && (strongDailyTrend ? alignedCount >= 2 : m10Aligned))
    : (dAligned && structuralAligned && m10Aligned);
  const biasAligned = baseBiasAligned || laggingH1BreakoutLong;

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
  adverseRsiDivSummary = summarizeDivergence(adverseRsiDiv);
  const adversePhaseDiv = side === "LONG"
    ? collectActivePhaseDivergence([m10, m15, m30, h1, h4, D, W], "bear")
    : collectActivePhaseDivergence([m10, m15, m30, h1, h4, D, W], "bull");
  adversePhaseDivSummary = summarizeDivergence(adversePhaseDiv);
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
  if (laggingH1BreakoutLong && !momentumTrigger && !pullbackTrigger && !reclaimTrigger) {
    reclaimTrigger = true;
  }

  c10FiveTwelveConfirmed = side === "LONG"
    ? !!(c10_5?.bull && c10_5?.above)
    : !!(c10_5?.bear && c10_5?.below);
  c30FiveTwelveConfirmed = side === "LONG"
    ? !!(c30_5?.bull && c30_5?.above)
    : !!(c30_5?.bear && c30_5?.below);
  c30FiveTwelveOpposed = side === "LONG"
    ? !!c30_5?.below
    : !!c30_5?.above;
  const bearishFiveTwelveRecoveryLong = side === "LONG"
    && pullbackTrigger
    && !reclaimTrigger
    && hasEmaCrossBull
    && !hasStFlipBull
    && !c10FiveTwelveConfirmed
    && !c30FiveTwelveConfirmed
    && !!(c10_5?.bear || c10_5?.inCloud)
    && !!(c30_5?.bear || c30_5?.inCloud);
  const confirmedBullContinuationLong = laggingH1BreakoutLong;

  // ── 4. QUALITY REJECTION GATES ──
  rsi10m = Number(m10?.rsi?.r5) || 50;
  rsi30m = Number(m30?.rsi?.r5) || 50;
  rsi1h = Number(h1?.rsi?.r5) || 50;
  rsi4h = Number(h4?.rsi?.r5) || 50;
  rsiD = Number(D?.rsi?.r5) || 50;
  rsiW = Number(W?.rsi?.r5) || 50;
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
  const tickerUpper = String(d?.ticker || d?.sym || ctx.ticker || "").trim().toUpperCase();
  const orbPrimary = d?.orb?.primary || d?.orb || null;
  const executionProfileName = String(
    d?.execution_profile?.active_profile
    || d?.execution_profile_name
    || d?.executionProfileName
    || d?.execution_profile?.name
    || ""
  );
  const tickerPersonality = String(
    d?._ticker_profile?.learning?.personality
    || d?.ticker_character?.personality
    || d?._ticker_profile?.behavior_type
    || d?._ticker_profile?.personality
    || d?.execution_profile?.personality
    || ""
  ).toUpperCase();
  const correctionTransitionProfile = executionProfileName === "correction_transition";
  const pullbackPlayerPersonality = tickerPersonality === "PULLBACK_PLAYER"
    || tickerPersonality === "MEAN_REVERT";
  const volatileRunnerPersonality = tickerPersonality === "VOLATILE_RUNNER";
  const setupGrade = String(d?.setup_grade || d?.setupGrade || "").trim();
  const isPrimeGrade = setupGrade.toLowerCase() === "prime";
  const isConfirmedGrade = setupGrade.toLowerCase() === "confirmed";
  const isSpeculativeGrade = setupGrade.toLowerCase() === "speculative";
  const entryQualityScore = Number(
    d?.entry_quality_score
    ?? d?.entryQualityScore
    ?? d?.entry_quality?.score
    ?? scores?.entryQualityScore
  ) || 0;
  const gapAndGoBlockEnabled = String(daCfg.deep_audit_gap_and_go_block_enabled ?? "true") === "true";
  const gapAndGoMinGapPct = Number(daCfg.deep_audit_gap_and_go_min_gap_pct) || 2.0;
  const entrySupportGateEnabled = String(daCfg.deep_audit_entry_support_gate_enabled ?? "true") === "true";
  const entrySupportMinScore = Number(daCfg.deep_audit_entry_support_min_score) || 2;
  const entrySupportPrimeMinScore = Number(daCfg.deep_audit_entry_support_prime_min_score) || 1;
  const matureContinuationGuardEnabled = String(daCfg.deep_audit_mature_continuation_guard_enabled ?? "true") === "true";
  const matureContinuationFuelMin = Number(daCfg.deep_audit_mature_continuation_primary_fuel_min) || 75;
  const matureContinuationLtfMax = Number(daCfg.deep_audit_mature_continuation_ltf_max) || 12;
  const matureContinuationSupportMax = Number(daCfg.deep_audit_mature_continuation_support_max) || 3;
  const overheatedDivergenceGuardEnabled = String(daCfg.deep_audit_overheated_divergence_guard_enabled ?? "true") === "true";
  const overheatedDivergenceDailyRsiMin = Number(daCfg.deep_audit_overheated_divergence_daily_rsi_min) || 68;
  const overheatedDivergenceWeeklyRsiMin = Number(daCfg.deep_audit_overheated_divergence_weekly_rsi_min) || 80;
  const overheatedDivergenceFuelMin = Number(daCfg.deep_audit_overheated_divergence_primary_fuel_min) || 75;
  const overheatedDivergencePhaseResetMax = Number(daCfg.deep_audit_overheated_divergence_phase_reset_max) || 12;

  const openNoiseEndMin = Number(daCfg.deep_audit_ripster_opening_noise_end_minute) || 45;
  const nowEt = getEasternParts(new Date(now));
  const inOpeningNoise = nowEt.hour === 9 && nowEt.minute < openNoiseEndMin;
  const inLateSession = nowEt.hour === 15 && nowEt.minute >= 30;

  const momentumPullbackLtfMinScore = Number(daCfg.deep_audit_momentum_pullback_ltf_min_score) || 0;
  const momentumPullbackMin4hRegime = Number(daCfg.deep_audit_momentum_pullback_min_ema_regime_4h) || 2;
  const movePhaseScorecard = movePhase?.scores || {};
  const pullbackLateSessionGuardEnabled = String(daCfg.deep_audit_pullback_late_session_guard_enabled ?? "true") === "true";
  const pullbackMinBearishCount = Math.max(
    0,
    Number(daCfg.deep_audit_pullback_min_bearish_count) || 2,
  );
  const speculativePullbackPhaseDivGuardEnabled = String(daCfg.deep_audit_speculative_pullback_phase_div_guard_enabled ?? "true") === "true";
  const confirmedPullbackPremiumPhaseDivGuardEnabled = String(daCfg.deep_audit_confirmed_pullback_premium_phase_div_guard_enabled ?? "true") === "true";
  const speculativeMomentumPhaseDivGuardEnabled = String(daCfg.deep_audit_speculative_momentum_phase_div_guard_enabled ?? "true") === "true";
  const weakOrbGapPullbackGuardEnabled = String(daCfg.deep_audit_weak_orb_gap_pullback_guard_enabled ?? "true") === "true";
  const weakOrbGapPullbackMinGapPct = Number(daCfg.deep_audit_weak_orb_gap_pullback_min_gap_pct) || 2.0;
  const weakOrbGapPullbackMaxPriceVsOpenPct = Number.isFinite(Number(daCfg.deep_audit_weak_orb_gap_pullback_max_price_vs_open_pct))
    ? Number(daCfg.deep_audit_weak_orb_gap_pullback_max_price_vs_open_pct)
    : -1.0;
  const weakOrbGapPullbackTickers = deepAuditTickerSet(
    daCfg.deep_audit_weak_orb_gap_pullback_include_tickers || "AGQ,IESC",
  );
  const agqPullbackExceptionEnabled = String(daCfg.deep_audit_agq_pullback_exception_enabled ?? "true") === "true";
  const agqPullbackExceptionTickers = deepAuditTickerSet(
    daCfg.deep_audit_agq_pullback_exception_include_tickers || "AGQ",
  );
  const agqPullbackWeakConsensusAvgBiasMax = Number.isFinite(Number(daCfg.deep_audit_agq_pullback_weak_consensus_avg_bias_max))
    ? Number(daCfg.deep_audit_agq_pullback_weak_consensus_avg_bias_max)
    : 0.10;
  const agqPullbackLateFilledGapMinBarsSinceOpen = Math.max(
    0,
    Number(daCfg.deep_audit_agq_pullback_late_filled_gap_min_bars_since_open) || 20,
  );
  const agqPullbackLateFilledGapEntryQualityMax = Number.isFinite(Number(daCfg.deep_audit_agq_pullback_late_filled_gap_entry_quality_max))
    ? Number(daCfg.deep_audit_agq_pullback_late_filled_gap_entry_quality_max)
    : 70;

  const shouldRejectWeakMomentumPullback = config.ripsterTuneV2
    && side === "LONG"
    && momentumTrigger
    && currentState.includes("PULLBACK")
    && (scores.ltf < momentumPullbackLtfMinScore || emaRegime4h < momentumPullbackMin4hRegime);
  const shouldRejectSpeculativeMomentumPhaseDivergence = config.ripsterTuneV2
    && speculativeMomentumPhaseDivGuardEnabled
    && side === "LONG"
    && momentumTrigger
    && !reclaimTrigger
    && isSpeculativeGrade
    && correctionTransitionProfile
    && !confirmedBullContinuationLong
    && !h1Aligned
    && Number(movePhaseScorecard.adversePhaseDivCount) >= 1
    && Number(movePhaseScorecard.adverseRsiDivCount) >= 1
    && entryQualityScore < 85;
  const pdz4h = h4?.pdz || {};
  const pdzZone4h = String(pdz4h.zone || d?.pdz_zone_4h || "unknown");
  const fvgD = d?.fvg_D || {};
  const liqD = d?.liq_D || {};
  const hasNearbyFallbackSupport = side === "LONG" && (
    pdz.zoneD === "discount"
    || pdz.zoneD === "discount_approach"
    || pdzZone4h === "discount"
    || pdzZone4h === "discount_approach"
    || !!fvgD.inBullGap
    || (Number(fvgD.activeBull) > 0 && Number(fvgD.nearestBullDist) >= 0 && Number(fvgD.nearestBullDist) <= 0.35)
    || (Number(liqD.nearestSellsideDist) >= 0 && Number(liqD.nearestSellsideDist) <= 0.35)
  );
  const shouldRejectUnsupportedGapAndGo = config.ripsterTuneV2
    && gapAndGoBlockEnabled
    && side === "LONG"
    && (momentumTrigger || (pullbackTrigger && !reclaimTrigger))
    && gapContext?.direction === "up"
    && Number(gapContext?.absGapPct) >= gapAndGoMinGapPct
    && !!gapContext?.untestedImpulse
    && !gapContext?.halfGapHeld
    && !hasNearbyFallbackSupport;

  if (shouldRejectUnsupportedGapAndGo) {
    return rejectEntry("tt_gap_and_go_unsupported", {
      gapContext: summarizeGapContext(gapContext),
      cvgContext: summarizeCvgContext(cvgContext),
      requiredGapPct: gapAndGoMinGapPct,
      pdzZone: { D: pdz.zoneD, h4: pdzZone4h },
      fallbackSupport: {
        inBullGap: !!fvgD.inBullGap,
        activeBull: Number(fvgD.activeBull) || 0,
        nearestBullDist: Number(fvgD.nearestBullDist),
        nearestSellsideDist: Number(liqD.nearestSellsideDist),
      },
    });
  }

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

  if (config.ripsterTuneV2 && momentumTrigger && c30_5 && !c30FiveTwelveConfirmed && !scopedContinuationProof) {
    return rejectEntry("tt_momentum_30m_5_12_unconfirmed", {
      c10_5: summarizeCloud(c10_5),
      c30_5: summarizeCloud(c30_5),
      scopedContinuationProof,
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

  if (config.ripsterTuneV2 && bearishFiveTwelveRecoveryLong) {
    return rejectEntry("tt_pullback_ema_bounce_unreclaimed_bear_clouds", {
      c10_5: summarizeCloud(c10_5),
      c10_8: summarizeCloud(c10_8),
      c30_5: summarizeCloud(c30_5),
      emaStructure15m: Number(m15?.ema?.structure) || 0,
      hasEmaCrossBull,
      hasStFlipBull,
      entrySupport: summarizeEntrySupport(entrySupportProfile),
    });
  }

  stDir15m = Number(m15?.stDir) || 0;
  bearishPullbackCount = [stDir15m, stDir30m, Number(h1?.stDir) || 0]
    .filter((dir) => dir === 1)
    .length;
  if (config.ripsterTuneV2 && side === "LONG"
    && (pullbackTrigger || reclaimTrigger)
    && !confirmedBullContinuationLong
    && bearishPullbackCount < pullbackMinBearishCount) {
    return rejectEntry("tt_pullback_not_deep_enough", {
      stDir15m,
      stDir30m,
      stDir1h: Number(h1?.stDir) || 0,
      bearishPullbackCount,
      requiredBearishCount: pullbackMinBearishCount,
      reclaimTrigger,
    });
  }

  const shouldRejectLateSessionDeepPullback = config.ripsterTuneV2
    && pullbackLateSessionGuardEnabled
    && side === "LONG"
    && pullbackTrigger
    && !reclaimTrigger
    && !confirmedBullContinuationLong
    && correctionTransitionProfile
    && inLateSession
    && bearishPullbackCount >= 2
    && !hasStFlipBull
    && !hasEmaCrossBull
    && !hasSqRelease
    && entryQualityScore < 75;
  if (shouldRejectLateSessionDeepPullback) {
    return rejectEntry("tt_pullback_late_session_unreclaimed", {
      setupGrade,
      entryQualityScore,
      bearishPullbackCount,
      inLateSession,
      nowEt: { hour: nowEt.hour, minute: nowEt.minute },
      executionProfileName,
      reclaimTrigger,
    });
  }

  const weakOrbGapFailureShape = !!(
    orbPrimary
    && orbPrimary.breakout === "SHORT"
    && orbPrimary.holdingBelow === true
    && orbPrimary.reclaim === false
  );
  const shouldRejectWeakOrbGapPullback = config.ripsterTuneV2
    && weakOrbGapPullbackGuardEnabled
    && side === "LONG"
    && weakOrbGapPullbackTickers.has(tickerUpper)
    && pullbackTrigger
    && !reclaimTrigger
    && !confirmedBullContinuationLong
    && correctionTransitionProfile
    && !c10FiveTwelveConfirmed
    && gapContext?.direction === "up"
    && Number(gapContext?.absGapPct) >= weakOrbGapPullbackMinGapPct
    && !gapContext?.fullGapFilled
    && Number(gapContext?.priceVsOpenPct) <= weakOrbGapPullbackMaxPriceVsOpenPct
    && weakOrbGapFailureShape
    && entryQualityScore < 80;
  if (shouldRejectWeakOrbGapPullback) {
    return rejectEntry("tt_pullback_weak_orb_open_gap_risk", {
      ticker: tickerUpper,
      setupGrade,
      entryQualityScore,
      executionProfileName,
      gapContext: summarizeGapContext(gapContext),
      orb: orbPrimary ? {
        breakout: orbPrimary.breakout || null,
        holdingBelow: !!orbPrimary.holdingBelow,
        reclaim: !!orbPrimary.reclaim,
        confirmed: orbPrimary.confirmed ?? null,
        dayBias: Number(orbPrimary.dayBias) || 0,
      } : null,
      weakOrbGapPullbackMinGapPct,
      weakOrbGapPullbackMaxPriceVsOpenPct,
    });
  }

  const avgBiasScore = Number(d?.avg_bias ?? d?.swing_consensus?.bias) || 0;
  const lowerTfStillCounterLong = (Number(m15?.ema?.structure) || 0) < 0
    && (Number(m30?.ema?.structure) || 0) <= 0.4
    && (Number(h1?.ema?.structure) || 0) <= 0;
  const structuralBullReclaimSignal = hasStFlipBull || c10FiveTwelveConfirmed || c30FiveTwelveConfirmed;
  const agqPullbackCounterLtfLong = (Number(m30?.ema?.structure) || 0) <= 0
    && (Number(h1?.ema?.structure) || 0) <= 0;
  const agqLateWeakSupportLtfFractured = (
    (Number(m15?.ema?.structure) || 0) < 0
    || (Number(m30?.ema?.structure) || 0) < 0.9
    || (Number(h1?.ema?.structure) || 0) <= 0
  ) && !structuralBullReclaimSignal;
  const shouldRejectAgqWeakConsensusCounterLtfPullback = config.ripsterTuneV2
    && agqPullbackExceptionEnabled
    && side === "LONG"
    && agqPullbackExceptionTickers.has(tickerUpper)
    && executionProfileName === "choppy_selective"
    && pullbackTrigger
    && !reclaimTrigger
    && !confirmedBullContinuationLong
    && avgBiasScore <= agqPullbackWeakConsensusAvgBiasMax
    && consensusDirection !== "LONG"
    && agqPullbackCounterLtfLong;
  if (shouldRejectAgqWeakConsensusCounterLtfPullback) {
    return rejectEntry("tt_pullback_agq_weak_consensus_counter_ltf", {
      ticker: tickerUpper,
      setupGrade,
      consensusDirection,
      avgBiasScore,
      entryQualityScore,
      executionProfileName,
      gapContext: summarizeGapContext(gapContext),
      emaStructure15m: Number(m15?.ema?.structure) || 0,
      emaStructure30m: Number(m30?.ema?.structure) || 0,
      emaStructure1h: Number(h1?.ema?.structure) || 0,
      structuralBullReclaimSignal,
      agqPullbackWeakConsensusAvgBiasMax,
    });
  }
  const shouldRejectAgqLateFilledGapWeakSupportPullback = config.ripsterTuneV2
    && agqPullbackExceptionEnabled
    && side === "LONG"
    && agqPullbackExceptionTickers.has(tickerUpper)
    && executionProfileName === "choppy_selective"
    && pullbackTrigger
    && !reclaimTrigger
    && !confirmedBullContinuationLong
    && !!gapContext?.fullGapFilled
    && Number(gapContext?.barsSinceOpen) >= agqPullbackLateFilledGapMinBarsSinceOpen
    && Number(gapContext?.priceVsOpenPct) < 0
    && entryQualityScore < agqPullbackLateFilledGapEntryQualityMax
    && agqLateWeakSupportLtfFractured;
  if (shouldRejectAgqLateFilledGapWeakSupportPullback) {
    return rejectEntry("tt_pullback_agq_late_filled_gap_weak_support", {
      ticker: tickerUpper,
      setupGrade,
      entryQualityScore,
      executionProfileName,
      gapContext: summarizeGapContext(gapContext),
      emaStructure15m: Number(m15?.ema?.structure) || 0,
      emaStructure30m: Number(m30?.ema?.structure) || 0,
      emaStructure1h: Number(h1?.ema?.structure) || 0,
      structuralBullReclaimSignal,
      agqPullbackLateFilledGapMinBarsSinceOpen,
      agqPullbackLateFilledGapEntryQualityMax,
    });
  }
  const speculativeLongMissingReclaim = config.ripsterTuneV2
    && side === "LONG"
    && pullbackTrigger
    && !reclaimTrigger
    && !confirmedBullContinuationLong
    && !isPrimeGrade
    && !isConfirmedGrade
    && consensusDirection !== "LONG"
    && avgBiasScore <= 0.15
    && lowerTfStillCounterLong
    && !structuralBullReclaimSignal
    && entryQualityScore < 75
    && rsi30m < 45;
  if (speculativeLongMissingReclaim) {
    return rejectEntry("tt_pullback_speculative_unconfirmed_counter_ltf", {
      setupGrade,
      consensusDirection,
      avgBiasScore,
      entryQualityScore,
      emaStructure15m: Number(m15?.ema?.structure) || 0,
      emaStructure30m: Number(m30?.ema?.structure) || 0,
      emaStructure1h: Number(h1?.ema?.structure) || 0,
      hasEmaCrossBull,
      hasSqRelease,
      structuralBullReclaimSignal,
      rsi30m,
    });
  }

  const bullishPullbackCount = [stDir15m, stDir30m, Number(h1?.stDir) || 0]
    .filter((dir) => dir === -1)
    .length;
  if (config.ripsterTuneV2 && side === "SHORT"
    && (pullbackTrigger || reclaimTrigger)
    && bullishPullbackCount < 2) {
    return rejectEntry("tt_short_pullback_not_deep_enough", {
      stDir15m,
      stDir30m,
      stDir1h: Number(h1?.stDir) || 0,
      bullishPullbackCount,
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

  if (config.ripsterTuneV2 && side === "SHORT"
    && (pullbackTrigger || reclaimTrigger)
    && stDirD === -1) {
    return rejectEntry("tt_short_pullback_daily_st_conflict", {
      stDirD,
      reclaimTrigger,
      executionProfileName,
    });
  }

  if (config.ripsterTuneV2 && side === "LONG" && pullbackTrigger && !reclaimTrigger) {
    const selectivePullbackEnabled = String(daCfg.deep_audit_pullback_selective_enabled ?? "true") === "true";
    const selectiveNonPrimeMinRank = Number(daCfg.deep_audit_pullback_non_prime_min_rank) || 90;
    const selectivePrimeMinRank = Number(daCfg.deep_audit_pullback_prime_min_rank) || 0;
    const requiredRank = isPrimeGrade ? selectivePrimeMinRank : selectiveNonPrimeMinRank;
    if (!confirmedBullContinuationLong && selectivePullbackEnabled && requiredRank > 0 && rankScore < requiredRank) {
      return rejectEntry(
        isPrimeGrade ? "tt_pullback_prime_rank_selective" : "tt_pullback_non_prime_rank_selective",
        { setupGrade, rank: rankScore, requiredRank },
      );
    }
  }

  const shouldRejectSpeculativeDivergentPullback = config.ripsterTuneV2
    && speculativePullbackPhaseDivGuardEnabled
    && side === "LONG"
    && pullbackTrigger
    && !reclaimTrigger
    && isSpeculativeGrade
    && !confirmedBullContinuationLong
    && Number(movePhaseScorecard.adversePhaseDivCount) >= 1
    && (
      Number(movePhaseScorecard.adverseRsiDivCount) >= 1
      || Number(movePhaseScorecard.peakExhaustionCount) >= 3
      || (executionProfileName === "choppy_selective" && Number(movePhaseScorecard.atrExhaustedCount) >= 1)
    );
  if (shouldRejectSpeculativeDivergentPullback) {
    return rejectEntry("tt_pullback_speculative_phase_divergence", {
      setupGrade,
      executionProfileName,
      movePhase: summarizeMovePhase(movePhase),
      adverseRsiDivergence: adverseRsiDivSummary,
      adversePhaseDivergence: adversePhaseDivSummary,
      phaseContext,
    });
  }

  const shouldRejectConfirmedPremiumDivergentPullback = config.ripsterTuneV2
    && confirmedPullbackPremiumPhaseDivGuardEnabled
    && side === "LONG"
    && pullbackTrigger
    && !reclaimTrigger
    && isConfirmedGrade
    && correctionTransitionProfile
    && !confirmedBullContinuationLong
    && rankScore <= 90
    && entryQualityScore < 75
    && ["premium", "premium_approach"].includes(String(pdz.zoneD || "unknown"))
    && ["premium", "premium_approach"].includes(String(pdzZone4h || "unknown"))
    && Number(movePhaseScorecard.adversePhaseDivCount) >= 1
    && Number(movePhaseScorecard.peakExhaustionCount) >= 2;
  if (shouldRejectConfirmedPremiumDivergentPullback) {
    return rejectEntry("tt_pullback_confirmed_premium_phase_divergence", {
      setupGrade,
      rank: rankScore,
      entryQualityScore,
      executionProfileName,
      pdzZone: { D: pdz.zoneD, h4: pdzZone4h },
      movePhase: summarizeMovePhase(movePhase),
      adversePhaseDivergence: adversePhaseDivSummary,
      phaseContext,
    });
  }

  const primeSupportLeniency = config.ripsterTuneV2
    && isPrimeGrade
    && rankScore >= 95
    && emaRegimeDaily >= 2
    && emaRegime4h >= 2
    && Number(scores?.htf) >= 30
    && Number(scores?.ltf) >= 10
    && entrySupportProfile?.profile !== "unsupported_impulse";
  const shouldRejectWeakEntrySupport = config.ripsterTuneV2
    && entrySupportGateEnabled
    && side === "LONG"
    && !reclaimTrigger
    && !confirmedBullContinuationLong
    && !primeSupportLeniency
    && !!entrySupportProfile
    && (momentumTrigger || pullbackTrigger)
    && (
      entrySupportProfile.profile === "unsupported_impulse"
      || entrySupportProfile.profile === "speculative"
      || (!isPrimeGrade && correctionTransitionProfile)
    )
    && Number(entrySupportProfile.score) < (isPrimeGrade ? entrySupportPrimeMinScore : entrySupportMinScore);
  if (shouldRejectWeakEntrySupport) {
    return rejectEntry("tt_entry_support_weak", {
      setupGrade,
      requiredSupportScore: isPrimeGrade ? entrySupportPrimeMinScore : entrySupportMinScore,
      entrySupport: summarizeEntrySupport(entrySupportProfile),
      gapContext: summarizeGapContext(gapContext),
      cvgContext: summarizeCvgContext(cvgContext),
      pdzZone: { D: pdz.zoneD, h4: pdzZone4h },
      executionProfileName,
    });
  }

  const freshBullImpulse = hasStFlipBull || hasEmaCrossBull || hasSqRelease || reclaimTrigger;
  const shouldRejectMatureContinuation = config.ripsterTuneV2
    && matureContinuationGuardEnabled
    && side === "LONG"
    && !reclaimTrigger
    && !!entrySupportProfile
    && (momentumTrigger || pullbackTrigger)
    && Number(scores?.primaryFuel) >= matureContinuationFuelMin
    && (pullbackTrigger || Number(scores?.ltf) <= matureContinuationLtfMax)
    && Number(entrySupportProfile.score) <= matureContinuationSupportMax
    && !freshBullImpulse;
  if (shouldRejectMatureContinuation) {
    return rejectEntry("tt_mature_continuation_weak_reclaim", {
      setupGrade,
      primaryFuel: Number(scores?.primaryFuel) || 0,
      ltfScore: Number(scores?.ltf) || 0,
      requiredFreshImpulse: true,
      freshBullImpulse,
      matureContinuationFuelMin,
      matureContinuationLtfMax,
      matureContinuationSupportMax,
      entrySupport: summarizeEntrySupport(entrySupportProfile),
      gapContext: summarizeGapContext(gapContext),
      cvgContext: summarizeCvgContext(cvgContext),
      executionProfileName,
      triggerType: pullbackTrigger ? "pullback" : momentumTrigger ? "momentum" : "unknown",
    });
  }

  const phaseD = Number(D?.ph?.v ?? D?.saty?.v);
  const phase4h = Number(h4?.ph?.v ?? h4?.saty?.v);
  const prevPhaseD = Number(D?.ph?.prev ?? D?.saty?.p);
  const prevPhase4h = Number(h4?.ph?.prev ?? h4?.saty?.p);
  const phaseDLeaving = (
    Number.isFinite(phaseD)
    && Number.isFinite(prevPhaseD)
    && Math.abs(phaseD) < 10
    && Math.abs(prevPhaseD) > 20
  );
  const phase4hLeaving = (
    Number.isFinite(phase4h)
    && Number.isFinite(prevPhase4h)
    && Math.abs(phase4h) < 10
    && Math.abs(prevPhase4h) > 20
  );
  const dailyBearDivergence = side === "LONG"
    ? collectTfRsiDivergence(D, "D", "bear", {
        preferRecent: true,
        requireActive: false,
        minStrength: 1.0,
        maxAge: 15,
      })
    : null;
  dailyBearDivergenceSummary = summarizeDivergence(dailyBearDivergence);
  const hasDailyBearDivergence = !!dailyBearDivergence
    || !!adverseRsiDivSummary?.tfs?.includes?.("D");
  const hasStaleDailyBearDivergence = !!(D?.rsiDiv?.bear ?? D?.rsiDiv?.b ?? D?.rsiDiv?.rb);
  const phaseResetReady = reclaimTrigger
    || phaseDLeaving
    || phase4hLeaving
    || (Number.isFinite(phaseD) && Math.abs(phaseD) <= overheatedDivergencePhaseResetMax)
    || (Number.isFinite(phase4h) && Math.abs(phase4h) <= overheatedDivergencePhaseResetMax);
  const overheatedHigherTfContext = Number(rsiD) >= overheatedDivergenceDailyRsiMin
    || Number(rsiW) >= overheatedDivergenceWeeklyRsiMin
    || Number(scores?.primaryFuel) >= overheatedDivergenceFuelMin;
  const adversePdzContext = side === "LONG"
    ? (pdz.zoneD === "premium" || pdz.zoneD === "premium_approach" || pdzZone4h === "premium" || pdzZone4h === "premium_approach")
    : false;
  const shouldRejectOverheatedDivergence = config.ripsterTuneV2
    && overheatedDivergenceGuardEnabled
    && side === "LONG"
    && !reclaimTrigger
    && (momentumTrigger || pullbackTrigger)
    && hasDailyBearDivergence
    && overheatedHigherTfContext
    && !phaseResetReady;
  const shouldRejectSpeculativeBearDivMomentum = config.ripsterTuneV2
    && side === "LONG"
    && momentumTrigger
    && !reclaimTrigger
    && !isPrimeGrade
    && (hasDailyBearDivergence || hasStaleDailyBearDivergence)
    && adversePdzContext
    && entrySupportProfile?.profile === "speculative"
    && Number(rsiD) >= 70
    && Number.isFinite(phaseD)
    && phaseD >= 60;
  const shouldRejectBearDivRolloverLong = config.ripsterTuneV2
    && side === "LONG"
    && (momentumTrigger || pullbackTrigger)
    && !reclaimTrigger
    && !isPrimeGrade
    && rankScore < 95
    && (hasDailyBearDivergence || hasStaleDailyBearDivergence)
    && emaRegime4h <= -2
    && Number.isFinite(rsiD)
    && rsiD >= 60
    && Number.isFinite(phaseD)
    && phaseD >= 15;
  const shouldRejectPrimeCorrectionMomentumBearDiv = config.ripsterTuneV2
    && side === "LONG"
    && momentumTrigger
    && !reclaimTrigger
    && !confirmedBullContinuationLong
    && isPrimeGrade
    && correctionTransitionProfile
    && pullbackPlayerPersonality
    && rankScore < 90
    && entryQualityScore <= 60
    && Number(scores?.ltf) <= 15
    && !h1Aligned
    && (hasDailyBearDivergence || hasStaleDailyBearDivergence)
    && Number.isFinite(rsiD)
    && rsiD >= 60;
  const dualPremiumApproachLong = side === "LONG"
    && ["premium", "premium_approach"].includes(String(pdz.zoneD || "unknown"))
    && ["premium", "premium_approach"].includes(String(pdzZone4h || "unknown"));
  const shouldRejectPrimeCorrectionMomentumPremiumBearDiv = config.ripsterTuneV2
    && side === "LONG"
    && momentumTrigger
    && !reclaimTrigger
    && !confirmedBullContinuationLong
    && isPrimeGrade
    && correctionTransitionProfile
    && rankScore < 90
    && emaRegimeDaily >= 2
    && emaRegime4h >= 2
    && emaRegime1h < 1
    && dualPremiumApproachLong
    && (hasDailyBearDivergence || hasStaleDailyBearDivergence);
  const shouldRejectUnsupportedPremiumRollover = config.ripsterTuneV2
    && side === "LONG"
    && momentumTrigger
    && !isPrimeGrade
    && rankScore < 85
    && adversePdzContext
    && entrySupportProfile?.profile === "unsupported_impulse"
    && Number(entrySupportProfile?.score) <= -3
    && emaRegime4h <= -2
    && Number.isFinite(phase4h)
    && phase4h <= -20;
  const shouldRejectHotReclaimOverheat = config.ripsterTuneV2
    && side === "LONG"
    && reclaimTrigger
    && !!dailyBearDivergence
    && Number(rsiD) >= 80
    && adversePdzContext
    && Number(entrySupportProfile?.score) <= 0
    && !phaseDLeaving
    && !phase4hLeaving
    && Number.isFinite(phaseD)
    && Number.isFinite(phase4h)
    && Math.abs(phaseD) > overheatedDivergencePhaseResetMax
    && Math.abs(phase4h) > overheatedDivergencePhaseResetMax;
  const shouldRejectSpeculativeBearDivReclaim = config.ripsterTuneV2
    && side === "LONG"
    && reclaimTrigger
    && !!dailyBearDivergence
    && adversePdzContext
    && !isPrimeGrade
    && rankScore < 90
    && Number(entrySupportProfile?.score) <= -2
    && Number.isFinite(phaseD)
    && phaseD > 30
    && Number.isFinite(phase4h)
    && Math.abs(phase4h) <= 10;
  const shouldRejectCorrectionTransitionSpeculativeBearDivReclaim = config.ripsterTuneV2
    && side === "LONG"
    && reclaimTrigger
    && correctionTransitionProfile
    && pullbackPlayerPersonality
    && rankScore < 90
    && entryQualityScore <= 60
    && emaRegimeDaily >= 2
    && emaRegime4h >= 2
    && emaRegime1h < 1
    && dualPremiumApproachLong
    && (hasDailyBearDivergence || hasStaleDailyBearDivergence)
    && Number(entrySupportProfile?.score) <= -1
    && Number.isFinite(phaseD)
    && phaseD >= 20
    && Number.isFinite(phase4h)
    && Math.abs(phase4h) <= 10;
  phaseContext = {
    phaseD: Number.isFinite(phaseD) ? phaseD : null,
    prevPhaseD: Number.isFinite(prevPhaseD) ? prevPhaseD : null,
    phase4h: Number.isFinite(phase4h) ? phase4h : null,
    prevPhase4h: Number.isFinite(prevPhase4h) ? prevPhase4h : null,
    phaseDLeaving,
    phase4hLeaving,
    phaseResetReady,
  };
  if (shouldRejectOverheatedDivergence) {
    return rejectEntry("tt_overheated_bear_div_phase_pending", {
      triggerType: pullbackTrigger ? "pullback" : momentumTrigger ? "momentum" : "unknown",
      dailyBearDivergence: dailyBearDivergenceSummary,
      rsiD,
      rsiW,
      primaryFuel: Number(scores?.primaryFuel) || 0,
      phaseContext,
      overheatedDivergenceDailyRsiMin,
      overheatedDivergenceWeeklyRsiMin,
      overheatedDivergenceFuelMin,
      overheatedDivergencePhaseResetMax,
      entrySupport: summarizeEntrySupport(entrySupportProfile),
      movePhase: summarizeMovePhase(movePhase),
      executionProfileName,
    });
  }
  if (shouldRejectSpeculativeBearDivMomentum) {
    return rejectEntry("tt_momentum_speculative_bear_div_overheat", {
      triggerType: "momentum",
      setupGrade,
      rank: rankScore,
      dailyBearDivergence: dailyBearDivergenceSummary,
      adverseRsiDivergence: adverseRsiDivSummary,
      rsiD,
      rsiW,
      staleDailyBearDivergence: hasStaleDailyBearDivergence,
      pdzZone: { D: pdz.zoneD, h4: pdzZone4h },
      entrySupport: summarizeEntrySupport(entrySupportProfile),
      phaseContext,
      movePhase: summarizeMovePhase(movePhase),
      executionProfileName,
    });
  }
  if (shouldRejectBearDivRolloverLong) {
    return rejectEntry("tt_daily_bear_div_4h_rollover", {
      triggerType: pullbackTrigger ? "pullback" : momentumTrigger ? "momentum" : "unknown",
      setupGrade,
      rank: rankScore,
      dailyBearDivergence: dailyBearDivergenceSummary,
      adverseRsiDivergence: adverseRsiDivSummary,
      staleDailyBearDivergence: hasStaleDailyBearDivergence,
      emaRegime4h,
      rsiD,
      phaseContext,
      entrySupport: summarizeEntrySupport(entrySupportProfile),
      movePhase: summarizeMovePhase(movePhase),
      executionProfileName,
    });
  }
  if (shouldRejectPrimeCorrectionMomentumBearDiv) {
    return rejectEntry("tt_prime_correction_transition_bear_div_extension", {
      triggerType: "momentum",
      setupGrade,
      rank: rankScore,
      entryQualityScore,
      ltfScore: Number(scores?.ltf) || 0,
      h1Aligned,
      rsiD,
      dailyBearDivergence: dailyBearDivergenceSummary,
      adverseRsiDivergence: adverseRsiDivSummary,
      tickerPersonality,
      executionProfileName,
      phaseContext,
    });
  }
  if (shouldRejectPrimeCorrectionMomentumPremiumBearDiv) {
    return rejectEntry("tt_prime_correction_transition_premium_bear_div_h1_weak", {
      triggerType: "momentum",
      setupGrade,
      rank: rankScore,
      emaRegimeDaily,
      emaRegime4h,
      emaRegime1h,
      pdzZone: { D: pdz.zoneD, h4: pdzZone4h },
      dailyBearDivergence: dailyBearDivergenceSummary,
      staleDailyBearDivergence: hasStaleDailyBearDivergence,
      executionProfileName,
      phaseContext,
    });
  }
  if (shouldRejectUnsupportedPremiumRollover) {
    return rejectEntry("tt_momentum_unsupported_premium_rollover", {
      triggerType: "momentum",
      setupGrade,
      rank: rankScore,
      pdzZone: { D: pdz.zoneD, h4: pdzZone4h },
      emaRegime4h,
      phaseContext,
      entrySupport: summarizeEntrySupport(entrySupportProfile),
      movePhase: summarizeMovePhase(movePhase),
      executionProfileName,
    });
  }
  if (shouldRejectHotReclaimOverheat) {
    return rejectEntry("tt_hot_reclaim_overheat_recent_divergence", {
      triggerType: "reclaim",
      dailyBearDivergence: dailyBearDivergenceSummary,
      rsiD,
      rsiW,
      pdzZone: { D: pdz.zoneD, h4: pdzZone4h },
      adversePdzContext,
      entrySupport: summarizeEntrySupport(entrySupportProfile),
      phaseContext,
      movePhase: summarizeMovePhase(movePhase),
      executionProfileName,
    });
  }
  if (shouldRejectSpeculativeBearDivReclaim) {
    return rejectEntry("tt_reclaim_daily_bear_div_speculative", {
      triggerType: "reclaim",
      setupGrade,
      rank: rankScore,
      dailyBearDivergence: dailyBearDivergenceSummary,
      pdzZone: { D: pdz.zoneD, h4: pdzZone4h },
      adversePdzContext,
      entrySupport: summarizeEntrySupport(entrySupportProfile),
      phaseContext,
      movePhase: summarizeMovePhase(movePhase),
      executionProfileName,
    });
  }
  if (shouldRejectCorrectionTransitionSpeculativeBearDivReclaim) {
    return rejectEntry("tt_correction_transition_reclaim_bear_div_pending", {
      triggerType: "reclaim",
      setupGrade,
      rank: rankScore,
      entryQualityScore,
      dailyBearDivergence: dailyBearDivergenceSummary,
      staleDailyBearDivergence: hasStaleDailyBearDivergence,
      emaRegimeDaily,
      emaRegime4h,
      emaRegime1h,
      pdzZone: { D: pdz.zoneD, h4: pdzZone4h },
      adversePdzContext,
      entrySupport: summarizeEntrySupport(entrySupportProfile),
      phaseContext,
      movePhase: summarizeMovePhase(movePhase),
      executionProfileName,
      tickerPersonality,
    });
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

  if (config.ripsterTuneV2 && correctionTransitionProfile
    && side === "LONG" && momentumTrigger) {
    const movePhaseScores = movePhase?.scores || {};
    const hotUnsupportedMomentum = !!(
      c10_5?.above && !c10_5?.inCloud
      && c10_8?.above && !c10_8?.inCloud
      && adversePdzContext
      && entrySupportProfile?.profile === "unsupported_impulse"
      && Number(entrySupportProfile?.score) <= -1
    );
    const exhaustedPremiumSpeculativeMomentum = !!(
      dualPremiumApproachLong
      && rankScore < 95
      && entrySupportProfile?.profile === "speculative"
      && Number(entrySupportProfile?.score) <= -2
      && Number(movePhaseScores.atrExhaustedCount) >= 2
      && Number.isFinite(phaseD)
      && phaseD >= 40
      && Number.isFinite(phase4h)
      && Math.abs(phase4h) <= 10
      && (Number(gapContext?.barsSinceOpen) || 0) >= 45
    );
    const exhaustedGapContinuationLong = !!(
      pullbackPlayerPersonality
      && dualPremiumApproachLong
      && !!dailyBearDivergenceSummary
      && entrySupportProfile?.profile === "supportive"
      && Number(entrySupportProfile?.score) >= 4
      && gapContext?.direction === "up"
      && !!gapContext?.halfGapHeld
      && !!gapContext?.fullGapFilled
      && !!cvgContext?.bullish?.active
      && !!cvgContext?.bullish?.untestedImpulse
      && Number(movePhaseScores.atrExhaustedCount) >= 2
      && Number(movePhaseScores.phaseLateCount) >= 1
      && Number.isFinite(phaseD)
      && phaseD >= 30
      && Number.isFinite(rsiW)
      && rsiW >= 68
      && stDir15m < 0
    );
    const lateOrExhaustedCorrectionMomentum = (Number(movePhaseScores.atrExhaustedCount) || 0) >= 1
      || (Number(movePhaseScores.phaseLateCount) || 0) >= 1
      || (Number(gapContext?.barsSinceOpen) || 0) >= 30
      || !!dailyBearDivergenceSummary;
    if (!isPrimeGrade && hotUnsupportedMomentum && lateOrExhaustedCorrectionMomentum) {
      return rejectEntry("tt_momentum_correction_transition_unsupported_extension", {
        executionProfileName,
        tickerPersonality,
        distToCloudPct: trendExtensionPct,
        pdzZone: { D: pdz.zoneD, h4: pdzZone4h },
        barsSinceOpen: Number(gapContext?.barsSinceOpen) || 0,
        entrySupport: summarizeEntrySupport(entrySupportProfile),
        movePhase: summarizeMovePhase(movePhase),
        dailyBearDivergence: dailyBearDivergenceSummary,
      });
    }
    if (exhaustedPremiumSpeculativeMomentum) {
      return rejectEntry("tt_momentum_correction_transition_premium_exhausted", {
        executionProfileName,
        tickerPersonality,
        setupGrade,
        rank: rankScore,
        pdzZone: { D: pdz.zoneD, h4: pdzZone4h },
        barsSinceOpen: Number(gapContext?.barsSinceOpen) || 0,
        phaseContext,
        entrySupport: summarizeEntrySupport(entrySupportProfile),
        movePhase: summarizeMovePhase(movePhase),
        adverseRsiDivergence: adverseRsiDivSummary,
      });
    }
    if (exhaustedGapContinuationLong) {
      return rejectEntry("tt_momentum_correction_transition_exhausted_gap_continuation", {
        executionProfileName,
        tickerPersonality,
        setupGrade,
        rank: rankScore,
        rsiW,
        st15m: stDir15m,
        pdzZone: { D: pdz.zoneD, h4: pdzZone4h },
        gapContext: summarizeGapContext(gapContext),
        cvgContext: summarizeCvgContext(cvgContext),
        phaseContext,
        entrySupport: summarizeEntrySupport(entrySupportProfile),
        movePhase: summarizeMovePhase(movePhase),
        dailyBearDivergence: dailyBearDivergenceSummary,
      });
    }
  }

  // ── 5. MEAN REVERSION TRIGGER ──
  const pdzZoneD = pdz.zoneD;
  const td9 = d?.mean_revert_td9 || {};
  const meanReversionPhaseD = Number(D?.ph?.v) || 0;
  const meanReversionPhase4h = Number(h4?.ph?.v) || 0;
  const meanReversionPhaseDLeaving = Math.abs(meanReversionPhaseD) < 10 && Math.abs(Number(D?.ph?.prev) || 0) > 20;
  const meanReversionPhase4hLeaving = Math.abs(meanReversionPhase4h) < 10 && Math.abs(Number(h4?.ph?.prev) || 0) > 20;
  const phaseOrTd9 = meanReversionPhaseDLeaving || meanReversionPhase4hLeaving || !!td9?.active;

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
  const shouldBlockMomentumPeak = config.ripsterTuneV2 && momentumTrigger
    && !confirmedBullContinuationLong
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

  if (shouldRejectWeakMomentumPullback) {
    return rejectEntry("tt_momentum_pullback_state_weak", {
      state: currentState,
      ltfScore: scores.ltf,
      requiredLtfScore: momentumPullbackLtfMinScore,
      emaRegime4h,
      requiredEmaRegime4h: momentumPullbackMin4hRegime,
      pullbackTrigger,
      reclaimTrigger,
    });
  }

  if (shouldRejectSpeculativeMomentumPhaseDivergence) {
    return rejectEntry("tt_momentum_speculative_phase_div_countertrend", {
      setupGrade,
      entryQualityScore,
      executionProfileName,
      h1Aligned,
      movePhase: movePhaseSummary,
      adverseRsiDivergence: adverseRsiDivSummary,
      adversePhaseDivergence: adversePhaseDivSummary,
      phaseContext,
    });
  }

  if (momentumTrigger
    && config.ripsterTuneV2
    && !isPrimeGrade
    && adversePdzContext
    && entrySupportProfile?.profile === "unsupported_impulse"
    && Number(entrySupportProfile?.score) <= -3
    && emaRegime4h <= -2
    && Number.isFinite(phase4h)
    && phase4h <= -20) {
    return rejectEntry("tt_momentum_unsupported_premium_rollover", {
      triggerType: reclaimTrigger
        ? "momentum_reclaim_hybrid"
        : pullbackTrigger
          ? "momentum_pullback_hybrid"
          : "momentum_5_12_cross",
      setupGrade,
      rank: rankScore,
      momentumTrigger,
      pullbackTrigger,
      reclaimTrigger,
      pdzZone: { D: pdzZoneD, h4: pdzZone4h },
      emaRegime4h,
      phaseContext,
      entrySupport: summarizeEntrySupport(entrySupportProfile),
      movePhase: movePhaseSummary,
      executionProfile: {
        name: executionProfileName || null,
        personality: tickerPersonality || null,
        profileRegimeMult,
        volatileMomentumMult,
      },
    });
  }

  if (momentumTrigger) {
    return qualifyEntry("tt_momentum", "medium", "tt_5_12_trend_trigger", {
      ...baseSizing,
    }, {
      cloudAlignment: cloudMeta,
      triggerType: "momentum_5_12_cross",
      pdzZone: { D: pdzZoneD, h4: pdzZone4h },
      gapContext: summarizeGapContext(gapContext),
      cvgContext: summarizeCvgContext(cvgContext),
      entrySupport: summarizeEntrySupport(entrySupportProfile),
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
      gapContext: summarizeGapContext(gapContext),
      cvgContext: summarizeCvgContext(cvgContext),
      entrySupport: summarizeEntrySupport(entrySupportProfile),
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
      gapContext: summarizeGapContext(gapContext),
      cvgContext: summarizeCvgContext(cvgContext),
      entrySupport: summarizeEntrySupport(entrySupportProfile),
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
        gapContext: summarizeGapContext(gapContext),
        cvgContext: summarizeCvgContext(cvgContext),
        entrySupport: summarizeEntrySupport(entrySupportProfile),
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

function summarizeGapContext(gapContext) {
  if (!gapContext) return null;
  return {
    direction: gapContext.direction || "flat",
    absGapPct: Number(gapContext.absGapPct) || 0,
    gapPct: Number(gapContext.gapPct) || 0,
    enteredGapBody: !!gapContext.enteredGapBody,
    halfGapTouched: !!gapContext.halfGapTouched,
    halfGapHeld: !!gapContext.halfGapHeld,
    fullGapFilled: !!gapContext.fullGapFilled,
    untestedImpulse: !!gapContext.untestedImpulse,
    priceVsOpenPct: Number(gapContext.priceVsOpenPct) || 0,
    barsSinceOpen: Number(gapContext.barsSinceOpen) || 0,
  };
}

function summarizeCvgContext(cvgContext) {
  if (!cvgContext) return null;
  return {
    tf: cvgContext.tf || null,
    bullish: summarizeDirectionalCvg(cvgContext.bullish),
    bearish: summarizeDirectionalCvg(cvgContext.bearish),
  };
}

function summarizeDirectionalCvg(cvg) {
  if (!cvg) return null;
  return {
    gapPct: Number(cvg.gapPct) || 0,
    barsSinceFormed: Number(cvg.barsSinceFormed) || 0,
    enteredBody: !!cvg.enteredBody,
    held: !!cvg.held,
    filled: !!cvg.filled,
    active: !!cvg.active,
    inZone: !!cvg.inZone,
    untestedImpulse: !!cvg.untestedImpulse,
    distancePct: Number(cvg.distancePct) || 0,
  };
}

function summarizeEntrySupport(entrySupport) {
  if (!entrySupport) return null;
  return {
    profile: entrySupport.profile || "mixed",
    score: Number(entrySupport.score) || 0,
    supportiveSignals: Number(entrySupport.supportiveSignals) || 0,
    penaltySignals: Number(entrySupport.penaltySignals) || 0,
    reasons: Array.isArray(entrySupport.reasons) ? entrySupport.reasons.slice(0, 6) : [],
  };
}

function hasActiveRsiDivergence(tfs, side) {
  return !!collectActiveRsiDivergence(tfs, side);
}

function collectActiveRsiDivergence(tfs, side) {
  return collectRsiDivergence(tfs, side);
}

function collectActivePhaseDivergence(tfs, side) {
  return collectSeriesDivergence(tfs, "phaseDiv", side);
}

function collectTfRsiDivergence(tf, tfLabel, side, opts = {}) {
  if (!tf?.rsiDiv) return null;
  const requireActive = opts.requireActive ?? true;
  const minStrength = Number(opts.minStrength ?? 1.5);
  const maxAge = Number(opts.maxAge ?? 8);
  const preferRecent = !!opts.preferRecent;
  const bucketKeys = side === "bear"
    ? (preferRecent ? ["rb", "bear"] : ["bear", "rb"])
    : (preferRecent ? ["ru", "bull"] : ["bull", "ru"]);
  for (const key of bucketKeys) {
    const div = tf.rsiDiv?.[key];
    if (!div) continue;
    const active = div?.active ?? div?.a;
    const strength = Number(div?.strength ?? div?.s) || 0;
    const barsSince = Number(div?.barsSince ?? div?.bs);
    if (requireActive && !active) continue;
    if (strength < minStrength) continue;
    if (Number.isFinite(barsSince) && barsSince > maxAge) continue;
    return [{
      tf: tfLabel,
      strength,
      barsSince: Number.isFinite(barsSince) ? barsSince : null,
      active: !!active,
      source: key === "rb" || key === "ru" ? "recent" : "active",
    }];
  }
  return null;
}

function collectRsiDivergence(tfs, side, opts = {}) {
  const requireActive = opts.requireActive ?? true;
  const minStrength = Number(opts.minStrength ?? 1.5);
  const defaultMaxAge = Number(opts.maxAge ?? 8);
  const maxAgeByTf = opts.maxAgeByTf || {};
  const hits = [];
  for (const [idx, tf] of (tfs || []).entries()) {
    const div = tf?.rsiDiv?.[side];
    if (!div) continue;
    const active = div?.active ?? div?.a;
    if (requireActive && !active) continue;
    const strength = Number(div?.strength ?? div?.s) || 0;
    const barsSince = Number(div?.barsSince ?? div?.bs);
    const tfLabel = tfLabelForIndex(idx);
    const maxAge = Number(maxAgeByTf?.[tfLabel] ?? defaultMaxAge);
    if (strength < minStrength) continue;
    if (Number.isFinite(barsSince) && barsSince > maxAge) continue;
    hits.push({
      tf: tfLabel,
      strength,
      barsSince: Number.isFinite(barsSince) ? barsSince : null,
      active: !!active,
    });
  }
  return hits.length ? hits : null;
}

function collectSeriesDivergence(tfs, field, side, opts = {}) {
  const requireActive = opts.requireActive ?? true;
  const minStrength = Number(opts.minStrength ?? 1.5);
  const defaultMaxAge = Number(opts.maxAge ?? 8);
  const maxAgeByTf = opts.maxAgeByTf || {};
  const hits = [];
  for (const [idx, tf] of (tfs || []).entries()) {
    const div = tf?.[field]?.[side];
    if (!div) continue;
    const active = div?.active ?? div?.a;
    if (requireActive && !active) continue;
    const strength = Number(div?.strength ?? div?.s) || 0;
    const barsSince = Number(div?.barsSince ?? div?.bs);
    const tfLabel = tfLabelForIndex(idx, tfs.length);
    const maxAge = Number(maxAgeByTf?.[tfLabel] ?? defaultMaxAge);
    if (strength < minStrength) continue;
    if (Number.isFinite(barsSince) && barsSince > maxAge) continue;
    hits.push({
      tf: tfLabel,
      strength,
      barsSince: Number.isFinite(barsSince) ? barsSince : null,
      active: !!active,
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

function tfLabelForIndex(idx, total = 0) {
  const labels = total >= 7
    ? ["10m", "15m", "30m", "1h", "4h", "D", "W"]
    : ["10m", "30m", "1h", "4h", "D"];
  return labels[idx] || `tf_${idx}`;
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
