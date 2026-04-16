import { normalizeLearnedTickerProfile, resolveTickerProfileContext } from "./profile-resolution.js";
import { resolveRegimeVocabulary } from "./regime-vocabulary.js";

function trimText(value, max = 200) {
  const text = String(value || "").trim();
  return text ? text.slice(0, max) : null;
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sanitizePolicy(policy) {
  if (!policy || typeof policy !== "object") return null;
  return {
    source: trimText(policy.source, 80),
    match: policy.match && typeof policy.match === "object" ? policy.match : null,
    context: policy.context && typeof policy.context === "object" ? policy.context : null,
    recommend: policy.recommend && typeof policy.recommend === "object" ? policy.recommend : null,
    investor: policy.investor && typeof policy.investor === "object" ? policy.investor : null,
  };
}

function sanitizeReferenceExecution(referenceExecution) {
  if (!referenceExecution || typeof referenceExecution !== "object") return null;
  return {
    run_id: trimText(referenceExecution.run_id, 80),
    trade_id: trimText(referenceExecution.trade_id, 120),
    ticker: trimText(referenceExecution.ticker, 20),
    entry_ts: finiteOrNull(referenceExecution.entry_ts),
    entry_path_expected: trimText(referenceExecution.entry_path_expected, 80),
    engine_source_expected: trimText(referenceExecution.engine_source_expected, 80),
    scenario_policy_source_expected: trimText(referenceExecution.scenario_policy_source_expected, 80),
  };
}

function sanitizeExecutionProfile(executionProfile) {
  if (!executionProfile || typeof executionProfile !== "object") return null;
  return {
    active_profile: trimText(executionProfile.active_profile, 80),
    confidence: finiteOrNull(executionProfile.confidence),
    ticker_regime: trimText(executionProfile.ticker_regime, 40),
    market_state: trimText(executionProfile.market_state, 40),
    personality: trimText(executionProfile.personality, 80),
    reasons: Array.isArray(executionProfile.reasons)
      ? executionProfile.reasons.filter(Boolean).map((x) => trimText(x, 120)).slice(0, 6)
      : [],
    adjustments: executionProfile.adjustments && typeof executionProfile.adjustments === "object"
      ? {
          minHTFScoreAdj: finiteOrNull(executionProfile.adjustments.minHTFScoreAdj),
          minRRAdj: finiteOrNull(executionProfile.adjustments.minRRAdj),
          maxCompletionAdj: finiteOrNull(executionProfile.adjustments.maxCompletionAdj),
          positionSizeMultiplierAdj: finiteOrNull(executionProfile.adjustments.positionSizeMultiplierAdj),
          slCushionMultiplierAdj: finiteOrNull(executionProfile.adjustments.slCushionMultiplierAdj),
          requireSqueezeRelease: executionProfile.adjustments.requireSqueezeRelease === true,
          defendWinnerBias: trimText(executionProfile.adjustments.defendWinnerBias, 80),
        }
      : null,
  };
}

function sanitizeCioDecision(decision) {
  if (!decision || typeof decision !== "object") return null;
  return {
    decision: trimText(decision.decision, 30),
    confidence: finiteOrNull(decision.confidence),
    fallback: decision.fallback === true,
    model: trimText(decision.model || decision.model_used, 80),
    latency_ms: finiteOrNull(decision.latency_ms),
    reasoning: trimText(decision.reasoning, 240),
    risk_flags: Array.isArray(decision.risk_flags)
      ? decision.risk_flags.filter(Boolean).map((x) => trimText(x, 80)).slice(0, 6)
      : [],
    adjustments: decision.adjustments && typeof decision.adjustments === "object"
      ? {
          sl: finiteOrNull(decision.adjustments.sl),
          tp: finiteOrNull(decision.adjustments.tp),
          size_mult: finiteOrNull(decision.adjustments.size_mult),
          reason: trimText(decision.adjustments.reason, 160),
        }
      : null,
    override: decision.override && typeof decision.override === "object"
      ? {
          trim_pct: finiteOrNull(decision.override.trim_pct),
          trail_stop_pct: finiteOrNull(decision.override.trail_stop_pct),
          hold_bars: finiteOrNull(decision.override.hold_bars),
        }
      : null,
    applied: decision.applied && typeof decision.applied === "object"
      ? {
          sl: finiteOrNull(decision.applied.sl),
          tp: finiteOrNull(decision.applied.tp),
          size_mult: finiteOrNull(decision.applied.size_mult),
        }
      : null,
  };
}

export function recordAdaptiveLineageFact(tickerData, key, value) {
  if (!tickerData || typeof tickerData !== "object" || !key) return;
  const existing = tickerData.__adaptive_lineage && typeof tickerData.__adaptive_lineage === "object"
    ? tickerData.__adaptive_lineage
    : {};
  existing[key] = value;
  tickerData.__adaptive_lineage = existing;
}

export function buildAdaptiveInfluenceSnapshot(tickerData) {
  if (!tickerData || typeof tickerData !== "object") return null;
  const profileContext = resolveTickerProfileContext(
    tickerData?.ticker || tickerData?.sym || "",
    tickerData?._tickerProfile || tickerData?._ticker_profile || null,
    { learnedSource: tickerData?.__profile_resolution?.learned_profile_source || "runtime" }
  );
  const learnedProfile = normalizeLearnedTickerProfile(
    tickerData?._tickerProfile || tickerData?._ticker_profile || null,
    { ticker: tickerData?.ticker || tickerData?.sym || "", source: tickerData?.__profile_resolution?.learned_profile_source || "runtime" }
  );
  const regimeVocabulary = resolveRegimeVocabulary(tickerData, {
    executionFallback: tickerData?.regime_class || "UNKNOWN",
  });
  const out = {
    engine_selection: {
      selected_engine: trimText(tickerData?.__selected_engine, 40),
      selected_management_engine: trimText(tickerData?.__selected_management_engine, 40),
      engine_source: trimText(tickerData?.__engine_source, 80),
      reference_execution: sanitizeReferenceExecution(tickerData?.__reference_execution),
    },
    scenario_policy: sanitizePolicy(tickerData?.__scenario_policy),
    learning_policy: sanitizePolicy(tickerData?.__learning_policy),
    execution_profile: sanitizeExecutionProfile(tickerData?.execution_profile),
    profile_overlay: {
      static_behavior_profile: profileContext?.staticBehaviorProfile
        ? {
            key: trimText(profileContext.staticBehaviorProfile.profileKey, 40),
            label: trimText(profileContext.staticBehaviorProfile.label, 80),
            min_rank: finiteOrNull(profileContext.staticBehaviorProfile.minRank),
            sl_mult: finiteOrNull(profileContext.staticBehaviorProfile.slMult),
            doa_hours: finiteOrNull(profileContext.staticBehaviorProfile.doaHours),
            max_hold_hours: finiteOrNull(profileContext.staticBehaviorProfile.maxHoldHours),
          }
        : null,
      learned_profile: learnedProfile
        ? {
            source: trimText(profileContext?.lineage?.learned_profile_source, 80),
            behavior_type: trimText(learnedProfile.behaviorType, 80),
            personality: trimText(learnedProfile.learning?.personality, 80),
            entry_threshold_adj: finiteOrNull(learnedProfile.entryThresholdAdj),
            sl_mult: finiteOrNull(learnedProfile.slMult),
            tp_mult: finiteOrNull(learnedProfile.tpMult),
            runtime_policy_present: !!(learnedProfile.learning?.runtime_policy),
          }
        : null,
    },
    regime_overlay: {
      execution_regime_class: trimText(regimeVocabulary.executionRegimeClass, 40),
      execution_regime_score: finiteOrNull(regimeVocabulary.executionRegimeScore),
      swing_regime_snapshot: regimeVocabulary.swingRegimeSnapshot || null,
      market_volatility_regime: trimText(regimeVocabulary.marketVolatilityRegime, 40),
      market_backdrop_class: trimText(regimeVocabulary.marketBackdropClass, 40),
      market_trend_bias: trimText(regimeVocabulary.marketTrendBias, 40),
      regime_params: tickerData?.regime_params
        ? {
            minHTFScore: finiteOrNull(tickerData.regime_params.minHTFScore),
            minRR: finiteOrNull(tickerData.regime_params.minRR),
            maxCompletion: finiteOrNull(tickerData.regime_params.maxCompletion),
            positionSizeMultiplier: finiteOrNull(tickerData.regime_params.positionSizeMultiplier),
            slCushionMultiplier: finiteOrNull(tickerData.regime_params.slCushionMultiplier),
            requireSqueezeRelease: tickerData.regime_params.requireSqueezeRelease === true,
            defendWinnerBias: trimText(tickerData.regime_params.defendWinnerBias, 80),
          }
        : null,
    },
    sizing_overlay: {
      pdz_size_mult: finiteOrNull(tickerData?.__pdz_size_mult),
      ema21_size_mult: finiteOrNull(tickerData?.__ema21_size_mult),
    },
    cio_entry: sanitizeCioDecision(tickerData?.__cio_entry_decision),
    cio_lifecycle: sanitizeCioDecision(tickerData?.__cio_lifecycle_decision),
    runtime_facts: tickerData?.__adaptive_lineage && typeof tickerData.__adaptive_lineage === "object"
      ? tickerData.__adaptive_lineage
      : null,
  };

  const hasValue = Object.values(out).some((value) => {
    if (value == null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.values(value).some((v) => v != null && (!(Array.isArray(v)) || v.length > 0));
    return true;
  });
  return hasValue ? out : null;
}
