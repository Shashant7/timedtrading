// worker/model-lifecycle.js
// -----------------------------------------------------------------------------
// Unified model lifecycle — one product surface for trader + investor books.
//
// Product contract (plans/unified-model-lifecycle.plan.md):
//   Watching → Queued → Bought → Held → Trimming → Exited
//
// Horizon (swing / long_haul / day) and book (trader / investor) are metadata.
// This module RESOLVES the unified state from existing fields; it does not
// replace kanban_stage / investor stage storage yet.
// -----------------------------------------------------------------------------

export const MODEL_LIFECYCLE_VERSION = 1;

export const LIFECYCLE_STATES = Object.freeze({
  WATCHING: "watching",
  QUEUED: "queued",
  BOUGHT: "bought",
  HELD: "held",
  TRIMMING: "trimming",
  EXITED: "exited",
});

export const LIFECYCLE_LABELS = Object.freeze({
  watching: "Watching",
  queued: "Queued",
  bought: "Bought",
  held: "Held",
  trimming: "Trimming",
  exited: "Exited",
});

const TRADER_WATCHING = new Set([
  "setup", "setup_watch", "flip_watch", "watch", "research", "neutral",
]);
const TRADER_QUEUED = new Set([
  "in_review", "enter", "enter_now", "just_flipped", "queued",
]);
const TRADER_BOUGHT = new Set(["just_entered", "entered"]);
const TRADER_HELD = new Set(["hold", "active", "holding", "defend", "defending", "exiting"]);
const TRADER_TRIMMING = new Set(["trim", "trimming"]);
const TRADER_EXITED = new Set(["exit", "exited", "closed"]);

const INVESTOR_WATCHING = new Set([
  "research_on_watch", "watch", "research_low", "research_avoid", "on_radar",
]);
const INVESTOR_QUEUED = new Set(["accumulate_queued", "accumulate"]);
const INVESTOR_BOUGHT = new Set(["accumulate_entered", "entered"]);
const INVESTOR_HELD = new Set(["core_hold", "hold"]);
const INVESTOR_TRIMMING = new Set(["reduce", "reducing", "trim"]);
const INVESTOR_EXITED = new Set(["exited", "exit"]);

/**
 * Resolve unified lifecycle state from trader and/or investor fields.
 *
 * Priority when both books touch the same ticker:
 *   open position / trim / exit > queued > watching
 *   trader "doing" beats investor watching (and vice versa for investor open).
 */
export function resolveModelLifecycle(input = {}) {
  const ticker = String(input.ticker || "").toUpperCase() || null;
  const traderStage = norm(input.kanban_stage || input.trader_stage);
  const investorStage = norm(input.investor_stage || input.stage);
  const actionTier = String(input.actionTier || input.action_tier || "").toLowerCase();
  const hasOpenTrader = input.open_trader === true || input.has_open_trader === true;
  const hasOpenInvestor = input.open_investor === true || input.has_open_investor === true;
  const trimmedToday = input.trimmed_today === true;
  const justEnteredMs = Number(input.entry_ts || input.just_entered_ts);
  const now = Number(input.nowMs) || Date.now();
  const boughtWindowMs = Number(input.bought_window_ms) || 4 * 60 * 60 * 1000;

  const traderState = mapTraderStage(traderStage, {
    hasOpen: hasOpenTrader,
    trimmedToday,
    justEntered: Number.isFinite(justEnteredMs) && (now - justEnteredMs) < boughtWindowMs,
  });
  const investorState = mapInvestorStage(investorStage, {
    hasOpen: hasOpenInvestor,
    actionTier,
    justEntered: Number.isFinite(justEnteredMs) && (now - justEnteredMs) < boughtWindowMs
      && hasOpenInvestor,
  });

  const state = pickDominantState(traderState, investorState, {
    hasOpenTrader,
    hasOpenInvestor,
  });

  const horizon = resolveHorizon(input, state, traderState, investorState);
  const book = resolveBook({
    hasOpenTrader,
    hasOpenInvestor,
    traderState,
    investorState,
    preferred: input.book,
  });

  const why = input.why || input.reason || input.stageReason || input.stage_reason || null;
  const intent = input.intent || defaultIntent(state, horizon, book);
  const levels = normalizeLevels(input.levels || input);

  return {
    version: MODEL_LIFECYCLE_VERSION,
    ticker,
    state,
    label: LIFECYCLE_LABELS[state] || state,
    horizon,
    book,
    why: why ? String(why).slice(0, 280) : null,
    intent,
    levels,
    sources: {
      trader_stage: traderStage || null,
      trader_lifecycle: traderState,
      investor_stage: investorStage || null,
      investor_lifecycle: investorState,
      action_tier: actionTier || null,
    },
  };
}

