// FSD-driven runtime merges for sector/theme stances + scoring ratings.
// The CRO KV blob (`cro:tactical_overrides`) is the live strategy arm —
// structural stance changes from FSD publications merge on top of the
// in-code playbook at read time and sync into timed:admin:sector_ratings
// for rankTickersInSector scoring boosts.

export const CRO_STRATEGY_OVERRIDE_KV_KEY = "cro:tactical_overrides";

const SECTOR_RATING_ALIASES = {
  Healthcare: "Health Care",
  Materials: "Basic Materials",
};

const DEFAULT_MULTIPLIERS = {
  overweight: 1.15,
  neutral: 1.0,
  underweight: 0.85,
};

// Playbook tilt multipliers live in ~0.85–1.25. Model weights (31.4%) or
// weight deltas (-2.5) must NOT flow into scoring boost via this formula.
const PLAYBOOK_MULT_MIN = 0.75;
const PLAYBOOK_MULT_MAX = 1.30;

const STANCE_BOOST_DEFAULTS = {
  overweight: 5,
  neutral: 0,
  underweight: -4,
};

let _overrideCache = null;
let _overrideLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export function resolveRatingSectorName(playbookSector) {
  const s = String(playbookSector || "").trim();
  return SECTOR_RATING_ALIASES[s] || s;
}

export function stanceToBoost(stance, multiplier = null) {
  const s = String(stance || "neutral").toLowerCase();
  if (s === "neutral") return 0;

  const m = Number(multiplier);
  if (Number.isFinite(m) && m >= PLAYBOOK_MULT_MIN && m <= PLAYBOOK_MULT_MAX) {
    return Math.max(-8, Math.min(8, Math.round((m - 1) * 20)));
  }
  return STANCE_BOOST_DEFAULTS[s] ?? 0;
}

export function stanceToMultiplier(stance, newMultiplier = null) {
  const m = Number(newMultiplier);
  if (Number.isFinite(m) && m > 0) return m;
  return DEFAULT_MULTIPLIERS[String(stance || "neutral").toLowerCase()] ?? 1.0;
}

function collectStanceChanges(blob) {
  if (!blob || typeof blob !== "object") {
    return { sectors: [], themes: [] };
  }
  const sectors = [
    ...(Array.isArray(blob.sector_stance_changes) ? blob.sector_stance_changes : []),
    ...(Array.isArray(blob.structural_pending?.sector_stance_changes)
      ? blob.structural_pending.sector_stance_changes : []),
  ];
  const themes = [
    ...(Array.isArray(blob.theme_stance_changes) ? blob.theme_stance_changes : []),
    ...(Array.isArray(blob.structural_pending?.theme_stance_changes)
      ? blob.structural_pending.theme_stance_changes : []),
  ];
  const sectorMap = new Map();
  for (const row of sectors) {
    if (row?.sector) sectorMap.set(String(row.sector), row);
  }
  const themeMap = new Map();
  for (const row of themes) {
    if (row?.theme) themeMap.set(String(row.theme), row);
  }
  return { sectors: [...sectorMap.values()], themes: [...themeMap.values()] };
}

export function parseStrategyOverrideBlob(blob) {
  if (!blob || typeof blob !== "object") return null;
  const { sectors, themes } = collectStanceChanges(blob);
  return {
    ...blob,
    sector_stance_changes: sectors,
    theme_stance_changes: themes,
    sector_notes: Array.isArray(blob.sector_notes) ? blob.sector_notes : [],
    theme_notes: Array.isArray(blob.theme_notes) ? blob.theme_notes : [],
  };
}

export function mergeSectorTilt(base, change, tacticalNote = null) {
  if (!change && !tacticalNote) return base;
  const out = base
    ? { ...base }
    : {
      stance: "neutral",
      multiplier: 1.0,
      rationale_short: null,
      rationale_long: "",
      boost_themes: [],
    };
  if (change) {
    const stance = String(change.new_stance || out.stance || "neutral").toLowerCase();
    out.stance = stance;
    out.multiplier = stanceToMultiplier(stance, change.new_multiplier);
    if (change.rationale_short) out.rationale_short = String(change.rationale_short);
    out._fsd_applied = true;
  }
  if (tacticalNote) {
    const note = String(tacticalNote).slice(0, 300);
    out.rationale_short = out.rationale_short
      ? `${out.rationale_short} [FSD: ${note}]`
      : `[FSD: ${note}]`;
  }
  return out;
}

export function mergeThemeTilt(base, change, tacticalNote = null) {
  if (!change && !tacticalNote) return base;
  const out = base
    ? { ...base }
    : { stance: "neutral", multiplier: 1.0, tier: "tier_2", playbook: "" };
  if (change) {
    const stance = String(change.new_stance || out.stance || "neutral").toLowerCase();
    out.stance = stance;
    out.multiplier = stanceToMultiplier(stance, change.new_multiplier);
    out._fsd_applied = true;
  }
  if (tacticalNote) {
    const note = String(tacticalNote).slice(0, 120);
    out.playbook = out.playbook
      ? `${out.playbook} (FSD: ${note})`
      : note;
  }
  return out;
}

