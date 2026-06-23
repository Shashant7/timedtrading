// ═══════════════════════════════════════════════════════════════════════════
// worker/signal-grammar.js — Unified signal taxonomy (Watching vs Doing ×
// Trader vs Investor). Single source of truth for Discord, email, bell,
// activity strip, and kanban badge copy.
// ═══════════════════════════════════════════════════════════════════════════

/** @typedef {'trader'|'investor'} SignalEngine */
/** @typedef {'watching'|'doing'} SignalMode */
/** @typedef {'watching'|'recommended'|'done'} SignalExecState */
/** @typedef {'enter'|'add'|'trim'|'exit'|'hold'|'accumulate'|'reduce'|'core_hold'|'watch'|'defend'|'setup'|'review'} SignalAction */

/**
 * @param {object} opts
 * @returns {object}
 */
export function buildSignal(opts = {}) {
  const engine = String(opts.engine || "trader").toLowerCase() === "investor" ? "investor" : "trader";
  const execStateRaw = String(opts.execState || opts.exec_state || "watching").toLowerCase();
  const execState = execStateRaw === "done" || execStateRaw === "recommended"
    ? execStateRaw
    : "watching";
  let mode = String(opts.mode || "").toLowerCase();
  if (mode !== "watching" && mode !== "doing") {
    mode = execState === "recommended" || execState === "done" || opts.actionTaken ? "doing" : "watching";
  }
  if (execState === "recommended" || execState === "done") mode = "doing";

  const action = String(opts.action || "hold").toLowerCase();
  const severity = String(opts.severity || inferSeverity(mode, execState, action));

  return {
    engine,
    mode,
    execState,
    action,
    ticker: String(opts.ticker || "").toUpperCase(),
    direction: opts.direction ? String(opts.direction).toUpperCase() : null,
    price: Number.isFinite(Number(opts.price)) ? Number(opts.price) : null,
    reasonHuman: opts.reasonHuman || opts.reason || null,
    severity,
    tradeId: opts.tradeId || opts.trade_id || null,
    pnlPct: Number.isFinite(Number(opts.pnlPct)) ? Number(opts.pnlPct) : null,
    trimmedPct: Number.isFinite(Number(opts.trimmedPct)) ? Number(opts.trimmedPct) : null,
    meta: opts.meta && typeof opts.meta === "object" ? opts.meta : {},
  };
}

function inferSeverity(mode, execState, action) {
  if (execState === "done") return "info";
  if (execState === "recommended") return "action";
  if (mode === "doing") return "action";
  if (action === "reduce" || action === "exit") return "warn";
  return "info";
}

export function engineLabel(engine) {
  return engine === "investor" ? "INVESTOR" : "TRADER";
}

export function modeLabel(mode) {
  return mode === "doing" ? "DOING" : "WATCHING";
}

export function execStateLabel(execState) {
  if (execState === "recommended") return "RECOMMENDED";
  if (execState === "done") return "DONE";
  return "";
}

export function actionVerb(action) {
  const map = {
    enter: "Enter",
    add: "Add",
    trim: "Trim",
    exit: "Exit",
    hold: "Hold",
    accumulate: "Accumulate",
    reduce: "Reduce",
    core_hold: "Core Hold",
    watch: "Watch",
    defend: "Defend",
    setup: "Setup",
    review: "Review",
  };
  return map[String(action || "").toLowerCase()] || "Update";
}

/** Discord title: `{emoji} TRADER · DOING · Exit: MU` */
export function renderDiscordTitle(signal, { emoji = "" } = {}) {
  const s = typeof signal === "object" ? signal : buildSignal(signal);
  const parts = [engineLabel(s.engine), modeLabel(s.mode)];
  const execLbl = execStateLabel(s.execState);
  if (execLbl) parts.push(execLbl);
  const prefix = emoji ? `${emoji} ` : "";
  const verb = actionVerb(s.action);
  const tail = s.ticker ? `: ${s.ticker}` : "";
  return `${prefix}${parts.join(" · ")} · ${verb}${tail}`.replace(/\s+/g, " ").trim();
}

/** Email subject: `[TRADER · DOING] Exit MU LONG +42.97%` */
export function renderEmailSubject(signal, extras = {}) {
  const s = typeof signal === "object" ? signal : buildSignal(signal);
  const dir = s.direction ? ` ${s.direction}` : "";
  const pct = Number.isFinite(s.pnlPct)
    ? ` ${s.pnlPct >= 0 ? "+" : ""}${s.pnlPct.toFixed(2)}%`
    : "";
  const price = Number.isFinite(s.price) ? ` @ $${s.price.toFixed(2)}` : "";
  const thread = extras.threadLabel ? ` (${extras.threadLabel})` : "";
  return `[${engineLabel(s.engine)} · ${modeLabel(s.mode)}] ${actionVerb(s.action)} ${s.ticker}${dir}${pct}${price}${thread}`.trim();
}