function norm(v) {
  return String(v || "").toLowerCase().trim();
}

function mapTraderStage(stage, opts = {}) {
  if (opts.trimmedToday) return LIFECYCLE_STATES.TRIMMING;
  if (opts.hasOpen && opts.justEntered) return LIFECYCLE_STATES.BOUGHT;
  if (opts.hasOpen && TRADER_TRIMMING.has(stage)) return LIFECYCLE_STATES.TRIMMING;
  if (opts.hasOpen && (TRADER_HELD.has(stage) || TRADER_BOUGHT.has(stage) || !stage)) {
    return LIFECYCLE_STATES.HELD;
  }
  if (TRADER_EXITED.has(stage) && !opts.hasOpen) return LIFECYCLE_STATES.EXITED;
  if (TRADER_BOUGHT.has(stage)) return LIFECYCLE_STATES.BOUGHT;
  if (TRADER_TRIMMING.has(stage)) return LIFECYCLE_STATES.TRIMMING;
  if (TRADER_QUEUED.has(stage)) return LIFECYCLE_STATES.QUEUED;
  if (TRADER_HELD.has(stage)) return LIFECYCLE_STATES.HELD;
  if (TRADER_WATCHING.has(stage) || !stage) return LIFECYCLE_STATES.WATCHING;
  return LIFECYCLE_STATES.WATCHING;
}

function mapInvestorStage(stage, opts = {}) {
  const tier = String(opts.actionTier || "");
  // accumulate + act_now/ready = queued for the hourly rebalance
  if (stage === "accumulate" && (tier === "act_now" || tier === "ready" || tier === "queued")) {
    return LIFECYCLE_STATES.QUEUED;
  }
  if (opts.hasOpen && opts.justEntered) return LIFECYCLE_STATES.BOUGHT;
  if (opts.hasOpen && INVESTOR_TRIMMING.has(stage)) return LIFECYCLE_STATES.TRIMMING;
  if (opts.hasOpen && (INVESTOR_HELD.has(stage) || INVESTOR_BOUGHT.has(stage) || stage === "accumulate")) {
    return stage === "accumulate" && !opts.hasOpen
      ? LIFECYCLE_STATES.QUEUED
      : LIFECYCLE_STATES.HELD;
  }
  if (INVESTOR_EXITED.has(stage) && !opts.hasOpen) return LIFECYCLE_STATES.EXITED;
  if (INVESTOR_BOUGHT.has(stage)) return LIFECYCLE_STATES.BOUGHT;
  if (INVESTOR_TRIMMING.has(stage)) return LIFECYCLE_STATES.TRIMMING;
  if (INVESTOR_QUEUED.has(stage)) return LIFECYCLE_STATES.QUEUED;
  if (INVESTOR_HELD.has(stage)) return LIFECYCLE_STATES.HELD;
  if (INVESTOR_WATCHING.has(stage) || !stage) return LIFECYCLE_STATES.WATCHING;
  return LIFECYCLE_STATES.WATCHING;
}

const STATE_RANK = {
  [LIFECYCLE_STATES.EXITED]: 1,
  [LIFECYCLE_STATES.WATCHING]: 2,
  [LIFECYCLE_STATES.QUEUED]: 3,
  [LIFECYCLE_STATES.BOUGHT]: 4,
  [LIFECYCLE_STATES.HELD]: 5,
  [LIFECYCLE_STATES.TRIMMING]: 6,
};

