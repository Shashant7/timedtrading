// Canonical technical rank formulas. Dependencies are injected once by the worker;
// tests and offline driver audits execute this same implementation.
import { stampTechnicalRank, capRankByFreshness } from "./candidate-rank.js";
import { finiteRankInput, rankCompletion, rankFlag, rankDirection, rsiRankDelta,
  breakoutRankDelta, triggerRankSummary, supertrendRankDirection, rankStateContext,
  rankStrengthRole, normalizeRankWeights, tdSequentialRankContribution } from "./rank-drivers.js";

export const RANK_DRIVER_VERSION = "rank-drivers-v2";

export function createTechnicalRanker({
  sideFromStateOrScores, computeRR, computeDataCompleteness, tfTechAlignmentSummary,
  computeMoveStatus, shouldTraceRankBreakdown = () => false,
  getAdaptiveRankWeights = () => null, sectorMap = {}, logTrace = () => {},
}) {
  const triggerSummaryAndScore = d => triggerRankSummary(d, sideFromStateOrScores(d));
function computeRankV2(d) {
  delete d.__adaptive_v1;
  const ticker = String(d?.ticker || d?.sym || "").toUpperCase();
  const side = sideFromStateOrScores(d);

  const rankTrace = true; // Persist the score-time parts on every entry, independent of diagnostic logging.
  const logRankTrace = shouldTraceRankBreakdown(d);
  const rankTraceParts = [];
  // V2 base starts at 30 (same as V1) so the baseline trend-following bonuses
  // below can lift scores into the 60-90 range for proper setups. The v10b
  // calibration sample was already a PRE-FILTERED set (all trades passed V1),
  // so "everyone has aligned_state" was only true inside that sample.
  // At true scoring time (all 215 tickers across all bars), most tickers
  // have NO state at all. We need to properly reward the basic building blocks
  // that distinguish "this ticker is in a trend" from "nothing is happening".
  let score = 30;

  const addTrace = (label, delta, extra = null) => {
    if (rankTrace) {
      rankTraceParts.push({
        label, delta,
        score_after: score,
        ...(extra && typeof extra === "object" ? extra : {}),
      });
    }
  };
  addTrace("v2_base", 30);

  // ── BASELINE TREND-FOLLOWING SIGNALS (kept from V1) ─────
  // These separate "ticker is in a setup" from "nothing happening".
  // Without these, V2 can't distinguish good tickers from noise.
  const state = String(d.state || "");
  const { aligned, setup } = rankStateContext(state, side);
  if (aligned) {
    score += 12;
    addTrace("v2_aligned_state", 12);
  } else if (setup) {
    score += 6;
    addTrace("v2_setup_state", 6);
  }

  // Opposing HTF strength cannot establish support for this candidate.
  const htf = finiteRankInput(d.htf_score);
  const htfRole = rankStrengthRole(htf, side);
  if (htfRole === "aligned_strength") {
    const htfAbs = Math.abs(htf);
    if (htfAbs >= 25) {
      score += 10;
      addTrace("v2_htf_strong", 10, { htf, role: htfRole });
    } else if (htfAbs >= 15) {
      score += 6;
      addTrace("v2_htf_med", 6, { htf, role: htfRole });
    } else if (htfAbs >= 5) {
      score += 3;
      addTrace("v2_htf_weak", 3, { htf, role: htfRole });
    }
  }

  if (htfRole !== "aligned_strength") addTrace("v2_htf_strength", 0, { htf, role: htfRole });

  // Retain intentional pullback-depth weighting only for a compatible setup.
  const ltf = finiteRankInput(d.ltf_score);
  const ltfRole = rankStrengthRole(ltf, side, setup);
  if (ltfRole === "aligned_strength" || ltfRole === "pullback_depth") {
    const ltfAbs = Math.abs(ltf);
    if (ltfAbs >= 20) {
      score += 8;
      addTrace("v2_ltf_strong", 8, { ltf, role: ltfRole });
    } else if (ltfAbs >= 10) {
      score += 5;
      addTrace("v2_ltf_med", 5, { ltf, role: ltfRole });
    }
  }

  if (ltfRole === "opposed_strength" || ltfRole === "unknown_or_neutral") addTrace("v2_ltf_strength", 0, { ltf, role: ltfRole });
  if (!aligned && !setup && state) addTrace("v2_state_context", 0, { state, side, reason: "state_does_not_describe_candidate" });

  // Data completeness penalty — essential (bad data → bad signals)
  const completeness = d?.data_completeness || computeDataCompleteness(d);
  if (completeness && typeof completeness === "object") {
    if (completeness.score < 70) {
      score -= 10;
      addTrace("v2_data_incomplete", -10, { completenessScore: completeness.score });
    } else if (completeness.score < 85) {
      score -= 5;
      addTrace("v2_data_incomplete", -5, { completenessScore: completeness.score });
    }
  }

  // Move status
  const ms = d?.move_status || computeMoveStatus(d);
  if (ms && typeof ms === "object") {
    if (ms.status === "INVALIDATED") {
      score -= 25;
      addTrace("v2_move_invalidated", -25);
    } else if (ms.status === "COMPLETED") {
      score -= 15;
      addTrace("v2_move_completed", -15);
    }
  }

  // Historical calibration hypotheses; selected/post-entry samples do not prove incremental lift.

  // Grade is assigned after rank and can survive from an earlier snapshot.
  // Do not let the outcome of qualification feed back into its input score.
  const setupGrade = String(d?.setup_grade || d?.__setup_grade || "").toLowerCase();
  if (setupGrade) addTrace("v2_setup_grade", 0, { setupGrade, reason: "not_proven_available_before_rank" });

  // RSI bull/bear divergence aligned with direction
  const rsiDiv = d?.rsi_divergence || d?.rsi?.divergence || null;
  if (rsiDiv && typeof rsiDiv === "object") {
    // Support two shapes: single-TF ({type, strength}) OR multi-TF ({M:{bull,bear}, ...})
    let bullActive = false, bearActive = false;
    if (rsiDiv.type) {
      if (rsiDiv.type === "bullish" && (rsiDiv.active == null || rankFlag(rsiDiv.active))) bullActive = true;
      if (rsiDiv.type === "bearish" && (rsiDiv.active == null || rankFlag(rsiDiv.active))) bearActive = true;
    } else {
      for (const tf of Object.keys(rsiDiv)) {
        const v = rsiDiv[tf];
        if (v && typeof v === "object") {
          if (v.bull && rankFlag(v.bull.active)) bullActive = true;
          if (v.bear && rankFlag(v.bear.active)) bearActive = true;
        }
      }
    }
    if (side === "LONG" && bullActive && !bearActive) {
      score += 8;
      addTrace("v2_rsi_bull_div", 8);
    } else if (side === "SHORT" && bearActive && !bullActive) {
      score += 5; // smaller boost (bear div only +2.1% lift vs bull's +9.5%)
      addTrace("v2_rsi_bear_div", 5);
    }
  }

  // regime_class=TRENDING: +6, TRANSITIONAL: -4, CHOPPY: -8
  // Softer penalties than the initial calibration suggested — TRANSITIONAL
  // is common during live scoring (many bars during the trading day land here
  // even on ultimately-successful trades), so we only apply a mild penalty.
  // The -10 from the v10b calibration reflected a POST-ENTRY snapshot which
  // isn't quite the same thing as the live scoring moment.
  const regimeClass = String(
    d?.execution_profile_json?.regime_class
    || d?.regime?.class
    || d?.regime_class
    || ""
  ).toUpperCase();
  if (regimeClass === "TRENDING") {
    score += 6;
    addTrace("v2_trending_regime", 6);
  } else if (regimeClass === "TRANSITIONAL") {
    score -= 4;
    addTrace("v2_transitional_regime", -4);
  } else if (regimeClass === "CHOPPY") {
    score -= 8;
    addTrace("v2_choppy_regime", -8);
  }

  // The former +4 rationale used SuperTrend's sign backwards. With the
  // producer's Pine convention, historical alignment underperformed.
  // Retire the bonus; keep its corrected direction visible for future audits.
  const st30 = supertrendRankDirection(d, "30");
  if (st30) {
    addTrace("v2_st30_aligned", 0, { st30, aligned: st30 === side,
      reason: "prior_calibration_used_reversed_sign" });
  }

  // RR contribution — graduated based on v7 empirical data (229 trades):
  //   rr >= 7:   77.8% WR  -> +12 (strong edge signal)
  //   rr >= 5:   ~65% WR   -> +8
  //   rr >= 3:   57.0% WR  -> +5
  //   rr >= 2:   47.1% WR  -> +0 (neutral — slight underperform of base)
  //   rr >= 1.5: 60.0% WR  -> +0 (tiny sample, hold neutral)
  //   rr <  1.5:  0% WR    -> -10 (clear danger)
  const rr = d.rr != null ? finiteRankInput(d.rr) : finiteRankInput(computeRR(d));
  if (Number.isFinite(rr)) {
    let rrDelta = 0;
    if (rr >= 7) rrDelta = 12;
    else if (rr >= 5) rrDelta = 8;
    else if (rr >= 3) rrDelta = 5;
    else if (rr >= 1.5) rrDelta = 0;
    else rrDelta = -10;
    score += rrDelta;
    addTrace("v2_rr", rrDelta, { rr });
  }

  // ── NEGATIVE signals ────────────────────────────────
  // ATR displacement "already moved in our direction" = mean-reversion risk
  // Calibration (v10b 101 closed): ATR_week aligned displacement = 16.7% WR,
  // ATR_day aligned = 30.8% WR. Signals a late-stage move likely to fade.
  const atrDisp = d?.atr_disp || {};
  const atrDay = atrDisp?.day || {};
  const atrWeek = atrDisp?.week || {};
  const signDir = side === "LONG" ? 1 : side === "SHORT" ? -1 : 0;
  const atrWeekAlignedD = Number(atrWeek?.d ?? 0) * signDir;
  const atrDayAlignedD = Number(atrDay?.d ?? 0) * signDir;
  if (atrWeekAlignedD >= 0.3) {
    score -= 20;
    addTrace("v2_atr_week_extended", -20, { atrD: atrWeek?.d });
  } else if (atrDayAlignedD >= 0.3) {
    score -= 10;
    addTrace("v2_atr_day_extended", -10, { atrD: atrDay?.d });
  }

  // Phase 1H / D over-extended
  const satyPhase = d?.saty_phase || {};
  const phase1H = finiteRankInput(satyPhase?.["1H"]?.v);
  const phaseD = finiteRankInput(satyPhase?.D?.v);
  if (Number.isFinite(phase1H) && phase1H * signDir > 70) {
    score -= 8;
    addTrace("v2_phase_1H_high", -8, { phase1H });
  }
  if (Number.isFinite(phaseD) && phaseD * signDir > 70) {
    score -= 8;
    addTrace("v2_phase_D_high", -8, { phaseD });
  }

  // Phase zone HIGH on 1H
  const phase1HZ = String(satyPhase?.["1H"]?.z || "").toUpperCase();
  if (phase1HZ === "HIGH" && Number.isFinite(phase1H) && phase1H * signDir > 0 && phase1H * signDir <= 70) {
    score -= 6;
    addTrace("v2_phase_1H_zone_HIGH", -6);
  }

  // LTF over-alignment (paradoxical — v10b showed aligned LTF_30m underperformed)
  // Use 30m bias from tf_summary if present
  const tf30Bias = Number(
    d?.signal_snapshot_json?.tf?.["30m"]?.bias
    || d?.tf?.m30?.bias
    || d?.tf_tech?.m30?.bias
    || 0
  );
  if (Number.isFinite(tf30Bias)) {
    const sign = signDir;
    if (tf30Bias * sign > 0.5) {
      score -= 4;
      addTrace("v2_ltf_overaligned", -4, { tf30Bias });
    }
  }

  // SHORT penalty when SPY is not clearly in downtrend
  if (side === "SHORT") {
    const spyDaily = d?._env?._marketRegime?.spy_daily_structure || d?._spyData?.daily_structure || {};
    const knownSpy = typeof spyDaily.close_below_e21 === "boolean" &&
      finiteRankInput(spyDaily.e21_slope_5bar_pct) !== null && finiteRankInput(spyDaily.ema_regime_daily) !== null;
    const spyBelowE21 = spyDaily?.close_below_e21 === true;
    const spyE21SlopeNeg = Number(spyDaily?.e21_slope_5bar_pct ?? 0) < 0;
    const spyBearRegime = Number(spyDaily?.ema_regime_daily ?? 0) <= -1;
    const bearSignals = [spyBelowE21, spyE21SlopeNeg, spyBearRegime].filter(Boolean).length;
    if (knownSpy && bearSignals < 2) {
      score -= 8;
      addTrace("v2_short_no_spy_downtrend", -8, { bearSignals });
    }
  }

  const rawScore = score;
  const finalScore = stampTechnicalRank(d, rawScore, "v2");

  if (rankTrace && d && typeof d === "object") {
    d.__rank_trace = {
      ticker, ts: Number(d?.ts ?? d?.ingest_ts ?? 0),
      formula: "v2", driver_version: RANK_DRIVER_VERSION,
      finalScore,
      rawScore,
      rr, side,
      setupGrade,
      regimeClass,
      phase1H, phaseD, phase1HZ,
      st30, tf30Bias,
      parts: rankTraceParts,
    };
    if (logRankTrace) try {
      logTrace(`[V2-TRACE] ${ticker} ts=${Number(d?.ts ?? d?.ingest_ts ?? 0)} final=${finalScore} parts=${JSON.stringify(rankTraceParts)}`);
    } catch {}
  }

  return finalScore;
}

// ── Freshness Doctrine (2026-06-11) — quarantined payloads never rank. ──
// A payload whose Data Age Contract says live-STALE (see worker/freshness.js)
// is capped to a floor so it can never surface in Today/Prime/FocusRail or
// pass rank-gated entry paths, regardless of what its (stale) indicators say.
// Replay blocks are diagnostic-only (enforced: false) and never capped.
function _applyFreshnessRankCap(d, rank) {
  return capRankByFreshness(d, rank);
}

function computeRank(d) {
  delete d.__adaptive_v1; // Clear prior attribution before a disabled or unavailable multiplier.
  // PHASE-I 2026-04-22: route to v2 when configured via DA key.
  // Default remains v1 so we don't break existing pinned-config backtests.
  const daCfg = d?._env?._deepAuditConfig || null;
  const formula = String(daCfg?.deep_audit_rank_formula || "v1").toLowerCase();
  if (formula === "v2") return _applyFreshnessRankCap(d, computeRankV2(d));

  const aw = normalizeRankWeights(getAdaptiveRankWeights());
  const htf = finiteRankInput(d.htf_score);
  const ltf = finiteRankInput(d.ltf_score);
  const side = sideFromStateOrScores(d);
  const comp = rankCompletion(d);
  const rawPhase = finiteRankInput(d.phase_pct);
  const phase = rawPhase !== null && rawPhase >= 0 && rawPhase <= 1 ? rawPhase : null;
  const rr = d.rr != null ? finiteRankInput(d.rr) : finiteRankInput(computeRR(d));
  const executionProfileName = String(
    d?.execution_profile?.active_profile
    || d?.execution_profile_name
    || d?.executionProfileName
    || d?.execution_profile?.name
    || ""
  ).trim().toLowerCase();
  const regimeCombined = String(
    d?.regime?.combined
    || d?.regime_combined
    || ""
  ).trim().toUpperCase();
  const weakLateBull = regimeCombined === "LATE_BULL";
  const weakEarlyBear = regimeCombined === "EARLY_BEAR";
  const choppySelective = executionProfileName === "choppy_selective";
  const weakChoppySelective = choppySelective && regimeCombined !== "STRONG_BULL";
  const weakRankContext = weakChoppySelective || weakLateBull || weakEarlyBear;
  const rankTrace = true; // Persist the score-time parts on every entry, independent of diagnostic logging.
  const logRankTrace = shouldTraceRankBreakdown(d);
  const rankTraceParts = [];
  const addRankTrace = (label, delta, extra = null) => {
    if (!rankTrace) return;
    rankTraceParts.push({
      label,
      delta: Number.isFinite(Number(delta)) ? Number(delta) : delta,
      score_after: Number.isFinite(score) ? Number(score) : score,
      ...(extra && typeof extra === "object" ? extra : {}),
    });
  };

  const flags = d.flags || {};
  const sqRel = rankFlag(flags.sq30_release);
  const sqOn = rankFlag(flags.sq30_on);
  const phaseZoneChange = rankFlag(flags.phase_zone_change);
  const momentumElite = rankFlag(flags.momentum_elite);

  const state = String(d.state || "");
  const { aligned, setup } = rankStateContext(state, side);

  let score = 30;
  addRankTrace("base", 30);

  // Data completeness: slightly down-rank incomplete payloads so “Today/Prime” stays sane.
  const completeness = d?.data_completeness || computeDataCompleteness(d);
  if (completeness && typeof completeness === "object") {
    if (completeness.score < 70) {
      score -= 10;
      addRankTrace("data_completeness", -10, { completenessScore: completeness.score });
    } else if (completeness.score < 85) {
      score -= 5;
      addRankTrace("data_completeness", -5, { completenessScore: completeness.score });
    } else if (completeness.score < 95) {
      score -= 2;
      addRankTrace("data_completeness", -2, { completenessScore: completeness.score });
    } else {
      addRankTrace("data_completeness", 0, { completenessScore: completeness.score });
    }
  }

  // Per-TF technical structure alignment (bonus/penalty).
  const tfAlign = tfTechAlignmentSummary(d);
  d.tf_summary = tfAlign;
  if (
    tfAlign &&
    typeof tfAlign === "object" &&
    Number.isFinite(tfAlign.score)
  ) {
    score += tfAlign.score;
    addRankTrace("tf_summary", tfAlign.score, { tfSummaryScore: tfAlign.score });
  }

  // Explicit triggers[] “why now” boost.
  const trig = triggerSummaryAndScore(d);
  d.trigger_summary = trig;
  if (trig && typeof trig === "object" && Number.isFinite(trig.score)) {
    score += trig.score;
    addRankTrace("trigger_summary", trig.score, { triggerSummaryScore: trig.score, triggerParts: trig.parts, capDelta: trig.cap_delta });
  }

  // Move status: invalidate/completed moves should fall out of “best setups”
  const ms = d?.move_status || computeMoveStatus(d);
  if (ms && typeof ms === "object") {
    if (ms.status === "INVALIDATED") {
      score -= 25;
      addRankTrace("move_status", -25, { moveStatus: ms.status });
    } else if (ms.status === "COMPLETED") {
      score -= 15;
      addRankTrace("move_status", -15, { moveStatus: ms.status });
    } else {
      addRankTrace("move_status", 0, { moveStatus: ms.status });
    }
  }

  // State bonuses (reduced)
  if (aligned) {
    score += 12; // Reduced from 15
    addRankTrace("aligned_state", 12);
  }
  if (setup) {
    score += 4; // Reduced from 5
    addRankTrace("setup_state", 4);
  }

  // HTF/LTF contributions — thresholds adaptive
  const htfStrong = aw?.htf_strong_threshold ?? 25;
  const htfRole = rankStrengthRole(htf, side);
  if (htfRole === "aligned_strength") {
    const htfAbs = Math.abs(htf);
    if (htfAbs >= htfStrong) {
      const delta = Math.min(10, htfAbs * 0.4);
      score += delta;
      addRankTrace("htf_strength", delta, { htf, role: htfRole });
    } else if (htfAbs >= 15) {
      const delta = Math.min(7, htfAbs * 0.35);
      score += delta;
      addRankTrace("htf_strength", delta, { htf, role: htfRole });
    } else {
      const delta = Math.min(4, htfAbs * 0.25);
      score += delta;
      addRankTrace("htf_strength", delta, { htf, role: htfRole });
    }
  }

  if (htfRole !== "aligned_strength") addRankTrace("htf_strength", 0, { htf, role: htfRole });

  const ltfStrong = aw?.ltf_strong_threshold ?? 20;
  const ltfRole = rankStrengthRole(ltf, side, setup);
  if (ltfRole === "aligned_strength" || ltfRole === "pullback_depth") {
    const ltfAbs = Math.abs(ltf);
    if (ltfAbs >= ltfStrong) {
      const delta = Math.min(10, ltfAbs * 0.3);
      score += delta;
      addRankTrace("ltf_strength", delta, { ltf, role: ltfRole });
    } else if (ltfAbs >= 12) {
      const delta = Math.min(6, ltfAbs * 0.25);
      score += delta;
      addRankTrace("ltf_strength", delta, { ltf, role: ltfRole });
    } else {
      const delta = Math.min(3, ltfAbs * 0.2);
      score += delta;
      addRankTrace("ltf_strength", delta, { ltf, role: ltfRole });
    }
  }

  if (ltfRole === "opposed_strength" || ltfRole === "unknown_or_neutral") addRankTrace("ltf_strength", 0, { ltf, role: ltfRole });
  if (!aligned && !setup && state) addRankTrace("state_context", 0, { state, side, reason: "state_does_not_describe_candidate" });

  // Completion bonus — adaptive when available
  if (Number.isFinite(comp)) {
    const earlyBonus = aw?.completion_early_bonus ?? 15;
    const midBonus = aw?.completion_mid_bonus ?? 10;
    if (comp <= 0.2) {
      const delta = weakRankContext ? Math.min(9, earlyBonus) : earlyBonus;
      score += delta;
      addRankTrace("completion_bonus", delta, { completion: comp });
    } else if (comp <= 0.4) {
      const delta = weakRankContext ? Math.min(6, midBonus) : midBonus;
      score += delta;
      addRankTrace("completion_bonus", delta, { completion: comp });
    } else if (comp <= 0.6) {
      score += 5;
      addRankTrace("completion_bonus", 5, { completion: comp });
    }
  }

  // Phase penalty — adaptive threshold
  if (Number.isFinite(phase)) {
    const penaltyStart = aw?.phase_penalty_start ?? 0.5;
    const penaltyMult = aw?.phase_penalty_mult ?? 30;
    if (phase > penaltyStart) {
      const delta = Math.max(0, (phase - penaltyStart) * penaltyMult);
      score -= delta;
      addRankTrace("phase_penalty", -delta, { phase });
    }
    if (phase <= 0.3) {
      score += 3;
      addRankTrace("phase_early_bonus", 3, { phase });
    }
  }

  // Release is counted once in trigger_summary. Compression is a separate,
  // non-directional readiness hypothesis; retain its existing weight for audit.
  const hasSqRelease = sqRel || trig.parts.some(p => p.event === "squeeze_release_30");
  if (hasSqRelease) addRankTrace("squeeze_release", 0, { reason: "counted_in_trigger_summary" });
  if (sqOn && !hasSqRelease) {
    const delta = aw?.squeeze_setup_bonus ?? 5;
    score += delta;
    addRankTrace("squeeze_on", delta);
  }

  if (phaseZoneChange) {
    addRankTrace("phase_zone_change", 0, { reason: "extreme_zone_is_not_favorable_transition" });
  }

  if (Number.isFinite(rr)) {
    if (weakRankContext) {
      if (rr >= 2.0) {
        score += 4;
        addRankTrace("rr_bonus", 4, { rr, weakRankContext });
      } else if (rr >= 1.5) {
        score += 3;
        addRankTrace("rr_bonus", 3, { rr, weakRankContext });
      } else if (rr >= 1.2) {
        score += 2;
        addRankTrace("rr_bonus", 2, { rr, weakRankContext });
      }
    } else {
      if (rr >= 2.0) {
        score += 10;
        addRankTrace("rr_bonus", 10, { rr, weakRankContext });
      } else if (rr >= 1.5) {
        score += 7;
        addRankTrace("rr_bonus", 7, { rr, weakRankContext });
      } else if (rr >= 1.2) {
        score += 4;
        addRankTrace("rr_bonus", 4, { rr, weakRankContext });
      }
    }
  }

  if (momentumElite) {
    const eliteBonus = aw?.momentum_elite_bonus ?? 15;
    const direction = rankDirection(flags.momentum_elite_dir);
    const delta = side && direction === side ? (weakRankContext ? Math.min(6, eliteBonus) : eliteBonus) : 0;
    score += delta;
    addRankTrace("momentum_elite", delta, { weakRankContext, direction, side,
      reason: !direction ? "missing_direction" : direction === side ? "aligned" : "opposed" });
  }

  // EMA cross and buyable dip are already scored by the named/flag event
  // resolver. The former direct +5/+7 (including adaptive ema_cross_bonus)
  // duplicated the same observation and could overwhelm an opposing trigger.

  // Sep-Dec forensic audit showed elite-rank inflation clustered in
  // `choppy_selective`, `LATE_BULL`, and `EARLY_BEAR`, especially on
  // momentum/pullback names that never achieved early excursion.
  if (weakChoppySelective) {
    score -= 8;
    addRankTrace("weak_choppy_selective", -8, { regimeCombined, executionProfileName });
  }
  if (weakLateBull) {
    score -= 8;
    addRankTrace("weak_late_bull", -8, { regimeCombined });
  }
  if (weakEarlyBear) {
    score -= 10;
    addRankTrace("weak_early_bear", -10, { regimeCombined });
  }

  // HTF/LTF divergence penalty — DATA-DRIVEN (Phase 1 analysis: htf_ltf_diverging
  // has -28.2% lift toward DOWN moves, the #3 predictive bearish feature).
  // When HTF and LTF disagree on direction, setups are unreliable.
  const htfBull = htf > 5;
  const htfBear = htf < -5;
  const ltfBull = ltf > 5;
  const ltfBear = ltf < -5;
  if ((htfBull && ltfBear) || (htfBear && ltfBull)) {
    score -= 5; // HTF/LTF divergence: setup reliability drops significantly
    addRankTrace("htf_ltf_divergence", -5, { htf, ltf });
  }

  // Historical UP percentages do not establish a side-conditioned sector edge.
  // Keep provenance visible while neutralizing the unvalidated fixed prior.
  const ticker = String(d?.ticker || "").toUpperCase();
  const sector = sectorMap[ticker] || "";
  if (sector) addRankTrace("sector_bias", 0, { sector, reason: "unvalidated_fixed_prior" });

  const divergence = d?.rsi?.divergence;
  if (divergence) {
    const delta = rsiRankDelta(divergence, side);
    score += delta;
    addRankTrace("rsi_divergence", delta, { divType: divergence.type,
      divStrength: finiteRankInput(divergence.strength), side, active: divergence.active ?? null });
  }

  // TD boost was produced for HTF bias, which can oppose a forming candidate.
  // Recompute the same D/W/M recipe for the current side from component evidence.
  if (d.td_sequential) {
    const tdContribution = tdSequentialRankContribution(d.td_sequential, side);
    score += tdContribution.delta;
    addRankTrace("td_sequential", tdContribution.delta, { ...tdContribution, side });
  }

  // Breakout detection rank boost: lift tickers showing breakout signals
  // from their typical low rank (avg 5.8) into the 20-30 range so entry
  // paths can consider them before traditional triggers fire.
  const bo = d?.breakout;
  if (bo && bo.type) {
    const delta = breakoutRankDelta(bo, side);
    score += delta;
    addRankTrace("breakout", delta, { breakoutType: bo.type, direction: bo.dir ?? null, side,
      reason: delta > 0 ? "aligned_known_type" : "unknown_or_opposed" });
  }

  // ── Opening Range Breakout (ORB) rank adjustment ──
  // Confirmed ORB breakouts with multi-window consensus get a boost.
  // Failed breakouts (reclaims) get a penalty to avoid fakeouts.
  const orb = d?.orb;
  if (orb && orb.primary?.resolved) {
    const p = orb.primary;
    const side = sideFromStateOrScores(d);

    if (p.breakout === "LONG" && side === "LONG" && orb.orbBias >= 1) {
      const delta = 10 + (orb.longBreakouts >= 3 ? 5 : 0);
      score += delta;
      addRankTrace("orb_breakout", delta, { orbBias: orb.orbBias, side });
    } else if (p.breakout === "SHORT" && side === "SHORT" && orb.orbBias <= -1) {
      const delta = 10 + (orb.shortBreakouts >= 3 ? 5 : 0);
      score += delta;
      addRankTrace("orb_breakout", delta, { orbBias: orb.orbBias, side });
    } else if (p.reclaim) {
      score -= 5; // Fakeout: broke out then came back — penalize
      addRankTrace("orb_reclaim", -5, { side });
    }

    // Day bias alignment: today's ORM vs yesterday's ORM confirms trend
    if (p.dayBias === 1 && side === "LONG") {
      score += 3;
      addRankTrace("orb_day_bias", 3, { dayBias: p.dayBias, side });
    } else if (p.dayBias === -1 && side === "SHORT") {
      score += 3;
      addRankTrace("orb_day_bias", 3, { dayBias: p.dayBias, side });
    } else if (side && [1, -1].includes(p.dayBias) && p.dayBias !== (side === "LONG" ? 1 : -1)) {
      score -= 2;
      addRankTrace("orb_day_bias", -2, { dayBias: p.dayBias, side });
    }
  }

  // 2026-05-26 — Adaptive Scoring Layer 1: regime weight multiplier
  // (docs/2026-05-26-adaptive-scoring-spec.md). Default-off via
  // `model_config.gates.adaptive_scoring_v1`. When enabled AND the HMM
  // has decoded the latent regime with confidence >= 0.6:
  //
  //   - state agrees with the trade direction → small boost (×1.05)
  //   - state opposes the trade direction     → small penalty (×0.93)
  //   - CHOP regime                            → small dampener (×0.96)
  //
  // Multiplier bounded so the absolute swing is small (max ~7%); the
  // gate exists so an operator can turn it off in one config update if
  // anything regresses. Trace stamp lets admission_cohort_log see what
  // happened and why.
  let _adaptiveV1Applied = null;
  try {
    const _adaptGates = (d?._env?._deepAuditConfig?.gates && typeof d._env._deepAuditConfig.gates === "object")
      ? d._env._deepAuditConfig.gates : {};
    if (_adaptGates.adaptive_scoring_v1 === true) {
      const _lr = d?.latent_regime;
      const _lrState = String(_lr?.state || "").toUpperCase();
      // The producer uses the Viterbi path for state and a separate marginal
      // posterior map. Confidence in another state cannot qualify this one.
      const _lrPost = finiteRankInput(_lr?.posterior?.[_lrState]) ?? 0;
      if (_lrPost >= 0.6 && _lrPost <= 1 && _lrState && side) {
        const _isAlignedBull = side === "LONG";
        const _isAlignedBear = side === "SHORT";
        let mult = 1.0;
        let reason = "neutral";
        if (_lrState === "BULL_TREND" && _isAlignedBull) { mult = 1.05; reason = "bull_aligned"; }
        else if (_lrState === "BEAR_TREND" && _isAlignedBear) { mult = 1.05; reason = "bear_aligned"; }
        else if (_lrState === "BULL_TREND" && _isAlignedBear) { mult = 0.93; reason = "bear_vs_bull_macro"; }
        else if (_lrState === "BEAR_TREND" && _isAlignedBull) { mult = 0.93; reason = "bull_vs_bear_macro"; }
        else if (_lrState === "CHOP") { mult = 0.96; reason = "chop_dampener"; }
        if (mult !== 1.0) {
          const before = score;
          score = score * mult;
          _adaptiveV1Applied = {
            latent_state: _lrState,
            posterior: Number(_lrPost.toFixed(3)),
            ticker_state: state,
            candidate_side: side,
            multiplier: mult,
            reason,
            score_before: Number(before.toFixed(2)),
            score_after: Number(score.toFixed(2)),
            delta: score - before,
          };
          addRankTrace("adaptive_v1", _adaptiveV1Applied.delta, _adaptiveV1Applied);
        }
      }
    }
  } catch (_) { /* never throw from a scoring multiplier */ }
  // Stamp on tickerData so admission_cohort_log can read it
  if (d && typeof d === "object" && _adaptiveV1Applied) d.__adaptive_v1 = _adaptiveV1Applied;

  const rawScore = score;
  const finalScore = stampTechnicalRank(d, rawScore, "v1");
  if (rankTrace && d && typeof d === "object") {
    d.__rank_trace = {
      ticker: String(d?.ticker || d?.sym || "").toUpperCase(),
      ts: Number(d?.ts ?? d?.ingest_ts ?? 0),
      state, side, formula: "v1", driver_version: RANK_DRIVER_VERSION,
      finalScore,
      rawScore,
      adaptive_v1: _adaptiveV1Applied,
      adaptive_weights: aw,
      htf,
      ltf,
      completion: comp,
      phase,
      rr,
      moveStatus: ms?.status || null,
      triggerSummaryScore: trig?.score ?? null,
      tfSummaryScore: tfAlign?.score ?? null,
      completenessScore: completeness?.score ?? null,
      regimeCombined,
      executionProfileName,
      parts: rankTraceParts,
    };
  }
  if (logRankTrace) {
    try {
      logTrace(`[RANK-TRACE] ${JSON.stringify({
        ticker: String(d?.ticker || d?.sym || "").toUpperCase(),
        ts: Number(d?.ts ?? d?.ingest_ts ?? 0),
        state,
        finalScore,
        rawScore,
        htf,
        ltf,
        completion: comp,
        phase,
        rr,
        moveStatus: ms?.status || null,
        triggerSummaryScore: trig?.score ?? null,
        tfSummaryScore: tfAlign?.score ?? null,
        completenessScore: completeness?.score ?? null,
        regimeCombined,
        executionProfileName,
        parts: rankTraceParts,
      })}`);
    } catch (err) {
      logTrace(`[RANK-TRACE] serialization_failed ${err?.message || String(err)}`);
    }
  }
  return finalScore;
}


  return { computeRank, computeRankV2 };
}
