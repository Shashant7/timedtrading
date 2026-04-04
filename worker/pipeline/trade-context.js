// worker/pipeline/trade-context.js
// Builds a normalized TradeContext from raw tickerData + env.
// Single input contract for all pipeline stages.

import { normalizeTfKey } from "../ingest.js";

export function buildTradeContext(tickerData, asOfTs = null) {
  const d = tickerData || {};
  const env = d._env || {};
  const now = (asOfTs != null && Number.isFinite(Number(asOfTs)))
    ? Number(asOfTs)
    : Date.now();

  const ticker = String(d.ticker || d.sym || "").toUpperCase();
  const price = Number(d.price) || 0;
  const state = String(d.state || "");

  const side = inferSide(d, state);

  const engineRaw = String(env._entryEngine || "").trim().toLowerCase();
  const engine = engineRaw === "ripster_core" ? "ripster_core"
    : engineRaw === "tt_core" ? "tt_core" : "legacy";

  const mgmtRaw = String(env._managementEngine || "").trim().toLowerCase();
  const managementEngine = mgmtRaw === "ripster_core" ? "ripster_core"
    : mgmtRaw === "tt_core" ? "tt_core" : "legacy";

  const leadingLtf = resolveLeadingLtf(d, env);
  const leadingLtfLabel = leadingLtf === "30" ? "30m"
    : leadingLtf === "15" ? "15m" : "10m";

  const extractTf = (key) => {
    const src = d.tf_tech;
    if (!src || typeof src !== "object") return null;
    if (src[key]) return src[key];
    const k = String(key || "");
    const up = k.toUpperCase();
    const low = k.toLowerCase();
    if (src[up]) return src[up];
    if (src[low]) return src[low];
    const aliasMap = {
      "10": ["10m"],
      "15": ["15m"],
      "30": ["30m"],
      "1H": ["60", "1h", "60m"],
      "4H": ["240", "4h", "240m"],
      D: ["d", "1d"],
      W: ["w", "1w"],
    };
    for (const a of (aliasMap[k] || [])) {
      if (src[a]) return src[a];
      const au = String(a).toUpperCase();
      const al = String(a).toLowerCase();
      if (src[au]) return src[au];
      if (src[al]) return src[al];
    }
    return null;
  };
  const tf = {
    m10: extractTf("10") || extractTf("15") || {},
    m15: extractTf("15") || {},
    m30: extractTf("30") || {},
    h1: extractTf("1H") || extractTf("60") || {},
    h4: extractTf("4H") || extractTf("240") || {},
    D: extractTf("D") || {},
    W: extractTf("W") || {},
  };

  const htf = Number(d.htf_score) || 0;
  const ltf = Number(d.ltf_score) || 0;
  const rank = Number(d.score ?? d.rank) || 0;
  const rr = Number(d.rr) || 0;
  const completion = Number(d.completion) || 0;
  const phase = Number(d.phase_pct) || 0;
  const fuelLead = d.fuel?.[leadingLtf]?.fuelPct ?? d.fuel?.["10"]?.fuelPct ?? 50;
  const fuel30 = d.fuel?.["30"]?.fuelPct ?? 50;
  const fuel10 = fuelLead;
  const fuelD = d.fuel?.D?.fuelPct ?? 50;
  const primaryFuel = Math.max(fuel30, fuel10);

  const stSupportScore = d.st_support?.supportScore ?? 0.5;
  const activeGates = d.active_gates || [];

  const regimeClass = String(d.regime_class || "TRANSITIONAL");
  const rParams = d.regime_params || {};

  const rvol30 = d.rvol_map?.["30"]?.vr ?? d.rvol_map?.["60"]?.vr ?? 1.0;
  const rvol1H = d.rvol_map?.["60"]?.vr ?? 1.0;
  const rvolBest = Math.max(rvol30, rvol1H);

  const vixLevel = Number(env._vixLevel ?? d._vixLevel ?? d._vix) || 0;
  const vixTier = vixLevel > 35 ? "extreme"
    : vixLevel > 25 ? "high"
    : vixLevel > 18 ? "elevated" : "low";

  const deepAuditConfig = env._deepAuditConfig || {};
  const ripsterTuneV2 = parseBool(env._ripsterTuneV2, false);
  const exitDebounceBars = Math.max(1, Number(env._ripsterExitDebounceBars) || 3);
  const movePhase = buildMovePhaseProfile(d, side, tf, deepAuditConfig);
  if (movePhase) d.move_phase_profile = movePhase;
  const structureHealth = buildStructureHealthProfile(d, side, tf, movePhase, stSupportScore, rvolBest);
  const progression = buildProgressionProfile(d, side, tf, movePhase, structureHealth, rvolBest);
  const eventRisk = buildEventRiskProfile(d);

  return {
    ticker,
    side,
    price,
    state,
    asOfTs: now,
    isReplay: !!env._isReplay,

    tf,
    leadingLtf,
    leadingLtfLabel,

    scores: {
      htf, ltf, rank, rr, completion, phase,
      fuelLead, fuel30, fuel10, fuelD, primaryFuel,
    },

    ema: {
      depth30: d.ema_map?.["30"]?.depth ?? 5,
      depthD: d.ema_map?.D?.depth ?? 5,
      struct30: d.ema_map?.["30"]?.structure ?? 0,
      structD: d.ema_map?.D?.structure ?? 0,
      mom30: d.ema_map?.["30"]?.momentum ?? 0,
      momD: d.ema_map?.D?.momentum ?? 0,
    },

    support: { stScore: stSupportScore, activeGates },
    flags: d.flags || {},
    tdSequential: d.td_sequential || {},
    patterns: d.pattern_match || null,

    regime: {
      class: regimeClass,
      params: rParams,
      swing: String(d.regime?.combined || "").toUpperCase(),
      market: String(d.regime?.market || ""),
      sector: String(d.regime?.sector || ""),
    },

    market: {
      internals: d._marketInternals || env._marketInternals || null,
      vix: vixLevel,
      vixTier,
      spy: d._spyData || null,
      cryptoLead: d._cryptoLead || null,
    },

    profile: d._tickerProfile || null,

    rvol: { best: rvolBest, m30: rvol30, h1: rvol1H },
    divergence: {
      rsi: d.rsi_divergence || null,
      phase: d.phase_divergence || null,
    },

    pdz: {
      zoneD: String(d.pdz_zone_D || "unknown"),
      pctD: Number(d.pdz_pct_D) || 50,
    },
    movePhase,
    structureHealth,
    progression,
    eventRisk,

    fvg: { D: d.fvg_D || {} },
    liq: { D: d.liq_D || {}, h4: d.liq_4h || {} },

    config: {
      engine,
      managementEngine,
      deepAudit: deepAuditConfig,
      ripsterTuneV2,
      exitDebounceBars,
      leadingLtf,
      cioEnabled: parseBool(env._cioEnabled, false),
    },

    raw: tickerData,
  };
}

