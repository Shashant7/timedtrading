// worker/fsd-level-policy.js
// ─────────────────────────────────────────────────────────────────────────────
// FSD level-conditioned runtime modes — when a ticker has FSD key-point levels,
// overlay defensive/neutral/aggressive posture by price vs those levels.
// Otherwise callers keep the existing model/runtime_policy rules.
// ─────────────────────────────────────────────────────────────────────────────

const LEVEL_KINDS = new Set(["support", "resistance", "trigger", "target", "stop"]);

const MODE_PRESETS = {
  defensive: {
    guard_bundle: "orb_defensive",
    sl_tp_style: "tight_defensive",
    entry_timing: "wait_for_reclaim",
    trim_run_bias: "quick_trim",
  },
  neutral: {
    guard_bundle: "reclaim_confirmation",
    sl_tp_style: "standard",
    entry_timing: "allow_but_reduce_chase",
    trim_run_bias: "balanced",
  },
  aggressive: {
    guard_bundle: "trend_confirmed",
    sl_tp_style: "wide_runner",
    entry_timing: "allow_momentum",
    trim_run_bias: "let_run",
  },
};

function safeJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

/** Parse "341-350" or "99.5" into numeric bounds. */
export function parseLevelString(levelStr) {
  const s = String(levelStr || "").trim();
  if (!s) return null;
  const range = s.match(/^([\d.]+)\s*[-–]\s*([\d.]+)$/);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (Number.isFinite(low) && Number.isFinite(high)) {
      return { low: Math.min(low, high), high: Math.max(low, high), mid: (low + high) / 2 };
    }
  }
  const single = Number(s.replace(/[^\d.]/g, ""));
  if (Number.isFinite(single) && single > 0) {
    return { low: single, high: single, mid: single };
  }
  return null;
}

function normalizeKeyPoint(kp) {
  if (!kp || typeof kp !== "object") return null;
  const kind = String(kp.kind || "").toLowerCase();
  if (!LEVEL_KINDS.has(kind)) return null;
  const parsed = parseLevelString(kp.level);
  if (!parsed) return null;
  return {
    kind,
    price: parsed.mid,
    low: parsed.low,
    high: parsed.high,
    direction: kp.direction || null,
    horizon: kp.horizon || null,
    note: String(kp.note || "").slice(0, 120) || null,
    source: "fsd",
    pub_id: kp.pub_id || null,
  };
}

/**
 * Load recent FSD levels for a ticker from cro_publication_rewrites key points.
 */
