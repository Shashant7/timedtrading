// Action provenance — compact technical + research refs for every trade action.
// -----------------------------------------------------------------------------
// Self-calibrating loop keystone: decision_records.inputs_json must answer
// "why did the model act?" with referenceable technical + research inputs —
// Short Term (trader) and Long Term (investor) alike.
//
// Pure helpers only. Callers merge the result into decision_records inputs
// (d1InsertTradeEvent, DEFEND writers, investor recordInvestorDecision).
// Cap is enforced downstream by decision-records.js (MAX_JSON ~16k).
// -----------------------------------------------------------------------------

const TF_KEYS = ["15", "30", "60", "1H", "240", "4H", "D", "W"];

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v, max = 120) {
  if (v == null) return null;
  const s = String(v);
  return s ? s.slice(0, max) : null;
}

/** Compact per-TF technical stack (bias / RSI / SuperTrend / EMA21). */
export function compactTfTech(tickerData) {
  const tt = tickerData?.tf_tech;
  if (!tt || typeof tt !== "object") return null;
  const out = {};
  for (const k of TF_KEYS) {
    const t = tt[k];
    if (!t || typeof t !== "object") continue;
    const rsi = numOrNull(t.rsi?.rsi ?? t.rsi?.value ?? t.rsi);
    const stDir = t.supertrend?.direction ?? t.st?.direction ?? t.supertrend_dir ?? null;
    const ema21 = numOrNull(t.ema21 ?? t.ema?.ema21 ?? t.emas?.ema21);
    const bias = t.bias ?? t.trend_bias ?? null;
    if (rsi == null && stDir == null && ema21 == null && bias == null) continue;
    out[k] = {
      bias: bias != null ? String(bias) : null,
      rsi,
      st: stDir != null ? String(stDir) : null,
      ema21,
    };
  }
  return Object.keys(out).length ? out : null;
}

/** Research / fundamental overlays stamped on tickerData at scoring time. */
export function compactResearchRefs(tickerData) {
  if (!tickerData || typeof tickerData !== "object") return null;
  const compounder = tickerData._compounder || tickerData.compounder || null;
  const fv = tickerData._fair_value || tickerData.fair_value || null;
  const bc = tickerData._business_character || tickerData.business_character || null;
  const fsd =
    tickerData.fsd_alignment
    || tickerData.__fsd_alignment
    || tickerData._fsd
    || tickerData.fsd
    || null;

  const research = {
    compounder: compounder
      ? {
          tier: compounder.tier ?? null,
          tier_label: compounder.tier_label ?? null,
          eligible: compounder.eligible === true,
          dip_buy: compounder.dip_buy === true,
          dip_signals: Array.isArray(compounder.dip_signals)
            ? compounder.dip_signals.slice(0, 8)
            : [],
          boost: compounder.boost ?? null,
        }
      : null,
    fair_value: fv
      ? {
          fair_value: fv.fair_value ?? null,
          fv_premium_pct: fv.fv_premium_pct ?? null,
          fv_class: fv.fv_class ?? null,
          quality_grade: fv.quality_grade ?? null,
          growth_detected: fv.growth_detected ?? null,
          tilt: fv.tilt ?? null,
        }
      : null,
    business_character: bc
      ? {
          archetype: bc.archetype ?? null,
          quality_grade: bc.quality_grade ?? null,
          growth_class: bc.growth_class ?? null,
          valuation_state: bc.valuation_state ?? null,
          compounder_tier: bc.compounder_tier ?? null,
          pullback_means: bc.technical_lens?.pullback_means ?? null,
          summary: bc.technical_lens?.summary
            ? String(bc.technical_lens.summary).slice(0, 200)
            : null,
        }
      : null,
    fsd_alignment: fsd
      ? {
          vintage: fsd.vintage ?? null,
          stance: fsd.stance ?? fsd.tier ?? null,
          on_thesis: fsd.on_thesis ?? fsd.isPick ?? null,
          tier: fsd.tier ?? null,
          tactical_matches: Array.isArray(fsd.tactical_matches)
            ? fsd.tactical_matches.slice(0, 4)
            : undefined,
        }
      : null,
    sector: tickerData.sector || tickerData.context?.sector || null,
    themes: Array.isArray(tickerData.themes)
      ? tickerData.themes.slice(0, 6)
      : (Array.isArray(tickerData._themes) ? tickerData._themes.slice(0, 6) : null),
  };

  const hasAny = research.compounder || research.fair_value
    || research.business_character || research.fsd_alignment
    || research.sector || (research.themes && research.themes.length);
  return hasAny ? research : null;
}

