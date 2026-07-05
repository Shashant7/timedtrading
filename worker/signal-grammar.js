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

/** Phase D4 — verdict vocabulary for notifications and Discord titles. */
export function verdictWordFromSignal(signal) {
  const s = typeof signal === "object" ? signal : buildSignal(signal);
  const action = String(s.action || "").toLowerCase();
  if (action === "enter" || action === "accumulate") return "BUY";
  if (action === "exit" || action === "reduce") return "SELL";
  if (action === "trim" || action === "defend") return "TIGHTEN";
  if (action === "hold" || action === "core_hold") return "HOLD";
  if (action === "setup" || action === "review" || action === "watch") return "FORMING";
  return actionVerb(s.action).toUpperCase();
}

/** Discord title: `{emoji} TRADER · BUY · NVDA` (lane + verdict word first). */
export function renderDiscordTitle(signal, { emoji = "" } = {}) {
  const s = typeof signal === "object" ? signal : buildSignal(signal);
  const prefix = emoji ? `${emoji} ` : "";
  const verdict = verdictWordFromSignal(s);
  const tail = s.ticker ? `: ${s.ticker}` : "";
  return `${prefix}${engineLabel(s.engine)} · ${verdict}${tail}`.replace(/\s+/g, " ").trim();
}

/** Bell / notification title — strips legacy DOING/WATCHING bracket prefixes. */
export function formatNotificationTitle(raw, opts = {}) {
  let t = String(raw || "").trim();
  t = t.replace(/^\[(?:TRADER|INVESTOR)\s*·\s*(?:DOING|WATCHING)(?:\s*·\s*\w+)?\]\s*/i, "");
  t = t.replace(/^\[(?:TRADER|INVESTOR)\s*·\s*\w+\]\s*/i, "");
  return t.trim();
}

/** Email / bell subject: `Exit GEV LONG -1.00% @ $1042.00 (filled)` */
export function renderEmailSubject(signal, extras = {}) {
  const s = typeof signal === "object" ? signal : buildSignal(signal);
  const dir = s.direction ? ` ${s.direction}` : "";
  const pct = Number.isFinite(s.pnlPct)
    ? ` ${s.pnlPct >= 0 ? "+" : ""}${s.pnlPct.toFixed(2)}%`
    : "";
  const price = Number.isFinite(s.price) ? ` @ $${s.price.toFixed(2)}` : "";
  const thread = extras.threadLabel ? ` (${extras.threadLabel})` : "";
  if (s.execState === "recommended") {
    return `Warning: ${s.ticker} — ${actionVerb(s.action).toLowerCase()} recommended`;
  }
  return `${actionVerb(s.action)} ${s.ticker}${dir}${pct}${price}${thread}`.trim();
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
  let title = `${emoji} Exit: ${ticker} ${dir} — ${headline}${detail}`;
  if (Number.isFinite(Number(exitPrice))) title += ` @ $${Number(exitPrice).toFixed(2)}`;
  if (typeof formatEtClock === "function") {
    const et = formatEtClock(actionTs);
    if (et) title += ` · ${et}`;
  }
  return title;
}

export function formatExitRecommendedTitle(ticker) {
  return `⚠️ Warning: ${String(ticker || "").toUpperCase()} — Exit recommended`;
}

export function formatTradeTrimTitle({ ticker, direction, stepLabel, fillPrice, isProfit }) {
  const emoji = isProfit ? "💰" : "✂️";
  const action = isProfit ? "Taking Profit" : "Trimming";
  return `${emoji}  TRADER · ${action}: ${ticker} ${direction} — ${stepLabel} @ $${Number(fillPrice).toFixed(2)}`;
}

