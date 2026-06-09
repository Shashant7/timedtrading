// worker/cio/cio-service.js
// CIO entry/lifecycle evaluation service — proposal builders, chart vision, OpenAI API calls.

import {
  AI_CIO_TIMEOUT_MS,
  AI_CIO_MODEL,
  AI_CIO_REASONING_MODEL,
  AI_CIO_SYSTEM_PROMPT,
  AI_CIO_USER_TEMPLATE,
  AI_CIO_LIFECYCLE_PROMPT,
  AI_CIO_LIFECYCLE_TEMPLATE,
} from "./cio-prompts.js";
import { resolveRegimeVocabulary } from "../regime-vocabulary.js";

// ── Model Resolver ────────────────────────────────────────────────────────
// 2026-05-28 — Make the CIO model operator-configurable. Three call sites:
//   ENTRY (text only)            → resolveCioModel(env, "entry", false)
//   ENTRY (vision / chart SVG)   → resolveCioModel(env, "entry", true)
//   LIFECYCLE                    → resolveCioModel(env, "lifecycle", chartSvg)
//
// Resolution order (first wins):
//   1. explicit `modelOverride` argument (used by /timed/admin/ai-cio/probe?model=...)
//   2. model_config row (ai_cio_entry_model / ai_cio_vision_model / ai_cio_lifecycle_model)
//      Resolved either from env._deepAuditConfig (already lazy-loaded by
//      processTradeSimulation) OR from a per-isolate cache populated by
//      ensureCioModelCache() below for non-scoring HTTP paths.
//   3. env var (AI_CIO_ENTRY_MODEL / AI_CIO_VISION_MODEL / AI_CIO_LIFECYCLE_MODEL)
//   4. lane fallback: vision path → "gpt-4o" (vision-capable). text path → AI_CIO_MODEL
export function resolveCioModel(env, lane = "entry", useVision = false, modelOverride = null) {
  // 1. Explicit override (probe / smoke testing)
  if (modelOverride && typeof modelOverride === "string" && modelOverride.trim()) {
    return modelOverride.trim();
  }
  // 2. model_config (operator override, no-redeploy). Merge env._deepAuditConfig
  //    with the per-isolate _cioModelCache so HTTP-path callers (like the
  //    probe endpoint and any future direct CIO invocation) see model_config
  //    values without going through the */5 scoring cron first.
  const fromDaCfg = env?._deepAuditConfig || {};
  const fromCioCache = env?._cioModelCache || {};
  const merged = { ...fromCioCache, ...fromDaCfg };
  const keys = useVision
    ? ["ai_cio_vision_model", `ai_cio_${lane}_model`]
    : [`ai_cio_${lane}_model`];
  for (const k of keys) {
    const v = merged?.[k];
    if (v && typeof v === "string" && v.trim()) return v.trim();
  }
  // 3. env var
  const envKeys = useVision
    ? ["AI_CIO_VISION_MODEL", `AI_CIO_${lane.toUpperCase()}_MODEL`]
    : [`AI_CIO_${lane.toUpperCase()}_MODEL`];
  for (const k of envKeys) {
    const v = env?.[k];
    if (v && typeof v === "string" && v.trim()) return v.trim();
  }
  // 4. lane fallback.
  return useVision ? "gpt-4o" : AI_CIO_MODEL;
}

// Lazily load just the three CIO model_config keys into a per-isolate cache.
// Called once per CIO eval so HTTP-path callers (probe + admin tools) see the
// operator's model selection without needing the */5 scoring cron to have run
// first. The cache is per-isolate and TTL'd at 5 minutes so model_config
// flips propagate to running isolates within one CIO cycle.
const DEFAULT_ENTRY_TIMEOUT_MS = 20000;
const CIO_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

// Resolve per-lane API timeout from model_config / env. Entry defaults
// higher (20s) because gpt-5.4 entry calls average ~5-6s. Lifecycle API
// keeps the legacy 15s default; the tighter lifecycle-gate Promise.race
// cap is separate (ai_cio_lifecycle_timeout_ms in cio-lifecycle-gate.js).
export function resolveCioTimeoutMs(env, lane = "entry") {
  const fromDaCfg = env?._deepAuditConfig || {};
  const fromCioCache = env?._cioModelCache || {};
  const merged = { ...fromCioCache, ...fromDaCfg };
  const key = lane === "entry" ? "ai_cio_entry_timeout_ms" : "ai_cio_lifecycle_api_timeout_ms";
  const raw = merged?.[key];
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return lane === "entry" ? DEFAULT_ENTRY_TIMEOUT_MS : AI_CIO_TIMEOUT_MS;
}

async function ensureCioModelCache(env) {
  try {
    if (!env?.DB) return;
    const cache = env._cioModelCache;
    if (cache && cache._loadedAt && (Date.now() - cache._loadedAt) < CIO_MODEL_CACHE_TTL_MS) {
      return;
    }
    const rows = await env.DB.prepare(
      `SELECT config_key, config_value FROM model_config
        WHERE config_key IN (
          'ai_cio_entry_model','ai_cio_lifecycle_model','ai_cio_vision_model',
          'ai_cio_entry_timeout_ms','ai_cio_lifecycle_timeout_ms','ai_cio_lifecycle_api_timeout_ms'
        )`
    ).all().catch(() => ({ results: [] }));
    const out = { _loadedAt: Date.now() };
    for (const r of (rows?.results || [])) {
      if (!r?.config_key) continue;
      const raw = r.config_value;
      let v = raw;
      try { v = JSON.parse(raw); } catch { /* keep raw string */ }
      if (v && typeof v === "string") out[r.config_key] = v;
    }
    env._cioModelCache = out;
  } catch (e) {
    console.warn("[AI_CIO] ensureCioModelCache failed:", String(e?.message || e).slice(0, 150));
  }
}

