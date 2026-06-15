// worker/foundation/indicator-contract.js
// ─────────────────────────────────────────────────────────────────────────────
//  FOUNDATION — Layer 2 contract: pure, versioned indicators with declared
//  data requirements (Phase 0 of tasks/2026-06-14-foundation-rebuild-plan.md).
//
//  An indicator is a PURE function bars[] -> value, plus a declaration of the
//  contiguous lookback it needs. The runner enforces the SeriesView contract
//  BEFORE computing: if the series is incomplete or too short, the indicator
//  returns { available: false, reason } — it never computes on a short/gappy
//  window and never throws into the caller. This is the structural fix for
//  "TD Sequential / EMAs calculated without error".
//
//  Same code path in live and replay. Nothing in the live worker imports this
//  yet (additive scaffolding + tests).
// ─────────────────────────────────────────────────────────────────────────────

import { checkSeries } from "./series-contract.js";

/**
 * @typedef {Object} IndicatorSpec
 * @property {string} name
 * @property {string} version              semantic version of the formula
 * @property {{ tf:string, minBars:number, finalizedOnly?:boolean }} requires
 * @property {(bars:import("./series-contract.js").Bar[]) => (number|object)} compute  PURE
 */

/**
 * @typedef {Object} IndicatorResult
 * @property {boolean} available
 * @property {(number|object|null)} value
 * @property {string|null} reason          null when available
 * @property {string} name
 * @property {string} version
 * @property {string} tf
 */

/** Validate an IndicatorSpec shape. Throws on a malformed spec (author error). */
export function defineIndicator(spec) {
  if (!spec || typeof spec !== "object") throw new Error("indicator: spec required");
  if (!spec.name) throw new Error("indicator: name required");
  if (!spec.version) throw new Error(`indicator ${spec.name}: version required`);
  if (typeof spec.compute !== "function") throw new Error(`indicator ${spec.name}: compute fn required`);
  const req = spec.requires || {};
  if (!req.tf) throw new Error(`indicator ${spec.name}: requires.tf required`);
  if (!Number.isFinite(Number(req.minBars)) || Number(req.minBars) < 1) {
    throw new Error(`indicator ${spec.name}: requires.minBars must be >= 1`);
  }
  return {
    name: String(spec.name),
    version: String(spec.version),
    requires: {
      tf: String(req.tf),
      minBars: Number(req.minBars),
      finalizedOnly: req.finalizedOnly !== false, // default: confirmation indicators use finalized bars
    },
    compute: spec.compute,
  };
}

/**
 * Run an indicator against a SeriesView, enforcing the data contract.
 *
 * @param {IndicatorSpec} spec
 * @param {import("./series-contract.js").SeriesView} view
 * @returns {IndicatorResult}
 */
export function runIndicator(spec, view) {
  const s = defineIndicator(spec);
  const base = { name: s.name, version: s.version, tf: s.requires.tf };

  if (!view) return { ...base, available: false, value: null, reason: "no_series" };
  if (String(view.tf) !== s.requires.tf) {
    return { ...base, available: false, value: null, reason: `tf_mismatch:${view.tf}!=${s.requires.tf}` };
  }

  const gate = checkSeries(view, {
    minBars: s.requires.minBars,
    allowForming: !s.requires.finalizedOnly,
  });
  if (!gate.ok) return { ...base, available: false, value: null, reason: gate.reason };

  const bars = s.requires.finalizedOnly ? view.bars.filter((b) => b.finalized !== false) : view.bars;
  try {
    const value = s.compute(bars);
    if (value == null || (typeof value === "number" && !Number.isFinite(value))) {
      return { ...base, available: false, value: null, reason: "compute_returned_nonfinite" };
    }
    return { ...base, available: true, value, reason: null };
  } catch (err) {
    return { ...base, available: false, value: null, reason: `compute_error:${String(err?.message || err).slice(0, 80)}` };
  }
}