function inferSide(d, state) {
  const consensusDir = d.swing_consensus?.direction;
  if (consensusDir === "LONG" || consensusDir === "SHORT") return consensusDir;
  if (state.includes("BULL")) return "LONG";
  if (state.includes("BEAR")) return "SHORT";
  const h = Number(d.htf_score);
  if (Number.isFinite(h)) {
    if (h > 0) return "LONG";
    if (h < 0) return "SHORT";
  }
  return null;
}

function resolveLeadingLtf(d, env) {
  const requested = normalizeTfKey(
    d.leading_ltf || d.lead_intraday_tf || env._leadingLtf || "10",
  ) || "10";
  if (requested === "30" && (d.tf_tech?.["30"] || d.fuel?.["30"] || d.ema_map?.["30"]))
    return "30";
  if (requested === "15" && (d.tf_tech?.["15"] || d.fuel?.["15"] || d.ema_map?.["15"]))
    return "15";
  return "10";
}

export function parseBool(v, defaultVal = false) {
  if (v == null) return defaultVal;
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return defaultVal;
}

function buildMovePhaseProfile(d, side, tf, daCfg = {}) {
  if (!d || !side) return null;

  const atrLevels = d.atr_levels || {};
  const atr = {};
  let atrExtendedCount = 0;
  let atrExhaustedCount = 0;
  let atrSupportiveCount = 0;
  const reasons = [];

  for (const horizon of ["day", "week", "month", "quarter", "longterm"]) {
    const src = atrLevels[horizon] || {};
    const disp = Number(src.disp) || 0;
    const directionalDisp = side === "SHORT" ? -disp : disp;
    const rangeOfATR = Number(src.rangeOfATR) || 0;
    const inDirection = directionalDisp > 0;
    const triggerReached = inDirection && directionalDisp >= 0.236;
    const keyTargetReached = inDirection && directionalDisp >= 0.618;
    const fullAtrReached = inDirection && directionalDisp >= 1.0;
    const rangeColor = rangeOfATR >= 90 ? "red" : rangeOfATR > 70 ? "orange" : "green";
    const extended = inDirection && (fullAtrReached || (keyTargetReached && rangeColor !== "green"));
    const exhausted = inDirection && ((fullAtrReached && rangeColor !== "green") || rangeColor === "red");
    const supportive = inDirection && triggerReached && !keyTargetReached && rangeColor === "green";
    const countsForGate = horizon !== "longterm";
    if (countsForGate && extended) atrExtendedCount++;
    if (countsForGate && exhausted) atrExhaustedCount++;
    if (countsForGate && supportive) atrSupportiveCount++;
    if (countsForGate && exhausted) reasons.push(`${horizon}_atr_exhausted`);
    else if (countsForGate && extended) reasons.push(`${horizon}_atr_extended`);
    atr[horizon] = {
      disp,
      directionalDisp: round3(directionalDisp),
      band: String(src.band || "NEUTRAL"),
      rangeOfATR: round3(rangeOfATR),
      rangeColor,
      triggerReached,
      keyTargetReached,
      fullAtrReached,
      gateEntered: !!src?.gate?.entered,
      gateCompleted: !!src?.gate?.completed,
      stage: exhausted ? "exhausted" : extended ? "extended" : supportive ? "supportive" : "neutral",
      diagnosticOnly: horizon === "longterm",
    };
  }

  const phase = {};
  let phaseLateCount = 0;
  let phaseExtremeCount = 0;
  let phaseSupportiveCount = 0;
  for (const [label, src] of Object.entries({
    m30: tf?.m30,
    h1: tf?.h1,
    h4: tf?.h4,
    D: tf?.D,
    W: tf?.W,
  })) {
    const value = Number(src?.ph?.v ?? src?.saty?.v);
    if (!Number.isFinite(value)) continue;
    const directionalValue = side === "SHORT" ? -value : value;
    const late = directionalValue >= 55;
    const extreme = directionalValue >= 75;
    const supportive = directionalValue > 5 && directionalValue < 35;
    if (late) phaseLateCount++;
    if (extreme) phaseExtremeCount++;
    if (supportive) phaseSupportiveCount++;
    if (extreme) reasons.push(`${label}_phase_extreme`);
    phase[label] = {
      value: round3(value),
      directionalValue: round3(directionalValue),
      stage: extreme ? "extreme" : late ? "late" : supportive ? "supportive" : "neutral",
    };
  }

  const pdzZoneD = String(d?.pdz_zone_D || "unknown").toLowerCase();
  const pdzZone4h = String(tf?.h4?.pdz?.zone || d?.pdz_zone_4h || "unknown").toLowerCase();
  const favorablePdz = side === "LONG"
    ? [pdzZoneD, pdzZone4h].filter((z) => z === "discount" || z === "discount_approach").length
    : [pdzZoneD, pdzZone4h].filter((z) => z === "premium" || z === "premium_approach").length;
  const unfavorablePdz = side === "LONG"
    ? [pdzZoneD, pdzZone4h].filter((z) => z === "premium" || z === "premium_approach").length
    : [pdzZoneD, pdzZone4h].filter((z) => z === "discount" || z === "discount_approach").length;
  if (unfavorablePdz > 0) reasons.push("pdz_unfavorable");

  const td9 = d?.mean_revert_td9 || {};
  const tdCounterSignal = !!td9?.active && String(td9?.direction || "").toUpperCase() !== side;
  if (tdCounterSignal) reasons.push("td9_counter_signal");

  const ew = {};
  let ewSupportiveCount = 0;
  let ewCounterCount = 0;
  for (const [label, src] of Object.entries({ D: tf?.D?.ew, W: tf?.W?.ew })) {
    if (!src || src.detected !== true) continue;
    const dirLabel = Number(src.dir) >= 0 ? "LONG" : "SHORT";
    const aligned = dirLabel === side;
    if (aligned) ewSupportiveCount++;
    else ewCounterCount++;
    if (!aligned) reasons.push(`${label}_ew_counter`);
    ew[label] = {
      detected: true,
      direction: dirLabel,
      aligned,
      retrace: Number(src.r2) || null,
    };
  }

  const adverseDivSide = side === "LONG" ? "bear" : "bull";
  const participation = {};
  const lateStageConditions = [];
  const countertrendPeakReasons = [];
  let adverseRsiDivCount = 0;
  let adversePhaseDivCount = 0;
  for (const [label, src] of Object.entries({ m30: tf?.m30, h1: tf?.h1, h4: tf?.h4, D: tf?.D, W: tf?.W })) {
    if (!src || typeof src !== "object" || Object.keys(src).length === 0) continue;
    const c5 = src?.ripster?.c5_12 || {};
    const stDir = Number(src?.stDir);
    const emaStructure = Number(src?.ema?.structure);
    const phaseStage = phase[label]?.stage || "neutral";
    const adverseRsiDiv = summarizeTfDiv(src, "rsiDiv", adverseDivSide);
    const adversePhaseDiv = summarizeTfDiv(src, "phaseDiv", adverseDivSide);
    const c5Confirmed = side === "LONG"
      ? !!(c5?.bull && c5?.above)
      : !!(c5?.bear && c5?.below);
    const c5Opposed = side === "LONG" ? !!c5?.below : !!c5?.above;
    const stAligned = Number.isFinite(stDir)
      ? (side === "LONG" ? stDir <= 0 : stDir >= 0)
      : false;
    const emaAligned = Number.isFinite(emaStructure)
      ? (side === "LONG" ? emaStructure >= 0 : emaStructure <= 0)
      : false;
    const late = phaseStage === "late" || phaseStage === "extreme";
    const exhausted = phaseStage === "extreme"
      || (adverseRsiDiv?.active && (adverseRsiDiv?.strength || 0) >= 1.5)
      || (adversePhaseDiv?.active && (adversePhaseDiv?.strength || 0) >= 1.5);
    const supportive = !!(
      c5Confirmed
      || (stAligned && emaAligned && !c5Opposed && !late && !exhausted)
    );
    if (late) lateStageConditions.push(`${label}_phase_${phaseStage}`);
    if (c5Opposed) countertrendPeakReasons.push(`${label}_5_12_opposed`);
    if (adverseRsiDiv?.active) {
      adverseRsiDivCount++;
      countertrendPeakReasons.push(`${label}_rsi_div_${adverseDivSide}`);
    }
    if (adversePhaseDiv?.active) {
      adversePhaseDivCount++;
      countertrendPeakReasons.push(`${label}_phase_div_${adverseDivSide}`);
    }
    participation[label] = {
      available: true,
      c5Confirmed,
      c5Opposed,
      stDir: Number.isFinite(stDir) ? stDir : null,
      stAligned,
      emaStructure: Number.isFinite(emaStructure) ? round3(emaStructure) : null,
      emaAligned,
      phaseStage,
      adverseRsiDiv,
      adversePhaseDiv,
      supportive,
      late,
      exhausted,
    };
  }

  const supportiveSignals = atrSupportiveCount + phaseSupportiveCount + favorablePdz + ewSupportiveCount;
  const counterSignals = ewCounterCount + (tdCounterSignal ? 1 : 0) + unfavorablePdz;
  let profile = "neutral";
  const strongPeakStructure = atrExhaustedCount >= 2 && phaseLateCount >= 2;
  const trendIsCrowded = atrExtendedCount >= 2 && phaseExtremeCount >= 1;
  const countertrendConfluence = counterSignals >= 2 && phaseLateCount >= 1;
  const unfavorableContext = unfavorablePdz > 0 || tdCounterSignal || ewCounterCount > 0;
  const peakExhaustionCount = atrExhaustedCount + phaseExtremeCount + adverseRsiDivCount + adversePhaseDivCount + (tdCounterSignal ? 1 : 0);

  if (strongPeakStructure && (countertrendConfluence || unfavorableContext)) {
    profile = "countertrend_peak_risk";
  } else if (strongPeakStructure || (trendIsCrowded && unfavorableContext)) {
    profile = "exhausted";
  } else if (atrExtendedCount >= 2 || phaseLateCount >= 2) {
    profile = "late_but_trend_ok";
  } else if (supportiveSignals >= 3 && counterSignals === 0) {
    profile = "supportive";
  }

  const blockMomentum = profile === "exhausted" || profile === "countertrend_peak_risk";
  const blockReclaim = profile === "countertrend_peak_risk";
  return {
    profile,
    blockMomentum,
    blockReclaim,
    atr,
    phase,
    pdz: {
      D: pdzZoneD,
      h4: pdzZone4h,
      favorableCount: favorablePdz,
      unfavorableCount: unfavorablePdz,
    },
    td: {
      active: !!td9?.active,
      direction: td9?.direction || null,
      counterSignal: tdCounterSignal,
    },
    ew,
    scores: {
      atrExtendedCount,
      atrExhaustedCount,
      phaseLateCount,
      phaseExtremeCount,
      supportiveSignals,
      counterSignals,
      adverseRsiDivCount,
      adversePhaseDivCount,
      peakExhaustionCount,
    },
    participation,
    peak: {
      lateStageConditions: [...new Set(lateStageConditions)].slice(0, 8),
      countertrendPeakReasons: [...new Set(countertrendPeakReasons)].slice(0, 8),
      peakExhaustionCount,
    },
    reasons: [...new Set(reasons)].slice(0, 8),
    version: Number(daCfg.deep_audit_move_phase_profile_version) || 1,
  };
}

