// worker/foundation/score-contract.js
// ─────────────────────────────────────────────────────────────────────────────
//  FOUNDATION — Layer 4 contract: the score as a deterministic formula with a
//  critical-input gate (Phase 0 of tasks/2026-06-14-foundation-rebuild-plan.md).
//
//  score(inputs) -> { value, status, version, components, inputs_meta,
//                     missing_critical }
//
//  The whole thesis: a missing or stale CRITICAL input yields UNSCORABLE — never
//  a silent number. This kills the class of bug where the conviction signal ran
//  on `no_sector_data` / `spy_baseline_missing` and still emitted a score that
//  ranked and traded. The raw scoring formula is a PURE function of its declared
//  inputs; this wrapper gates emission and stamps provenance.
//
//  Status ladder:
//    UNSCORABLE  — at least one CRITICAL input unavailable/stale → value = null
//    DEGRADED    — all critical inputs OK but a non-critical one is bad → value emitted, flagged
//    SCORABLE    — every declared input available + fresh
//
//  Pure, deterministic, versioned. Same path in live and replay. Nothing in the
//  live worker imports this yet (additive scaffolding + tests).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} InputMeta
 * @property {boolean} available
 * @property {number} [as_of]    ms timestamp the input was sourced at
 * @property {number} [age_ms]   age relative to the score's as_of
 * @property {boolean} [stale]   explicit staleness (else derived from age + max_age_ms)
 * @property {number} [max_age_ms]  SLO for this input; age beyond it = stale
 */

/**
 * @typedef {Object} ScoreResult
 * @property {number|null} value
 * @property {"SCORABLE"|"DEGRADED"|"UNSCORABLE"} status
 * @property {string} version
 * @property {object|null} components
 * @property {Object<string,InputMeta>} inputs_meta
 * @property {string[]} missing_critical
 * @property {string[]} degraded_inputs
 */

/** An input is "bad" if it's unavailable OR stale (explicit or age-derived). */
export function isInputBad(meta) {
  if (!meta || meta.available === false) return true;
  if (meta.stale === true) return true;
  if (meta.stale === false) return false;
  const age = Number(meta.age_ms);
  const slo = Number(meta.max_age_ms);
  if (Number.isFinite(age) && Number.isFinite(slo) && slo > 0) return age > slo;
  return false;
}

/**
 * Evaluate the gated score.
 *
 * @param {Object} args
 * @param {string} args.version
 * @param {(inputs:object) => {value:number, components?:object}} args.formula  PURE
 * @param {object} args.inputs                 raw values the formula consumes
 * @param {Object<string,InputMeta>} args.inputs_meta
 * @param {string[]} args.critical             names of critical inputs (gate emission)
 * @returns {ScoreResult}
 */
export function evaluateScore({ version, formula, inputs, inputs_meta, critical }) {
  const meta = inputs_meta || {};
  const criticalSet = Array.isArray(critical) ? critical : [];

  const missing_critical = criticalSet.filter((name) => isInputBad(meta[name]));
  const degraded_inputs = Object.keys(meta).filter(
    (name) => !criticalSet.includes(name) && isInputBad(meta[name]),
  );

  if (missing_critical.length > 0) {
    return {
      value: null,
      status: "UNSCORABLE",
      version: String(version),
      components: null,
      inputs_meta: meta,
      missing_critical,
      degraded_inputs,
    };
  }

  let value = null;
  let components = null;
  try {
    const out = formula(inputs);
    value = typeof out === "number" ? out : Number(out?.value);
    components = (out && typeof out === "object") ? (out.components ?? null) : null;
  } catch (err) {
    return {
      value: null,
      status: "UNSCORABLE",
      version: String(version),
      components: null,
      inputs_meta: meta,
      missing_critical: [`formula_error:${String(err?.message || err).slice(0, 80)}`],
      degraded_inputs,
    };
  }

  if (!Number.isFinite(value)) {
    return {
      value: null,
      status: "UNSCORABLE",
      version: String(version),
      components,
      inputs_meta: meta,
      missing_critical: ["formula_returned_nonfinite"],
      degraded_inputs,
    };
  }

  return {
    value,
    status: degraded_inputs.length > 0 ? "DEGRADED" : "SCORABLE",
    version: String(version),
    components,
    inputs_meta: meta,
    missing_critical: [],
    degraded_inputs,
  };
}
