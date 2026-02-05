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
  active: 3,      // Healthy position - hold, monitor
  trim: 4,        // Approaching profit target - take partial profits
  exit: 5,        // Stop hit or invalidated - close position
  // Archive
  closed: 6,      // Position closed - completed, stopped, or expired
};

/** Legacy stage mapping for backward compatibility */
export const LEGACY_STAGE_MAP = {
  'setup_watch': 'setup',
  'flip_watch': 'setup',
  'enter_now': 'enter',
  'just_entered': 'active',
  'hold': 'active',
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