function summarizeTfDiv(tf, keyName, side) {
  if (!tf?.[keyName]) return null;
  const keys = side === "bear" ? ["bear", "rb"] : ["bull", "ru"];
  for (const key of keys) {
    const div = tf[keyName][key];
    if (!div) continue;
    const active = div?.active ?? div?.a;
    const strength = Number(div?.strength ?? div?.s) || 0;
    const barsSince = Number(div?.barsSince ?? div?.bs);
    return {
      side,
      source: key,
      active: !!active,
      strength: round3(strength),
      barsSince: Number.isFinite(barsSince) ? barsSince : null,
    };
  }
  return null;
}

function buildStructureHealthProfile(d, side, tf, movePhase, stSupportScore, rvolBest) {
  if (!side) return null;
  const checks = [];
  const addCheck = (label, aligned, reason) => {
    if (aligned == null) return;
    checks.push({ label, aligned: !!aligned, reason });
  };

  const st30 = Number(tf?.m30?.stDir);
  const st1 = Number(tf?.h1?.stDir);
  const st4 = Number(tf?.h4?.stDir);
  const ema30 = Number(tf?.m30?.ema?.structure);
  const emaD = Number(tf?.D?.ema?.structure);
  addCheck("st_30m", Number.isFinite(st30) ? (side === "LONG" ? st30 <= 0 : st30 >= 0) : null, "supertrend");
  addCheck("st_1h", Number.isFinite(st1) ? (side === "LONG" ? st1 <= 0 : st1 >= 0) : null, "supertrend");
  addCheck("st_4h", Number.isFinite(st4) ? (side === "LONG" ? st4 <= 0 : st4 >= 0) : null, "supertrend");
  addCheck("ema_30m", Number.isFinite(ema30) ? (side === "LONG" ? ema30 >= 0 : ema30 <= 0) : null, "ema_structure");
  addCheck("ema_D", Number.isFinite(emaD) ? (side === "LONG" ? emaD >= 0 : emaD <= 0) : null, "ema_structure");

  const intactCount = checks.filter((c) => c.aligned).length;
  const brokenCount = checks.filter((c) => !c.aligned).length;
  const participation = movePhase?.participation || {};
  const supportiveParticipation = Object.values(participation).filter((row) => row?.supportive).length;
  const exhaustedParticipation = Object.values(participation).filter((row) => row?.exhausted).length;
  const score = round3(
    (intactCount * 1.25)
    + (supportiveParticipation * 0.75)
    + ((Number(stSupportScore) || 0.5) * 2)
    + (Math.min(3, Number(rvolBest) || 0) >= 1.2 ? 0.5 : 0)
    - (brokenCount * 1.5)
    - (exhaustedParticipation * 0.75)
  );
  const intact = brokenCount === 0 && intactCount >= 3;
  const fragile = !intact && brokenCount <= 1 && intactCount >= 2;
  const broken = brokenCount >= 2 || intactCount === 0;
  const posture = broken ? "broken" : intact ? "intact" : fragile ? "fragile" : "mixed";

  return {
    posture,
    intact,
    fragile,
    broken,
    score,
    intactCount,
    brokenCount,
    supportiveParticipation,
    exhaustedParticipation,
    checks,
  };
}

