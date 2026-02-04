// Trading module — Kanban stage ordering, monotonicity, and direction helpers

/** Kanban stage ordering for monotonicity (positions can only move forward). */
export const KANBAN_STAGE_ORDER = {
  watch: 0,
  setup_watch: 1,
  flip_watch: 2,
  enter_now: 3,
  just_entered: 4,
  hold: 5,
  trim: 6,
  exit: 7,
  archive: 8,
};

/**
 * Enforce stage monotonicity for open positions: management lanes can only progress forward.
 * Prevents bouncing from EXIT→TRIM→HOLD due to price fluctuations.
 * @param {string} newStage - Newly computed stage
 * @param {string} prevStage - Previous stage
 * @param {boolean} hasOpenPosition - Whether there's an open position
 * @returns {string} - Finalized stage
 */
export function enforceStageMonotonicity(newStage, prevStage, hasOpenPosition) {
  if (!hasOpenPosition) return newStage;
  if (!prevStage || !newStage) return newStage;

  const newOrder = KANBAN_STAGE_ORDER[newStage] ?? 0;
  const prevOrder = KANBAN_STAGE_ORDER[prevStage] ?? 0;

  if (prevOrder >= KANBAN_STAGE_ORDER.just_entered && prevStage !== "archive") {
    if (newOrder < prevOrder) {
      return prevStage;
    }
  }
  return newStage;
}

/** Get trade direction from state string. */
export function getTradeDirection(state) {
  const s = String(state || "");
  if (s.includes("BULL")) return "LONG";
  if (s.includes("BEAR")) return "SHORT";
  return null;
}