function pickDominantState(traderState, investorState, opts = {}) {
  // Open book wins over watching/exited on the other engine.
  if (opts.hasOpenTrader && traderState !== LIFECYCLE_STATES.WATCHING) return traderState;
  if (opts.hasOpenInvestor && investorState !== LIFECYCLE_STATES.WATCHING) return investorState;
  if (opts.hasOpenTrader) return traderState === LIFECYCLE_STATES.WATCHING ? LIFECYCLE_STATES.HELD : traderState;
  if (opts.hasOpenInvestor) return investorState === LIFECYCLE_STATES.WATCHING ? LIFECYCLE_STATES.HELD : investorState;

  const tRank = STATE_RANK[traderState] ?? 0;
  const iRank = STATE_RANK[investorState] ?? 0;
  // Prefer actionable (queued/trimming) over passive watching when flat.
  if (tRank >= iRank) return traderState;
  return investorState;
}

function resolveHorizon(input, state, traderState, investorState) {
  const explicit = String(input.horizon || "").toLowerCase();
  if (explicit === "day" || explicit === "swing" || explicit === "long_haul") return explicit;
  if (input.day_trade === true) return "day";
  if (investorState !== LIFECYCLE_STATES.WATCHING && investorState !== LIFECYCLE_STATES.EXITED) {
    return "long_haul";
  }
  if (traderState !== LIFECYCLE_STATES.WATCHING && traderState !== LIFECYCLE_STATES.EXITED) {
    return "swing";
  }
  return "swing";
}

function resolveBook({ hasOpenTrader, hasOpenInvestor, traderState, investorState, preferred }) {
  if (preferred === "trader" || preferred === "investor" || preferred === "both") return preferred;
  if (hasOpenTrader && hasOpenInvestor) return "both";
  if (hasOpenTrader) return "trader";
  if (hasOpenInvestor) return "investor";
  const tActive = traderState === LIFECYCLE_STATES.QUEUED || traderState === LIFECYCLE_STATES.TRIMMING;
  const iActive = investorState === LIFECYCLE_STATES.QUEUED || investorState === LIFECYCLE_STATES.TRIMMING;
  if (tActive && iActive) return "both";
  if (iActive) return "investor";
  if (tActive) return "trader";
  return "trader";
}

function defaultIntent(state, horizon, book) {
  if (state === LIFECYCLE_STATES.WATCHING) return "stalk_levels";
  if (state === LIFECYCLE_STATES.QUEUED) {
    return horizon === "long_haul" ? "accumulate_on_clear" : "enter_on_clear";
  }
  if (state === LIFECYCLE_STATES.BOUGHT || state === LIFECYCLE_STATES.HELD) {
    return horizon === "long_haul" ? "hold_structure" : "hold_to_targets";
  }
  if (state === LIFECYCLE_STATES.TRIMMING) return "reduce_partial";
  if (state === LIFECYCLE_STATES.EXITED) return "flat";
  return "observe";
}

function normalizeLevels(src = {}) {
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : null;
  };
  const levels = {
    entry: n(src.entry ?? src.entry_price ?? src.price),
    invalidation: n(src.invalidation ?? src.sl ?? src.stop_loss ?? src.stop),
    target_1: n(src.target_1 ?? src.tp1 ?? src.tp ?? src.take_profit),
    target_2: n(src.target_2 ?? src.tp2),
    target_3: n(src.target_3 ?? src.tp3),
    next_decision: n(src.next_decision ?? src.trigger_price ?? src.decision_price),
  };
  const any = Object.values(levels).some((v) => v != null);
  return any ? levels : null;
}

/** Compact stamp for timed:latest / investor scores / UI. */
export function modelLifecycleLineage(lifecycle) {
  if (!lifecycle) return null;
  return {
    version: lifecycle.version || MODEL_LIFECYCLE_VERSION,
    state: lifecycle.state,
    label: lifecycle.label,
    horizon: lifecycle.horizon,
    book: lifecycle.book,
    why: lifecycle.why,
    intent: lifecycle.intent,
    levels: lifecycle.levels,
  };
}

/**
 * Human one-liner for feeds: "Held · swing — hold to targets".
 */
export function formatLifecycleHeadline(lifecycle) {
  if (!lifecycle) return null;
  const label = lifecycle.label || LIFECYCLE_LABELS[lifecycle.state] || lifecycle.state;
  const horizon = lifecycle.horizon ? ` · ${lifecycle.horizon.replace(/_/g, " ")}` : "";
  const intent = lifecycle.intent ? ` — ${String(lifecycle.intent).replace(/_/g, " ")}` : "";
  return `${label}${horizon}${intent}`;
}