export async function loadFsdLevelsForTicker(env, ticker, opts = {}) {
  const db = env?.DB;
  const sym = String(ticker || "").toUpperCase();
  if (!db || !sym) return [];
  const lookbackDays = Math.max(1, Number(opts.lookbackDays) || 21);
  const since = Date.now() - lookbackDays * 86400000;
  const limit = Math.min(10, Math.max(1, Number(opts.limit) || 5));

  try {
    const rows = (await db.prepare(`
      SELECT r.pub_id, r.tt_key_points_json, p.published_at, p.fetched_at
        FROM cro_publication_rewrites r
        JOIN cro_publication_tickers pt ON pt.pub_id = r.pub_id
        JOIN cro_publications p ON p.pub_id = r.pub_id
       WHERE pt.ticker = ?1
         AND r.tt_key_points_json IS NOT NULL
         AND COALESCE(p.published_at, p.fetched_at) >= ?2
       ORDER BY COALESCE(p.published_at, p.fetched_at) DESC
       LIMIT ?3
    `).bind(sym, since, limit).all())?.results || [];

    const levels = [];
    const seen = new Set();
    for (const row of rows) {
      const kps = safeJson(row.tt_key_points_json) || [];
      for (const kp of kps) {
        if (kp?.ticker && String(kp.ticker).toUpperCase() !== sym) continue;
        const norm = normalizeKeyPoint({ ...kp, pub_id: row.pub_id });
        if (!norm) continue;
        const key = `${norm.kind}:${norm.price.toFixed(2)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        levels.push(norm);
      }
    }
    return levels.sort((a, b) => a.price - b.price);
  } catch (_) {
    return [];
  }
}

/**
 * Build level-conditioned mode rules from FSD levels + current price.
 */
export function buildLevelConditionedModes(fsdLevels = [], price, ttLevels = null) {
  const px = Number(price);
  if (!(px > 0)) return null;

  const supports = fsdLevels.filter((l) => l.kind === "support" || l.kind === "stop");
  const resistances = fsdLevels.filter((l) => l.kind === "resistance" || l.kind === "target" || l.kind === "trigger");

  const rules = [];
  for (const s of supports) {
    rules.push({
      threshold: s.price,
      compare: "below",
      mode: "defensive",
      label: `FSD ${s.kind} ${s.price}`,
      recommend: { ...MODE_PRESETS.defensive },
      level: s,
    });
  }
  for (const r of resistances) {
    rules.push({
      threshold: r.price,
      compare: "above",
      mode: "aggressive",
      label: `FSD ${r.kind} ${r.price}`,
      recommend: { ...MODE_PRESETS.aggressive },
      level: r,
    });
  }

  // Neutral band between nearest support below and resistance above.
  const supportBelow = supports.filter((s) => s.price <= px).sort((a, b) => b.price - a.price)[0] || null;
  const resistAbove = resistances.filter((r) => r.price >= px).sort((a, b) => a.price - b.price)[0] || null;
  if (supportBelow && resistAbove && resistAbove.price > supportBelow.price) {
    rules.push({
      threshold_low: supportBelow.price,
      threshold_high: resistAbove.price,
      compare: "between",
      mode: "neutral",
      label: `FSD range ${supportBelow.price}-${resistAbove.price}`,
      recommend: { ...MODE_PRESETS.neutral },
    });
  }

  let activeMode = "neutral";
  let activeRule = rules.find((r) => r.compare === "between" && px >= r.threshold_low && px <= r.threshold_high) || null;

  const belowSupport = supports.find((s) => px < s.low);
  if (belowSupport) {
    activeMode = "defensive";
    activeRule = rules.find((r) => r.compare === "below" && r.threshold === belowSupport.price) || activeRule;
  }

  const aboveResistance = resistances.find((r) => px > r.high);
  if (aboveResistance) {
    activeMode = "aggressive";
    activeRule = rules.find((r) => r.compare === "above" && r.threshold === aboveResistance.price) || activeRule;
  }

  if (!activeRule) {
    activeRule = {
      compare: "default",
      mode: "neutral",
      label: "model default",
      recommend: { ...MODE_PRESETS.neutral },
    };
  }

  return {
    source: fsdLevels.length ? "fsd" : "model",
    active_mode: activeMode,
    active_rule: activeRule,
    rules,
    fsd_levels: fsdLevels,
    model_levels: ttLevels || null,
  };
}

/** Merge FSD levels into ticker-scenario support/resistance lists. */
export function mergeFsdLevelsIntoScenarioLevels(scenario, fsdLevels = []) {
  if (!scenario?.levels || !Array.isArray(fsdLevels) || fsdLevels.length === 0) return scenario;
  const price = Number(scenario.price) || 0;
  const support = [...(scenario.levels.support || [])];
  const resistance = [...(scenario.levels.resistance || [])];

  for (const lv of fsdLevels) {
    const entry = {
      price: Math.round(lv.price * 100) / 100,
      label: `FSD ${lv.kind} ${lv.price}`,
      source: "fsd",
      direction: lv.direction || null,
      horizon: lv.horizon || null,
    };
    if (lv.kind === "support" || lv.kind === "stop") {
      if (price <= 0 || entry.price < price) support.push(entry);
    } else {
      if (price <= 0 || entry.price > price) resistance.push(entry);
    }
  }

  const dedupe = (arr, asc) => {
    const sorted = [...arr].sort((a, b) => (asc ? a.price - b.price : b.price - a.price));
    const out = [];
    for (const lvl of sorted) {
      if (!out.find((o) => Math.abs(o.price - lvl.price) < 0.10)) out.push(lvl);
    }
    return out.slice(0, 5);
  };

  return {
    ...scenario,
    levels: {
      support: dedupe(support, false),
      resistance: dedupe(resistance, true),
    },
  };
}

/**
 * Resolve FSD level modes for a ticker (cached-friendly entry point).
 */
export async function resolveFsdLevelModesForTicker(env, ticker, price, opts = {}) {
  const fsdLevels = await loadFsdLevelsForTicker(env, ticker, opts);
  if (!fsdLevels.length) return null;
  return buildLevelConditionedModes(fsdLevels, price, opts.modelLevels || null);
}

/** Merge FSD level overlay onto a ticker learning/scenario policy resolution. */
export function mergeFsdLevelPolicyOverlay(basePolicy, fsdModes) {
  if (!fsdModes?.active_rule?.recommend) return basePolicy;
  const fsdRec = fsdModes.active_rule.recommend;
  if (!basePolicy) {
    return {
      source: "fsd_level_policy",
      match: { fsd_mode: fsdModes.active_mode },
      context: null,
      recommend: fsdRec,
      fsd_level_modes: fsdModes,
    };
  }
  return {
    ...basePolicy,
    source: `${basePolicy.source}+fsd_level`,
    recommend: { ...(basePolicy.recommend || {}), ...fsdRec },
    fsd_level_modes: fsdModes,
  };
}
