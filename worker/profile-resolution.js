const STATIC_BEHAVIOR_PROFILES = {
  trend_rider: { slMult: 1.5, doaHours: 8, maxHoldHours: 504, minRank: 65, label: "Trend-Rider" },
  high_vol: { slMult: 2.0, doaHours: 3, maxHoldHours: 168, minRank: 75, label: "High-Vol Quick-Fail" },
  churner: { slMult: 1.2, doaHours: 4, maxHoldHours: 336, minRank: 80, label: "High-Freq Churner" },
  catastrophic: { slMult: 1.0, doaHours: 4, maxHoldHours: 168, minRank: 80, maxLossUsd: 500, label: "Catastrophic Hold" },
  default: { slMult: 1.2, doaHours: 6, maxHoldHours: 504, minRank: 70, label: "Default" },
};

const STATIC_BEHAVIOR_PROFILE_MAP = {
  AVGO: "trend_rider", PH: "trend_rider", KTOS: "trend_rider", MLI: "trend_rider",
  HII: "trend_rider", TJX: "trend_rider", MNST: "trend_rider", CSX: "trend_rider",
  FN: "trend_rider", JCI: "trend_rider", STRL: "trend_rider", DY: "trend_rider",

  CLS: "high_vol", BE: "high_vol", IESC: "high_vol", LITE: "high_vol",
  IONQ: "high_vol", PLTR: "high_vol", RKLB: "high_vol", RDDT: "high_vol", TSLA: "high_vol",

  CAT: "churner", FIX: "churner", BABA: "churner", WMT: "churner", H: "churner",
  GE: "churner", PWR: "churner", DCI: "churner", WTS: "churner",

  META: "catastrophic", LRN: "catastrophic", APP: "catastrophic", CCJ: "catastrophic",
  CDNS: "catastrophic", TT: "catastrophic", MDB: "catastrophic", ORCL: "catastrophic",
  ON: "catastrophic", SGI: "catastrophic",
};

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseLearning(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function parseMaybeObject(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveStaticBehaviorProfile(sym) {
  const ticker = String(sym || "").toUpperCase();
  const profileKey = STATIC_BEHAVIOR_PROFILE_MAP[ticker] || "default";
  const base = STATIC_BEHAVIOR_PROFILES[profileKey] || STATIC_BEHAVIOR_PROFILES.default;
  return {
    profileKey,
    label: base.label,
    slMult: base.slMult,
    tpMult: 1.0,
    doaHours: base.doaHours,
    maxHoldHours: base.maxHoldHours,
    minRank: base.minRank,
    maxLossUsd: base.maxLossUsd ?? null,
    sl_mult: base.slMult,
    tp_mult: 1.0,
    doa_hours: base.doaHours,
    max_hold_hours: base.maxHoldHours,
    min_rank: base.minRank,
    max_loss_usd: base.maxLossUsd ?? null,
  };
}

export function normalizeLearnedTickerProfile(rawProfile, options = {}) {
  if (!rawProfile || typeof rawProfile !== "object") return null;
  const ticker = String(options.ticker || rawProfile.ticker || "").toUpperCase() || null;
  const learning = rawProfile.learning || parseLearning(rawProfile.learning_json);
  const normalized = {
    ticker,
    sector: rawProfile.sector || null,
    behaviorType: rawProfile.behaviorType || rawProfile.behavior_type || null,
    atrPctP50: num(rawProfile.atrPctP50 ?? rawProfile.atr_pct_p50, null),
    atrPctP90: num(rawProfile.atrPctP90 ?? rawProfile.atr_pct_p90, null),
    dailyRangePct: num(rawProfile.dailyRangePct ?? rawProfile.daily_range_pct, null),
    gapFrequency: num(rawProfile.gapFrequency ?? rawProfile.gap_frequency, null),
    trendPersistence: num(rawProfile.trendPersistence ?? rawProfile.trend_persistence, null),
    meanReversionSpeed: num(rawProfile.meanReversionSpeed ?? rawProfile.mean_reversion_speed, null),
    avgMoveAtr: num(rawProfile.avgMoveAtr ?? rawProfile.avg_move_atr, null),
    avgMoveDurationBars: num(rawProfile.avgMoveDurationBars ?? rawProfile.avg_move_duration_bars, null),
    avgMoveDurationDays: num(rawProfile.avgMoveDurationDays ?? rawProfile.avg_move_duration_days, null),
    moveCount2yr: num(rawProfile.moveCount2yr ?? rawProfile.move_count_2yr, null),
    ichimokuResponsiveness: num(rawProfile.ichimokuResponsiveness ?? rawProfile.ichimoku_responsiveness, null),
    supertrendFlipAccuracy: num(rawProfile.supertrendFlipAccuracy ?? rawProfile.supertrend_flip_accuracy, null),
    emaCrossAccuracy: num(rawProfile.emaCrossAccuracy ?? rawProfile.ema_cross_accuracy, null),
    tfWeights: rawProfile.tfWeights || parseMaybeObject(rawProfile.tf_weights_json) || null,
    signalWeights: rawProfile.signalWeights || parseMaybeObject(rawProfile.signal_weights_json) || null,
    bestTimeframes: rawProfile.bestTimeframes || parseMaybeObject(rawProfile.best_timeframes_json) || null,
    slMult: num(rawProfile.slMult ?? rawProfile.sl_mult, 1.0) ?? 1.0,
    tpMult: num(rawProfile.tpMult ?? rawProfile.tp_mult, 1.0) ?? 1.0,
    entryThresholdAdj: num(rawProfile.entryThresholdAdj ?? rawProfile.entry_threshold_adj, 0) ?? 0,
    calibratedAt: rawProfile.calibratedAt || rawProfile.calibrated_at || null,
    calibrationVersion: rawProfile.calibrationVersion || rawProfile.calibration_version || null,
    learning: learning || null,
    learning_json: rawProfile.learning_json || (learning ? learning : null),
    source: options.source || rawProfile.source || rawProfile.__source || null,
  };

  normalized.behavior_type = normalized.behaviorType;
  normalized.atr_pct_p50 = normalized.atrPctP50;
  normalized.atr_pct_p90 = normalized.atrPctP90;
  normalized.daily_range_pct = normalized.dailyRangePct;
  normalized.gap_frequency = normalized.gapFrequency;
  normalized.trend_persistence = normalized.trendPersistence;
  normalized.mean_reversion_speed = normalized.meanReversionSpeed;
  normalized.avg_move_atr = normalized.avgMoveAtr;
  normalized.avg_move_duration_bars = normalized.avgMoveDurationBars;
  normalized.avg_move_duration_days = normalized.avgMoveDurationDays;
  normalized.move_count_2yr = normalized.moveCount2yr;
  normalized.ichimoku_responsiveness = normalized.ichimokuResponsiveness;
  normalized.supertrend_flip_accuracy = normalized.supertrendFlipAccuracy;
  normalized.ema_cross_accuracy = normalized.emaCrossAccuracy;
  normalized.sl_mult = normalized.slMult;
  normalized.tp_mult = normalized.tpMult;
  normalized.entry_threshold_adj = normalized.entryThresholdAdj;
  normalized.calibrated_at = normalized.calibratedAt;
  normalized.calibration_version = normalized.calibrationVersion;
  return normalized;
}

export function resolveTickerProfileContext(sym, rawLearnedProfile, options = {}) {
  const staticBehaviorProfile = resolveStaticBehaviorProfile(sym);
  const learnedProfile = normalizeLearnedTickerProfile(rawLearnedProfile, {
    ticker: sym,
    source: options.learnedSource || null,
  });
  return {
    staticBehaviorProfile,
    learnedProfile,
    lineage: {
      static_behavior_profile_key: staticBehaviorProfile.profileKey,
      static_behavior_profile_label: staticBehaviorProfile.label,
      learned_profile_present: !!learnedProfile,
      learned_profile_source: learnedProfile ? (learnedProfile.source || options.learnedSource || null) : null,
      learned_behavior_type: learnedProfile?.behaviorType || null,
      learned_calibration_version: learnedProfile?.calibrationVersion || null,
      learned_has_learning: !!learnedProfile?.learning,
    },
  };
}

export function buildLegacyLearnedProfileView(rawLearnedProfile, options = {}) {
  const learnedProfile = normalizeLearnedTickerProfile(rawLearnedProfile, options);
  if (!learnedProfile) return null;
  return {
    behavior_type: learnedProfile.behaviorType,
    sl_mult: learnedProfile.slMult,
    tp_mult: learnedProfile.tpMult,
    entry_threshold_adj: learnedProfile.entryThresholdAdj,
    atr_pct_p50: learnedProfile.atrPctP50,
    trend_persistence: learnedProfile.trendPersistence,
    ichimoku_responsiveness: learnedProfile.ichimokuResponsiveness,
    learning: learnedProfile.learning || null,
  };
}

export function buildTickerCharacterEvidence(profileContext) {
  const staticBehaviorProfile = profileContext?.staticBehaviorProfile || null;
  const learnedProfile = profileContext?.learnedProfile || null;
  if (!staticBehaviorProfile && !learnedProfile) return null;
  return {
    static_behavior_profile: staticBehaviorProfile
      ? {
          key: staticBehaviorProfile.profileKey,
          label: staticBehaviorProfile.label,
          sl_mult: staticBehaviorProfile.slMult,
          doa_hours: staticBehaviorProfile.doaHours,
          max_hold_hours: staticBehaviorProfile.maxHoldHours,
          min_rank: staticBehaviorProfile.minRank,
        }
      : null,
    learned_profile: learnedProfile
      ? {
          personality: learnedProfile.learning?.personality || learnedProfile.behaviorType || null,
          behavior_type: learnedProfile.behaviorType,
          sl_mult: learnedProfile.slMult,
          tp_mult: learnedProfile.tpMult,
          entry_threshold_adj: learnedProfile.entryThresholdAdj,
          atr_pct_p50: learnedProfile.atrPctP50,
          trend_persistence: learnedProfile.trendPersistence,
          source: learnedProfile.source || null,
          calibration_version: learnedProfile.calibrationVersion || null,
        }
      : null,
  };
}
