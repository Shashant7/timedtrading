// worker/macro-risk-tilt.js — Real-time rank overlay from macro wire pulse.
//
// Bounded ±4, direction-aware (same pattern as theme-tilt.js).
// Source: KV timed:discovery:macro-wire-pulse (LLM-classified x-wire).

import { THEMES, getThemesForTicker } from "./sector-mapping.js";
import { getStrategyForTicker } from "./strategy-context.js";
import {
  MACRO_WIRE_PULSE_KV,
  parseIntelJson,
  urgencyWeight,
  sentimentSign,
} from "./discovery/macro-wire-intel.js";

export const MACRO_RISK_GATE_KEY = "macro_wire_rank_boost_enabled";
export const MACRO_RISK_MAX = 4;

const clamp = (v, lim) => Math.max(-lim, Math.min(lim, v));
const rnd1 = (v) => Math.round(v * 10) / 10;

/** Raw tilt for one ticker from a single classified post (pre-side, pre-clamp). */
export function postTiltContribution(intel, { sym, themes = [], sector = null } = {}) {
  if (!intel) return 0;
  const S = String(sym || "").toUpperCase();
  let hit = false;
  if (S && (intel.tickers || []).includes(S)) hit = true;
  if ((intel.themes || []).some((t) => themes.includes(t))) hit = true;
  if (sector && (intel.sectors || []).some((s) => {
    const a = String(s).toLowerCase();
    const b = String(sector).toLowerCase();
    return a.includes(b.slice(0, 6)) || b.includes(a.slice(0, 6));
  })) hit = true;
  if (!hit) return 0;
  const sign = sentimentSign(intel.sentiment);
  if (sign === 0) return 0;
  const mag = (intel.catalyst_strength / 10) * urgencyWeight(intel.urgency) * MACRO_RISK_MAX;
  return sign * mag;
}

/** Pure map builder — unit-testable. */
export function computeMacroRiskTiltMap({ pulse, themeMembersByKey = THEMES, enabled = true } = {}) {
  const posts = pulse?.posts || [];
  const tickerHits = {};

  for (const p of posts) {
    const intel = p.intel || parseIntelJson(p.intel_json);
    if (!intel) continue;
    const candidates = new Set(intel.tickers || []);
    for (const th of (intel.themes || [])) {
      for (const m of (themeMembersByKey[th] || [])) candidates.add(String(m).toUpperCase());
    }
    for (const sym of candidates) {
      const S = String(sym).toUpperCase();
      if (!S) continue;
      const themes = getThemesForTicker(S) || [];
      let sector = null;
      try {
        sector = getStrategyForTicker(S, null, getThemesForTicker)?.sector || null;
      } catch (_) {}
      const contrib = postTiltContribution(intel, { sym: S, themes, sector });
      if (contrib === 0) continue;
      if (!tickerHits[S]) tickerHits[S] = { raw: 0, posts: 0 };
      tickerHits[S].raw += contrib;
      tickerHits[S].posts += 1;
    }
  }

  const byTicker = {};
  for (const [sym, { raw, posts: pc }] of Object.entries(tickerHits)) {
    const tilt = clamp(rnd1(raw / Math.max(1, Math.min(pc, 3))), MACRO_RISK_MAX);
    if (tilt === 0) continue;
    byTicker[sym] = { tilt, posts: pc, source: "macro_wire" };
  }

  return {
    by_ticker: byTicker,
    enabled: enabled !== false,
    risk_tone: pulse?.risk_tone || "neutral",
    computed_at: Date.now(),
    pulse_generated: pulse?.generated || null,
    posts_scored: posts.length,
    tickers_tilted: Object.keys(byTicker).length,
  };
}

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 45 * 1000;

export function invalidateMacroRiskTiltCache() {
  _cache = null;
  _cacheAt = 0;
}

export async function loadMacroRiskTiltMap(env, { force = false } = {}) {
  if (!force && _cache && Date.now() - _cacheAt < CACHE_TTL_MS) return _cache;

  let pulse = null;
  try {
    const kv = env?.KV_TIMED || env?.KV;
    const raw = await kv?.get(MACRO_WIRE_PULSE_KV);
    if (raw) pulse = JSON.parse(raw);
  } catch (_) {}

  let enabled = true;
  try {
    const row = await env?.DB?.prepare(
      `SELECT config_value FROM model_config WHERE config_key = ?1`,
    ).bind(MACRO_RISK_GATE_KEY).first();
    if (row?.config_value != null) {
      enabled = String(row.config_value).toLowerCase() !== "false";
    }
  } catch (_) {}

  _cache = pulse
    ? computeMacroRiskTiltMap({ pulse, enabled })
    : { by_ticker: {}, enabled, risk_tone: "neutral", computed_at: Date.now(), posts_scored: 0, tickers_tilted: 0 };
  _cacheAt = Date.now();
  return _cache;
}

export function lookupMacroRiskTilt(map, sym, htfScore = 0) {
  const S = String(sym || "").toUpperCase();
  if (!S || !map?.by_ticker?.[S]) return null;
  const side = Number(htfScore) > 0 ? 1 : Number(htfScore) < 0 ? -1 : 0;
  const raw = map.by_ticker[S].tilt;
  const applied = side ? rnd1(raw * side) : 0;
  if (applied === 0 && raw === 0) return null;
  return { tilt: applied, raw, posts: map.by_ticker[S].posts, risk_tone: map.risk_tone };
}

export function _resetMacroRiskTiltCacheForTests() {
  invalidateMacroRiskTiltCache();
}
