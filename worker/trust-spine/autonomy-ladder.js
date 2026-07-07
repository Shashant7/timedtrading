// Trust Spine — autonomy ladder L0–L5 (advisory → full self-driving).

export const AUTONOMY_LEVELS = Object.freeze({
  L0: { id: "L0", label: "Advisory", description: "Engine signals; human executes" },
  L1: { id: "L1", label: "Supervised", description: "Engine proposes; human one-click approves" },
  L2: { id: "L2", label: "Bounded autonomy", description: "Auto-execute proven setups within risk caps" },
  L3: { id: "L3", label: "Self-calibrating", description: "Auto-tune within bounds; attributed + reversible" },
  L4: { id: "L4", label: "Capital-scaling", description: "Sizing scales with proven edge" },
  L5: { id: "L5", label: "Full self-driving", description: "Engine runs the book; humans set policy" },
});

const LEVEL_ORDER = ["L0", "L1", "L2", "L3", "L4", "L5"];

export const DEFAULT_AUTONOMY_CAPS = Object.freeze({
  L0: { max_auto_orders_per_day: 0, options_auto_mirror: false, conviction_sizing: false },
  L1: { max_auto_orders_per_day: 0, options_auto_mirror: false, conviction_sizing: false },
  L2: { max_auto_orders_per_day: 3, options_auto_mirror: true, conviction_sizing: false },
  L3: { max_auto_orders_per_day: 5, options_auto_mirror: true, conviction_sizing: true },
  L4: { max_auto_orders_per_day: 8, options_auto_mirror: true, conviction_sizing: true },
  L5: { max_auto_orders_per_day: 15, options_auto_mirror: true, conviction_sizing: true },
});

export function normalizeAutonomyLevel(raw) {
  const s = String(raw || "L0").toUpperCase().trim();
  return LEVEL_ORDER.includes(s) ? s : "L0";
}

/** Read autonomy level from deep-audit / model_config map. */
export function resolveAutonomyConfig(daCfg = {}) {
  const level = normalizeAutonomyLevel(daCfg.autonomy_level ?? daCfg.trust_spine_autonomy_level ?? "L0");
  const caps = { ...DEFAULT_AUTONOMY_CAPS[level] };
  const idx = LEVEL_ORDER.indexOf(level);
  return {
    level,
    meta: AUTONOMY_LEVELS[level],
    caps,
    options_auto_mirror_allowed: idx >= 2,
    conviction_sizing_allowed: idx >= 3,
    auto_execute_allowed: idx >= 2,
    rung_index: idx,
    next_rung: idx < LEVEL_ORDER.length - 1 ? LEVEL_ORDER[idx + 1] : null,
  };
}

/** Gate checklist for advancing rungs (operator + automated scorecard). */
export function evaluateRungGates(metrics = {}) {
  const n = Number(metrics.attributed_trades) || 0;
  const wr = Number(metrics.win_rate);
  const sqn = Number(metrics.sqn);
  const maxDd = Number(metrics.max_drawdown_pct);
  const epochs = Number(metrics.config_epochs) || 0;
  const reproducible = metrics.reproducible !== false;

  const gates = {
    min_attributed_trades: n >= 30,
    positive_expectancy: Number.isFinite(sqn) ? sqn > 0 : null,
    win_rate_ok: Number.isFinite(wr) ? wr >= 50 : null,
    drawdown_within_budget: Number.isFinite(maxDd) ? maxDd <= 15 : null,
    multi_epoch_attribution: epochs >= 2,
    reproducible_decisions: reproducible,
  };
  const passed = Object.values(gates).filter((v) => v === true).length;
  const total = Object.values(gates).filter((v) => v !== null).length;
  return { gates, passed, total, ready_to_advance: passed === total && total > 0 };
}