function buildProgressionProfile(d, side, tf, movePhase, structureHealth, rvolBest) {
  if (!side) return null;
  const emaMom30 = Number(d?.ema_map?.["30"]?.momentum ?? tf?.m30?.ema?.momentum) || 0;
  const emaMomD = Number(d?.ema_map?.D?.momentum ?? tf?.D?.ema?.momentum) || 0;
  const atrExtendedCount = Number(movePhase?.scores?.atrExtendedCount) || 0;
  const phaseLateCount = Number(movePhase?.scores?.phaseLateCount) || 0;
  const peakExhaustionCount = Number(movePhase?.scores?.peakExhaustionCount) || 0;
  const favorablePdz = Number(movePhase?.pdz?.favorableCount) || 0;
  const unfavorablePdz = Number(movePhase?.pdz?.unfavorableCount) || 0;
  const sponsorship = (Number(rvolBest) || 0) >= 1.8 ? "strong"
    : (Number(rvolBest) || 0) >= 1.2 ? "moderate"
    : "weak";
  const momentumAligned = side === "LONG"
    ? (emaMom30 >= 0 && emaMomD >= 0)
    : (emaMom30 <= 0 && emaMomD <= 0);
  const advancementScore = round3(
    ((structureHealth?.intactCount || 0) * 0.8)
    + ((structureHealth?.supportiveParticipation || 0) * 0.7)
    + (momentumAligned ? 1.0 : 0)
    + (favorablePdz > 0 ? 0.6 : 0)
    + (sponsorship === "strong" ? 0.8 : sponsorship === "moderate" ? 0.4 : 0)
  );
  const exhaustionScore = round3(
    (peakExhaustionCount * 0.9)
    + (atrExtendedCount * 0.5)
    + (phaseLateCount * 0.6)
    + (unfavorablePdz > 0 ? 0.8 : 0)
  );
  const status = exhaustionScore >= 3.5
    ? "stretched"
    : advancementScore >= 3.2 && exhaustionScore <= 2.0
      ? "advancing"
      : structureHealth?.fragile
        ? "fragile"
        : "mixed";
  return {
    status,
    momentumAligned,
    sponsorship,
    advancementScore,
    exhaustionScore,
    favorablePdz,
    unfavorablePdz,
    emaMom30: round3(emaMom30),
    emaMomD: round3(emaMomD),
  };
}