/** Winner/loss close title — avoids "Closed 25%" reading like a trim. */
export function formatTradeCloseTitle({
  ticker,
  direction,
  status,
  pnlPct,
  exitPrice,
  trimmedPct,
  actionTs,
  formatEtClock,
}) {
  const isWin = status === "WIN";
  const isFlat = status === "FLAT";
  const pctLabel = `${Number(pnlPct) >= 0 ? "+" : ""}${Number(pnlPct || 0).toFixed(2)}%`;
  const priorTrim = Number.isFinite(Number(trimmedPct)) ? Number(trimmedPct) : 0;
  const runnerPct = priorTrim > 0 && priorTrim < 0.9999
    ? Math.round((1 - priorTrim) * 100)
    : 100;
  const dir = String(direction || "").toUpperCase();
  let headline;
  if (isWin) headline = `Full exit ${pctLabel}`;
  else if (isFlat) headline = `Flat exit`;
  else headline = `Stopped out ${pctLabel}`;

  let detail = priorTrim > 0 && priorTrim < 0.9999
    ? ` — closed final ${runnerPct}% runner (after trimming ${Math.round(priorTrim * 100)}%)`
    : ` — closed full position`;

  const emoji = isWin ? "🏆" : isFlat ? "➖" : "🛑";
  const statusWord = isWin ? "Winner" : isFlat ? "Flat" : "Stopped Out";
  let title = `${emoji}  TRADER · DOING · DONE · ${statusWord}: ${ticker} ${dir} — ${headline}${detail}`;
  if (Number.isFinite(Number(exitPrice))) title += ` @ $${Number(exitPrice).toFixed(2)}`;
  if (typeof formatEtClock === "function") {
    const et = formatEtClock(actionTs);
    if (et) title += ` · ${et}`;
  }
  return title;
}

export function formatExitRecommendedTitle(ticker) {
  return `🚪  TRADER · DOING · RECOMMENDED · Exit: ${String(ticker || "").toUpperCase()}`;
}

export function formatTradeTrimTitle({ ticker, direction, stepLabel, fillPrice, isProfit }) {
  const emoji = isProfit ? "💰" : "✂️";
  const action = isProfit ? "Taking Profit" : "Trimming";
  return `${emoji}  TRADER · DOING · DONE · ${action}: ${ticker} ${direction} — ${stepLabel} @ $${Number(fillPrice).toFixed(2)}`;
}

export function formatTradeEntryTitle({ ticker, direction, entryPrice, isLong }) {
  const emoji = isLong ? "🟢" : "🔴";
  const dirLabel = isLong ? "LONG" : "SHORT";
  return `${emoji}  TRADER · DOING · DONE · Enter: ${ticker} ${dirLabel} @ $${Number(entryPrice).toFixed(2)}`;
}

/** Trader kanban lane metadata with watching/doing band. */
export const TRADER_LANE_META = Object.freeze({
  setup: { band: "watching", label: "Watchlist", action: "WATCH", title: "Setup forming — no action yet." },
  setup_watch: { band: "watching", label: "Watchlist", action: "WATCH", title: "Setup forming — no action yet." },
  flip_watch: { band: "watching", label: "Watchlist", action: "WATCH", title: "Flip watch — monitoring for trigger." },
  in_review: { band: "watching", label: "Trigger Ready", action: "REVIEW", title: "Model is evaluating an entry." },
  enter: { band: "watching", label: "Trigger Ready", action: "REVIEW", title: "Model is evaluating an entry." },
  enter_now: { band: "doing", label: "Trigger Ready", action: "ENTER", title: "Entry qualified — model may act." },
  just_flipped: { band: "watching", label: "Trigger Ready", action: "REVIEW", title: "Fresh flip — under review." },
  just_entered: { band: "doing", label: "Just Entered", action: "HOLD", title: "Trade just opened." },
  hold: { band: "doing", label: "Holding", action: "HOLD", title: "Thesis intact — let it work." },
  active: { band: "doing", label: "Holding", action: "HOLD", title: "Thesis intact — let it work." },
  defend: { band: "doing", label: "Defending", action: "DEFEND", title: "Under pressure — managing risk." },
  trim: { band: "doing", label: "Trimming", action: "TRIM", title: "Taking partial profits." },
  exiting: { band: "doing", label: "Exiting", action: "EXIT", title: "Model recommends closing — position still open." },
  exit: { band: "doing", label: "Closed", action: "DONE", title: "Recently closed — visible for 24h." },
  watch: { band: "watching", label: "Off Board", action: "—", title: "Not shown on the board." },
});

