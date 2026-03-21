// worker/pipeline/exit-engine.js
// Strategy-pattern dispatcher for exit/management evaluation.
// Routes to the correct engine module based on ctx.config.managementEngine.

const _engines = new Map();

/**
 * Register an exit engine implementation.
 * @param {string} name - Engine identifier ("tt_core", "ripster_core", "legacy")
 * @param {{ evaluateExit: (ctx, position) => ExitResult|null }} mod
 */
export function registerExitEngine(name, mod) {
  if (!mod || typeof mod.evaluateExit !== "function") {
    throw new Error(`Exit engine "${name}" must export evaluateExit(ctx, position)`);
  }
  _engines.set(name, mod);
}

/**
 * Evaluate exit using the management engine specified in ctx.config.managementEngine.
 * Returns ExitResult if an engine handled it, or null if no engine is registered
 * (caller falls through to inline logic during migration).
 *
 * ExitResult shape:
 * {
 *   stage: "hold"|"defend"|"trim"|"exit"|"just_entered",
 *   reason: string,
 *   family: string,       // e.g. "ripster_cloud", "ripster_pdz", "legacy_phase"
 *   metadata: object,     // engine-specific context
 * }
 */
export function evaluateExit(ctx, position) {
  const engineName = ctx.config.managementEngine;
  const engine = _engines.get(engineName);
  if (!engine) return null;
  return engine.evaluateExit(ctx, position);
}

/**
 * Check if an exit engine is registered.
 */
export function hasExitEngine(name) {
  return _engines.has(name);
}

/**
 * List registered exit engines (for diagnostics).
 */
export function listExitEngines() {
  return [..._engines.keys()];
}
