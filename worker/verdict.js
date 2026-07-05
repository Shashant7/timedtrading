// ═══════════════════════════════════════════════════════════════════════════
// worker/verdict.js — Phase D2 of the stabilization plan (Objective 3).
//
// THE THREE QUESTIONS every user brings:
//   1. What should I buy right now to grow my account? Why?
//   2. Should I buy THIS ticker right now? When? At what price? Why?
//   3. Should I sell THIS ticker right now? When? At what price? Why?
//
// This module is the ANSWER CONTRACT: one deterministic object per ticker,
// assembled from data the system already computes — kanban stage, state,
// SL/TP plan, open position, journey features (C2), setup shadow posture —
// so every surface (right rail, cards, Today page, alerts) renders the SAME
// answer instead of each inventing its own. The lane tag (trader/investor)
// is first-class: signal confusion between the two lanes is the #1 reported
// source of user chaos.
//
// Verdicts (per lane):
//   BUY          — entry conditions met now (stage enter/enter_now)
//   SETUP_FORMING— watch/in_review + improving journey: the story is building
//   HOLD         — open position, plan intact
//   TIGHTEN      — open position + defend/trim lane or deteriorating journey
//   SELL         — open position in exit lane / stop-breach class
//   WAIT         — nothing actionable; say what would change it
//
// Pure module — callers pass the payload (+ optional investor row).
// ═══════════════════════════════════════════════════════════════════════════

const ENTER_STAGES = new Set(["enter", "enter_now"]);
const EXIT_STAGES = new Set(["exit", "exit_now"]);
const DEFEND_STAGES = new Set(["defend", "trim"]);
const FORMING_STAGES = new Set(["watch", "in_review", "neutral"]);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(v) {
  const n = num(v);
  return n === null ? null : Math.round(n * 100) / 100;
}

/** Trader-lane verdict from a scored payload (+ open trade if any). Pure. */
export function buildTraderVerdict(payload, openTrade = null, nowMs = Date.now()) {
  if (!payload || typeof payload !== "object") return null;
  const stage = String(payload.kanban_stage || "").toLowerCase();
  const state = String(payload.state || "");
  const journey = payload._journey?.features || null;
  const direction = state.includes("BEAR") ? "SHORT" : "LONG";
  const price = num(payload._live_price) ?? num(payload.price) ?? num(payload.close);
  const hasPosition = !!openTrade;
  const posDir = hasPosition ? String(openTrade.direction || "LONG").toUpperCase() : null;
  const entryPx = hasPosition ? num(openTrade.entryPrice) : null;
  const pnlPct = hasPosition && entryPx > 0 && price > 0
    ? round2(((price - entryPx) / entryPx) * 100 * (posDir === "SHORT" ? -1 : 1))
    : null;

  const why = [];
  let verdict, timing = null;

  if (hasPosition) {
    const journeyBad = journey?.direction === "deteriorating";
    if (EXIT_STAGES.has(stage)) {
      verdict = "SELL";
      timing = "now";
      why.push(`exit lane (${stage})`);
    } else if (DEFEND_STAGES.has(stage) || journeyBad) {
      verdict = "TIGHTEN";
      timing = "now";
      if (DEFEND_STAGES.has(stage)) why.push(`${stage} lane`);
      if (journeyBad) why.push(`journey deteriorating (${journey.score_slope_1h ?? "?"}/h)`);
    } else {
      verdict = "HOLD";
      why.push(`plan intact (${stage || "managed"})`);
      if (journey?.direction === "improving") why.push("journey improving");
    }
    return {
      lane: "trader",
      verdict,
      direction: posDir,
      timing,
      price: round2(price),
      entry_price: round2(entryPx),
      pnl_pct: pnlPct,
      stop: round2(openTrade.sl ?? payload.sl),
      target: round2(payload.tp_trim ?? payload.tp_exit),
      why: why.join("; "),
      journey: journey ? { direction: journey.direction, time_in_stage_min: journey.time_in_stage_min, cell: journey.cell } : null,
      as_of: nowMs,
    };
  }

  // No position — entry side.
  if (ENTER_STAGES.has(stage)) {
    verdict = "BUY";
    timing = "now";
    why.push(`entry lane (${stage}), state ${state}`);
    if (num(payload.rank) !== null) why.push(`rank ${payload.rank}`);
  } else if (FORMING_STAGES.has(stage) && journey?.direction === "improving") {
    verdict = "SETUP_FORMING";
    timing = "on confirmation";
    why.push(`journey improving (${journey.score_slope_1h ?? "?"}/h) in ${stage}`);
    if (journey.cell) why.push(`cell ${journey.cell}`);
  } else {
    verdict = "WAIT";
    const wouldChange = [];
    if (journey?.direction === "deteriorating") wouldChange.push("journey must turn");
    wouldChange.push("stage must reach enter");
    why.push(`no setup (${stage || "unranked"}); ${wouldChange.join(", ")}`);
  }

  return {
    lane: "trader",
    verdict,
    direction,
    timing,
    price: round2(price),
    entry_price: verdict === "BUY" ? round2(price) : null,
    stop: verdict === "BUY" ? round2(payload.sl) : null,
    target: verdict === "BUY" ? round2(payload.tp_trim ?? payload.tp_exit) : null,
    why: why.join("; "),
    journey: journey ? { direction: journey.direction, time_in_stage_min: journey.time_in_stage_min, cell: journey.cell } : null,
    as_of: nowMs,
  };
}