export function formatTradeEntryTitle({ ticker, direction, entryPrice, isLong }) {
  const emoji = isLong ? "🟢" : "🔴";
  const dirLabel = isLong ? "LONG" : "SHORT";
  return `${emoji} Enter: ${ticker} ${dirLabel} @ $${Number(entryPrice).toFixed(2)}`;
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

/** Passive investor verbs — no push, bell, or activity strip. */
export const INVESTOR_PASSIVE_ALERT_VERBS = Object.freeze([
  "MODEL · ON RADAR",
  "MODEL · WATCH",
  "MODEL · INFO",
]);

/** Actionable investor verbs — executed, trigger-ready, or queued-by-policy. */
export const INVESTOR_ACTIONABLE_ALERT_VERBS = Object.freeze([
  "MODEL · QUEUE",
  "MODEL · BOUGHT",
  "MODEL · REDUCE",
  "MODEL · TRIMMED",
  "MODEL · EXITED",
  "MODEL · REVIEW",
  "MODEL · ADD",
  "ACCUMULATE",
  "QUEUE",
  "ADD ON PULLBACK",
  "REDUCE / EXIT",
  "TRIM / REDUCE",
  "REVIEW PORTFOLIO",
]);

const _INVESTOR_PASSIVE_SET = new Set(INVESTOR_PASSIVE_ALERT_VERBS);
const _INVESTOR_ACTIONABLE_SET = new Set(INVESTOR_ACTIONABLE_ALERT_VERBS);

const TRADER_EXEC_FEED_TYPES = new Set([
  "TRADE_ENTRY", "TRADE_TRIM", "TRADE_EXIT",
  "ENTRY", "ENTER", "ADD", "ADD_ENTRY",
  "TRIM", "TP_HIT_TRIM", "EXIT", "TP_HIT_EXIT", "SL_HIT",
]);

const INVESTOR_EXEC_ALERT_TYPES = new Set([
  "position_open", "position_add", "position_trim", "position_close",
]);

/** Kanban stages that are trigger-ready or post-entry — not passive watch. */
export const ACTIONABLE_KANBAN_STAGES = Object.freeze([
  "in_review", "enter", "enter_now", "just_flipped", "just_entered",
  "hold", "active", "defend", "trim", "exiting", "exit",
]);

const _ACTIONABLE_KANBAN_SET = new Set(ACTIONABLE_KANBAN_STAGES);

/** Kanban stages where the user must act in sync with the model — RTH alerts only. */
export const RTH_KANBAN_NOTIFY_STAGES = Object.freeze([
  "exit", "trim", "defend", "enter", "enter_now", "in_review",
]);

/**
 * Gate kanban lane Discord / in-app alerts to NY regular hours for stages
 * that require the user to follow along (exit advisory, trim, defend, entry).
 * Hard protective closes use TRADE_EXIT and are unaffected.
 */
export function shouldNotifyKanbanStageTransition(stage, isMarketOpen = true) {
  const s = String(stage || "").toLowerCase();
  if (!RTH_KANBAN_NOTIFY_STAGES.includes(s)) return true;
  return isMarketOpen === true;
}

function normalizeInvestorVerb(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (v.startsWith("MODEL ·")) return v;
  const upper = v.toUpperCase();
  if (upper.startsWith("ACCUMULATE")) return "MODEL · QUEUE";
  if (upper.startsWith("QUEUE")) return "MODEL · QUEUE";
  if (upper.startsWith("BOUGHT")) return "MODEL · BOUGHT";
  if (upper.startsWith("REDUCE")) return "MODEL · REDUCE";
  if (upper.startsWith("ADD")) return "MODEL · ADD";
  if (upper.includes("TRIM")) return "MODEL · TRIMMED";
  if (upper.includes("EXIT")) return "MODEL · EXITED";
  if (upper.includes("REVIEW")) return "MODEL · REVIEW";
  return v;
}

function investorVerbFromNotification(n) {
  const title = String(n?.title || "");
  const m = title.match(/^(?:INVESTOR|MODEL)\s*·\s*([^:]+)/i);
  if (m) return normalizeInvestorVerb(`MODEL · ${m[1].trim()}`);
  return normalizeInvestorVerb(title);
}

function kanbanStageFromNotification(n) {
  const body = String(n?.body || "").toLowerCase();
  const m = body.match(/moved to ([a-z_]+)/i);
  if (m) return String(m[1]).toLowerCase();
  const title = String(n?.title || "").toLowerCase();
  if (title.includes("under review")) return "in_review";
  if (title.includes("position initiated")) return "just_entered";
  if (title.includes("holding")) return "hold";
  if (title.includes("defending")) return "defend";
  if (title.includes("exit signal")) return "exit";
  if (title.includes("setup")) return "setup";
  return "";
}

/** Map raw activity / alert event to unified classification. */
export function classifyActivityEvent(ev) {
  const invT = String(ev?.investor_alert_type || "").toLowerCase();
  if (invT === "position_open") {
    return { engine: "investor", mode: "doing", execState: "done", action: "open", evType: "ENTRY", label: "BOUGHT", cls: "ev-entry ev-doing", scope: "investor" };
  }
  if (invT === "position_add") {
    return { engine: "investor", mode: "doing", execState: "done", action: "add", evType: "ADD", label: "ADD", cls: "ev-entry ev-doing", scope: "investor" };
  }
  if (invT === "position_trim") {
    return { engine: "investor", mode: "doing", execState: "done", action: "trim", evType: "TRIM", label: "TRIM", cls: "ev-trim ev-doing", scope: "investor" };
  }
  if (invT === "position_close") {
    return { engine: "investor", mode: "doing", execState: "done", action: "exit", evType: "EXIT", label: "EXIT", cls: "ev-exit ev-doing", scope: "investor" };
  }
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
  let isDoing = doingTypes.has(t) || modeRaw === "doing" || modeRaw === "done";

  let action = "hold";
  let label = "UPDATE";
  let cls = "";
  if (t.includes("ENTRY") || t === "ENTER" || t === "ADD") { action = t.includes("ADD") ? "add" : "enter"; label = t.includes("ADD") ? "ADD" : "ENTER"; cls = "ev-entry"; }
  else if (t.includes("TRIM") || t === "TP_HIT_TRIM") { action = "trim"; label = "TRIM"; cls = "ev-trim"; }
  else if (t.includes("EXIT") || t === "SL_HIT") { action = "exit"; label = "EXIT"; cls = "ev-exit"; }

  let invExecDone = false;
  if (t === "INVESTOR_SIGNAL") {
    const invT = String(ev?.investor_alert_type || "").toLowerCase();
    if (invT === "position_open") {
      action = "open"; label = "BOUGHT"; cls = "ev-entry ev-doing"; invExecDone = true;
    } else if (invT === "position_add") {
      action = "add"; label = "ADD"; cls = "ev-entry ev-doing"; invExecDone = true;
    } else if (invT === "position_trim") {
      action = "trim"; label = "TRIM"; cls = "ev-trim ev-doing"; invExecDone = true;
    } else if (invT === "position_close") {
      action = "exit"; label = "EXIT"; cls = "ev-exit ev-doing"; invExecDone = true;
    } else {
      const verb = normalizeInvestorVerb(ev?.action);
      if (verb === "MODEL · QUEUE" || verb === "MODEL · ACCUMULATE") {
        action = "queue"; label = "QUEUE"; cls = "ev-recommended ev-doing";
        isDoing = true;
      } else if (verb === "MODEL · REDUCE") {
        action = "reduce"; label = "REDUCE"; cls = "ev-trim ev-recommended ev-doing";
        isDoing = true;
      } else if (verb === "MODEL · REVIEW") {
        action = "review"; label = "REVIEW"; cls = "ev-recommended ev-doing";
        isDoing = true;
      } else {
        action = "accumulate"; label = "WATCH"; cls = "ev-watching";
      }
    }
  }

  const mode = invExecDone || isDoing ? "doing" : "watching";
  let execStateOut = invExecDone || isDoing ? "done" : "watching";
  if (t === "INVESTOR_SIGNAL" && (label === "QUEUE" || label === "ACCUM" || label === "REDUCE" || label === "REVIEW")) {
    execStateOut = "recommended";
  }
  return {
    engine,
    mode,
    execState: execStateOut,
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

/**
 * Activity strip / merged feed — exclude passive watch; include done,
 * trigger-ready (TRADE_EXIT_SIGNAL), and queued investor accumulate.
 */
export function isActionableFeedEvent(ev, meta) {
  if (!ev) return false;
  const sym = String(ev.ticker || ev.symbol || "").toUpperCase();
  if (!sym || sym === "UNDEFINED" || sym === "NULL") return false;

  const t = String(ev.type || ev.event || "").toUpperCase();
  if (t === "SIGNAL_GRADED") return false;
  if (t === "TRADE_EXIT_SIGNAL") return true;
  if (TRADER_EXEC_FEED_TYPES.has(t)) return true;

  const invType = String(ev.investor_alert_type || "").toLowerCase();
  if (INVESTOR_EXEC_ALERT_TYPES.has(invType)) return true;

  if (t === "INVESTOR_SIGNAL") {
    const verb = normalizeInvestorVerb(ev.action);
    if (_INVESTOR_PASSIVE_SET.has(verb)) return false;
    if (_INVESTOR_ACTIONABLE_SET.has(verb)) return true;
    if (invType === "thesis_invalidation") return true;
    if (meta) {
      if (meta.execState === "recommended") return true;
      if (meta.mode === "doing" && meta.execState === "done") return true;
      if (meta.label === "WATCH" || meta.label === "UPDATE") return false;
    }
    return false;
  }

  return false;
}

/** Notification bell — same policy as activity strip for trade/investor/kanban. */
export function isActionableNotification(n) {
  if (!n) return false;
  const t = String(n.type || "").toLowerCase();
  if (t === "trade_entry" || t === "trade_exit" || t === "trade_trim") return true;

  if (t === "investor_signal") {
    const verb = investorVerbFromNotification(n);
    if (_INVESTOR_PASSIVE_SET.has(verb)) return false;
    if (_INVESTOR_ACTIONABLE_SET.has(verb)) return true;
    const exec = String(n.exec_state || "").toLowerCase();
    const cls = String(n.alert_class || n.mode || "").toLowerCase();
    if (exec === "recommended" || exec === "done" || cls === "doing") return true;
    return false;
  }

  if (t === "kanban") {
    const stage = kanbanStageFromNotification(n);
    if (stage && !_ACTIONABLE_KANBAN_SET.has(stage)) return false;
    const title = String(n.title || "").toUpperCase();
    if (title.startsWith("SETUP:")) return false;
    return true;
  }

  return false;
}
