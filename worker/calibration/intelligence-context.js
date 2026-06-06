// worker/calibration/intelligence-context.js
//
// Loads AI CIO judgement + Research Desk editorial context into the
// statistical calibration pipeline. Trade autopsy remains the primary
// signal; intelligence nudges are capped at INTELLIGENCE_BLEND (15%).

const INTELLIGENCE_BLEND = 0.15;
const LOOKBACK_MS = 30 * 86400000;

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pct(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function parseProposalBucket(row) {
  try {
    const raw = row?.proposal_json;
    if (!raw) return null;
    const p = typeof raw === "string" ? JSON.parse(raw) : raw;
    return p?.bucket || p?.type || p?.lifecycle_type || null;
  } catch {
    return null;
  }
}

function isLifecycleDecision(row) {
  const d = String(row?.decision || "").toUpperCase();
  if (["PROCEED", "HOLD", "OVERRIDE"].includes(d)) return true;
  const bucket = String(parseProposalBucket(row) || "").toLowerCase();
  return /trim|exit|rebalance|sl_move|defend|lifecycle/.test(bucket);
}

function isEntryDecision(row) {
  const d = String(row?.decision || "").toUpperCase();
  return ["APPROVE", "ADJUST", "REJECT"].includes(d);
}

/**
 * Load CIO decisions + desk editorial from D1/KV.
 */
export async function loadCalibrationIntelligenceContext(env) {
  const db = env?.DB;
  const KV = env?.KV_TIMED || env?.KV;
  const cutoff = Date.now() - LOOKBACK_MS;
  const out = {
    ok: true,
    loaded_at: Date.now(),
    lookback_days: 30,
    cio: null,
    desk: null,
    sources: [],
  };

  // ── CIO decisions (live only) ──
  if (db) {
    try {
      const { results = [] } = await db.prepare(
        `SELECT ticker, direction, decision, confidence, reasoning, risk_flags,
                edge_score, fallback, model, proposal_json, created_at, shadow, trade_outcome
         FROM ai_cio_decisions
         WHERE created_at >= ?1 AND COALESCE(shadow, 0) = 0 AND COALESCE(is_replay, 0) = 0
         ORDER BY created_at DESC
         LIMIT 2000`,
      ).bind(cutoff).all();

      const entry = results.filter(isEntryDecision);
      const lifecycle = results.filter(isLifecycleDecision);
      const trimLifecycle = lifecycle.filter((r) => {
        const b = String(parseProposalBucket(r) || "").toLowerCase();
        return b.includes("trim") || b.includes("rebalance") || String(r.reasoning || "").toLowerCase().includes("trim");
      });

      const entryByDecision = {};
      for (const r of entry) {
        const d = String(r.decision || "").toUpperCase();
        entryByDecision[d] = (entryByDecision[d] || 0) + 1;
      }

      const lifeByDecision = {};
      for (const r of lifecycle) {
        const d = String(r.decision || "").toUpperCase();
        lifeByDecision[d] = (lifeByDecision[d] || 0) + 1;
      }

      const rejectedTickers = {};
      for (const r of entry.filter((x) => String(x.decision).toUpperCase() === "REJECT")) {
        const sym = String(r.ticker || "").toUpperCase();
        if (sym) rejectedTickers[sym] = (rejectedTickers[sym] || 0) + 1;
      }

      const holdTrims = trimLifecycle.filter((r) => String(r.decision).toUpperCase() === "HOLD").length;
      const overrideTrims = trimLifecycle.filter((r) => String(r.decision).toUpperCase() === "OVERRIDE").length;
      const proceedTrims = trimLifecycle.filter((r) => String(r.decision).toUpperCase() === "PROCEED").length;
      const trimTotal = trimLifecycle.length || 1;

      const attributed = entry.filter((r) => r.trade_outcome);
      const attributedWins = attributed.filter((r) => r.trade_outcome === "WIN").length;

      out.cio = {
        total_decisions: results.length,
        entry: {
          count: entry.length,
          approve: entryByDecision.APPROVE || 0,
          adjust: entryByDecision.ADJUST || 0,
          reject: entryByDecision.REJECT || 0,
          reject_rate_pct: pct(entryByDecision.REJECT || 0, entry.length),
          approve_rate_pct: pct(entryByDecision.APPROVE || 0, entry.length),
          attributed_count: attributed.length,
          attributed_win_rate_pct: pct(attributedWins, attributed.length),
          top_rejected_tickers: Object.entries(rejectedTickers)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([ticker, count]) => ({ ticker, count })),
        },
        lifecycle: {
          count: lifecycle.length,
          proceed: lifeByDecision.PROCEED || 0,
          hold: lifeByDecision.HOLD || 0,
          override: lifeByDecision.OVERRIDE || 0,
          hold_rate_pct: pct(lifeByDecision.HOLD || 0, lifecycle.length),
          override_rate_pct: pct(lifeByDecision.OVERRIDE || 0, lifecycle.length),
        },
        trim_bias: {
          sample: trimLifecycle.length,
          hold_pct: pct(holdTrims, trimTotal),
          override_pct: pct(overrideTrims, trimTotal),
          proceed_pct: pct(proceedTrims, trimTotal),
          interpretation: holdTrims > overrideTrims
            ? "CIO is holding trims more than overriding — favors letting winners run."
            : overrideTrims > holdTrims
              ? "CIO is overriding trims more than holding — favors faster profit protection."
              : "Trim bias neutral in the lookback window.",
        },
      };
      out.sources.push("ai_cio_decisions");
    } catch (e) {
      out.cio = { error: String(e?.message || e).slice(0, 200) };
    }
  }

  // ── Research Desk: tactical override + CRO daily note ──
  if (KV) {
    try {
      const tacticalRaw = await KV.get("cro:tactical_overrides");
      const tactical = tacticalRaw ? JSON.parse(tacticalRaw) : null;
      const croRaw = await KV.get("timed:cro:latest");
      const croNote = croRaw ? JSON.parse(croRaw) : null;

      const cautionRe = /(caution|bearish|under|reduce|fade|trim|down|stretch)/i;
      const cautionThemes = [];
      const favorThemes = [];
      const cautionSectors = [];
      const favorSectors = [];

      for (const sig of (tactical?.tactical_signals || [])) {
        const sign = cautionRe.test(String(sig.direction || "")) ? "caution" : "favor";
        for (const th of (sig.affected_tier1_themes || [])) {
          (sign === "caution" ? cautionThemes : favorThemes).push({ theme: th, signal: sig.signal, direction: sig.direction });
        }
        for (const sec of (sig.affected_sectors_overweight || [])) {
          favorSectors.push({ sector: sec, signal: sig.signal });
        }
      }

      for (const n of (tactical?.sector_notes || [])) {
        if (!n?.sector || !n?.tactical_note) continue;
        const sign = cautionRe.test(String(n.tactical_note)) ? "caution" : "favor";
        (sign === "caution" ? cautionSectors : favorSectors).push({
          sector: n.sector,
          note: String(n.tactical_note).slice(0, 160),
          source: "editorial_sector_note",
        });
      }

      for (const n of (tactical?.theme_notes || [])) {
        if (!n?.theme || !n?.tactical_note) continue;
        const sign = cautionRe.test(String(n.tactical_note)) ? "caution" : "favor";
        (sign === "caution" ? cautionThemes : favorThemes).push({
          theme: n.theme,
          note: String(n.tactical_note).slice(0, 160),
          source: "editorial_theme_note",
        });
      }

      out.desk = {
        tactical_overlay: tactical?.tactical_overlay || tactical?.tactical_title || null,
        tactical_vintage: tactical?.tactical_vintage || null,
        signals_live: Array.isArray(tactical?.tactical_signals) ? tactical.tactical_signals.length : 0,
        caution_themes: cautionThemes.slice(0, 6),
        favor_themes: favorThemes.slice(0, 6),
        caution_sectors: cautionSectors.slice(0, 6),
        favor_sectors: favorSectors.slice(0, 6),
        active_risks: (Array.isArray(tactical?.active_risks_add) ? tactical.active_risks_add : [])
          .slice(0, 4)
          .map((r) => ({ name: r.name, severity: r.severity, note: String(r.note || "").slice(0, 120) })),
        cro_verdict: croNote?.verdict ? String(croNote.verdict).slice(0, 400) : null,
        cro_as_of: croNote?.as_of_date || croNote?.produced_at || null,
        cro_observations: (croNote?.observations || []).slice(0, 3).map((o) => ({
          section: o.section,
          text: String(o.text || "").slice(0, 180),
        })),
      };
      out.sources.push("cro:tactical_overrides", "timed:cro:latest");
    } catch (e) {
      out.desk = { error: String(e?.message || e).slice(0, 200) };
    }
  }

  return out;
}