export function buildEffectiveSectorTilts(baseTilts, override) {
  if (!override) return baseTilts;
  const parsed = parseStrategyOverrideBlob(override);
  if (!parsed) return baseTilts;
  const out = { ...baseTilts };
  const notesBySector = new Map(
    (parsed.sector_notes || []).map((n) => [String(n.sector), n.tactical_note]),
  );
  for (const change of parsed.sector_stance_changes || []) {
    const key = String(change.sector);
    out[key] = mergeSectorTilt(out[key], change, notesBySector.get(key));
    notesBySector.delete(key);
  }
  for (const [sector, note] of notesBySector) {
    if (out[sector]) out[sector] = mergeSectorTilt(out[sector], null, note);
  }
  return out;
}

export function buildEffectiveThemeTilts(baseTilts, override) {
  if (!override) return baseTilts;
  const parsed = parseStrategyOverrideBlob(override);
  if (!parsed) return baseTilts;
  const out = { ...baseTilts };
  const notesByTheme = new Map(
    (parsed.theme_notes || []).map((n) => [String(n.theme), n.tactical_note]),
  );
  for (const change of parsed.theme_stance_changes || []) {
    const key = String(change.theme);
    out[key] = mergeThemeTilt(out[key], change, notesByTheme.get(key));
    notesByTheme.delete(key);
  }
  for (const [theme, note] of notesByTheme) {
    if (out[theme]) out[theme] = mergeThemeTilt(out[theme], null, note);
  }
  return out;
}

export function buildSectorRatingsPatch(baseRatings, override) {
  const parsed = parseStrategyOverrideBlob(override);
  if (!parsed?.sector_stance_changes?.length) return null;
  const patch = {};
  for (const change of parsed.sector_stance_changes) {
    const playbookSector = String(change.sector);
    const ratingSector = resolveRatingSectorName(playbookSector);
    const stance = String(change.new_stance || "neutral").toLowerCase();
    const mult = stanceToMultiplier(stance, change.new_multiplier);
    const boost = stanceToBoost(stance, mult);
    const base = baseRatings[ratingSector] || baseRatings[playbookSector] || {};
    const row = {
      rating: stance,
      boost,
      delta: stance === "neutral" ? 0 : (base.delta ?? 0),
      _fsd_source: true,
      _fsd_rationale: change.rationale_short || null,
    };
    patch[ratingSector] = row;
    if (ratingSector !== playbookSector && baseRatings[playbookSector]) {
      patch[playbookSector] = { ...row };
    }
  }
  return patch;
}

export function applySectorRatingsPatch(baseRatings, patch) {
  if (!patch || !Object.keys(patch).length) return baseRatings;
  for (const [sector, val] of Object.entries(patch)) {
    if (baseRatings[sector]) Object.assign(baseRatings[sector], val);
    else baseRatings[sector] = { ...val };
  }
  return baseRatings;
}

export function getEffectiveSectorRating(sector, baseRatings, overrideCache = _overrideCache) {
  const base = baseRatings?.[sector] || { rating: "neutral", boost: 0 };
  if (!overrideCache) return base;
  const patch = buildSectorRatingsPatch(baseRatings, overrideCache);
  if (!patch) return base;
  return patch[sector] || base;
}

export async function loadStrategyOverrideCache(env, { force = false } = {}) {
  const now = Date.now();
  if (!force && _overrideCache && (now - _overrideLoadedAt) < CACHE_TTL_MS) {
    return _overrideCache;
  }
  const kv = env?.KV_TIMED || env?.KV;
  if (!kv) return _overrideCache;
  try {
    const raw = await kv.get(CRO_STRATEGY_OVERRIDE_KV_KEY);
    _overrideCache = raw ? parseStrategyOverrideBlob(JSON.parse(raw)) : null;
    _overrideLoadedAt = now;
  } catch (_) {
    _overrideCache = null;
    _overrideLoadedAt = now;
  }
  return _overrideCache;
}

export function getStrategyOverrideCache() {
  return _overrideCache;
}

export function setStrategyOverrideCache(blob) {
  _overrideCache = blob ? parseStrategyOverrideBlob(blob) : null;
  _overrideLoadedAt = Date.now();
}

export async function syncSectorRatingsFromOverride(env, blob, baseRatings) {
  const patch = buildSectorRatingsPatch(baseRatings, blob);
  if (!patch || !Object.keys(patch).length) {
    return { ok: true, updated: 0, patch: null };
  }
  const kv = env?.KV_TIMED || env?.KV;
  if (!kv) return { ok: false, error_kind: "kv_unavailable" };

  let stored = {};
  try {
    const raw = await kv.get("timed:admin:sector_ratings");
    stored = raw ? JSON.parse(raw) : {};
  } catch (_) {}

  for (const [sector, val] of Object.entries(patch)) {
    stored[sector] = { ...(stored[sector] || {}), ...val };
  }
  await kv.put("timed:admin:sector_ratings", JSON.stringify(stored));
  applySectorRatingsPatch(baseRatings, patch);
  return { ok: true, updated: Object.keys(patch).length, patch };
}
