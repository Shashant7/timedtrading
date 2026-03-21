// worker/pipeline/entry-engine.js
// Strategy-pattern dispatcher for entry evaluation.
// Routes to the correct engine module based on ctx.config.engine.

const _engines = new Map();

/**
 * Register an entry engine implementation.
 * @param {string} name - Engine identifier ("tt_core", "ripster_core", "legacy")
 * @param {{ evaluateEntry: (ctx: TradeContext) => EntryResult|null }} mod
 */
export function registerEntryEngine(name, mod) {
  if (!mod || typeof mod.evaluateEntry !== "function") {
    throw new Error(`Entry engine "${name}" must export evaluateEntry(ctx)`);
  }
  _engines.set(name, mod);
}

/**
 * Evaluate entry using the engine specified in ctx.config.engine.
 * Returns EntryResult if an engine handled it, or null if no engine is registered
 * (caller falls through to inline logic during migration).
 */
export function evaluateEntry(ctx) {
  const engineName = ctx.config.engine;
  const engine = _engines.get(engineName);
  if (!engine) return null;
  return engine.evaluateEntry(ctx);
}

/**
 * Check if an engine is registered.
 */
export function hasEngine(name) {
  return _engines.has(name);
}

/**
 * List registered engines (for diagnostics).
 */
export function listEngines() {
  return [..._engines.keys()];
}