function blendKnob(base, delta, blend = INTELLIGENCE_BLEND) {
  const b = num(base);
  if (b == null) return base;
  return Math.round((b + delta * blend) * 100) / 100;
}

/**
 * Nudge calibration recommendations using CIO judgement + desk editorial.
 * Returns { recommendations, adjustments, intelligence_context }.
 */
export async function applyIntelligenceToCalibration(env, recommendations, options = {}) {
  const ctx = await loadCalibrationIntelligenceContext(env);
  const adjustments = [];
  const recs = { ...recommendations };
  const blend = num(options.blend, INTELLIGENCE_BLEND) || INTELLIGENCE_BLEND;

  let SectorMap = null;
  try {
    SectorMap = await import("../sector-mapping.js");
  } catch (_) {}

  // ── CIO entry strictness → rank threshold ──
  const rejectRate = num(ctx.cio?.entry?.reject_rate_pct);
  if (rejectRate != null && rejectRate > 50 && recs.rank_threshold != null) {
    const delta = Math.min(8, Math.round((rejectRate - 50) / 5));
    const before = recs.rank_threshold;
    recs.rank_threshold = Math.round(blendKnob(before, delta, blend));
    adjustments.push({
      knob: "rank_threshold",
      before,
      after: recs.rank_threshold,
      reason: `CIO entry reject rate ${rejectRate}% — tighten rank bar`,
      source: "cio_entry",
    });
  } else if (rejectRate != null && rejectRate < 25 && recs.rank_threshold != null) {
    const delta = -Math.min(5, Math.round((25 - rejectRate) / 5));
    const before = recs.rank_threshold;
    recs.rank_threshold = Math.round(blendKnob(before, delta, blend));
    adjustments.push({
      knob: "rank_threshold",
      before,
      after: recs.rank_threshold,
      reason: `CIO entry reject rate ${rejectRate}% — loosen rank bar slightly`,
      source: "cio_entry",
    });
  }

  // ── CIO trim bias → TP tiers ──
  const holdTrimPct = num(ctx.cio?.trim_bias?.hold_pct);
  const overrideTrimPct = num(ctx.cio?.trim_bias?.override_pct);
  if (recs.tp_tiers && ctx.cio?.trim_bias?.sample >= 10) {
    let tpDelta = 0;
    if (holdTrimPct > overrideTrimPct + 15) tpDelta = 0.15; // hold trims → wider targets
    else if (overrideTrimPct > holdTrimPct + 15) tpDelta = -0.15; // override trims → tighter targets

    if (tpDelta !== 0) {
      const before = { ...recs.tp_tiers };
      recs.tp_tiers = {
        trim: blendKnob(recs.tp_tiers.trim, tpDelta, blend),
        exit: blendKnob(recs.tp_tiers.exit, tpDelta, blend),
        runner: blendKnob(recs.tp_tiers.runner, tpDelta, blend),
      };
      adjustments.push({
        knob: "tp_tiers",
        before,
        after: recs.tp_tiers,
        reason: ctx.cio.trim_bias.interpretation,
        source: "cio_trim_bias",
      });
    }
  }

  // ── Desk editorial → sector_biases on adaptive_rank_weights ──
  if (recs.adaptive_rank_weights) {
    const sectorBiases = { ...(recs.adaptive_rank_weights.sector_biases || {}) };

    for (const s of (ctx.desk?.caution_sectors || [])) {
      if (!s.sector) continue;
      const before = sectorBiases[s.sector] || 0;
      sectorBiases[s.sector] = Math.round((before - 3 * blend) * 10) / 10;
      adjustments.push({
        knob: `sector_bias:${s.sector}`,
        before,
        after: sectorBiases[s.sector],
        reason: s.note || `Desk caution on ${s.sector}`,
        source: "desk_editorial",
      });
    }

    for (const s of (ctx.desk?.favor_sectors || [])) {
      if (!s.sector) continue;
      const before = sectorBiases[s.sector] || 0;
      sectorBiases[s.sector] = Math.round((before + 2 * blend) * 10) / 10;
      adjustments.push({
        knob: `sector_bias:${s.sector}`,
        before,
        after: sectorBiases[s.sector],
        reason: s.signal || s.note || `Desk favor on ${s.sector}`,
        source: "desk_editorial",
      });
    }

    // Map CIO top-rejected tickers to sectors for rank penalty
    if (SectorMap?.SECTOR_MAP && ctx.cio?.entry?.top_rejected_tickers?.length) {
      for (const { ticker, count } of ctx.cio.entry.top_rejected_tickers.slice(0, 5)) {
        const sector = SectorMap.SECTOR_MAP[ticker];
        if (!sector || count < 2) continue;
        const before = sectorBiases[sector] || 0;
        sectorBiases[sector] = Math.round((before - count * blend) * 10) / 10;
        adjustments.push({
          knob: `sector_bias:${sector}`,
          before,
          after: sectorBiases[sector],
          reason: `CIO rejected ${ticker} ${count}× in lookback`,
          source: "cio_reject_cluster",
        });
      }
    }

    if (Object.keys(sectorBiases).length > 0) {
      recs.adaptive_rank_weights = {
        ...recs.adaptive_rank_weights,
        sector_biases: sectorBiases,
      };
    }
  }

  // ── Desk caution themes → note in recommendations (informational) ──
  if ((ctx.desk?.caution_themes || []).length > 0) {
    recs.desk_caution_themes = ctx.desk.caution_themes.map((t) => t.theme).filter(Boolean);
  }
  if (ctx.desk?.cro_verdict) {
    recs.desk_cro_verdict_excerpt = String(ctx.desk.cro_verdict).slice(0, 200);
  }

  recs.intelligence_adjustments = adjustments;
  recs.intelligence_blend = blend;

  return {
    recommendations: recs,
    intelligence_context: ctx,
    adjustments,
  };
}