// Some newer OpenAI models (gpt-5.x family in particular) require
// `max_completion_tokens` instead of the legacy `max_tokens`, and may not
// accept the `temperature` field for deterministic JSON tasks. This helper
// builds a model-aware request body so a single switch works for both eras.
function buildOpenAIBody(model, messages, maxCompletionTokens, options = {}) {
  const isGpt5Family = String(model || "").toLowerCase().startsWith("gpt-5");
  const body = {
    model,
    messages,
    max_completion_tokens: maxCompletionTokens,
  };
  if (!isGpt5Family) {
    body.temperature = options.temperature ?? 0.1;
  }
  if (options.responseFormat) body.response_format = options.responseFormat;
  return body;
}

// ── Signal Condensers ─────────────────────────────────────────────────────
// Helpers that compress the rich tickerData signals into compact, CIO-ready
// shapes. Goal: keep the prompt token budget reasonable while still surfacing
// every decision-impacting field. All helpers are tolerant of missing data.

const round = (n, p = 2) => {
  if (n == null || !Number.isFinite(Number(n))) return null;
  const m = Math.pow(10, p);
  return Math.round(Number(n) * m) / m;
};

// Take a {state: prob} object and return the top-N states by probability.
function topStates(probMap, n = 2) {
  if (!probMap || typeof probMap !== "object") return null;
  const entries = Object.entries(probMap)
    .filter(([, v]) => Number.isFinite(Number(v)))
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, n)
    .map(([k, v]) => ({ state: k, p: round(v, 3) }));
  return entries.length > 0 ? entries : null;
}

// Sum of probability mass that aligns with the trade direction.
// LONG-friendly states contain "BULL_LTF_BULL" or "BULL_LTF_PULLBACK" (entry chance).
// SHORT-friendly states contain "BEAR_LTF_BEAR" or "BEAR_LTF_PULLBACK".
function probInDirection(probMap, direction) {
  if (!probMap || typeof probMap !== "object") return null;
  const dir = String(direction || "").toUpperCase();
  const friendly = dir === "LONG"
    ? ["HTF_BULL_LTF_BULL", "HTF_BULL_LTF_PULLBACK"]
    : dir === "SHORT"
      ? ["HTF_BEAR_LTF_BEAR", "HTF_BEAR_LTF_PULLBACK"]
      : [];
  if (!friendly.length) return null;
  let s = 0;
  for (const k of friendly) {
    const v = Number(probMap[k]);
    if (Number.isFinite(v)) s += v;
  }
  return round(s, 3);
}

// Condense the full regime_forecast payload to a compact CIO-friendly summary.
function condenseMarkovForecast(forecast, direction) {
  if (!forecast || typeof forecast !== "object") return null;
  const out = {
    current_state: forecast.state || null,
    matrix_source: forecast.matrix_source || null,
    matrix_total_transitions: forecast.matrix_total_transitions || null,
  };
  if (forecast.p_next) {
    out.p_next_top2 = topStates(forecast.p_next, 2);
    if (direction) out.p_next_in_direction = probInDirection(forecast.p_next, direction);
  }
  if (forecast.p_5_bar) {
    out.p_5_bar_top2 = topStates(forecast.p_5_bar, 2);
    if (direction) out.p_5_bar_in_direction = probInDirection(forecast.p_5_bar, direction);
  }
  if (forecast.p_20_bar && direction) {
    out.p_20_bar_in_direction = probInDirection(forecast.p_20_bar, direction);
  }
  if (forecast.p_1h && direction) {
    out.p_1h_in_direction = probInDirection(forecast.p_1h, direction);
  }
  if (forecast.p_1d && direction) {
    out.p_1d_in_direction = probInDirection(forecast.p_1d, direction);
  }
  // Expanded 12-state — just the band (EARLY / MID / LATE) is enough for CIO.
  if (forecast.expanded?.band) {
    out.expanded_band = forecast.expanded.band;
  }
  return out;
}

// Condense HMM latent_regime: state + posterior + confidence label + age.
function condenseHmmRegime(latent) {
  if (!latent || typeof latent !== "object" || !latent.state) return null;
  const post = latent.posterior || {};
  const topProb = Math.max(...Object.values(post).map(v => Number(v) || 0), 0);
  let confidence = "low";
  if (topProb >= 0.8) confidence = "high";
  else if (topProb >= 0.6) confidence = "medium";
  return {
    state: latent.state,
    posterior_top: round(topProb, 3),
    confidence_label: confidence,
    decoded_at: latent.decoded_at || null,
  };
}

// Condense __learning_policy.recommend into a compact archetype card.
function condenseMoveArchetype(learningPolicy) {
  const rec = learningPolicy?.recommend;
  if (!rec || typeof rec !== "object") return null;
  return {
    archetype: rec.archetype || null,
    entry_timing: rec.entry_timing || null,
    guard_bundle: rec.guard_bundle || null,
    sl_tp_style: rec.sl_tp_style || null,
    trim_run_bias: rec.trim_run_bias || null,
    exit_style: rec.exit_style || null,
    source: learningPolicy?.source || null,
  };
}