/** Core TA / setup / path context at action time. */
export function compactTechnicalRefs(tickerData, trade = null) {
  if (!tickerData && !trade) return null;
  const d = tickerData || {};
  const t = trade || {};
  const technical = {
    rank: numOrNull(d.rank ?? t.rank),
    rr: numOrNull(d.rr ?? t.rr),
    state: strOrNull(d.state ?? t.state, 40),
    setup_name: strOrNull(d.setupName || d.setup_name || t.setup_name, 80),
    setup_grade: strOrNull(d.setupGrade || d.setup_grade || t.setup_grade, 20),
    entry_path: strOrNull(d.__entry_path || d.entry_path || t.entry_path, 80),
    direction: strOrNull(d.direction || t.direction, 8),
    kanban: strOrNull(d.kanban_stage || d.kanban || t.kanban_stage, 40),
    conviction_tier: strOrNull(
      d.__conviction_tier || d.conviction_tier || t.conviction_tier,
      8,
    ),
    regime_class: strOrNull(d.regime_class || t.entry_latent_regime, 40),
    latent_regime: d.latent_regime?.state
      ? {
          state: d.latent_regime.state,
          confidence: numOrNull(
            d.latent_regime.posterior
              ? Math.max(...Object.values(d.latent_regime.posterior).map(Number).filter(Number.isFinite))
              : null,
          ),
        }
      : null,
    sl: numOrNull(t.sl ?? d.sl),
    tp: numOrNull(t.tp ?? d.tp),
    price: numOrNull(d.price ?? d._live_price ?? d.close ?? t.entryPrice),
    tf_tech: compactTfTech(d),
    flags: d.flags && typeof d.flags === "object"
      ? {
          st_flip_bull: !!d.flags.st_flip_bull,
          st_flip_bear: !!d.flags.st_flip_bear,
          sq30_release: !!d.flags.sq30_release,
          momentum_elite: !!d.flags.momentum_elite,
          quality_compounder_dip: !!d.flags.quality_compounder_dip,
        }
      : null,
    learning_policy: d.__learning_policy
      ? {
          source: d.__learning_policy.source || d.__learning_policy_source || null,
          match: d.__learning_policy.match || null,
          recommend: d.__learning_policy.recommend || null,
        }
      : null,
  };

  const hasAny = Object.values(technical).some((v) => v != null && v !== "");
  return hasAny ? technical : null;
}

/**
 * Pick the "why" fields from a trade history event / DEFEND payload so the
 * calibration loop can attribute the action without replaying the full ledger.
 */
export function compactActionWhy(event = {}, extras = {}) {
  const e = event && typeof event === "object" ? event : {};
  return {
    type: strOrNull(e.type || extras.eventType, 24),
    reason: strOrNull(e.reason || extras.reason, 240),
    exit_reason: strOrNull(e.exitReason || e.exit_reason || extras.exit_reason, 120),
    exit_category: strOrNull(e.exitCategory || e.exit_category || extras.exit_category, 60),
    defend_reason: strOrNull(
      e.defend_reason || e.defendReason || extras.defend_reason,
      120,
    ),
    note: strOrNull(e.note, 200),
    decision_category: strOrNull(e.decisionCategory || e.decision_category, 60),
    setup_name: strOrNull(e.setup_name || extras.setup_name, 80),
    setup_grade: strOrNull(e.setup_grade || extras.setup_grade, 20),
    entry_path: strOrNull(e.entry_path || extras.entry_path, 80),
    kanban: strOrNull(e.kanban || e.KANBAN_IN_REVIEW || extras.kanban, 40),
    conviction_tier: strOrNull(e.conviction_tier || e.convictionTier || extras.conviction_tier, 8),
    thesis: strOrNull(e.thesis, 240),
    pnl_pct: numOrNull(e.pnl_pct ?? e.pnlPct ?? extras.pnl_pct),
    old_sl: numOrNull(e.old_sl ?? extras.old_sl),
    new_sl: numOrNull(e.new_sl ?? extras.new_sl),
    protection_stage: strOrNull(e.protection_stage || extras.protection_stage, 40),
  };
}

/**
 * Build rich inputs for a trader (Short Term) decision_record.
 * Merges event-level why + technical + research. Keeps a shallow copy of
 * useful event scalars so existing consumers of thin meta still work.
 */
export function buildTraderActionProvenance(opts = {}) {
  const event = opts.event && typeof opts.event === "object" ? opts.event : {};
  const tickerData = opts.tickerData || null;
  const trade = opts.trade || null;
  const extras = opts.extras && typeof opts.extras === "object" ? opts.extras : {};

  const why = compactActionWhy(event, extras);
  const technical = compactTechnicalRefs(tickerData, trade);
  const research = compactResearchRefs(tickerData);

  // Preserve common event scalars (price/rank/setup/…) for backward compat
  // with thin meta consumers, without dumping unbounded blobs.
  const eventCore = {
    price: numOrNull(event.price),
    shares: numOrNull(event.shares),
    value: numOrNull(event.value),
    trimPct: numOrNull(event.trimPct ?? event.trimmedPct),
    trimDeltaPct: numOrNull(event.trimDeltaPct),
    rank: numOrNull(event.rank),
    rr: numOrNull(event.rr),
    direction: strOrNull(event.direction, 8),
    setup_name: strOrNull(event.setup_name, 80),
    setup_grade: strOrNull(event.setup_grade, 20),
    entry_price: numOrNull(event.entry_price),
    sl_price: numOrNull(event.sl_price),
    tp_price: numOrNull(event.tp_price),
    KANBAN_IN_REVIEW: event.KANBAN_IN_REVIEW ?? null,
  };

  return {
    engine: "trader",
    provenance_v: 1,
    why,
    technical,
    research,
    event: eventCore,
    ...extras.overlay,
  };
}

/**
 * Merge provenance onto an existing inputs object (DEFEND / partial writers).
 * Never drops caller-supplied keys; provenance fills technical/research/why.
 */
export function enrichDecisionInputs(baseInputs, opts = {}) {
  const base = baseInputs && typeof baseInputs === "object" ? { ...baseInputs } : {};
  const prov = buildTraderActionProvenance({
    event: opts.event || { type: opts.eventType, reason: opts.reason, ...base },
    tickerData: opts.tickerData,
    trade: opts.trade,
    extras: {
      eventType: opts.eventType,
      reason: opts.reason,
      ...opts.extras,
      overlay: undefined,
    },
  });
  return {
    ...base,
    engine: base.engine || "trader",
    provenance_v: 1,
    why: { ...prov.why, ...pickDefined(base.why) },
    technical: base.technical || prov.technical,
    research: base.research || prov.research,
    event: base.event || prov.event,
  };
}

function pickDefined(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null && v !== "") out[k] = v;
  }
  return out;
}