/** Investor-lane verdict from the investor score/stage row (+ position). Pure. */
export function buildInvestorVerdict(payload, investorRow = null, investorPosition = null, nowMs = Date.now()) {
  const payloadStage = payload?.investor_stage || payload?.investorStage;
  const effectiveRow = investorRow
    || (payloadStage ? { stage: payloadStage, score: payload?.investor_score } : null);
  if (!effectiveRow && !investorPosition) return null;
  const stage = String(effectiveRow?.stage || effectiveRow?.investor_stage || "").toLowerCase();
  const score = num(effectiveRow?.score ?? payload?.investor_score);
  const price = num(payload?._live_price) ?? num(payload?.price) ?? num(payload?.close);
  const owned = !!investorPosition;
  const avgEntry = owned ? num(investorPosition.avg_entry) : null;
  const pnlPct = owned && avgEntry > 0 && price > 0 ? round2(((price - avgEntry) / avgEntry) * 100) : null;
  const journey = payload?._journey?.features || null;

  let verdict, timing = null;
  const why = [];
  if (owned) {
    if (stage === "exit" || stage === "reduce") {
      verdict = "SELL";
      timing = "now";
      why.push(`investor stage ${stage}`);
    } else if (journey?.direction === "deteriorating") {
      verdict = "TIGHTEN";
      why.push("journey deteriorating — review stop/trim");
    } else {
      verdict = "HOLD";
      why.push(`stage ${stage || "hold"}${score !== null ? `, score ${score}` : ""}`);
    }
  } else if (stage === "accumulate") {
    verdict = "BUY";
    timing = "scale in";
    why.push(`accumulate zone${score !== null ? `, score ${score}` : ""}`);
  } else if (stage === "watch" && journey?.direction === "improving") {
    verdict = "SETUP_FORMING";
    timing = "on zone entry";
    why.push("watch zone with improving journey");
  } else {
    verdict = "WAIT";
    why.push(`zone ${stage || "none"} — wait for accumulate`);
  }

  return {
    lane: "investor",
    verdict,
    timing,
    price: round2(price),
    avg_entry: round2(avgEntry),
    pnl_pct: pnlPct,
    why: why.join("; "),
    as_of: nowMs,
  };
}

/**
 * Question 1: "what should I buy right now?" — rank BUY / SETUP_FORMING
 * verdicts across the universe. Pure; caller supplies the per-ticker
 * verdict list.
 */
/**
 * Cross-lane narrative for the right-rail guide — reconciles trader vs
 * investor when horizons diverge (e.g. trader WAIT + bearish posture while
 * investor accumulate stays valid).
 */