function buildEventRiskProfile(d) {
  const event = d?.__eventRiskProfile || d?._eventRiskProfile || d?.eventRiskProfile || null;
  const upcoming = d?.__upcomingRiskEvent || d?._upcomingRiskEvent || d?.upcomingRiskEvent || null;
  const trimPct = Number(event?.trimPct);
  const scheduledTs = Number(upcoming?.scheduledTs || event?.scheduledTs);
  const nowTs = Number(d?.ts || d?.ingest_ts || d?.snapshot_ts || Date.now());
  const hoursToEvent = Number.isFinite(scheduledTs) && Number.isFinite(nowTs)
    ? round3((scheduledTs - nowTs) / 3600000)
    : null;
  const severity = Number.isFinite(trimPct)
    ? (trimPct >= 0.5 ? "high" : trimPct >= 0.2 ? "medium" : "low")
    : "none";
  return {
    active: !!upcoming || !!event,
    severity,
    trimPct: Number.isFinite(trimPct) ? trimPct : null,
    eventType: upcoming?.eventType || event?.eventType || null,
    eventKey: upcoming?.eventKey || event?.eventKey || null,
    session: upcoming?.session || event?.session || null,
    hoursToEvent,
    reasons: Array.isArray(event?.reasons) ? event.reasons.slice(0, 6) : [],
  };
}

function round3(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}
