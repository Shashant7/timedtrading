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

    pdz: {
      zoneD: String(d.pdz_zone_D || "unknown"),
      pctD: Number(d.pdz_pct_D) || 50,
    },
    movePhase,

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

  const supportiveSignals = atrSupportiveCount + phaseSupportiveCount + favorablePdz + ewSupportiveCount;
  const counterSignals = ewCounterCount + (tdCounterSignal ? 1 : 0) + unfavorablePdz;
  let profile = "neutral";
  const strongPeakStructure = atrExhaustedCount >= 2 && phaseLateCount >= 2;
  const trendIsCrowded = atrExtendedCount >= 2 && phaseExtremeCount >= 1;
  const countertrendConfluence = counterSignals >= 2 && phaseLateCount >= 1;
  const unfavorableContext = unfavorablePdz > 0 || tdCounterSignal || ewCounterCount > 0;

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
    },
    reasons: [...new Set(reasons)].slice(0, 8),
    version: Number(daCfg.deep_audit_move_phase_profile_version) || 1,
  };
}

function round3(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}