export function buildVerdictGuide(trader, investor, payload = null) {
  if (!trader && !investor) return null;
  const tv = String(trader?.verdict || "WAIT").toUpperCase();
  const iv = investor ? String(investor.verdict || "WAIT").toUpperCase() : "WAIT";
  const state = String(payload?.state || "");
  const bearish = state.includes("BEAR");
  const journey = payload?._journey?.features;
  const timing = payload?.timing_overlay;
  const macroRiskOff = timing?.posture === "RISK_OFF"
    || (Array.isArray(timing?.warnings) && timing.warnings.some((w) => String(w).includes("macro_risk_off")));

  const parts = [];
  let headline = "Lane guide";
  let modelNotEntered = null;
  let earlyEntry = null;

  const diverge = (iv === "BUY" && (tv === "WAIT" || tv === "SETUP_FORMING"))
    || (tv === "BUY" && iv === "WAIT")
    || (bearish && iv === "BUY" && tv !== "BUY");

  if (iv === "BUY" && tv === "WAIT") {
    headline = "Horizons diverge — accumulate vs no trader entry";
    parts.push(bearish
      ? "Short-term trader read is bearish or choppy; the tactical entry trigger has not fired."
      : "Trader lane has no entry signal yet — the stage must reach enter before the model opens a position.");
    parts.push("Investor lane flags an accumulate zone; the longer thesis may still be intact.");
    if (macroRiskOff) parts.push("Broader market drawdown / risk-off timing is weighing on the short-term read.");
    modelNotEntered = trader?.why || "The model has not opened a trader position.";
    earlyEntry = "Scaling in before the model's scale-in call is appropriate only inside the published buy zone, with capped size and a defined invalidation level.";
  } else if (tv === "BUY" && iv === "WAIT") {
    headline = "Trader entry active — investor lane not yet accumulate";
    parts.push("Tactical entry conditions are met on the trader lane.");
    parts.push("Investor lane is not in accumulate yet — shorter-term trade and longer-term build run on different clocks.");
    if (investor?.why) modelNotEntered = investor.why;
  } else if (tv === "BUY" && iv === "BUY") {
    headline = "Both lanes align";
    parts.push("Trader entry and investor accumulate agree. Size each lane by its horizon rules.");
  } else if (tv === "SETUP_FORMING") {
    headline = "Setup building — confirmation pending";
    parts.push("Trader setup is forming; the entry trigger has not fired yet.");
    if (iv === "BUY") {
      parts.push("Investor accumulate may still be valid on a separate, longer clock.");
      earlyEntry = "Do not confuse a forming trader setup with investor scale-in — each lane has its own invalidation.";
    }
    modelNotEntered = trader?.why;
  } else if (tv === "WAIT" && iv === "WAIT") {
    headline = "No lane action yet";
    parts.push("Neither lane is actionable right now. Watch the technical screener below or wait for the next scoring pass.");
    modelNotEntered = trader?.why || investor?.why;
  } else if (["HOLD", "TIGHTEN", "SELL"].includes(tv) || ["HOLD", "TIGHTEN", "SELL"].includes(iv)) {
    headline = `Managing — trader ${tv.toLowerCase()}, investor ${iv.toLowerCase()}`;
    if (trader?.why) parts.push(trader.why);
    if (investor?.why && investor.why !== trader?.why) parts.push(investor.why);
  } else {
    headline = `Trader ${tv} · Investor ${iv}`;
    if (trader?.why) parts.push(trader.why);
    if (investor?.why) parts.push(investor.why);
  }

  if (journey?.direction === "deteriorating" && tv === "WAIT") {
    parts.push("Journey is deteriorating on the trader lane — wait for improvement before forcing a tactical entry.");
  }

  return {
    headline,
    narrative: parts.filter(Boolean).join(" "),
    model_not_entered: modelNotEntered,
    early_entry: earlyEntry,
    diverge: !!diverge,
    trader_verdict: tv,
    investor_verdict: iv,
  };
}

export function rankBuyCandidates(verdictRows, limit = 5) {
  const score = (v) => {
    if (!v) return -1;
    let s = 0;
    if (v.verdict === "BUY") s += 100;
    else if (v.verdict === "SETUP_FORMING") s += 50;
    else return -1;
    if (v.journey?.direction === "improving") s += 20;
    if (Number.isFinite(v.rank)) s += Math.max(0, 100 - v.rank) / 10;
    return s;
  };
  return (verdictRows || [])
    .map((row) => ({ row, s: score(row?.trader) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.row);
}
