// worker/officer-rank-tilt.js
// Bounded live-rank overlays from CTO probabilistic levels + the CRO
// tactical overlay.
//
// Mirrors theme-tilt.js: enough to break ties, never enough to override a
// weak chart. Direction-aware via HTF sign (same as theme + fair-value tilts).
//
// 2026-06-12 v2 (review follow-up on PR #627):
//   - The CRO component no longer regex-scans the daily note's prose.
//     That approach evaluated bull/bear words against the WHOLE note, so
//     mixed-tone notes (most of them) netted zero for every ticker and
//     single-tone notes hit every merely-MENTIONED sector regardless of
//     context. The structured source already exists: the live tactical
//     overlay (KV cro:tactical_overrides) carries machine-validated
//     signals with affected theme KEYS + a direction string — the same
//     source the promotion queue's W_TACTICAL nudge uses. Same keys,
//     same direction heuristic, deterministic.
//   - loadOfficerRankMap now has the same 5-minute in-isolate cache as
//     theme-tilt (it runs on every /timed/all request + scoring tick).

import { getThemesForTicker } from "./sector-mapping.js";
import { getStrategyForTicker } from "./strategy-context.js";
import { loadCTOUniverse } from "./cto/cto-service.js";

export const CTO_RANK_GATE_KEY = "cto_rank_boost_enabled";
export const CRO_NOTE_RANK_GATE_KEY = "cro_note_rank_nudge_enabled";

export const CTO_MAX = 3;
export const CRO_NOTE_MAX = 2;
export const OFFICER_TOTAL_MAX = 5;

const clamp = (v, lim) => Math.max(-lim, Math.min(lim, v));
const rnd1 = (v) => Math.round(v * 10) / 10;

function readGateValue(raw, defaultOn = true) {
  if (raw == null) return defaultOn;
  const v = String(raw).toLowerCase();
  return !(v === "false" || v === "0");
}

/** Build per-ticker CTO tilt from universe rollup (±CTO_MAX raw, pre-side). */
export function ctoTiltFromRow(row) {
  if (!row || !row.ok) return 0;
  const up = row.top_upside?.[0];
  const dn = row.top_downside?.[0];
  const upProb = Number(up?.regime_adjusted_prob);
  const dnProb = Number(dn?.regime_adjusted_prob);
  let raw = 0;
  if (Number.isFinite(upProb) && upProb >= 0.65) raw += (upProb - 0.5) * 6;
  if (Number.isFinite(dnProb) && dnProb >= 0.65) raw -= (dnProb - 0.5) * 4;
  return clamp(rnd1(raw), CTO_MAX);
}

/* ── CRO tactical overlay (structured) ──────────────────────────────
 * Same parsing convention as the promotion queue's
 * buildTacticalNudgeContext: affected_tier1_themes carry THEMES keys
 * (the FSD extractor validates them against playbook keys), and the
 * direction string decides the sign.
 */
const CAUTION_RE = /(caution|bearish|under|reduce|fade|trim|down|stretch)/i;

export function buildOverlayDirMaps(tacticalBlob) {
  const themeDir = new Map();
  const sectorDir = new Map();
  const signals = Array.isArray(tacticalBlob?.tactical_signals) ? tacticalBlob.tactical_signals : [];
  for (const sig of signals) {
    const sign = CAUTION_RE.test(String(sig.direction || "")) ? -1 : 1;
    for (const th of (sig.affected_tier1_themes || [])) themeDir.set(th, sign);
    for (const sec of (sig.affected_sectors_overweight || [])) sectorDir.set(sec, 1);
  }
  return { themeDir, sectorDir, signals_count: signals.length, tactical_title: tacticalBlob?.tactical_title || null };
}

/** Tilt for one ticker from the overlay dir maps (±CRO_NOTE_MAX raw, pre-side). */
export function croOverlayTilt(overlay, { themes = [], sector = null } = {}) {
  if (!overlay || (overlay.themeDir?.size === 0 && overlay.sectorDir?.size === 0)) return 0;
  let nudge = 0;
  for (const th of themes) {
    const s = overlay.themeDir?.get(th);
    if (s) nudge += s;
  }
  if (sector) {
    const s = overlay.sectorDir?.get(sector);
    if (s) nudge += s;
  }
  if (nudge === 0) return 0;
  // One aligned theme = full weight; multiple just confirm (cap at ±1 sign).
  return clamp(Math.sign(nudge) * CRO_NOTE_MAX, CRO_NOTE_MAX);
}