/** Investor kanban lane metadata with watching/doing band. */
export const INVESTOR_LANE_META = Object.freeze({
  research_on_watch: { band: "watching", label: "On Radar", action: "WAIT", title: "Not owned — worth tracking." },
  research_low: { band: "watching", label: "Low Conviction", action: "WAIT", title: "Not owned — low conviction." },
  research_avoid: { band: "watching", label: "Avoid", action: "SKIP", title: "Not owned — weak signals." },
  accumulate: { band: "doing", label: "Accumulating", action: "BUY", title: "Execution-ready — model would add." },
  core_hold: { band: "doing", label: "Core Hold", action: "HOLD", title: "Owned core — let it run." },
  watch: { band: "doing", label: "Hold & Watch", action: "HOLD", title: "Owned — mixed signals, hold flat." },
  reduce: { band: "doing", label: "Reducing", action: "TRIM", title: "Owned — thesis weakening." },
});

export function traderLaneMeta(stage) {
  const key = String(stage || "").toLowerCase();
  return TRADER_LANE_META[key] || { band: "watching", label: key || "—", action: "—", title: "" };
}

export function investorLaneMeta(stage) {
  const key = String(stage || "").toLowerCase();
  return INVESTOR_LANE_META[key] || { band: "watching", label: key || "—", action: "—", title: "" };
}

/** Map raw activity / alert event to unified classification. */
export function classifyActivityEvent(ev) {
  const t = String(ev?.type || ev?.event || "").toUpperCase();
  const modeRaw = String(ev?.mode || ev?.alert_class || "").toLowerCase();
  const engine = String(ev?.engine || ev?.desk || "").toLowerCase() === "investor"
    || t === "INVESTOR_SIGNAL"
    || ev?.investor_alert_type
    ? "investor"
    : "trader";

  if (t === "TRADE_EXIT_SIGNAL" || t === "KANBAN_EXIT" || modeRaw === "recommended") {
    return {
      engine,
      mode: "doing",
      execState: "recommended",
      action: "exit",
      evType: "EXIT",
      label: "EXIT",
      cls: "ev-exit ev-recommended",
      scope: engine,
    };
  }

  const doingTypes = new Set([
    "TRADE_ENTRY", "TRADE_TRIM", "TRADE_EXIT", "ENTRY", "ENTER", "ADD", "ADD_ENTRY",
    "TRIM", "TP_HIT_TRIM", "EXIT", "TP_HIT_EXIT", "SL_HIT",
  ]);
  const isDoing = doingTypes.has(t) || modeRaw === "doing" || modeRaw === "done";

  let action = "hold";
  let label = "UPDATE";
  let cls = "";
  if (t.includes("ENTRY") || t === "ENTER" || t === "ADD") { action = t.includes("ADD") ? "add" : "enter"; label = t.includes("ADD") ? "ADD" : "ENTER"; cls = "ev-entry"; }
  else if (t.includes("TRIM") || t === "TP_HIT_TRIM") { action = "trim"; label = "TRIM"; cls = "ev-trim"; }
  else if (t.includes("EXIT") || t === "SL_HIT") { action = "exit"; label = "EXIT"; cls = "ev-exit"; }

  if (t === "INVESTOR_SIGNAL") {
    const invT = String(ev?.investor_alert_type || "").toLowerCase();
    if (invT === "position_add") { action = "add"; label = "ADD"; cls = "ev-entry"; }
    else if (invT === "position_trim") { action = "trim"; label = "TRIM"; cls = "ev-trim"; }
    else if (invT === "position_close") { action = "exit"; label = "EXIT"; cls = "ev-exit"; }
    else { action = "accumulate"; label = "WATCH"; cls = "ev-watching"; }
  }

  return {
    engine,
    mode: isDoing ? "doing" : "watching",
    execState: isDoing ? "done" : "watching",
    action,
    evType: t,
    label,
    cls: cls || (isDoing ? "ev-doing" : "ev-watching"),
    scope: engine,
  };
}

export function notificationMetaFromSignal(signal) {
  const s = typeof signal === "object" ? signal : buildSignal(signal);
  return {
    alert_class: s.mode,
    severity: s.severity,
    engine: s.engine,
    exec_state: s.execState,
  };
}
