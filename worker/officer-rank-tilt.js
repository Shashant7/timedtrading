// worker/officer-rank-tilt.js
// Bounded live-rank overlays from CTO probabilistic levels + CRO daily note.
//
// Mirrors theme-tilt.js: enough to break ties, never enough to override a
// weak chart. Direction-aware via HTF sign (same as theme + fair-value tilts).

import { getThemesForTicker } from "./sector-mapping.js";
import { getStrategyForTicker } from "./strategy-context.js";
import { loadCTOUniverse } from "./cto/cto-service.js";
import { loadLatestCRONote } from "./cro/cro-service.js";

export const CTO_RANK_GATE_KEY = "cto_rank_boost_enabled";
export const CRO_NOTE_RANK_GATE_KEY = "cro_note_rank_nudge_enabled";

export const CTO_MAX = 3;
export const CRO_NOTE_MAX = 2;
export const OFFICER_TOTAL_MAX = 5;

const clamp = (v, lim) => Math.max(-lim, Math.min(lim, v));
const rnd1 = (v) => Math.round(v * 10) / 10;

const BULL_RE = /(lead|leader|strength|breakout|bid|upside|overweight|favor|buy|bull|rotate into|outperform)/i;
const BEAR_RE = /(lag|weak|breakdown|offer|downside|underweight|fade|trim|sell|bear|rotate out|underperform|caution)/i;

function readGate(cfg, key, defaultOn = true) {
  if (cfg && Object.prototype.hasOwnProperty.call(cfg, key)) {
    const v = String(cfg[key]).toLowerCase();
    return !(v === "false" || v === "0");
  }
  return defaultOn;
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

/** Sentiment of CRO note text toward a ticker sector/theme (±CRO_NOTE_MAX raw). */
export function croNoteTiltFromText(text, { sector, themes = [] } = {}) {
  const blob = String(text || "").toLowerCase();
  if (!blob) return 0;
  const needles = [];
  if (sector) needles.push(String(sector).toLowerCase());
  for (const th of themes) needles.push(String(th).replace(/_/g, " "));
  if (needles.length === 0) return 0;

  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");
  const blobNorm = norm(blob);

  let hit = false;
  let score = 0;
  for (const n of needles) {
    const nn = norm(n);
    if (!nn || nn.length < 3 || !blobNorm.includes(nn)) continue;
    hit = true;
    if (BULL_RE.test(blob)) score += 1.5;
    if (BEAR_RE.test(blob)) score -= 1.5;
  }
  if (!hit) return 0;
  return clamp(rnd1(score), CRO_NOTE_MAX);
}

/** Pure map builder — unit-testable without KV. */
export function computeOfficerRankMap({ ctoRollup, croNote, gates = {} } = {}) {
  const ctoEnabled = gates.cto !== false;
  const croEnabled = gates.cro !== false;
  const byTicker = {};
  const ctoRows = {};

  if (ctoRollup && Array.isArray(ctoRollup.results)) {
    for (const row of ctoRollup.results) {
      const sym = String(row?.ticker || "").toUpperCase();
      if (!sym) continue;
      ctoRows[sym] = row;
      const tilt = ctoTiltFromRow(row);
      if (tilt !== 0) {
        byTicker[sym] = {
          cto: tilt,
          cro: 0,
          tilt: tilt,
          cto_upside: row.top_upside?.[0] || null,
          cto_downside: row.top_downside?.[0] || null,
        };
      }
    }
  }

  const noteText = [
    croNote?.verdict || "",
    ...(Array.isArray(croNote?.observations)
      ? croNote.observations.map((o) => `${o.category || ""}: ${o.claim || o.text || ""}`)
      : []),
  ].join(" ");

  if (croEnabled && noteText) {
    // cro note nudge resolved lazily per ticker in lookupOfficerTilt
  }

  return {
    enabled: { cto: ctoEnabled, cro: croEnabled },
    computed_at: ctoRollup?.computed_at || null,
    cro_note_date: croNote?.as_of_date || null,
    cto_rows: ctoRows,
    by_ticker: byTicker,
    cro_note_text: noteText.slice(0, 4000),
  };
}

export function lookupOfficerTilt(map, sym, htfScore = 0) {
  const S = String(sym || "").toUpperCase();
  if (!S || !map) return null;
  const side = Number(htfScore) > 0 ? 1 : Number(htfScore) < 0 ? -1 : 0;

  let ctoRaw = 0;
  let croRaw = 0;

  const row = map.cto_rows?.[S];
  if (map.enabled?.cto !== false && row) {
    ctoRaw = ctoTiltFromRow(row);
  }

  if (map.enabled?.cro !== false && map.cro_note_text) {
    let sector = null;
    try {
      const strat = getStrategyForTicker(S, null, getThemesForTicker);
      sector = strat?.sector || null;
    } catch (_) {}
    const themes = getThemesForTicker(S) || [];
    croRaw = croNoteTiltFromText(map.cro_note_text, { sector, themes });
  }

  if (map.enabled?.cto === false) ctoRaw = 0;
  if (map.enabled?.cro === false) croRaw = 0;

  const ctoApplied = side ? rnd1(ctoRaw * side) : 0;
  const croApplied = side ? rnd1(croRaw * side) : 0;
  const totalApplied = side ? clamp(rnd1((ctoApplied + croApplied)), OFFICER_TOTAL_MAX) : 0;

  if (ctoRaw === 0 && croRaw === 0) return null;

  return {
    cto: ctoApplied,
    cro: croApplied,
    tilt: totalApplied,
    cto_upside: row?.top_upside?.[0] || null,
    cto_downside: row?.top_downside?.[0] || null,
  };
}

let _gateCache = null;
let _gateCacheAt = 0;

async function loadGates(env) {
  const now = Date.now();
  if (_gateCache && now - _gateCacheAt < 60000) return _gateCache;
  const gates = { cto: true, cro: true };
  try {
    const rows = await env?.DB?.prepare(
      `SELECT config_key, config_value FROM model_config
        WHERE config_key IN (?1, ?2)`,
    ).bind(CTO_RANK_GATE_KEY, CRO_NOTE_RANK_GATE_KEY).all();
    for (const r of rows?.results || []) {
      const off = String(r.config_value).toLowerCase() === "false" || String(r.config_value) === "0";
      if (r.config_key === CTO_RANK_GATE_KEY) gates.cto = !off;
      if (r.config_key === CRO_NOTE_RANK_GATE_KEY) gates.cro = !off;
    }
  } catch (_) {}
  _gateCache = gates;
  _gateCacheAt = now;
  return gates;
}

export async function loadOfficerRankMap(env) {
  const gates = await loadGates(env);
  const [ctoRollup, croNote] = await Promise.all([
    loadCTOUniverse(env).catch(() => null),
    loadLatestCRONote(env).catch(() => null),
  ]);
  const map = computeOfficerRankMap({ ctoRollup, croNote, gates });
  map.gates = gates;
  return map;
}

export function _resetOfficerRankGateCacheForTests() {
  _gateCache = null;
  _gateCacheAt = 0;
}