/** Pure map builder — unit-testable without KV. */
export function computeOfficerRankMap({ ctoRollup, tacticalOverlay, gates = {} } = {}) {
  const ctoEnabled = gates.cto !== false;
  const croEnabled = gates.cro !== false;
  const ctoRows = {};

  if (ctoRollup && Array.isArray(ctoRollup.results)) {
    for (const row of ctoRollup.results) {
      const sym = String(row?.ticker || "").toUpperCase();
      if (!sym) continue;
      ctoRows[sym] = row;
    }
  }

  return {
    enabled: { cto: ctoEnabled, cro: croEnabled },
    computed_at: ctoRollup?.computed_at || null,
    cto_rows: ctoRows,
    overlay: croEnabled ? buildOverlayDirMaps(tacticalOverlay) : null,
  };
}

export function lookupOfficerTilt(map, sym, htfScore = 0, sectorHint = null) {
  const S = String(sym || "").toUpperCase();
  if (!S || !map) return null;
  const side = Number(htfScore) > 0 ? 1 : Number(htfScore) < 0 ? -1 : 0;

  let ctoRaw = 0;
  let croRaw = 0;

  const row = map.cto_rows?.[S];
  if (map.enabled?.cto !== false && row) {
    ctoRaw = ctoTiltFromRow(row);
  }

  if (map.enabled?.cro !== false && map.overlay) {
    let sector = sectorHint || null;
    if (!sector) {
      try {
        const strat = getStrategyForTicker(S, null, getThemesForTicker);
        sector = strat?.sector || null;
      } catch (_) {}
    }
    croRaw = croOverlayTilt(map.overlay, { themes: getThemesForTicker(S) || [], sector });
  }

  const ctoApplied = side ? rnd1(ctoRaw * side) : 0;
  const croApplied = side ? rnd1(croRaw * side) : 0;
  const totalApplied = side ? clamp(rnd1(ctoApplied + croApplied), OFFICER_TOTAL_MAX) : 0;

  if (ctoRaw === 0 && croRaw === 0) return null;

  return {
    cto: ctoApplied,
    cro: croApplied,
    tilt: totalApplied,
    cto_upside: row?.top_upside?.[0] || null,
    cto_downside: row?.top_downside?.[0] || null,
  };
}

/* ── Async loader with 5-minute in-isolate cache ─────────────────────
 * Same lifecycle as theme-tilt: one KV/D1 round per 5 minutes per
 * isolate, shared by the scoring cron preamble and /timed/all.
 */
let _mapCache = null;
let _mapCacheAt = 0;
const MAP_CACHE_TTL_MS = 5 * 60 * 1000;

export async function loadOfficerRankMap(env, { force = false } = {}) {
  if (!force && _mapCache && Date.now() - _mapCacheAt < MAP_CACHE_TTL_MS) return _mapCache;

  const gates = { cto: true, cro: true };
  try {
    const rows = await env?.DB?.prepare(
      `SELECT config_key, config_value FROM model_config
        WHERE config_key IN (?1, ?2)`,
    ).bind(CTO_RANK_GATE_KEY, CRO_NOTE_RANK_GATE_KEY).all();
    for (const r of rows?.results || []) {
      if (r.config_key === CTO_RANK_GATE_KEY) gates.cto = readGateValue(r.config_value);
      if (r.config_key === CRO_NOTE_RANK_GATE_KEY) gates.cro = readGateValue(r.config_value);
    }
  } catch (_) {}

  let ctoRollup = null;
  let tacticalOverlay = null;
  try { ctoRollup = await loadCTOUniverse(env); } catch (_) {}
  try {
    const KV = env?.KV_TIMED || env?.KV;
    const raw = await KV?.get("cro:tactical_overrides");
    tacticalOverlay = raw ? JSON.parse(raw) : null;
  } catch (_) {}

  const map = computeOfficerRankMap({ ctoRollup, tacticalOverlay, gates });
  map.gates = gates;
  _mapCache = map;
  _mapCacheAt = Date.now();
  return map;
}

export function _resetOfficerRankCacheForTests() {
  _mapCache = null;
  _mapCacheAt = 0;
}