// Per-TF TD Sequential counts. Only include TFs with non-trivial counts (>=4)
// or active countdowns. Filters out null/zero rows to save tokens.
function condenseTdSequential(tickerData) {
  const tfs = ["D", "4H", "1H", "30", "15", "10"];
  const out = {};
  for (const tf of tfs) {
    const tf_tech = tickerData?.tf_tech?.[tf];
    const td = tf_tech?.td;
    if (!td) continue;
    const setup = Number(td.setup_count ?? td.tv_count) || 0;
    const countdown = Number(td.countdown) || 0;
    if (setup < 4 && countdown < 1) continue;
    out[tf] = {
      setup_count: setup || null,
      countdown: countdown || null,
      direction: td.direction || null,
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Direction-aware divergence summary. "Adverse" = bearish div on LONG entries
// or bullish div on SHORT entries.
function condenseDivergence(tickerData, direction) {
  const summary = tickerData?.__entry_divergence_summary;
  if (!summary || typeof summary !== "object") return null;
  const out = {};
  // Pre-computed adverse_rsi / adverse_phase already direction-correct.
  if (summary.adverse_rsi) {
    out.rsi = {
      count: summary.adverse_rsi.count || null,
      strongest_tf: summary.adverse_rsi.strongest?.tf || null,
      strongest_strength: round(summary.adverse_rsi.strongest?.strength, 1),
      bars_since: summary.adverse_rsi.strongest?.barsSince || null,
    };
  }
  if (summary.adverse_phase) {
    out.phase = {
      count: summary.adverse_phase.count || null,
      strongest_tf: summary.adverse_phase.strongest?.tf || null,
      strongest_strength: round(summary.adverse_phase.strongest?.strength, 1),
      bars_since: summary.adverse_phase.strongest?.barsSince || null,
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Multi-window ORB summary: primary breakout/bias + how many targets hit in
// trade direction across all 4 windows.
function condenseOrb(tickerData, direction) {
  const orb = tickerData?.orb;
  if (!orb || typeof orb !== "object") return null;
  const out = {};
  if (orb.primary) {
    out.primary = {
      window: orb.primary.window || "15m",
      breakout: orb.primary.breakout || null,
      priceVsORM: orb.primary.priceVsORM || null,
      dayBias: orb.primary.dayBias || null,
      widthPct: round(orb.primary.widthPct, 2),
    };
  }
  // Multi-window consensus: how many windows agree with dayBias?
  if (orb.byTf && typeof orb.byTf === "object") {
    let consensus = 0;
    const targetsHitInDir = { 5: 0, 15: 0, 30: 0, 60: 0 };
    for (const [tfKey, tfOrb] of Object.entries(orb.byTf)) {
      if (!tfOrb) continue;
      if (tfOrb.dayBias && tfOrb.dayBias === out.primary?.dayBias) consensus++;
      if (direction === "LONG") {
        targetsHitInDir[tfKey] = Number(tfOrb.targetsHitUp) || 0;
      } else if (direction === "SHORT") {
        targetsHitInDir[tfKey] = Number(tfOrb.targetsHitDn) || 0;
      }
    }
    out.window_consensus_count = consensus;
    out.max_targets_hit_in_dir = Math.max(...Object.values(targetsHitInDir), 0);
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Sizing overrides already applied by the system upstream of CIO. CIO should
// know what's already been baked in so it doesn't double-discount.
function condenseSizingOverrides(tickerData, sizingMeta) {
  const out = {};
  const markov = Number(tickerData?.__regime_favor_mult);
  if (Number.isFinite(markov) && markov !== 1) out.markov_favor_mult = round(markov, 2);
  const chop = Number(tickerData?.__chop_size_mult);
  if (Number.isFinite(chop) && chop !== 1) out.chop_size_mult = round(chop, 2);
  const danger = Number(tickerData?.__danger_size_mult);
  if (Number.isFinite(danger) && danger !== 1) out.danger_size_mult = round(danger, 2);
  const rvolHigh = Number(tickerData?.__da_rvol_high_size_mult);
  if (Number.isFinite(rvolHigh) && rvolHigh !== 1) out.rvol_high_size_mult = round(rvolHigh, 2);
  const pdz = Number(tickerData?.__pdz_size_mult);
  if (Number.isFinite(pdz) && pdz !== 1) out.pdz_size_mult = round(pdz, 2);
  const orb = Number(tickerData?.__da_orb_size_mult);
  if (Number.isFinite(orb) && orb !== 1) out.orb_size_mult = round(orb, 2);
  const effective = Number(sizingMeta?.effectiveMult);
  if (Number.isFinite(effective) && effective !== 1) out.effective_combined_mult = round(effective, 2);
  return Object.keys(out).length > 0 ? out : null;
}

// Current book context for the CIO — concentration / direction balance.
function condenseOpenBook(sym, direction, allTrades) {
  if (!Array.isArray(allTrades)) return null;
  const open = allTrades.filter(t =>
    t && (t.status === "OPEN" || t.status === "TP_HIT_TRIM" || !t.status)
  );
  if (open.length === 0) return null;
  const sameTicker = open.filter(t => String(t.ticker || "").toUpperCase() === sym).length;
  const sameDir = open.filter(t => String(t.direction || "").toUpperCase() === String(direction || "").toUpperCase()).length;
  return {
    total_open: open.length,
    same_ticker_open: sameTicker,
    same_direction_open: sameDir,
  };
}

// Move-phase + regime-run-length + exhaustion. Cheap forward indicator.
function condenseMovePhase(tickerData) {
  const out = {
    profile_class: tickerData?.move_phase_profile?.class || tickerData?.move_phase_profile || null,
    phase_pct: round(Number(tickerData?.phase_pct), 1),
    completion_pct: round(Number(tickerData?.completion), 1),
    regime_run_bars: Number(tickerData?._regime_run_length) || null,
    regime_exhausted: tickerData?.regime_exhausted === true ? true : null,
  };
  // Drop empties
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return Object.keys(out).length > 0 ? out : null;
}

// ── Proposal Builders ──────────────────────────────────────────────────────

/**
 * Build an entry proposal object for CIO review.
 * @param {Function} getTickerProfile - (sym) => profile object
 * @param {Array} [allTrades] - optional, for open-book concentration context
 */
export function buildCIOProposal(sym, direction, entryPx, finalSL, validTP, tickerData, sizingMeta, confidence, setupGrade, setupName, calculatedRR, getTickerProfile, allTrades) {
  const orb = tickerData?.orb?.primary;
  const _tp = getTickerProfile(sym);
  const regimeVocabulary = resolveRegimeVocabulary(tickerData, {
    executionFallback: tickerData?.regime_class || "UNKNOWN",
  });
  // 2026-05-28 — Enrichment. CIO previously could not see Markov regime
  // forecasts, HMM latent regime, TD9 / divergence / multi-window ORB,
  // move archetype, or the sizing overrides the system already applied
  // upstream. Each helper returns null when its source data is absent
  // (safe to omit field).
  const markovForecast = condenseMarkovForecast(tickerData?.regime_forecast, direction);
  const hmmRegime = condenseHmmRegime(tickerData?.latent_regime);
  const moveArchetype = condenseMoveArchetype(tickerData?.__learning_policy);
  const engineResolution = tickerData?.__adaptive_lineage?.entry_engine_resolution
    ? {
        source: tickerData.__adaptive_lineage.entry_engine_resolution.source,
        selected_engine: tickerData.__adaptive_lineage.entry_engine_resolution.selected_engine,
        management_engine: tickerData.__adaptive_lineage.entry_engine_resolution.selected_management_engine,
      }
    : null;
  const tdSequential = condenseTdSequential(tickerData);
  const divergence = condenseDivergence(tickerData, direction);
  const orbFull = condenseOrb(tickerData, direction);
  const movePhase = condenseMovePhase(tickerData);
  const sizingOverrides = condenseSizingOverrides(tickerData, sizingMeta);
  const openBook = condenseOpenBook(sym, direction, allTrades);
  return {
    ticker: sym,
    direction,
    entry_price: entryPx,
    sl: finalSL,
    tp: validTP,
    rr: Math.round((calculatedRR || 0) * 100) / 100,
    rank: Number(tickerData?.rank) || 0,
    setup: { name: setupName, grade: setupGrade, path: tickerData?.__entry_path },
    confidence: Math.round((confidence || 0) * 100) / 100,
    // 2026-05-28 — Stochastic + adaptive signal stack (Markov + HMM + archetype
    // + engine selection). All omitted if the source data is unavailable.
    ...(markovForecast && { markov_forecast: markovForecast }),
    ...(hmmRegime && { hmm_regime: hmmRegime }),
    ...(moveArchetype && { move_archetype: moveArchetype }),
    ...(engineResolution && { engine_resolution: engineResolution }),
    ...(tdSequential && { td_sequential: tdSequential }),
    ...(divergence && { divergence }),
    ...(movePhase && { move_phase: movePhase }),
    ...(sizingOverrides && { sizing_overrides: sizingOverrides }),
    ...(openBook && { open_book: openBook }),
    state: tickerData?.state,
    ticker_profile: {
      type: _tp.profileKey,
      label: _tp.label,
      sl_mult: _tp.sl_mult,
      doa_hours: _tp.doa_hours,
      max_hold_hours: _tp.max_hold_hours,
    },
    pullback: {
      confirmed: !!tickerData?.__pullback_confirmed,
      details: tickerData?.__pullback_details || null,
    },
    fvg_imbalance: tickerData?.__fvg_imbalance || null,
    ema21_dist_pct: tickerData?.__ema21_dist_pct ?? null,
    regime: {
      ticker: regimeVocabulary.executionRegimeClass,
      score: regimeVocabulary.executionRegimeScore,
      market: regimeVocabulary.marketRegimeLabel,
      market_score: regimeVocabulary.marketRegimeScore,
      execution_regime_class: regimeVocabulary.executionRegimeClass,
      swing_regime_snapshot: regimeVocabulary.swingRegimeSnapshot,
      market_volatility_regime: regimeVocabulary.marketVolatilityRegime,
      market_backdrop_class: regimeVocabulary.marketBackdropClass,
      market_trend_bias: regimeVocabulary.marketTrendBias,
    },
    scores: {
      htf: Number(tickerData?.htf_score) || 0,
      ltf: Number(tickerData?.ltf_score) || 0,
    },
    technicals: {
      atr: Number(tickerData?.atr) || 0,
      completion: Number(tickerData?.completion) || 0,
      phase_pct: Number(tickerData?.phase_pct) || 0,
      ema_regime_d: tickerData?.ema_regime_daily,
      st_dir_d: tickerData?.tf_tech?.D?.stDir,
      rsi_30m: tickerData?.tf_tech?.["30"]?.rsi,
      rsi_15m: tickerData?.tf_tech?.["15"]?.rsi,
      st_dir_30m: tickerData?.tf_tech?.["30"]?.stDir,
      st_dir_1h: tickerData?.tf_tech?.["1H"]?.stDir,
    },
    flags: {
      momentum_elite: !!tickerData?.flags?.momentum_elite,
      squeeze_release: !!tickerData?.flags?.sq30_release,
      squeeze_on: !!tickerData?.flags?.sq30_on,
      orb_confirmed: !!tickerData?.__orb_confirmed,
      orb_against: !!tickerData?.__orb_against,
      orb_fakeout: !!tickerData?.__orb_fakeout,
    },
    orb: orbFull || (orb ? {
      breakout: orb.breakout, priceVsORM: orb.priceVsORM,
      dayBias: orb.dayBias, widthPct: orb.widthPct,
    } : null),
    danger: {
      score: tickerData?.__danger_score ?? 0,
      flags: tickerData?.__danger_flags || [],
    },
    sizing: {
      method: sizingMeta?.method,
      risk_pct: Math.round((sizingMeta?.riskPct || 0) * 10000) / 100,
      vix: sizingMeta?.vixAtEntry || 0,
    },
    ichimoku: tickerData?.ichimoku_d ? {
      position: tickerData.ichimoku_d.position,
      tk_bull: tickerData.ichimoku_d.tkBull,
      cloud_bullish: tickerData.ichimoku_d.cloudBullish,
    } : null,
    entry_path: tickerData?.__entry_path || setupName,
    pdz_zone_D: tickerData?.pdz_zone_D || tickerData?.tf_tech?.D?.pdz?.zone,
    pdz_pct_D: tickerData?.pdz_pct_D || tickerData?.tf_tech?.D?.pdz?.pct,
    pdz_zone_4h: tickerData?.pdz_zone_4h || tickerData?.tf_tech?.["4H"]?.pdz?.zone,
    pdz_size_mult: tickerData?.__pdz_size_mult || null,
    ripster_bias_state: tickerData?.__ripster_bias_state || null,
    cloud_alignment: {
      c5_12_10m: tickerData?.tf_tech?.["10"]?.ripster?.c5_12?.bull ? "bull" : tickerData?.tf_tech?.["10"]?.ripster?.c5_12?.bear ? "bear" : "flat",
      c34_50_10m: tickerData?.tf_tech?.["10"]?.ripster?.c34_50?.bull ? "bull" : tickerData?.tf_tech?.["10"]?.ripster?.c34_50?.bear ? "bear" : "flat",
      c34_50_1H: tickerData?.tf_tech?.["1H"]?.ripster?.c34_50?.bull ? "bull" : tickerData?.tf_tech?.["1H"]?.ripster?.c34_50?.bear ? "bear" : "flat",
      c34_50_D: tickerData?.tf_tech?.D?.ripster?.c34_50?.bull ? "bull" : tickerData?.tf_tech?.D?.ripster?.c34_50?.bear ? "bear" : "flat",
      c72_89_10m: tickerData?.tf_tech?.["10"]?.ripster?.c72_89?.bull ? "bull" : tickerData?.tf_tech?.["10"]?.ripster?.c72_89?.bear ? "bear" : "flat",
    },
  };
}

/**
 * Build a lifecycle (trim/exit) proposal object for CIO review.
 * @param {Function} getTickerProfile - (sym) => profile object
 */
export function buildCIOLifecycleProposal(action, sym, openTrade, tickerData, pxNow, getTickerProfile) {
  const entryPx = Number(openTrade?.entryPrice) || 0;
  const dir = String(openTrade?.direction || "").toUpperCase();
  const isLong = dir === "LONG";
  const pnlPct = entryPx > 0 ? ((isLong ? pxNow - entryPx : entryPx - pxNow) / entryPx) * 100 : 0;
  const holdMs = (Date.now() - (Number(openTrade?.entry_ts) || Date.now()));
  const holdHours = holdMs / 3600000;
  const trimmedPct = Number(openTrade?.trimmedPct) || 0;
  const orb = tickerData?.orb?.primary;
  const mfe = Number(openTrade?.maxFavorableExcursion) || Number(openTrade?.mfe_pct) || (pnlPct > 0 ? pnlPct : 0);
  const mae = Number(openTrade?.maxAdverseExcursion) || Number(openTrade?.mae_pct) || (pnlPct < 0 ? pnlPct : 0);

  const profitRetainedPct = mfe > 0 ? +(pnlPct / mfe * 100).toFixed(0) : null;
  const _tp = getTickerProfile(sym);
  const regimeVocabulary = resolveRegimeVocabulary(tickerData, {
    executionFallback: tickerData?.regime_class || "UNKNOWN",
  });
  // 2026-05-28 — Same stochastic + adaptive enrichment as entry. For lifecycle
  // decisions, the in-direction probabilities (p_5_bar, p_1h) and divergence
  // firing right now are the key HOLD-vs-PROCEED signals.
  const markovForecast = condenseMarkovForecast(tickerData?.regime_forecast, dir);
  const hmmRegime = condenseHmmRegime(tickerData?.latent_regime);
  const moveArchetype = condenseMoveArchetype(tickerData?.__learning_policy);
  const tdSequential = condenseTdSequential(tickerData);
  const divergence = condenseDivergence(tickerData, dir);
  const orbFull = condenseOrb(tickerData, dir);
  const movePhase = condenseMovePhase(tickerData);

  return {
    action,
    ticker: sym,
    direction: dir,
    entry_price: entryPx,
    current_price: pxNow,
    pnl_pct: +pnlPct.toFixed(2),
    mfe_pct: +mfe.toFixed(2),
    mae_pct: +mae.toFixed(2),
    profit_retained_pct: profitRetainedPct,
    hold_hours: +holdHours.toFixed(1),
    trimmed_pct: +trimmedPct.toFixed(2),
    exit_reason: openTrade?.exitReason || tickerData?.__exit_reason || null,
    sl: Number(openTrade?.sl) || null,
    tp: Number(openTrade?.tp) || null,
    setup: { name: openTrade?.setupName, grade: openTrade?.setupGrade },
    ticker_profile: { type: _tp.profileKey, label: _tp.label, max_hold_hours: _tp.max_hold_hours },
    fvg_imbalance: tickerData?.fvg_imbalance_D || null,
    regime: {
      ticker: regimeVocabulary.executionRegimeClass,
      market: regimeVocabulary.marketRegimeLabel,
      execution_regime_class: regimeVocabulary.executionRegimeClass,
      swing_regime_snapshot: regimeVocabulary.swingRegimeSnapshot,
      market_volatility_regime: regimeVocabulary.marketVolatilityRegime,
      market_backdrop_class: regimeVocabulary.marketBackdropClass,
      market_trend_bias: regimeVocabulary.marketTrendBias,
    },
    technicals: {
      ema_regime_d: tickerData?.ema_regime_daily,
      st_dir_d: tickerData?.tf_tech?.D?.stDir,
      st_dir_1h: tickerData?.tf_tech?.["1H"]?.stDir,
      st_dir_30m: tickerData?.tf_tech?.["30"]?.stDir,
      rsi_30m: tickerData?.tf_tech?.["30"]?.rsi,
      rsi_1h: tickerData?.tf_tech?.["1H"]?.rsi,
      completion: Number(tickerData?.completion) || 0,
      phase_pct: Number(tickerData?.phase_pct) || 0,
    },
    orb: orb ? { breakout: orb.breakout, priceVsORM: orb.priceVsORM } : null,
    rank: Number(tickerData?.rank) || 0,
    entry_path: openTrade?.entryPath || openTrade?.setupName || null,
    pdz_zone_entry: openTrade?.pdz_zone_D || null,
    pdz_zone_current: tickerData?.pdz_zone_D || tickerData?.tf_tech?.D?.pdz?.zone || null,
    pdz_zone_shift: (() => {
      const _e = openTrade?.pdz_zone_D; const _c = tickerData?.pdz_zone_D || tickerData?.tf_tech?.D?.pdz?.zone;
      return (_e && _c && _e !== _c) ? `${_e}\u2192${_c}` : null;
    })(),
    ripster_cloud_status: {
      c5_12_aligned: dir === "LONG"
        ? !!(tickerData?.tf_tech?.["10"]?.ripster?.c5_12?.bull)
        : !!(tickerData?.tf_tech?.["10"]?.ripster?.c5_12?.bear),
      c34_50_aligned: dir === "LONG"
        ? !!(tickerData?.tf_tech?.["10"]?.ripster?.c34_50?.bull && tickerData?.tf_tech?.["1H"]?.ripster?.c34_50?.bull)
        : !!(tickerData?.tf_tech?.["10"]?.ripster?.c34_50?.bear && tickerData?.tf_tech?.["1H"]?.ripster?.c34_50?.bear),
      c72_89_aligned: dir === "LONG"
        ? !!(tickerData?.tf_tech?.["10"]?.ripster?.c72_89?.bull)
        : !!(tickerData?.tf_tech?.["10"]?.ripster?.c72_89?.bear),
    },
    exit_family: tickerData?.__exit_family || null,
    // 2026-05-28 — Stochastic + adaptive signal stack on the lifecycle side.
    // For TRIM/EXIT: prob-in-direction tells CIO whether to HOLD or PROCEED.
    // For HOLD: divergence firing now or TD9 setup_count >= 9 should flip
    // the decision back to PROCEED. Move archetype tells CIO whether this
    // ticker's trim_run_bias historically favors holding or trimming early.
    ...(markovForecast && { markov_forecast: markovForecast }),
    ...(hmmRegime && { hmm_regime: hmmRegime }),
    ...(moveArchetype && { move_archetype: moveArchetype }),
    ...(tdSequential && { td_sequential: tdSequential }),
    ...(divergence && { divergence }),
    ...(orbFull && { orb_full: orbFull }),
    ...(movePhase && { move_phase: movePhase }),
  };
}

// ── Chart Vision ────────────────────────────────────────────────────────────

export function generateCIOChartSVG(ticker, candleCache, entryAnnotation = null) {
  const TFS = [
    { key: "240", label: "4H", bars: 60, role: "DIRECTION" },
    { key: "60",  label: "1H", bars: 60, role: "DIRECTION" },
    { key: "30",  label: "30m", bars: 60, role: "MANAGEMENT" },
    { key: "15",  label: "15m", bars: 60, role: "ENTRY" },
  ];

  const W = 1200, H = 900;
  const paneW = W / 2, paneH = H / 2;
  const PAD = 8, CANDLE_PAD = 2;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="monospace" font-size="10">`;
  svg += `<rect width="${W}" height="${H}" fill="#1a1a2e"/>`;

  TFS.forEach((tf, idx) => {
    const col = idx % 2, row = Math.floor(idx / 2);
    const ox = col * paneW, oy = row * paneH;
    const candles = (candleCache?.[tf.key] || []).slice(-tf.bars);
    if (candles.length < 5) {
      svg += `<text x="${ox + paneW/2}" y="${oy + paneH/2}" fill="#666" text-anchor="middle">${tf.label}: No data</text>`;
      return;
    }

    svg += `<rect x="${ox}" y="${oy}" width="${paneW}" height="${paneH}" fill="none" stroke="#333" stroke-width="1"/>`;
    svg += `<text x="${ox + 8}" y="${oy + 16}" fill="#8af" font-weight="bold">${tf.label} — ${tf.role}</text>`;

    const chartY = oy + 24, chartH = (tf.key === "30" || tf.key === "15") ? paneH * 0.65 - 24 : paneH - 32;
    const chartW = paneW - PAD * 2;
    const cw = Math.max(2, (chartW - CANDLE_PAD * candles.length) / candles.length);

    const highs = candles.map(c => c.h), lows = candles.map(c => c.l);
    const maxP = Math.max(...highs), minP = Math.min(...lows);
    const range = maxP - minP || 1;
    const yScale = (p) => chartY + chartH - ((p - minP) / range) * chartH;

    candles.forEach((c, i) => {
      const x = ox + PAD + i * (cw + CANDLE_PAD);
      const isGreen = c.c >= c.o;
      const color = isGreen ? "#26a69a" : "#ef5350";
      const bodyTop = yScale(Math.max(c.o, c.c));
      const bodyBot = yScale(Math.min(c.o, c.c));
      const bodyH = Math.max(1, bodyBot - bodyTop);
      svg += `<line x1="${x + cw/2}" y1="${yScale(c.h)}" x2="${x + cw/2}" y2="${yScale(c.l)}" stroke="${color}" stroke-width="1"/>`;
      svg += `<rect x="${x}" y="${bodyTop}" width="${cw}" height="${bodyH}" fill="${color}"/>`;
    });

    const closes = candles.map(c => c.c);
    const drawEma = (period, color) => {
      if (closes.length < period) return;
      const emaVals = [];
      let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = 0; i < closes.length; i++) {
        if (i < period - 1) { emaVals.push(null); continue; }
        if (i === period - 1) { emaVals.push(prev); continue; }
        prev = closes[i] * (2 / (period + 1)) + prev * (1 - 2 / (period + 1));
        emaVals.push(prev);
      }
      let pts = [];
      emaVals.forEach((v, i) => {
        if (v === null) return;
        const x = ox + PAD + i * (cw + CANDLE_PAD) + cw / 2;
        pts.push(`${x},${yScale(v)}`);
      });
      if (pts.length > 1) svg += `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.2" opacity="0.8"/>`;
    };
    drawEma(9, "#4fc3f7");
    drawEma(21, "#ffa726");
    drawEma(48, "#ef5350");

    const stLevels = candles.map(c => ({ dir: c.stDir, line: c.stLine })).filter(s => s.line > 0);
    if (stLevels.length > 2) {
      let stPts = [];
      stLevels.forEach((s, i) => {
        const ci = candles.length - stLevels.length + i;
        const x = ox + PAD + ci * (cw + CANDLE_PAD) + cw / 2;
        const stColor = s.dir === -1 ? "#26a69a" : "#ef5350";
        stPts.push({ x, y: yScale(s.line), color: stColor });
      });
      for (let i = 1; i < stPts.length; i++) {
        svg += `<line x1="${stPts[i-1].x}" y1="${stPts[i-1].y}" x2="${stPts[i].x}" y2="${stPts[i].y}" stroke="${stPts[i].color}" stroke-width="1.5" opacity="0.6"/>`;
      }
    }

    if (tf.key === "30" || tf.key === "15") {
      const rsiY = oy + paneH * 0.65, rsiH = paneH * 0.30;
      svg += `<line x1="${ox}" y1="${rsiY}" x2="${ox + paneW}" y2="${rsiY}" stroke="#333" stroke-width="0.5"/>`;
      svg += `<line x1="${ox + PAD}" y1="${rsiY + rsiH * 0.3}" x2="${ox + chartW + PAD}" y2="${rsiY + rsiH * 0.3}" stroke="#555" stroke-width="0.5" stroke-dasharray="3"/>`;
      svg += `<line x1="${ox + PAD}" y1="${rsiY + rsiH * 0.7}" x2="${ox + chartW + PAD}" y2="${rsiY + rsiH * 0.7}" stroke="#555" stroke-width="0.5" stroke-dasharray="3"/>`;
      svg += `<text x="${ox + 8}" y="${rsiY + 12}" fill="#888" font-size="9">RSI</text>`;
      svg += `<text x="${ox + chartW}" y="${rsiY + rsiH * 0.3 + 3}" fill="#666" font-size="8" text-anchor="end">70</text>`;
      svg += `<text x="${ox + chartW}" y="${rsiY + rsiH * 0.7 + 3}" fill="#666" font-size="8" text-anchor="end">30</text>`;

      if (closes.length >= 15) {
        const rsiPeriod = 14;
        let gains = 0, losses = 0;
        for (let i = 1; i <= rsiPeriod; i++) {
          const d = closes[i] - closes[i - 1];
          if (d > 0) gains += d; else losses -= d;
        }
        let avgGain = gains / rsiPeriod, avgLoss = losses / rsiPeriod;
        const rsiArr = [100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss))];
        for (let i = rsiPeriod + 1; i < closes.length; i++) {
          const d = closes[i] - closes[i - 1];
          avgGain = (avgGain * (rsiPeriod - 1) + (d > 0 ? d : 0)) / rsiPeriod;
          avgLoss = (avgLoss * (rsiPeriod - 1) + (d < 0 ? -d : 0)) / rsiPeriod;
          rsiArr.push(100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)));
        }
        let rsiPts = [];
        const rsiStart = closes.length - rsiArr.length;
        rsiArr.forEach((v, i) => {
          const ci = rsiStart + i;
          const x = ox + PAD + ci * (cw + CANDLE_PAD) + cw / 2;
          const y = rsiY + rsiH * (1 - v / 100);
          rsiPts.push(`${x},${y}`);
        });
        if (rsiPts.length > 1) svg += `<polyline points="${rsiPts.join(" ")}" fill="none" stroke="#ba68c8" stroke-width="1.2"/>`;
      }
    }

    if (tf.key === "15" && entryAnnotation) {
      const ep = Number(entryAnnotation.price);
      if (ep > minP && ep < maxP) {
        const ey = yScale(ep);
        svg += `<line x1="${ox + PAD}" y1="${ey}" x2="${ox + paneW - PAD}" y2="${ey}" stroke="#ffeb3b" stroke-width="1" stroke-dasharray="4"/>`;
        svg += `<text x="${ox + paneW - PAD - 4}" y="${ey - 4}" fill="#ffeb3b" font-size="9" text-anchor="end">${entryAnnotation.label || "ENTRY"} ${ep.toFixed(2)}</text>`;
      }
    }

    svg += `<text x="${ox + paneW - PAD}" y="${chartY + 12}" fill="#aaa" font-size="9" text-anchor="end">${maxP.toFixed(2)}</text>`;
    svg += `<text x="${ox + paneW - PAD}" y="${chartY + chartH - 2}" fill="#aaa" font-size="9" text-anchor="end">${minP.toFixed(2)}</text>`;
  });

  svg += `<text x="${W/2}" y="${H - 4}" fill="#555" font-size="9" text-anchor="middle">${ticker} — CIO Chart Vision</text>`;
  svg += `</svg>`;
  return svg;
}

export function svgToBase64DataUri(svgString) {
  const encoded = btoa(unescape(encodeURIComponent(svgString)));
  return `data:image/svg+xml;base64,${encoded}`;
}

// ── API Evaluation Functions ────────────────────────────────────────────────

export async function evaluateWithAICIO(env, proposal, memory, chartSvg = null, modelOverride = null) {
  const apiKey = env?.OPENAI_API_KEY;
  if (!apiKey) return { decision: "APPROVE", fallback: true, reason: "no_api_key" };

  // 2026-05-28 — populate per-isolate model_config cache for HTTP-path
  // callers (probe + future direct invocations). Skipped silently in
  // replay since replay routes already pre-load deepAuditConfig.
  if (env?.DB && !modelOverride) await ensureCioModelCache(env);

  try {
    const entryTimeoutMs = resolveCioTimeoutMs(env, "entry");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), entryTimeoutMs);

    const useVision = !!chartSvg;
    // 2026-05-28 — resolved model: explicit override → model_config → env var
    // → lane fallback. Lets operators upgrade to gpt-5.4 (or any other model)
    // via a single model_config row, no redeploy.
    const entryModel = resolveCioModel(env, "entry", useVision, modelOverride);

    const userContent = useVision ? [
      { type: "text", text: AI_CIO_USER_TEMPLATE(proposal, memory) },
      { type: "image_url", image_url: { url: svgToBase64DataUri(chartSvg), detail: "high" } },
    ] : AI_CIO_USER_TEMPLATE(proposal, memory);

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildOpenAIBody(
        entryModel,
        [
          { role: "system", content: AI_CIO_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        // 2026-05-28 — 500 -> 1200. User reported reasoning truncated
        // mid-sentence in the Discord embed AND in the rail (ends with
        // "...sitting in premium PDZ with"). Root cause: this cap was
        // tight enough that the JSON payload (decision/confidence/edge/
        // risk_flags/adjustments + reasoning) consumed the full 500
        // tokens and the model ran out of tokens partway through the
        // reasoning string. 1200 leaves comfortable headroom for the
        // reasoning paragraph without spending materially more on
        // latency/cost (the model still stops at the end of the JSON).
        1200,
        { temperature: 0.1, responseFormat: { type: "json_object" } },
      )),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.warn(`[AI_CIO] OpenAI ${resp.status} (model=${entryModel}): ${errText.slice(0, 150)}`);
      return { decision: "APPROVE", fallback: true, reason: `api_error_${resp.status}`, model: entryModel };
    }

    const json = await resp.json();
    const raw = json.choices?.[0]?.message?.content || "";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(`[AI_CIO] Failed to parse response (model=${entryModel}): ${raw.slice(0, 200)}`);
      return { decision: "APPROVE", fallback: true, reason: "parse_error", model: entryModel };
    }

    parsed.model_used = entryModel;
    parsed.chart_vision = useVision;

    const decision = String(parsed.decision || "APPROVE").toUpperCase();
    if (!["APPROVE", "ADJUST", "REJECT"].includes(decision)) {
      return { decision: "APPROVE", fallback: true, reason: "invalid_decision", model: entryModel };
    }

    return {
      decision,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      reasoning: String(parsed.reasoning || "").slice(0, 300),
      adjustments: decision === "ADJUST" ? {
        sl: Number.isFinite(Number(parsed.adjustments?.sl)) ? Number(parsed.adjustments.sl) : null,
        tp: Number.isFinite(Number(parsed.adjustments?.tp)) ? Number(parsed.adjustments.tp) : null,
        size_mult: Number.isFinite(Number(parsed.adjustments?.size_mult))
          ? Math.max(0.25, Math.min(1.5, Number(parsed.adjustments.size_mult)))
          : null,
        reason: String(parsed.adjustments?.reason || "").slice(0, 200),
      } : null,
      risk_flags: Array.isArray(parsed.risk_flags) ? parsed.risk_flags.slice(0, 5).map(f => String(f).slice(0, 50)) : [],
      edge_score: Math.max(0, Math.min(1, Number(parsed.edge_score) || 0.5)),
      fallback: false,
      // 2026-05-28 — record the actual model that decided this trade, not the
      // hardcoded AI_CIO_MODEL constant. Critical for A/B comparison and for
      // operator visibility when running mixed models.
      model: entryModel,
      latency_ms: null,
    };
  } catch (err) {
    const isTimeout = err?.name === "AbortError";
    console.warn(`[AI_CIO] ${isTimeout ? "Timeout" : "Error"}: ${String(err).slice(0, 150)}`);
    return { decision: "APPROVE", fallback: true, reason: isTimeout ? "timeout" : "exception" };
  }
}

