// Trust Spine — calibrated probability + EV on signals (pattern_library + gates).

import { fuseConviction } from "../conviction.js";

/**
 * Best active pattern match for direction from pattern_library rows.
 */
export function selectBestPattern(patterns, direction) {
  const dir = String(direction || "").toUpperCase();
  if (!Array.isArray(patterns) || !dir) return null;
  const filtered = patterns.filter((p) => {
    const d = String(p?.expected_direction || "").toUpperCase();
    return d === dir || d === "UP" && dir === "LONG" || d === "DOWN" && dir === "SHORT";
  });
  if (!filtered.length) return null;
  return filtered.sort((a, b) => Number(b.expected_value || 0) - Number(a.expected_value || 0))[0];
}

/**
 * Stamp calibrated edge fields on a ticker snapshot.
 */
export function attachCalibratedEdge(tickerData = {}, patterns = [], opts = {}) {
  const direction = opts.direction || tickerData.trigger_dir || tickerData.direction;
  const conviction = fuseConviction(tickerData, { direction });
  const best = selectBestPattern(patterns, direction);

  const hitRate = best ? Number(best.hit_rate) : null;
  const ev = best ? Number(best.expected_value) : null;
  const prob = Number.isFinite(hitRate) ? hitRate : (conviction.tier === "A" ? 0.6 : conviction.tier === "B" ? 0.52 : 0.45);

  const calibrated = {
    probability: Math.round(prob * 1000) / 1000,
    expected_value: Number.isFinite(ev) ? ev : null,
    pattern_id: best?.pattern_id || null,
    pattern_name: best?.name || null,
    conviction_tier: conviction.tier,
    conviction_score: conviction.score,
    confirm_stack: conviction.components?.confirmStack === true,
    source: best ? "pattern_library" : "conviction_fallback",
  };

  return {
    ...tickerData,
    __calibrated_edge: calibrated,
    calibrated_probability: calibrated.probability,
    calibrated_expected_value: calibrated.expected_value,
    __conviction_tier: conviction.tier,
    __conviction_score: conviction.score,
  };
}
