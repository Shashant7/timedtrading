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

  // ═════════════════════════════════════════════════════════════════════════
  // PHASE-H.3 — ENTRY DISCIPLINE GATES
  // Three layers:
  //   1. Rank floor (minimum setup quality)
  //   2. Regime-adaptive strategy (don't fight the monthly cycle)
  //   3. Multi-signal consensus (corroboration across dimensions)
  // Every gate is DA-key toggled; defaults lean selective per the E.3/v5
  // peak performance (68.8% WR LONG-only sniper).
  //
  // See: tasks/phase-h3-entry-discipline-2026-04-20.md
  // ═════════════════════════════════════════════════════════════════════════
  {
    // ─────────────────────────────────────────────────────────────────
    // PHASE-H.4.0 — EARNINGS PROXIMITY BLOCK
    // V9/V10 audit: ORCL Jul 31 -5.17% (×2 runs), CDNS Jul 31 -3.24%,
    // AGYS Jul 21 -10.45% — all same-day or next-day earnings reactions.
    // Block new entries if ticker has an earnings event within N hours.
    // DA key: deep_audit_earnings_proximity_block_hours (default 48).
    // Set to 0 to disable.
    //
    // See: tasks/phase-h4-targeted-refinements-2026-04-21.md
    // ─────────────────────────────────────────────────────────────────
    const _h4EarningsBlockHrs = Number(daCfg.deep_audit_earnings_proximity_block_hours ?? 48);
    if (_h4EarningsBlockHrs > 0) {
      const _er = ctx.eventRisk;
      if (_er?.active && _er.eventType === "earnings" && Number.isFinite(_er.hoursToEvent)) {
        const absHrs = Math.abs(_er.hoursToEvent);
        if (absHrs <= _h4EarningsBlockHrs) {
          return rejectEntry("h4_earnings_proximity", {
            hoursToEvent: _er.hoursToEvent,
            blockHours: _h4EarningsBlockHrs,
            eventKey: _er.eventKey,
          });
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // PHASE-I.1 — POSITION-LIFECYCLE GUARDS
    // v10b audit: 15 orphaned open positions, 9 with a prior closed trade
    // on the same ticker within 1-18 days. TPL SHORT re-entered twice at
    // identical $288.33 price, 48h apart, both still open 85+ days.
    //
    // Two gates:
    //   1. Duplicate-open: hard block any same-direction entry while an
    //      existing OPEN trade exists for this ticker.
    //   2. Re-entry throttle: cooldown period after a recent EXIT on the
    //      same ticker+direction to prevent over-trading churn.
    //
    // See: tasks/phase-i-implementation-2026-04-22.md Workstream 1
    // ─────────────────────────────────────────────────────────────────
    {
      const _recentTrades = Array.isArray(ctx?.recentTrades) ? ctx.recentTrades : [];
      const _nowTs = Number(ctx?.nowTs) || Date.now();
      const _tickerUpper = String(d?.ticker || "").toUpperCase();
      const _sideUpper = String(side || "").toUpperCase();

      if (_recentTrades.length > 0 && _tickerUpper && _sideUpper) {
        // Gate 1: hard-block duplicate open in same direction
        const _duplicateOpenEnabled = String(daCfg.deep_audit_duplicate_open_block_enabled ?? "true") === "true";
        if (_duplicateOpenEnabled) {
          const _stillOpen = _recentTrades.find(t => {
            if (String(t?.ticker || "").toUpperCase() !== _tickerUpper) return false;
            if (String(t?.direction || "").toUpperCase() !== _sideUpper) return false;
            return !t?.exit_ts;
          });
          if (_stillOpen) {
            return rejectEntry("phase_i_duplicate_open", {
              existing_entry_ts: _stillOpen.entry_ts,
              existing_entry_price: _stillOpen.entry_price,
              existing_status: _stillOpen.status,
            });
          }
        }

        // Gate 2: re-entry throttle (same direction, within N hours of last exit)
        const _reentryThrottleHrs = Number(daCfg.deep_audit_reentry_throttle_hours ?? 24);
        if (_reentryThrottleHrs > 0) {
          const _cutoffMs = _nowTs - (_reentryThrottleHrs * 3600 * 1000);
          const _recentSameDir = _recentTrades.find(t => {
            if (String(t?.ticker || "").toUpperCase() !== _tickerUpper) return false;
            if (String(t?.direction || "").toUpperCase() !== _sideUpper) return false;
            const exitTs = Number(t?.exit_ts) || 0;
            return exitTs > 0 && exitTs >= _cutoffMs;
          });
          if (_recentSameDir) {
            return rejectEntry("phase_i_reentry_throttle", {
              last_exit_ts: _recentSameDir.exit_ts,
              last_pnl_pct: _recentSameDir.pnl_pct,
              hours_since_exit: (_nowTs - Number(_recentSameDir.exit_ts)) / 3600000,
              throttle_hours: _reentryThrottleHrs,
            });
          }
        }
      }
    }

    // Layer 1 — Rank floor (Phase-I.4: universe-size adaptive)
    //
    // Phase-I.4.2 (2026-04-22): removed the `rankScore > 0` bypass. In v10b
    // the rank field was often 0 for 215-ticker universe entries, silently
    // no-op'ing the floor. Now strict by default — if rank can't be computed,
    // we reject. Disable with deep_audit_strict_rank_required="false" for
    // legacy behavior.
    //
    // Phase-I.4.1 (2026-04-22): universe-size-adaptive rank floor. On the
    // 40-ticker curated universe v9 hit 70.8% WR with floor=90. On 215-
    // ticker v10b the SAME floor=90 let through 79 marginal trades from
    // single-trade-per-ticker names (31% WR, -33% PnL). Adapts the effective
    // floor upward when the universe is large, so the top-decile selectivity
    // that worked on 40 tickers translates to ~top-5% on 215 tickers.
    //
    //   effective_floor = base_floor + ceil((universeSize / reference) - 1) * bump
    //   reference = 40 (v9), default bump = 3 per 40-ticker increment
    //
    //   40 tickers:  effective = base_floor    (e.g. 90)
    //   80 tickers:  effective = base_floor + 3
    //   120 tickers: effective = base_floor + 6
    //   160 tickers: effective = base_floor + 9
    //   215 tickers: effective = base_floor + 15 (e.g. 90 -> 105, clamped to 100)
    //
    // For 215T a base_floor of 90 becomes an effective 100 (max). That's
    // effectively "only perfect scores" — probably too strict. Set base
    // floor to 85 for 215T and it becomes effective ~97.
    const _h3RankFloor = Number(daCfg.deep_audit_min_rank_floor) || 0;
    const _strictRank = String(daCfg.deep_audit_strict_rank_required ?? "true") === "true";
    const _universeAdaptive = String(daCfg.deep_audit_universe_adaptive_rank ?? "true") === "true";
    let _effectiveRankFloor = _h3RankFloor;
    if (_h3RankFloor > 0 && _universeAdaptive) {
      const _universeSize = Number(d?._env?._universeSize) || 40;
      const _refUniverse = Number(daCfg.deep_audit_universe_rank_reference ?? 40);
      const _rankBumpPerUniv = Number(daCfg.deep_audit_universe_rank_bump_per_ref ?? 3);
      const _extraUniv = Math.max(0, _universeSize - _refUniverse);
      const _bump = Math.ceil(_extraUniv / _refUniverse) * _rankBumpPerUniv;
      _effectiveRankFloor = Math.min(100, _h3RankFloor + _bump);
    }
    if (_effectiveRankFloor > 0) {
      if (_strictRank) {
        if (rankScore < _effectiveRankFloor) {
          return rejectEntry("h3_rank_below_floor", {
            rank: rankScore, floor: _effectiveRankFloor, baseFloor: _h3RankFloor,
            universeSize: Number(d?._env?._universeSize) || 0, strict: true,
          });
        }
      } else if (rankScore > 0 && rankScore < _effectiveRankFloor) {
        return rejectEntry("h3_rank_below_floor", {
          rank: rankScore, floor: _effectiveRankFloor, baseFloor: _h3RankFloor,
          universeSize: Number(d?._env?._universeSize) || 0, strict: false,
        });
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // PHASE-I.2 — SHORT-SIDE SELECTIVITY GATES (SPY downtrend + sector RS)
    // v10b had 4 of 5 big losers from SHORTs against a clear SPY/healthcare
    // uptrend (ISRG x2, ~-6% each). The existing H.3 gate allowed "neutral"
    // cycle shorts. I.2 adds hard-block: no SHORT unless SPY is confirmed
    // in downtrend, AND the ticker's sector isn't outperforming SPY.
    // High-rank speculative cohort carve-out for meme/crypto shorts.
    //
    // See: tasks/phase-i-implementation-2026-04-22.md Workstream 2
    // ─────────────────────────────────────────────────────────────────
    if (side === "SHORT") {
      const _shortSpyGate = String(daCfg.deep_audit_short_requires_spy_downtrend ?? "true") === "true";
      if (_shortSpyGate) {
        const spyDaily = ctx?.market?.spyDailyStructure || {};
        const spyBelowE21 = spyDaily?.close_below_e21 === true;
        const spyE21SlopeNeg = Number(spyDaily?.e21_slope_5bar_pct ?? 0) < 0;
        const spyBearRegime = Number(spyDaily?.ema_regime_daily ?? 0) <= -1;
        const bearSignals = [spyBelowE21, spyE21SlopeNeg, spyBearRegime].filter(Boolean).length;

        // V12 P4 (2026-04-23) — relax 2-of-3 to configurable floor.
        // V11 shipped 1 SHORT in 10 months. Target 5-15. `bearish_mixed`
        // (1 of 3 signals) is the practical minimum that still avoids
        // raw bull tape. See tasks/v12-killer-strategy-2026-04-23.md P4.
        const _spyFloorName = String(daCfg.deep_audit_short_spy_regime_floor ?? "bearish_mixed").toLowerCase();
        const _minBearSignals = _spyFloorName === "bearish_stacked" ? 2
          : _spyFloorName === "sideways_below_21ema" ? 1
          : /* bearish_mixed */ 1;
        const spyDowntrend = bearSignals >= _minBearSignals;

        // V12 P4: require ticker's own daily EMA structure to be
        // stacked-bearish (E21 < E48 < E200) when SPY isn't in full
        // downtrend. This replaces the sector-strength hard block.
        const _requireTickerBearish = String(
          daCfg.deep_audit_short_requires_ticker_bearish_daily ?? "true"
        ) === "true";
        const tickerDaily = d?.daily_structure || {};
        const tickerBearishDaily =
          Number(tickerDaily?.e21) > 0 &&
          Number(tickerDaily?.e48) > 0 &&
          Number(tickerDaily?.e200) > 0 &&
          Number(tickerDaily?.e21) < Number(tickerDaily?.e48) &&
          Number(tickerDaily?.e48) < Number(tickerDaily?.e200);

        if (!spyDowntrend && _requireTickerBearish && !tickerBearishDaily) {
          // Carve-out: exceptional rank + speculative cohort (meme/crypto)
          const _shortCarveRankMin = Number(daCfg.deep_audit_short_spy_carveout_rank_min ?? 95);
          const _shortCarveCohorts = String(daCfg.deep_audit_short_spy_carveout_cohorts ?? "speculative")
            .toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
          const rankHighEnough = rankScore >= _shortCarveRankMin;
          const cohortAllowed = _shortCarveCohorts.includes(String(d?._cohort || "").toLowerCase());
          if (!(rankHighEnough && cohortAllowed)) {
            return rejectEntry("phase_i_short_no_spy_downtrend", {
              bearSignals, spyBelowE21, spyE21SlopeNeg, spyBearRegime,
              tickerBearishDaily, minBearSignals: _minBearSignals,
              rank: rankScore, cohort: d?._cohort,
            });
          }
        }
      }

      // V12 P4: sector-strength gate now defaults OFF (rank penalty instead
      // of hard block). If still enabled, keep the original behavior.
      const _sectorStrengthGate = String(daCfg.deep_audit_short_sector_strength_gate ?? "false") === "true";
      if (_sectorStrengthGate) {
        const sectorRegime = String(ctx?.regime?.sector || "").toUpperCase();
        const sectorBullish = sectorRegime === "STRONG_BULL" || sectorRegime === "LATE_BULL";
        const _sectorStrengthRankMin = Number(daCfg.deep_audit_short_sector_strength_rank_min ?? 98);
        if (sectorBullish && rankScore < _sectorStrengthRankMin) {
          return rejectEntry("phase_i_short_sector_outperforming", {
            sectorRegime, rank: rankScore, rankMin: _sectorStrengthRankMin,
          });
        }
      }
    }

    // Layer 2 — Regime-adaptive strategy
    // Blocks SHORTs in "uptrend" cycles and LONGs in "downtrend" cycles
    // unless ticker rank is exceptional AND cohort is permitted.
    // Cycle label comes from ctx.market.monthlyCycle (populated by
    // trade-context from the backdrop file for the replay date).
    const _h3AdaptiveEnabled = String(daCfg.deep_audit_regime_adaptive_enabled ?? "false") === "true";
    if (_h3AdaptiveEnabled) {
      const cycle = String(ctx?.market?.monthlyCycle || "").toLowerCase();
      const tickerCohort = String(d?._cohort || d?.cohort || "").toLowerCase();
      const isShort = side === "SHORT";
      const isLong = side === "LONG";

      if (cycle === "uptrend" && isShort) {
        const _upShortRankMin = Number(daCfg.deep_audit_regime_uptrend_short_rank_min) || 98;
        const _upShortCohortsRaw = String(daCfg.deep_audit_regime_uptrend_short_cohorts || "speculative")
          .toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
        const cohortAllowed = _upShortCohortsRaw.includes(tickerCohort);
        if (rankScore < _upShortRankMin || !cohortAllowed) {
          return rejectEntry("h3_short_blocked_in_uptrend", {
            cycle, rank: rankScore, rankMin: _upShortRankMin, cohort: tickerCohort, cohortAllowed,
          });
        }
      } else if (cycle === "downtrend" && isLong) {
        const _dnLongRankMin = Number(daCfg.deep_audit_regime_downtrend_long_rank_min) || 98;
        const _require4hBull = String(daCfg.deep_audit_regime_downtrend_long_require_4h_bull ?? "true") === "true";
        const h4StBull = Number(h4?.stDir) > 0;
        if (rankScore < _dnLongRankMin || (_require4hBull && !h4StBull)) {
          return rejectEntry("h3_long_blocked_in_downtrend", {
            cycle, rank: rankScore, rankMin: _dnLongRankMin, h4StBull,
          });
        }
      } else if (cycle === "transitional" || cycle === "") {
        // Transitional (or unknown) — bumped rank floor still applies via _h3RankFloor above
        const _transRankMin = Number(daCfg.deep_audit_regime_transitional_rank_min) || 0;
        if (_transRankMin > 0 && rankScore < _transRankMin) {
          return rejectEntry("h3_rank_below_transitional_floor", {
            cycle: cycle || "unknown", rank: rankScore, rankMin: _transRankMin,
          });
        }
      }
    }

    // Layer 3 — Multi-signal consensus gate
    // Scoring across 5 dimensions. Requires at least N of 5 to corroborate
    // the direction before the setup is eligible. This kicks in before the
    // setup-specific evaluation below, so it acts as a baseline quality check.
    const _h3ConsensusEnabled = String(daCfg.deep_audit_consensus_gate_enabled ?? "false") === "true";
    if (_h3ConsensusEnabled) {
      const isLong = side === "LONG";
      let signals = 0;
      const breakdown = { trend: false, momentum: false, volume: false, sector: false, phase: false };

      // 1. Trend alignment — at least 2 of (1H, 4H, D) ST aligned
      const st1H = Number(h1?.stDir) || 0;
      const st4H = Number(h4?.stDir) || 0;
      const stD = Number(D?.stDir) || 0;
      const sign = isLong ? 1 : -1;
      const trendAligned = [st1H, st4H, stD].filter(x => Math.sign(x) === sign).length;
      if (trendAligned >= 2) { signals += 1; breakdown.trend = true; }

      // 2. Momentum alignment — RSI 30m AND RSI 1H both on direction's side of 50
      const rsi30 = Number(m30?.rsi?.r5);
      const rsi1h = Number(h1?.rsi?.r5);
      if (Number.isFinite(rsi30) && Number.isFinite(rsi1h)) {
        const momOk = isLong ? (rsi30 > 50 && rsi1h > 50) : (rsi30 < 50 && rsi1h < 50);
        if (momOk) { signals += 1; breakdown.momentum = true; }
      }

      // 3. Volume confirmation — 30m or 1H rvol >= 1.2
      const rvol30 = Number(d?.rvol_map?.["30"]?.vr);
      const rvol60 = Number(d?.rvol_map?.["60"]?.vr);
      const volMin = Number(daCfg.deep_audit_consensus_volume_rvol_min) || 1.2;
      if ((Number.isFinite(rvol30) && rvol30 >= volMin) || (Number.isFinite(rvol60) && rvol60 >= volMin)) {
        signals += 1; breakdown.volume = true;
      }

      // 4. Sector alignment — ticker's sector must be OW for LONGs, UW for SHORTs.
      // Sector rating text comes from ctx.market.sectorRating[ticker] (populated
      // by trade-context from SECTOR_RATINGS).
      const sectorRating = String(ctx?.sectorRating || d?._sector_rating || "").toLowerCase();
      const sectorOk = isLong
        ? (sectorRating === "overweight" || sectorRating === "neutral")
        : (sectorRating === "underweight" || sectorRating === "neutral");
      if (sectorRating && sectorOk) { signals += 1; breakdown.sector = true; }

      // 5. Phase positioning — phase between 15-75% (the sweet spot per Phase-E.3 miner)
      const phase = Number(phasePct);
      if (Number.isFinite(phase) && phase >= 15 && phase <= 75) {
        signals += 1; breakdown.phase = true;
      }

      const _h3MinSignals = Number(daCfg.deep_audit_consensus_min_signals) || 3;
      if (signals < _h3MinSignals) {
        return rejectEntry("h3_consensus_below_min", {
          signals, min: _h3MinSignals, breakdown,
        });
      }
    }
  }
  // ═════════════════════════════════════════════════════════════════════════
  // END PHASE-H.3 GATES
  // ═════════════════════════════════════════════════════════════════════════

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

  // V12 P5 (2026-04-23) — tt_momentum retune (stricter entry)
  //
  // V11: 71.4 % WR but total PnL -2.0 %. Wins mean +0.78 %, losses
  // mean -2.46 % — R:R is upside-down. The trigger is firing on too
  // many "okay" cross-ups that stall out. Tighten entry criteria so
  // only high-conviction momentum survives:
  //   - RVol floor (default 2.0x, was ~1.5x)
  //   - Bar close in upper N % of bar (default 60 %) — rejects wicks
  // Both DA-gated so we can tune or disable.
  if (momentumTrigger) {
    const _minRvol = Number(daCfg.deep_audit_tt_momentum_min_rvol);
    const _minBarPos = Number(daCfg.deep_audit_tt_momentum_bar_position_min);
    if (Number.isFinite(_minRvol) && _minRvol > 0) {
      const _rvol = Number(ctx?.rvol?.best) || Number(d?.rvol_map?.["30"]?.vr) || Number(d?.rvol_best) || 0;
      if (_rvol > 0 && _rvol < _minRvol) {
        momentumTrigger = false;
      }
    }
    if (momentumTrigger && Number.isFinite(_minBarPos) && _minBarPos > 0) {
      // Bar position: where did the close land in the bar's range?
      // LONG entries: want close in upper (60%+) of bar (strong buying)
      // SHORT entries: want close in lower (40%- for LONG side) of bar
      const bar = m10?.latest || m10?.currentBar || null;
      const high = Number(bar?.h ?? bar?.high);
      const low = Number(bar?.l ?? bar?.low);
      const close = Number(bar?.c ?? bar?.close ?? d?.price);
      if (Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close) && high > low) {
        const pos = (close - low) / (high - low);
        if (side === "LONG" && pos < _minBarPos) momentumTrigger = false;
        if (side === "SHORT" && pos > (1 - _minBarPos)) momentumTrigger = false;
      }
    }
  }

  pullbackTrigger = side === "LONG"
    ? !!((c10_8?.inCloud || c10_8?.above) && c10_8?.fastSlope >= 0 && ltfConfirm)
    : !!((c10_8?.inCloud || c10_8?.below) && c10_8?.fastSlope <= 0 && ltfConfirm);

  reclaimTrigger = config.ripsterTuneV2 && (side === "LONG"
    ? !!((c10_8?.crossUp || (c10_8?.bull && c10_8?.above)) && hasStFlipBull && ltfRecovering && c10_8?.fastSlope >= 0)
    : !!((c10_8?.crossDn || (c10_8?.bear && c10_8?.below)) && hasStFlipBear && ltfConfirm && c10_8?.fastSlope <= 0));
  if (laggingH1BreakoutLong && !momentumTrigger && !pullbackTrigger && !reclaimTrigger) {
    reclaimTrigger = true;
  }

  // tickerUpper is needed by the Phase-E ETF swing trigger below; the main
  // QUALITY REJECTION GATES block also declares it but the trigger needs it
  // first. Use a local identifier here.
  const _tickerUpperEarly = String(d?.ticker || d?.sym || ctx.ticker || "").trim().toUpperCase();

  // ──────────────────────────────────────────────────────────────────────
  // V12 P6 (2026-04-23) — ETF PRECISION GATE
  //
  // Goal: 90%+ WR on SPY/QQQ/IWM/DIA. V11 delivered 4 trades, 25% WR.
  // The strategy's normal entry pipeline isn't calibrated for broad-index
  // ETFs — they barely pull back, use different volatility ranges, and
  // respond to different technical cues than single stocks.
  //
  // 10-filter conjunction MUST all pass for a SHORT/LONG entry on
  // precision-gated tickers. If any fails, immediate reject regardless
  // of what the regular triggers would say.
  //
  // Filters:
  //   1. Daily EMA21 > EMA48 > EMA200 (stacked same direction as trade)
  //   2. Pullback within N% of daily EMA21 (not deeper)
  //   3. Daily RSI in 40-65 healthy pullback zone
  //   4. 1H close above 21EMA (LONG) / below 21EMA (SHORT)
  //   5. Current price above 30m ATR Saty-0 line (anchor)
  //   6. Weekly not overextended (within 2 weekly ATRs of weekly EMA21)
  //   7. VIX ≤ N (suppress panic-tape entries on broad ETFs)
  //   8. Breadth ≥ N% green (regime alignment)
  //   9. No FOMC/CPI/NFP event within M hours
  //  10. Run-rank ≥ N (baseline quality)
  //
  // See: tasks/v12-killer-strategy-2026-04-23.md
  // ──────────────────────────────────────────────────────────────────────
  const _etfPgEnabled = String(daCfg.deep_audit_etf_precision_gate_enabled ?? "false") === "true";
  const _etfPgTickerList = String(daCfg.deep_audit_etf_precision_tickers ?? "SPY,QQQ,IWM,DIA")
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const _isEtfPgTicker = _etfPgEnabled && _etfPgTickerList.includes(_tickerUpperEarly);
  if (_isEtfPgTicker) {
    const fails = [];
    const daily = ctx?.daily || d?.daily_structure || {};
    const isLong = side === "LONG";

    // F1 — Daily EMA stack aligned with direction
    const e21 = Number(daily?.e21);
    const e48 = Number(daily?.e48);
    const e200 = Number(daily?.e200);
    const stackBull = e21 > 0 && e48 > 0 && e200 > 0 && e21 > e48 && e48 > e200;
    const stackBear = e21 > 0 && e48 > 0 && e200 > 0 && e21 < e48 && e48 < e200;
    if (isLong && !stackBull) fails.push("f1_daily_stack_not_bull");
    if (!isLong && !stackBear) fails.push("f1_daily_stack_not_bear");

    // F2 — Pullback depth (within _maxPullback of daily EMA21)
    const _maxPullback = Number(daCfg.deep_audit_etf_precision_daily_ema_pullback_pct ?? 1.5);
    const currentPrice = Number(d?.price ?? d?.close ?? d?._live_price);
    if (e21 > 0 && Number.isFinite(currentPrice)) {
      const distPct = Math.abs((currentPrice - e21) / e21) * 100;
      if (distPct > _maxPullback) fails.push(`f2_pullback_too_deep_${distPct.toFixed(2)}%`);
    } else {
      fails.push("f2_missing_price_or_e21");
    }

    // F3 — Daily RSI in healthy pullback zone
    const _rsiMin = Number(daCfg.deep_audit_etf_precision_daily_rsi_min ?? 40);
    const _rsiMax = Number(daCfg.deep_audit_etf_precision_daily_rsi_max ?? 65);
    const rsiDailyLocal = Number(daily?.rsi ?? D?.rsi);
    if (!Number.isFinite(rsiDailyLocal)) {
      fails.push("f3_rsi_daily_missing");
    } else if (rsiDailyLocal < _rsiMin || rsiDailyLocal > _rsiMax) {
      fails.push(`f3_rsi_daily_out_of_band_${rsiDailyLocal.toFixed(1)}`);
    }

    // F4 — 1H structure aligned
    const h1Above = h1?.ripster?.c34_50?.above || h1?.close_above_e21;
    const h1Below = h1?.ripster?.c34_50?.below || h1?.close_below_e21;
    if (isLong && !h1Above) fails.push("f4_1h_not_aligned_long");
    if (!isLong && !h1Below) fails.push("f4_1h_not_aligned_short");

    // F5 — 30m price above ATR Saty-0 (the current-day anchor)
    const saty0Level = Number(m30?.saty_atr_levels?.anchor ?? m30?.atr_levels?.["0"]);
    if (Number.isFinite(saty0Level) && Number.isFinite(currentPrice)) {
      if (isLong && currentPrice < saty0Level) fails.push("f5_below_30m_saty_anchor");
      if (!isLong && currentPrice > saty0Level) fails.push("f5_above_30m_saty_anchor");
    }
    // if Saty level unavailable, skip F5 rather than hard-reject

    // F6 — Weekly not overextended (within 2 weekly ATRs of weekly EMA21)
    const wE21 = Number(W?.ema21 ?? W?.e21);
    const wAtr = Number(W?.atr);
    if (Number.isFinite(wE21) && Number.isFinite(wAtr) && wAtr > 0 && Number.isFinite(currentPrice)) {
      const wDistAtrs = Math.abs(currentPrice - wE21) / wAtr;
      if (wDistAtrs > 2.0) fails.push(`f6_weekly_overextended_${wDistAtrs.toFixed(2)}atr`);
    }

    // F7 — VIX cap
    const _vixMax = Number(daCfg.deep_audit_etf_precision_vix_max ?? 25);
    const vixNow = Number(ctx?.market?.vix ?? d?._env?.vix);
    if (Number.isFinite(vixNow) && vixNow > _vixMax) {
      fails.push(`f7_vix_too_high_${vixNow.toFixed(1)}`);
    }

    // F8 — Breadth regime aligned
    const _breadthMin = Number(daCfg.deep_audit_etf_precision_breadth_min ?? 50);
    const breadthPct = Number(ctx?.market?.breadth_pct ?? d?._env?.breadth_pct);
    if (Number.isFinite(breadthPct)) {
      if (isLong && breadthPct < _breadthMin) fails.push(`f8_breadth_weak_${breadthPct.toFixed(0)}%`);
      if (!isLong && breadthPct > (100 - _breadthMin)) fails.push(`f8_breadth_strong_${breadthPct.toFixed(0)}%`);
    }

    // F9 — Macro event proximity
    const _macroHours = Number(daCfg.deep_audit_etf_precision_macro_event_hours ?? 48);
    const hoursToMacro = Number(ctx?.eventProximity?.hours_to_macro ?? d?._env?.hours_to_macro);
    if (Number.isFinite(hoursToMacro) && hoursToMacro >= 0 && hoursToMacro < _macroHours) {
      fails.push(`f9_macro_event_in_${hoursToMacro.toFixed(0)}h`);
    }

    // F10 — Rank floor
    const _minRank = Number(daCfg.deep_audit_etf_precision_min_rank ?? 90);
    const rankLocal = Number(scores?.rank ?? d?.rank ?? d?.score ?? 0);
    if (rankLocal < _minRank) fails.push(`f10_rank_below_${_minRank}_got_${rankLocal}`);

    if (fails.length > 0) {
      return reject("etf_precision_gate_fail", {
        ticker: _tickerUpperEarly,
        side,
        fails,
        filtersRequired: 10,
        filtersFailed: fails.length,
      });
    }
    // If we reach here, ALL 10 filters passed. Let the normal trigger
    // pipeline decide which trigger label to attach (most likely the
    // existing index_etf_swing trigger).
  }

  // ──────────────────────────────────────────────────────────────────────
  // PHASE-E (2026-04-19) INDEX-ETF SWING TRIGGER (Daily-Brief aligned)
  // ──────────────────────────────────────────────────────────────────────
  // The Daily Brief actively produces bull/bear game-plan levels for
  // SPY/QQQ/IWM every session, yet 10 months of v2 slices produced ZERO
  // trades on these three tickers. Block-chain analysis showed they
  // reach kanban=setup with score=95+ in HTF_BULL_LTF_PULLBACK state,
  // but the pullback/reclaim/momentum triggers all fail because index
  // ETFs pull back softly to D21/D48 without the crisp 5/12 EMA reclaim
  // the standard triggers require. This ETF-specific trigger fires when
  // the Daily structure is clean (stacked + healthy slope + non-extended)
  // AND the LTF is at a shallow pullback in an aligned HTF state.
  let indexEtfSwingTrigger = false;
  const etfSwingEnabled = String(daCfg.deep_audit_index_etf_swing_enabled ?? "true") === "true";
  if (etfSwingEnabled && ctx?.daily) {
    const etfSwingTickers = deepAuditTickerSet(
      daCfg.deep_audit_index_etf_swing_tickers || "SPY,QQQ,IWM",
    );
    if (etfSwingTickers.has(_tickerUpperEarly) && ctx.daily) {
      const daily = ctx.daily;
      const minScore = Number(daCfg.deep_audit_index_etf_swing_min_score) || 92;
      const pctAboveE48Min = Number(daCfg.deep_audit_index_etf_swing_pct_above_e48_min) ?? 1.0;
      const pctAboveE48Max = Number(daCfg.deep_audit_index_etf_swing_pct_above_e48_max) || 7.0;
      const pctBelowE48Min = Number(daCfg.deep_audit_index_etf_swing_pct_below_e48_min) ?? 1.0;
      const pctBelowE48Max = Number(daCfg.deep_audit_index_etf_swing_pct_below_e48_max) || 7.0;
      const e21SlopeMin = Number(daCfg.deep_audit_index_etf_swing_e21_slope_min) || 0.3;
      const e21SlopeMax = Number(daCfg.deep_audit_index_etf_swing_e21_slope_max) || 3.0;
      const rvolMin = Number(daCfg.deep_audit_index_etf_swing_rvol_min) || 0.7;
      const rankScore = Number(scores?.rank) || Number(d?.score) || Number(d?.rank) || 0;
      const rvolSignal = Number(ctx?.rvol?.best) || Number(d?.rvol_map?.["30"]?.vr) || 1.0;
      const pctAbove48 = Number(daily.pct_above_e48);
      const e21Slope = Number(daily.e21_slope_5d_pct);
      const state = String(ctx.state || "");
      const m30Cloud89 = tf?.m30?.ripster?.c8_9 || null;
      if (side === "LONG"
        && rankScore >= minScore
        && rvolSignal >= rvolMin
        && daily.bull_stack === true
        && daily.above_e200 === true
        && Number.isFinite(pctAbove48)
        && pctAbove48 >= pctAboveE48Min
        && pctAbove48 <= pctAboveE48Max
        && Number.isFinite(e21Slope)
        && e21Slope >= e21SlopeMin
        && e21Slope <= e21SlopeMax
        && (state === "HTF_BULL_LTF_PULLBACK" || state === "HTF_BULL_LTF_BULL")
        && (c10_8?.above || c10_8?.inCloud || m30Cloud89?.above || m30Cloud89?.inCloud)) {
        indexEtfSwingTrigger = true;
      } else if (side === "SHORT"
        && rankScore >= minScore
        && rvolSignal >= rvolMin
        && daily.bear_stack === true
        && daily.above_e200 === false
        && Number.isFinite(pctAbove48)
        && pctAbove48 <= -pctBelowE48Min
        && pctAbove48 >= -pctBelowE48Max
        && Number.isFinite(e21Slope)
        && e21Slope <= -e21SlopeMin
        && e21Slope >= -e21SlopeMax
        && (state === "HTF_BEAR_LTF_BOUNCE" || state === "HTF_BEAR_LTF_BEAR")
        && (c10_8?.below || c10_8?.inCloud || m30Cloud89?.below || m30Cloud89?.inCloud)) {
        indexEtfSwingTrigger = true;
      }
      if (indexEtfSwingTrigger) {
        // Promote to reclaimTrigger semantically so downstream quality gates
        // that test `reclaimTrigger` relax correctly (this trigger is more
        // conservative than pullback since it requires a full daily-stack
        // alignment).
        reclaimTrigger = true;
      }
    }
  }
  // ──────────────────────────────────────────────────────────────────────

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

  // ──────────────────────────────────────────────────────────────────────
  // PHASE-E.3 (2026-04-19) COHORT-AWARE THRESHOLD OVERLAY
  // ──────────────────────────────────────────────────────────────────────
  // Pattern mining across 150 v4 trades (8 months) surfaced cohort-
  // specific behaviour that universal thresholds miss:
  //   - Index ETF (SPY/QQQ/IWM): WR 75 % but 10 flat-slope entries were
  //     scratch; need slope floor ≥ 0.5 % and cap at 5 % above D48.
  //   - Mega-Cap Tech: overbought RSI is a GREEN flag (87 % WR), extended
  //     5-8 % above D48 still works (+1.57 % avg).
  //   - Industrial: 2-5 % extension is the sweet spot (58 % WR, +45 %),
  //     neutral RSI is toxic (25 % WR, −0.64 % avg).
  //   - Speculative: parabolic slope + extended is the BEST zone for this
  //     cohort (+6.61 % avg on 4 trades); overbought RSI 83 % WR.
  //   - Sector ETF (XLY): only negative cohort (−5.9 % over 6 trades).
  //
  // Each DA-key has a global default; the cohort value, when present,
  // overrides for that ticker only.
  const cohortOverlayEnabled = String(daCfg.deep_audit_cohort_overlay_enabled ?? "true") === "true";
  if (cohortOverlayEnabled && ctx?.daily) {
    const indexEtfSet = deepAuditTickerSet(
      daCfg.deep_audit_cohort_index_etf_tickers || "SPY,QQQ,IWM",
    );
    const megaCapSet = deepAuditTickerSet(
      daCfg.deep_audit_cohort_megacap_tickers || "AAPL,MSFT,GOOGL,AMZN,META,NVDA,TSLA",
    );
    const industrialSet = deepAuditTickerSet(
      daCfg.deep_audit_cohort_industrial_tickers || "ETN,FIX,IESC,MTZ,PH,SWK",
    );
    const speculativeSet = deepAuditTickerSet(
      daCfg.deep_audit_cohort_speculative_tickers || "AGQ,GRNY,RIOT,SGI",
    );
    const sectorEtfSet = deepAuditTickerSet(
      daCfg.deep_audit_cohort_sector_etf_tickers || "XLY",
    );
    const pauseSectorEtf = String(daCfg.deep_audit_cohort_sector_etf_pause_enabled ?? "true") === "true";
    if (pauseSectorEtf && sectorEtfSet.has(_tickerUpperEarly)) {
      return rejectEntry("tt_cohort_sector_etf_paused", {
        ticker: _tickerUpperEarly,
        reason: "10-month analysis: −5.9 % over 6 trades, only negative cohort",
      });
    }
    const dailyDetails = ctx.daily;
    const pctAboveE48Local = Number(dailyDetails.pct_above_e48);
    const e21Slope5dLocal = Number(dailyDetails.e21_slope_5d_pct);
    const rsiDLocal = Number(dailyDetails.rsi_d);
    const isLongSide = side === "LONG";
    // Pick cohort + apply its overlay.
    let cohortLabel = null;
    let slopeMinOverride = null;
    let extensionMaxOverride = null;
    let rsiMaxOverride = null;
    let rsiMinWhenNeutralBlock = null;
    if (indexEtfSet.has(_tickerUpperEarly)) {
      cohortLabel = "index_etf";
      slopeMinOverride = Number(daCfg.deep_audit_cohort_slope_min_index_etf);
      extensionMaxOverride = Number(daCfg.deep_audit_cohort_extension_max_index_etf);
      rsiMaxOverride = Number(daCfg.deep_audit_cohort_rsi_max_index_etf);
      if (!Number.isFinite(slopeMinOverride)) slopeMinOverride = 0.5;
      if (!Number.isFinite(extensionMaxOverride)) extensionMaxOverride = 5.0;
      if (!Number.isFinite(rsiMaxOverride)) rsiMaxOverride = 75;
    } else if (megaCapSet.has(_tickerUpperEarly)) {
      cohortLabel = "megacap_tech";
      slopeMinOverride = Number(daCfg.deep_audit_cohort_slope_min_megacap);
      extensionMaxOverride = Number(daCfg.deep_audit_cohort_extension_max_megacap);
      if (!Number.isFinite(slopeMinOverride)) slopeMinOverride = 0.3;
      if (!Number.isFinite(extensionMaxOverride)) extensionMaxOverride = 8.0;
      // RSI: overbought is GREEN for mega-caps; no cap
    } else if (industrialSet.has(_tickerUpperEarly)) {
      cohortLabel = "industrial";
      slopeMinOverride = Number(daCfg.deep_audit_cohort_slope_min_industrial);
      extensionMaxOverride = Number(daCfg.deep_audit_cohort_extension_max_industrial);
      rsiMinWhenNeutralBlock = Number(daCfg.deep_audit_cohort_rsi_neutral_block_industrial);
      if (!Number.isFinite(slopeMinOverride)) slopeMinOverride = 0.7;
      if (!Number.isFinite(extensionMaxOverride)) extensionMaxOverride = 8.0;
      if (!Number.isFinite(rsiMinWhenNeutralBlock)) rsiMinWhenNeutralBlock = 55;
    } else if (speculativeSet.has(_tickerUpperEarly)) {
      cohortLabel = "speculative";
      slopeMinOverride = Number(daCfg.deep_audit_cohort_slope_min_speculative);
      extensionMaxOverride = Number(daCfg.deep_audit_cohort_extension_max_speculative);
      if (!Number.isFinite(slopeMinOverride)) slopeMinOverride = 0.3;
      if (!Number.isFinite(extensionMaxOverride)) extensionMaxOverride = 99.0;
      // RSI: overbought GREEN (+3.70 % avg) — no cap
    }
    // Apply cohort LONG-side overlays.
    if (cohortLabel && isLongSide
      && (momentumTrigger || pullbackTrigger || reclaimTrigger)) {
      if (slopeMinOverride != null && Number.isFinite(e21Slope5dLocal)
        && e21Slope5dLocal < slopeMinOverride) {
        return rejectEntry("tt_cohort_slope_too_flat", {
          cohort: cohortLabel, e21Slope5d: e21Slope5dLocal, slopeMin: slopeMinOverride,
        });
      }
      if (extensionMaxOverride != null && Number.isFinite(pctAboveE48Local)
        && pctAboveE48Local > extensionMaxOverride) {
        return rejectEntry("tt_cohort_extension_too_wide", {
          cohort: cohortLabel, pctAboveE48: pctAboveE48Local, extensionMax: extensionMaxOverride,
        });
      }
      if (rsiMaxOverride != null && Number.isFinite(rsiDLocal)
        && rsiDLocal > rsiMaxOverride) {
        return rejectEntry("tt_cohort_rsi_too_high", {
          cohort: cohortLabel, rsiD: rsiDLocal, rsiMax: rsiMaxOverride,
        });
      }
      if (rsiMinWhenNeutralBlock != null && Number.isFinite(rsiDLocal)
        && rsiDLocal >= 45 && rsiDLocal < rsiMinWhenNeutralBlock) {
        return rejectEntry("tt_cohort_rsi_neutral_zone", {
          cohort: cohortLabel, rsiD: rsiDLocal, neutralBlockBelow: rsiMinWhenNeutralBlock,
        });
      }
    }
    // PHASE-F (2026-04-20) F11 — SHORT-side cohort overlay (mirror of LONG).
    // Slope: more negative = deeper decline = GREEN for shorts.
    // Extension: we want price below D48 (negative pct_above) for shorts.
    // RSI: don't short into oversold (<25) because those bounce.
    if (cohortLabel && !isLongSide
      && (momentumTrigger || pullbackTrigger || reclaimTrigger)) {
      let shortSlopeMax = null;  // "more negative than" → decline confirmation required
      let shortExtensionMin = null;  // pct_above_e48 must be ≤ this (i.e. price below D48)
      let shortRsiMin = null;  // don't short into oversold
      if (cohortLabel === "index_etf") {
        shortSlopeMax = Number(daCfg.deep_audit_cohort_short_slope_max_index_etf);
        shortExtensionMin = Number(daCfg.deep_audit_cohort_short_extension_min_index_etf);
        shortRsiMin = Number(daCfg.deep_audit_cohort_short_rsi_min_index_etf);
        if (!Number.isFinite(shortSlopeMax)) shortSlopeMax = -0.5;
        if (!Number.isFinite(shortExtensionMin)) shortExtensionMin = -1.0;
        if (!Number.isFinite(shortRsiMin)) shortRsiMin = 25;
      } else if (cohortLabel === "megacap_tech") {
        shortSlopeMax = Number(daCfg.deep_audit_cohort_short_slope_max_megacap);
        shortExtensionMin = Number(daCfg.deep_audit_cohort_short_extension_min_megacap);
        shortRsiMin = Number(daCfg.deep_audit_cohort_short_rsi_min_megacap);
        if (!Number.isFinite(shortSlopeMax)) shortSlopeMax = -0.3;
        if (!Number.isFinite(shortExtensionMin)) shortExtensionMin = -1.0;
        if (!Number.isFinite(shortRsiMin)) shortRsiMin = 30;
      } else if (cohortLabel === "industrial") {
        shortSlopeMax = Number(daCfg.deep_audit_cohort_short_slope_max_industrial);
        shortExtensionMin = Number(daCfg.deep_audit_cohort_short_extension_min_industrial);
        shortRsiMin = Number(daCfg.deep_audit_cohort_short_rsi_min_industrial);
        if (!Number.isFinite(shortSlopeMax)) shortSlopeMax = -0.7;
        if (!Number.isFinite(shortExtensionMin)) shortExtensionMin = -1.0;
        if (!Number.isFinite(shortRsiMin)) shortRsiMin = 30;
      } else if (cohortLabel === "speculative") {
        shortSlopeMax = Number(daCfg.deep_audit_cohort_short_slope_max_speculative);
        shortExtensionMin = Number(daCfg.deep_audit_cohort_short_extension_min_speculative);
        shortRsiMin = Number(daCfg.deep_audit_cohort_short_rsi_min_speculative);
        if (!Number.isFinite(shortSlopeMax)) shortSlopeMax = -0.3;
        if (!Number.isFinite(shortExtensionMin)) shortExtensionMin = -1.0;
        if (!Number.isFinite(shortRsiMin)) shortRsiMin = 25;
      }
      if (shortSlopeMax != null && Number.isFinite(e21Slope5dLocal)
        && e21Slope5dLocal > shortSlopeMax) {
        return rejectEntry("tt_cohort_short_slope_not_declining", {
          cohort: cohortLabel, e21Slope5d: e21Slope5dLocal, shortSlopeMax,
        });
      }
      if (shortExtensionMin != null && Number.isFinite(pctAboveE48Local)
        && pctAboveE48Local > shortExtensionMin) {
        return rejectEntry("tt_cohort_short_extension_insufficient", {
          cohort: cohortLabel, pctAboveE48: pctAboveE48Local, shortExtensionMin,
        });
      }
      if (shortRsiMin != null && Number.isFinite(rsiDLocal)
        && rsiDLocal < shortRsiMin) {
        return rejectEntry("tt_cohort_short_rsi_oversold", {
          cohort: cohortLabel, rsiD: rsiDLocal, shortRsiMin,
        });
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // PHASE-E (2026-04-19) DAILY-STRUCTURE FAKEOUT GATE
  // ──────────────────────────────────────────────────────────────────────
  // Evidence: 10-month v2 synthesis showed 10 of 24 clear-loser trades
  // entered when price was > +5 % above Daily EMA-48 (max +23 %), while
  // 8 big winners clustered tightly in +3.1 % to +6.5 %. A parabolic
  // e21_slope_5d (> +3 %) and a decelerating e48_slope_10d (< +0.25 %)
  // further separate winners from fakeouts. This gate rejects entries
  // that violate the structural-extension envelope regardless of score.
  if (ctx?.daily && (momentumTrigger || pullbackTrigger || reclaimTrigger)) {
    const daily = ctx.daily;
    const gateEnabled = String(daCfg.deep_audit_d_ema_overextension_gate_enabled ?? "true") === "true";
    if (gateEnabled) {
      const pctAboveE48 = Number(daily.pct_above_e48);
      const pctAboveE21 = Number(daily.pct_above_e21);
      const e21Slope5d = Number(daily.e21_slope_5d_pct);
      const e48Slope10d = Number(daily.e48_slope_10d_pct);
      if (side === "LONG") {
        const maxAboveE48 = Number(daCfg.deep_audit_d_ema_long_max_above_e48_pct) || 7.0;
        const maxE21Slope = Number(daCfg.deep_audit_d_ema_long_max_e21_slope_pct) || 3.5;
        const minE48Slope = Number(daCfg.deep_audit_d_ema_long_min_e48_slope_pct) || 0.25;
        if (Number.isFinite(pctAboveE48) && pctAboveE48 > maxAboveE48) {
          return rejectEntry("tt_d_ema_long_overextended", {
            pctAboveE48, maxAboveE48, e21: daily.e21, e48: daily.e48, e200: daily.e200,
          });
        }
        if (Number.isFinite(e21Slope5d) && e21Slope5d > maxE21Slope
          && Number.isFinite(pctAboveE21) && pctAboveE21 > 2.5) {
          return rejectEntry("tt_d_ema_long_parabolic", {
            e21Slope5d, maxE21Slope, pctAboveE21,
          });
        }
        if ((pullbackTrigger || reclaimTrigger)
          && Number.isFinite(e48Slope10d) && e48Slope10d < minE48Slope) {
          return rejectEntry("tt_d_ema_long_flat_structure", {
            e48Slope10d, minE48Slope, triggers: { pullbackTrigger, reclaimTrigger },
          });
        }
      } else if (side === "SHORT") {
        // PHASE-F (2026-04-20) — SHORT overextension gates reworked.
        // The prior Phase-E symmetric formulation blocked 4,194 bars in
        // Mar 2026 alone on "price > 7 % below D48" — which is the pay
        // zone for shorts, not the rejection zone. Inverted logic:
        //   - overextended: only block when price is > 15 % below D48 AND
        //     D21 is already turning up (5-day slope >= +0.5 %) = capitulation bounce.
        //   - flat_structure: block when D48 is RISING (bull structure intact).
        const maxBelowE48 = Number(daCfg.deep_audit_d_ema_short_max_below_e48_pct) || 15.0;
        const capitulationBounceSlope = Number(daCfg.deep_audit_d_ema_short_capitulation_slope_pct) || 0.5;
        const maxE21SlopeS = Number(daCfg.deep_audit_d_ema_short_max_e21_slope_pct) || -3.5;
        const maxE48SlopeS = Number(daCfg.deep_audit_d_ema_short_max_e48_slope_pct) || 0.25;
        const spyStructShort = ctx?.market?.spyDailyStructure || null;
        const spyBearStackedShort = spyStructShort?.bear_stack === true
          || spyStructShort?.above_e200 === false;
        if (Number.isFinite(pctAboveE48)
          && pctAboveE48 < -maxBelowE48
          && Number.isFinite(e21Slope5d)
          && e21Slope5d >= capitulationBounceSlope) {
          return rejectEntry("tt_d_ema_short_overextended", {
            pctAboveE48, maxBelowE48, e21Slope5d, capitulationBounceSlope,
            reason: "capitulation_bounce_risk",
            e21: daily.e21, e48: daily.e48, e200: daily.e200,
          });
        }
        // PHASE-F (2026-04-20): the "parabolic" short rejection only
        // applies when price has ALSO overextended past the capitulation
        // threshold. Just-broke-down trends like META Mar 27 (-16.78 %
        // below D48, slope -3.9 %) are the prime short setups, not
        // rejections. Only block when both: steep slope AND price is
        // already deep below D48 (near capitulation).
        if (Number.isFinite(e21Slope5d) && e21Slope5d < maxE21SlopeS
          && Number.isFinite(pctAboveE48) && pctAboveE48 < -maxBelowE48) {
          return rejectEntry("tt_d_ema_short_parabolic", {
            e21Slope5d, maxE21SlopeS, pctAboveE48, maxBelowE48,
            reason: "parabolic_plus_capitulation",
          });
        }
        // PHASE-F (2026-04-20) F9 — bypass flat_structure gate when SPY
        // is bear-stacked. A flat/declining ticker D48 alongside a broad
        // bearish SPY regime is confirmation, not fakeout signal.
        if ((pullbackTrigger || reclaimTrigger)
          && !spyBearStackedShort
          && Number.isFinite(e48Slope10d) && e48Slope10d > maxE48SlopeS) {
          return rejectEntry("tt_d_ema_short_flat_structure", {
            e48Slope10d, maxE48SlopeS, triggers: { pullbackTrigger, reclaimTrigger },
          });
        }
      }
    }
  }
  // ──────────────────────────────────────────────────────────────────────

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
  // T6 (2026-04-18): ticker-scoped overrides so the pullback-depth gate can
  // be relaxed for index / sector ETFs (SPY, QQQ, IWM, XLY) without
  // loosening the same gate on single-stock setups. The Phase-C 2025-07
  // diagnostic showed ETFs rarely satisfy the default 2-of-3 ST-bearish
  // pullback-depth rule in calm uptrends, even when they reach
  // kanban=in_review with score=100.
  const pullbackDepthEtfTickers = deepAuditTickerSet(
    daCfg.deep_audit_pullback_min_bearish_count_index_etf_tickers || "",
  );
  const pullbackDepthEtfOverrideRaw = daCfg.deep_audit_pullback_min_bearish_count_index_etf;
  const pullbackDepthEtfOverride = Number.isFinite(Number(pullbackDepthEtfOverrideRaw))
    ? Math.max(0, Number(pullbackDepthEtfOverrideRaw))
    : null;
  const basePullbackMinBearishCount = Math.max(
    0,
    Number(daCfg.deep_audit_pullback_min_bearish_count) || 2,
  );
  const pullbackMinBearishCount = (
    pullbackDepthEtfOverride != null
    && pullbackDepthEtfTickers.size > 0
    && pullbackDepthEtfTickers.has(tickerUpper)
  )
    ? pullbackDepthEtfOverride
    : basePullbackMinBearishCount;
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
  const abtLongQualityGuardEnabled = String(daCfg.deep_audit_abt_long_quality_guard_enabled ?? "true") === "true";
  const abtLongQualityGuardTickers = deepAuditTickerSet(
    daCfg.deep_audit_abt_long_quality_guard_include_tickers || "ABT",
  );
  const abtLongQualityGuardAvgBiasMax = Number.isFinite(Number(daCfg.deep_audit_abt_long_quality_guard_avg_bias_max))
    ? Number(daCfg.deep_audit_abt_long_quality_guard_avg_bias_max)
    : 0.70;

  // Narrow guard: block LONG momentum entry into a large unfilled, undefended
  // up-gap during the first 30 minutes of the session. Calibrated from
  // IESC-1761572700000 (10/27 09:45 ET max_loss) where the 09:30 entry is
  // rejected but momentum re-fires on the next 15m tick while the gap is
  // still undefended (halfGapHeld=false, fullGapFilled=false).
  const momentumUnfilledGapOpenChaseGuardEnabled = String(
    daCfg.deep_audit_momentum_unfilled_gap_open_chase_guard_enabled ?? "true",
  ) === "true";
  const momentumUnfilledGapOpenChaseTickers = deepAuditTickerSet(
    daCfg.deep_audit_momentum_unfilled_gap_open_chase_include_tickers || "IESC",
  );
  const momentumUnfilledGapOpenChaseMinGapPct = Number.isFinite(
    Number(daCfg.deep_audit_momentum_unfilled_gap_open_chase_min_gap_pct),
  )
    ? Number(daCfg.deep_audit_momentum_unfilled_gap_open_chase_min_gap_pct)
    : 2.0;
  const momentumUnfilledGapOpenChaseMaxBarsSinceOpen = Number.isFinite(
    Number(daCfg.deep_audit_momentum_unfilled_gap_open_chase_max_bars_since_open),
  )
    ? Number(daCfg.deep_audit_momentum_unfilled_gap_open_chase_max_bars_since_open)
    : 6;

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

  const shouldRejectMomentumUnfilledGapOpenChase = config.ripsterTuneV2
    && momentumUnfilledGapOpenChaseGuardEnabled
    && side === "LONG"
    && momentumTrigger
    && momentumUnfilledGapOpenChaseTickers.has(tickerUpper)
    && gapContext?.direction === "up"
    && Number(gapContext?.absGapPct) >= momentumUnfilledGapOpenChaseMinGapPct
    && !gapContext?.fullGapFilled
    && !gapContext?.halfGapHeld
    && Number(gapContext?.barsSinceOpen) <= momentumUnfilledGapOpenChaseMaxBarsSinceOpen;
  if (shouldRejectMomentumUnfilledGapOpenChase) {
    return rejectEntry("tt_momentum_unfilled_gap_open_chase", {
      ticker: tickerUpper,
      gapContext: summarizeGapContext(gapContext),
      minGapPct: momentumUnfilledGapOpenChaseMinGapPct,
      maxBarsSinceOpen: momentumUnfilledGapOpenChaseMaxBarsSinceOpen,
      includeTickers: Array.from(momentumUnfilledGapOpenChaseTickers),
      triggers: { momentumTrigger, pullbackTrigger, reclaimTrigger },
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

  // PHASE-E (2026-04-19): bypass the 5/12-reclaim requirement for index-ETF
  // swing entries. Index ETFs on soft pullbacks often keep 30m 5/12 opposed
  // without actually breaking down; the swing trigger's D-structure check
  // is a more robust filter.
  if (config.ripsterTuneV2 && pullbackTrigger && !reclaimTrigger
    && !indexEtfSwingTrigger
    && c30FiveTwelveOpposed && !c10FiveTwelveConfirmed) {
    return rejectEntry("tt_pullback_5_12_not_reclaimed", {
      c10_5: summarizeCloud(c10_5),
      c10_8: summarizeCloud(c10_8),
      c30_5: summarizeCloud(c30_5),
    });
  }

  if (config.ripsterTuneV2 && (pullbackTrigger || reclaimTrigger)
    && !indexEtfSwingTrigger
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
  // PHASE-E (2026-04-19): when the index-ETF swing trigger fired, bypass
  // this gate. The swing trigger itself encodes a richer daily-structure
  // qualification (bull_stack + above_e200 + slope + extension band) that
  // is materially stronger than an LTF ST-bearish count heuristic.
  if (config.ripsterTuneV2 && side === "LONG"
    && (pullbackTrigger || reclaimTrigger)
    && !confirmedBullContinuationLong
    && !indexEtfSwingTrigger
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
  // PHASE-E (2026-04-19) SHORT SPY-REGIME RELAXATION
  // In broad market declines individual tickers lag the index; requiring
  // 2 of 3 LTF ST to flip bearish before allowing a short prevents entry
  // at the first clean pullback after the state has already confirmed
  // HTF_BEAR. When SPY's daily structure is bearish (price < D48 AND
  // D21 < D48), relax the requirement to 1 of 3.
  const shortSpyRelaxEnabled = String(daCfg.deep_audit_short_spy_regime_relax_enabled ?? "true") === "true";
  const spyStruct = ctx?.market?.spyDailyStructure || null;
  const spyDailyBearish = !!(spyStruct
    && (spyStruct.above_e200 === false
      || (Number.isFinite(spyStruct.pct_above_e48) && spyStruct.pct_above_e48 <= -0.1)
      || spyStruct.bear_stack === true));
  const spyBearStacked = !!(spyStruct && spyStruct.bear_stack === true);
  const tickerDailyShortCtx = ctx?.daily || null;
  const tickerBearStacked = !!(tickerDailyShortCtx && tickerDailyShortCtx.bear_stack === true);
  // PHASE-F (2026-04-20) F12: when BOTH SPY and the ticker itself are
  // bear-stacked, allow the short to enter with 0-of-3 LTF ST bullish
  // (reclaim-path shorts) — the daily structural confirmation is strong
  // enough that we don't need LTF ST confirmation.
  const shortFullBearRelaxEnabled = String(daCfg.deep_audit_short_full_bear_relax_enabled ?? "true") === "true";
  // Phase-F (2026-04-20) F12: when BOTH SPY and the ticker are bear-stacked
  // AND ticker D48 slope is negative (structural trend confirmed), the daily
  // structural confirmation is strong enough to allow the short to enter
  // with 0-of-3 LTF ST bullish, regardless of trigger path (not just
  // reclaim). The original gate requires 2-of-3 LTF to turn bullish so the
  // short enters on a bounce — in a smooth decline that never happens and
  // we miss the whole move.
  const tickerD48Declining = !!(tickerDailyShortCtx
    && Number.isFinite(tickerDailyShortCtx.e48_slope_10d_pct)
    && tickerDailyShortCtx.e48_slope_10d_pct < 0);
  const shortPullbackMinCount = (
    shortFullBearRelaxEnabled
    && spyBearStacked && tickerBearStacked && tickerD48Declining
  ) ? 0
    : (shortSpyRelaxEnabled && spyDailyBearish) ? 1
    : 2;
  // PHASE-E (2026-04-19): same ETF-swing bypass for shorts.
  if (config.ripsterTuneV2 && side === "SHORT"
    && (pullbackTrigger || reclaimTrigger)
    && !indexEtfSwingTrigger
    && bullishPullbackCount < shortPullbackMinCount) {
    return rejectEntry("tt_short_pullback_not_deep_enough", {
      stDir15m,
      stDir30m,
      stDir1h: Number(h1?.stDir) || 0,
      bullishPullbackCount,
      requiredBullishCount: shortPullbackMinCount,
      spyDailyBearish,
      reclaimTrigger,
    });
  }

  emaStructure15m = Number(m15?.ema?.structure) || 0;
  const shouldRejectAbtLongQuality = config.ripsterTuneV2
    && abtLongQualityGuardEnabled
    && abtLongQualityGuardTickers.has(tickerUpper)
    && side === "LONG"
    && (momentumTrigger || pullbackTrigger)
    && !reclaimTrigger
    && !confirmedBullContinuationLong
    && ["choppy_selective", "correction_transition"].includes(executionProfileName)
    && stDir15m === -1
    && stDir30m === -1
    && avgBiasScore <= abtLongQualityGuardAvgBiasMax;
  if (shouldRejectAbtLongQuality) {
    return rejectEntry("tt_abt_long_quality_guard", {
      ticker: tickerUpper,
      executionProfileName,
      momentumTrigger,
      pullbackTrigger,
      avgBiasScore,
      avgBiasMax: abtLongQualityGuardAvgBiasMax,
      stDir15m,
      stDir30m,
      entryQualityScore,
      hasSqRelease,
      hasEmaCrossBull,
      structuralBullReclaimSignal,
    });
  }

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
    // T6 (2026-04-18): ticker-scoped non-Prime rank floor override for index
    // / sector ETFs — same CSV as the pullback-depth override so the two
    // gates stay in lock-step. The Phase-C 2025-07 probe showed SPY
    // typically sits at rank 87-88 at setup-stage moments, just below the
    // 90 floor, and that single point is enough to block all qualifying
    // entries across a 22-day month.
    const baseNonPrimeMinRank = Number(daCfg.deep_audit_pullback_non_prime_min_rank) || 90;
    const selectivePrimeMinRank = Number(daCfg.deep_audit_pullback_prime_min_rank) || 0;
    const nonPrimeEtfOverrideRaw = daCfg.deep_audit_pullback_non_prime_min_rank_index_etf;
    const nonPrimeEtfOverride = Number.isFinite(Number(nonPrimeEtfOverrideRaw))
      ? Math.max(0, Number(nonPrimeEtfOverrideRaw))
      : null;
    const selectiveNonPrimeMinRank = (
      nonPrimeEtfOverride != null
      && pullbackDepthEtfTickers.size > 0
      && pullbackDepthEtfTickers.has(tickerUpper)
    )
      ? nonPrimeEtfOverride
      : baseNonPrimeMinRank;
    const requiredRank = isPrimeGrade ? selectivePrimeMinRank : selectiveNonPrimeMinRank;
    // PHASE-E (2026-04-19): bypass rank-selective gate for index-ETF swing
    // trigger (rankScore is already required >= 92 in the trigger itself).
    if (!confirmedBullContinuationLong && !indexEtfSwingTrigger
      && selectivePullbackEnabled && requiredRank > 0 && rankScore < requiredRank) {
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

  // R5 (2026-04-17): Entry-path bias to protect tt_pullback big-winner source.
  // v1 Jul-Apr analysis: tt_momentum = 71 trades, 55.2% WR, +$677; tt_pullback = 42
  // trades, 68.3% WR, +$9,902. Inside tt_momentum, two clusters drive the losses:
  //   - setup_grade=Speculative: 2W/7L = 22% WR
  //   - execution_profile=correction_transition: 25W/28L = 47% WR
  // Pruning both yields 11 surviving tt_momentum trades with 100% WR and both big
  // winners preserved (CDNS +5.94%, FIX +7.16%). Total WR jumps 60.2 -> 74.5,
  // PnL 10579 -> 11610. Gated by two DA keys so they are testable independently.
  // When R5 would reject tt_momentum AND pullbackTrigger is ALSO active on this
  // bar, we fall through to the pullback path rather than reject outright — this
  // is the "favor tt_pullback" policy. If pullbackTrigger is NOT active, we reject.
  if (momentumTrigger) {
    const r5RejectSpeculative = String(
      daCfg.deep_audit_tt_momentum_reject_speculative_grade ?? "true"
    ) === "true";
    const r5RejectCorrectionTransition = String(
      daCfg.deep_audit_tt_momentum_reject_correction_transition ?? "true"
    ) === "true";
    const r5WouldReject = (r5RejectSpeculative && isSpeculativeGrade)
      || (r5RejectCorrectionTransition && correctionTransitionProfile);
    if (r5WouldReject && !pullbackTrigger) {
      const reasonCode = (r5RejectSpeculative && isSpeculativeGrade)
        ? "tt_momentum_r5_speculative_grade_biased"
        : "tt_momentum_r5_correction_transition_biased";
      return rejectEntry(reasonCode, {
        setupGrade,
        rank: rankScore,
        executionProfile: { name: executionProfileName || null },
      });
    }
    if (r5WouldReject && pullbackTrigger) {
      // Fall through to the pullback qualifier below. No return here.
    } else {
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