export async function evaluateCIOLifecycle(env, proposal, memory, chartSvg = null, modelOverride = null) {
  const apiKey = env?.OPENAI_API_KEY;
  if (!apiKey) return { decision: "PROCEED", fallback: true, reason: "no_api_key" };

  // 2026-05-28 — populate per-isolate model_config cache (see evaluateWithAICIO).
  if (env?.DB && !modelOverride) await ensureCioModelCache(env);

  const lifecycleTimeoutMs = resolveCioTimeoutMs(env, "lifecycle");
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), lifecycleTimeoutMs);

    const useVision = !!chartSvg;
    // 2026-05-28 — lifecycle decisions are loss-bearing (per-position) and
    // deserve the same model-selection plumbing as entry. Previously
    // hardcoded to AI_CIO_MODEL (gpt-4o-mini) even when chartSvg was passed.
    const lifecycleModel = resolveCioModel(env, "lifecycle", useVision, modelOverride);

    const userContent = useVision ? [
      { type: "text", text: AI_CIO_LIFECYCLE_TEMPLATE(proposal, memory) },
      { type: "image_url", image_url: { url: svgToBase64DataUri(chartSvg), detail: "low" } },
    ] : AI_CIO_LIFECYCLE_TEMPLATE(proposal, memory);

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildOpenAIBody(
        lifecycleModel,
        [
          { role: "system", content: AI_CIO_LIFECYCLE_PROMPT },
          { role: "user", content: userContent },
        ],
        // 2026-05-28 — 400 -> 900. Same truncation pattern as the
        // entry call above (just smaller because lifecycle JSON is
        // tighter). Lifecycle decisions still need 1-2 paragraphs of
        // reasoning so the operator/trader understands why we held,
        // proceeded, or pulled the trigger.
        1500,
        { temperature: 0.1, responseFormat: { type: "json_object" } },
      )),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.warn(`[AI_CIO_LIFECYCLE] OpenAI ${resp.status} (model=${lifecycleModel}): ${errText.slice(0, 150)}`);
      return { decision: "PROCEED", fallback: true, reason: `api_error_${resp.status}`, model: lifecycleModel };
    }

    const json = await resp.json();
    const raw = json.choices?.[0]?.message?.content || "";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      console.warn(`[AI_CIO_LIFECYCLE] Parse error (model=${lifecycleModel}): ${raw.slice(0, 200)}`);
      return { decision: "PROCEED", fallback: true, reason: "parse_error", model: lifecycleModel };
    }

    const decision = String(parsed.decision || "PROCEED").toUpperCase();
    if (!["PROCEED", "HOLD", "OVERRIDE"].includes(decision)) {
      return { decision: "PROCEED", fallback: true, reason: "invalid_decision", model: lifecycleModel };
    }

    return {
      decision,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      reasoning: String(parsed.reasoning || "").slice(0, 300),
      override: decision === "OVERRIDE" ? {
        trim_pct: Number.isFinite(Number(parsed.override?.trim_pct)) ? Math.max(0, Math.min(1, Number(parsed.override.trim_pct))) : null,
        trail_stop_pct: Number.isFinite(Number(parsed.override?.trail_stop_pct)) ? Number(parsed.override.trail_stop_pct) : null,
        hold_bars: Number.isFinite(Number(parsed.override?.hold_bars)) ? Math.min(20, Number(parsed.override.hold_bars)) : null,
      } : null,
      risk_flags: Array.isArray(parsed.risk_flags) ? parsed.risk_flags.slice(0, 5) : [],
      edge_remaining: Math.max(0, Math.min(1, Number(parsed.edge_remaining) || 0.5)),
      fallback: false,
      model: lifecycleModel,
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      console.warn(`[AI_CIO_LIFECYCLE] Timeout (${lifecycleTimeoutMs}ms)`);
      return { decision: "PROCEED", fallback: true, reason: "timeout" };
    }
    console.warn(`[AI_CIO_LIFECYCLE] Error: ${String(err).slice(0, 150)}`);
    return { decision: "PROCEED", fallback: true, reason: "exception" };
  }
}
