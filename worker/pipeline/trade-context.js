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
