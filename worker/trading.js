// Trading module — Kanban stage ordering, monotonicity, and direction helpers

/**
 * Kanban stage ordering for dual-mode system (Discovery + Management).
 * 
 * DISCOVERY MODE (no position):
 *   watch → setup → enter
 * 
 * MANAGEMENT MODE (has position):
 *   active → trim → exit → closed
 * 
 * Positions can only move forward within management mode.
 */
export const KANBAN_STAGE_ORDER = {
  // Discovery mode (no position)
  watch: 0,       // Monitoring pool - valid tickers, not ready
  setup: 1,       // In corridor + pullback - preparing for entry
  enter: 2,       // Gold Standard criteria met - actionable NOW
  // Management mode (has position)
  just_entered: 3, // Position just opened, < 15 min hold period
  hold: 4,        // Healthy position - on track, no action needed
  defend: 5,      // Warning signals - tighten SL, protect capital
  trim: 6,        // At extremes - take partial profit
  exit: 7,        // SL breach or critical - close position NOW
  // Legacy aliases
  active: 4,      // Maps to hold
  // Archive
  closed: 8,      // Position closed - completed, stopped, or expired
};

/** Legacy stage mapping for backward compatibility */
export const LEGACY_STAGE_MAP = {
  'setup_watch': 'setup',
  'flip_watch': 'setup',
  'enter_now': 'enter',
  'active': 'hold',
  'archive': 'closed',
};

/** Normalize legacy stage names to new system */
export function normalizeStage(stage) {
  if (!stage) return null;
  const s = String(stage).toLowerCase();
  return LEGACY_STAGE_MAP[s] || (KANBAN_STAGE_ORDER[s] !== undefined ? s : null);
}

/**
 * Enforce stage monotonicity for open positions: management lanes can only progress forward.
 * Prevents bouncing from EXIT→TRIM→ACTIVE due to price fluctuations.
 * 
 * Rules:
 * 1. Open positions MUST stay in management mode (active/trim/exit)
 * 2. Management stages can only move forward (active → trim → exit)
 * 3. Never regress from exit back to trim or active
 * 
 * @param {string} newStage - Newly computed stage
 * @param {string} prevStage - Previous stage (may be legacy name)
 * @param {boolean} hasOpenPosition - Whether there's an open position
 * @returns {string} - Finalized stage
 */
export function enforceStageMonotonicity(newStage, prevStage, hasOpenPosition) {
  // Normalize both stages to new system
  const normalizedNew = normalizeStage(newStage) || newStage;
  const normalizedPrev = normalizeStage(prevStage);
  
  if (!hasOpenPosition) return normalizedNew;
  if (!normalizedPrev || !normalizedNew) return normalizedNew;

  const newOrder = KANBAN_STAGE_ORDER[normalizedNew] ?? 0;
  const prevOrder = KANBAN_STAGE_ORDER[normalizedPrev] ?? 0;
  const activeOrder = KANBAN_STAGE_ORDER.active;

  // RULE 1: Open positions must be at least 'active' (floor)
  if (newOrder < activeOrder) {
    return normalizedPrev || 'active';
  }

  // RULE 2: Management stages only move forward (no regression)
  if (prevOrder >= activeOrder && newOrder < prevOrder) {
    return normalizedPrev;
  }

  return normalizedNew;
}

/** Get trade direction from state string. */
export function getTradeDirection(state) {
  const s = String(state || "");
  if (s.includes("BULL")) return "LONG";
  if (s.includes("BEAR")) return "SHORT";
  return null;
}
