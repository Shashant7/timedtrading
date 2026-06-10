// worker/theme-tilt.js — CRO theme-tilt overlay for live ranking.
//
// 2026-06-10 — Operator: "if memory stocks or space stocks are running,
// do we then boost the score of a ticker that is related?" Before this
// module the answer was NO: theme/sector intelligence (rotation engine
// breadth, playbook tilts) only influenced the screener promotion queue
// and LLM prompts — never the live `rank`/`dynamicScore` that orders
// the Today viewport and feeds the entry funnel.
//
// This module computes a BOUNDED per-ticker tilt from two sources:
//
//   1. OBSERVED theme activity (data, weight up to ±4): the CRO rotation
//      engine's nightly theme_breadth (timed:cro:rotation-snapshot) —
//      what % of theme members are up >5% over 5d, all-bid/all-offered
//      flags. "Memory stocks are running" is literally
//      theme_breadth[ai_infra_memory].breadth_5d_up_gt_5pct being high.
//
//   2. EDITORIAL playbook alignment (opinion, weight up to ±2):
//      getStrategyForTicker() — the active strategic playbook's theme/
//      sector tilts (e.g. Fundstrat 2026 Year Ahead). Deliberately
//      smaller than observed: data outranks opinion (same hierarchy the
//      promotion queue uses: W_THEME 15 vs W_STRATEGY 8).
//
// Total tilt clamps to ±6 — enough to break ties between two ~equal
// technical stacks, NEVER enough to put a weak chart above a strong one
// (corridor alone is +12, squeeze release +10).
//
// DIRECTION-AWARE application (in computeDynamicScore): a hot theme
// helps a LONG-side candidate and HURTS a SHORT-side candidate on the
// same ticker, so the applied value is tilt × side(htf_score).
//
// Gate: model_config `cro_theme_rank_boost_enabled` (default TRUE —
// operator flipped it live 2026-06-10). When disabled the map still
// loads and computeDynamicScore attaches `_theme_tilt_shadow` without
// touching the score, so the effect stays measurable after a rollback.

import { THEMES, getThemesForTicker } from "./sector-mapping.js";
import { getStrategyForTicker } from "./strategy-context.js";

const ROTATION_SNAPSHOT_KV_KEY = "timed:cro:rotation-snapshot";
export const THEME_TILT_GATE_KEY = "cro_theme_rank_boost_enabled";

export const OBSERVED_MAX = 4;   // ± cap for rotation-engine breadth signal
export const EDITORIAL_MAX = 2;  // ± cap for playbook alignment
export const TOTAL_MAX = 6;      // ± cap for the combined tilt

const clamp = (v, lim) => Math.max(-lim, Math.min(lim, v));
const rnd1 = (v) => Math.round(v * 10) / 10;

/* Observed activity score for ONE theme from its rotation-engine
 * breadth row. Range ±OBSERVED_MAX.
 *   base  — net 5d breadth (% members up >5% minus % down >5%),
 *           ±100 → ±3.
 *   kick  — all-bid / all-offered today (±1): the "theme is running
 *           RIGHT NOW" component.
 */
export function themeObservedScore(tb) {
  if (!tb || typeof tb !== "object") return 0;
  const up5 = Number(tb.breadth_5d_up_gt_5pct) || 0;
  const dn5 = Number(tb.breadth_5d_dn_gt_5pct) || 0;
  let score = ((up5 - dn5) / 100) * 3;
  if (tb.all_bid_today) score += 1;
  if (tb.all_offered_today) score -= 1;
  return clamp(rnd1(score), OBSERVED_MAX);
}

/* Editorial score for one ticker from the active playbook. The
 * strategy multiplier is ~0.85–1.2; map (multiplier − 1) × 10 onto
 * ±EDITORIAL_MAX so a 1.15 overweight ≈ +1.5 and 0.9 underweight ≈ −1.
 */
export function editorialScore(sym) {
  try {
    const s = getStrategyForTicker(sym, null, getThemesForTicker);
    if (!s || !s.aligned) return 0;
    return clamp(rnd1((Number(s.multiplier) - 1) * 10), EDITORIAL_MAX);
  } catch (_) { return 0; }
}

/* Build the per-ticker tilt map from a rotation snapshot. Pure given
 * its inputs — unit-testable without KV/D1.
 *
 * Per ticker: strongest |observed| score across its themes (a ticker in
 * 3 themes rides its hottest/coldest narrative, they don't stack) plus
 * the editorial component, clamped to ±TOTAL_MAX.
 */
export function computeThemeTiltMap({ rotationSnapshot, enabled = true } = {}) {
  const byTheme = {};
  for (const tb of (rotationSnapshot?.theme_breadth || [])) {
    if (!tb?.theme) continue;
    byTheme[tb.theme] = themeObservedScore(tb);
  }

  const byTicker = {};
  for (const [theme, members] of Object.entries(THEMES || {})) {
    const obs = byTheme[theme];
    if (!Number.isFinite(obs) || obs === 0) continue;
    for (const m of (members || [])) {
      const sym = String(m).toUpperCase();
      const cur = byTicker[sym];
      if (!cur || Math.abs(obs) > Math.abs(cur.observed)) {
        byTicker[sym] = { observed: obs, theme };
      }
    }
  }

  const out = {};
  for (const [sym, { observed, theme }] of Object.entries(byTicker)) {
    const editorial = editorialScore(sym);
    const tilt = clamp(rnd1(observed + editorial), TOTAL_MAX);
    if (tilt === 0) continue;
    out[sym] = {
      tilt,
      observed,
      editorial,
      theme,
      themes: getThemesForTicker(sym),
    };
  }
  // Editorial-only tilts (playbook names whose themes are flat today)
  // are intentionally NOT emitted: opinion without observed
  // confirmation shouldn't move the live rank. The promotion queue is
  // the place where pure playbook alignment earns points.

  return {
    by_ticker: out,
    enabled: enabled !== false,
    computed_at: Date.now(),
    snapshot_computed_at: rotationSnapshot?.computed_at || null,
    themes_scored: Object.keys(byTheme).length,
    tickers_tilted: Object.keys(out).length,
  };
}

/* Async loader with a short in-isolate cache. Called from the scoring
 * cron preamble and the /timed/all enrichment path; both are hot, so
 * one KV read + one D1 gate read per 5 minutes per isolate.
 */
let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function loadThemeTiltMap(env, { force = false } = {}) {
  if (!force && _cache && Date.now() - _cacheAt < CACHE_TTL_MS) return _cache;

  let snapshot = null;
  try {
    const raw = await env?.KV_TIMED?.get(ROTATION_SNAPSHOT_KV_KEY);
    if (raw) snapshot = JSON.parse(raw);
  } catch (_) {}

  let enabled = true; // default ON (operator-approved live, 2026-06-10)
  try {
    const row = await env?.DB?.prepare(
      `SELECT config_value FROM model_config WHERE config_key = ?1`,
    ).bind(THEME_TILT_GATE_KEY).first();
    if (row?.config_value != null) {
      enabled = String(row.config_value).toLowerCase() !== "false";
    }
  } catch (_) {}

  _cache = snapshot
    ? computeThemeTiltMap({ rotationSnapshot: snapshot, enabled })
    : { by_ticker: {}, enabled, computed_at: Date.now(), snapshot_computed_at: null, themes_scored: 0, tickers_tilted: 0 };
  _cacheAt = Date.now();
  return _cache;
}

export function _resetThemeTiltCacheForTests() { _cache = null; _cacheAt = 0; }
