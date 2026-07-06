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

/** Strict: null/undefined/"" → null (num() coerces null→0, which we don't want for levels). */
function numN(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(v) {
  const n = num(v);
  return n === null ? null : Math.round(n * 100) / 100;
}

/**
 * Plain-English read of the HTF×LTF state code. HTF sets the STRUCTURAL
 * direction (the trade plan / levels follow it); LTF is the short-term
 * momentum overlay that gates timing. This is why a bull-trend name can
 * carry a "Leaning bearish" short-term posture AND a LONG structural plan.
 */
const STATE_READS = {
  HTF_BULL_LTF_BULL: { htf: "up", ltf: "up", structuralDir: "LONG", label: "trend aligned up", ltfPhrase: "short-term momentum is also up" },
  HTF_BULL_LTF_PULLBACK: { htf: "up", ltf: "pulling back", structuralDir: "LONG", label: "bullish pullback", ltfPhrase: "short-term is pulling back into the trend" },
  HTF_BULL_LTF_BEAR: { htf: "up", ltf: "bearish", structuralDir: "LONG", label: "bull trend, bearish momentum", ltfPhrase: "short-term momentum has turned down" },
  HTF_BEAR_LTF_BEAR: { htf: "down", ltf: "down", structuralDir: "SHORT", label: "trend aligned down", ltfPhrase: "short-term momentum is also down" },
  HTF_BEAR_LTF_PULLBACK: { htf: "down", ltf: "bouncing", structuralDir: "SHORT", label: "bearish bounce", ltfPhrase: "short-term is bouncing against the trend" },
  HTF_BEAR_LTF_BULL: { htf: "down", ltf: "bullish", structuralDir: "SHORT", label: "bear trend, bullish momentum", ltfPhrase: "short-term momentum has turned up" },
};

export function readState(state) {
  const key = String(state || "").toUpperCase();
  if (STATE_READS[key]) return { ...STATE_READS[key], state: key };
  const htfBull = key.startsWith("HTF_BULL");
  const htfBear = key.startsWith("HTF_BEAR");
  if (!htfBull && !htfBear) return null;
  return {
    htf: htfBull ? "up" : "down",
    ltf: key.includes("LTF_BEAR") ? "bearish" : key.includes("LTF_BULL") ? "bullish" : "mixed",
    structuralDir: htfBull ? "LONG" : "SHORT",
    label: htfBull ? "higher-timeframe up" : "higher-timeframe down",
    ltfPhrase: key.includes("LTF_BEAR") ? "short-term momentum has turned down" : key.includes("LTF_BULL") ? "short-term momentum has turned up" : "short-term is mixed",
    state: key,
  };
}

function fmtUsd(n) {
  const x = num(n);
  if (x === null) return null;
  return "$" + (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2));
}

/** Trader-lane verdict from a scored payload (+ open trade if any). Pure. */
export function buildTraderVerdict(payload, openTrade = null, nowMs = Date.now()) {
  if (!payload || typeof payload !== "object") return null;
  const stage = String(payload.kanban_stage || "").toLowerCase();
  const state = String(payload.state || "");
  const journey = payload._journey?.features || null;
  // STRUCTURAL direction follows the higher timeframe (HTF), NOT a raw
  // "contains BEAR" test — HTF_BULL_LTF_BEAR is a bull-trend name with a
  // bearish short-term wobble and must resolve LONG so the plan + levels
  // agree with the trade plan the rail renders.
  const sread = readState(state);
  const direction = sread ? sread.structuralDir : (state.includes("BEAR") ? "SHORT" : "LONG");
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
    score,
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
 * Cross-lane narrative for the right-rail guide. GROUNDED in the actual
 * readings (state HTF×LTF, score, rank, plan levels, timing overlay,
 * journey) rather than boilerplate. Reconciles the short-term trader
 * posture with the structural plan and the investor lane so a name like
 * BE (bull structural LONG plan + bearish short-term momentum + investor
 * accumulate) reads as ONE coherent story instead of three contradictory
 * chips.
 */
export function buildVerdictGuide(trader, investor, payload = null) {
  if (!trader && !investor) return null;
  const tv = String(trader?.verdict || "WAIT").toUpperCase();
  const iv = investor ? String(investor.verdict || "WAIT").toUpperCase() : "WAIT";
  const p = payload || {};
  const sread = readState(p.state);
  const score = num(p.score);
  const rank = num(p.rank);
  const structuralDir = sread?.structuralDir || String(trader?.direction || "").toUpperCase();
  const stop = numN(trader?.stop) ?? numN(p.sl);
  const target = numN(trader?.target) ?? numN(p.tp_trim) ?? numN(p.tp_exit);
  const entryTrigger = numN(trader?.entry_price);
  const invScore = numN(investor?.score) ?? numN(p.investor_score);
  const journey = p._journey?.features;
  const timing = p.timing_overlay;
  const extension = num(timing?.extension_score);
  const macroRiskOff = timing?.posture === "RISK_OFF"
    || (Array.isArray(timing?.warnings) && timing.warnings.some((w) => String(w).includes("macro_risk_off")));

  // Reusable grounded fragments.
  const scoreFrag = score !== null ? `score ${score}${rank !== null ? `, rank ${rank}` : ""}` : (rank !== null ? `rank ${rank}` : "");
  const trendFrag = sread
    ? `Higher-timeframe trend is ${sread.htf} and ${sread.ltfPhrase}${scoreFrag ? ` (${scoreFrag})` : ""}.`
    : (scoreFrag ? `Model ${scoreFrag}.` : "");
  const structuralFrag = (() => {
    if (!structuralDir) return "";
    const bits = [];
    if (entryTrigger !== null) bits.push(`triggers near ${fmtUsd(entryTrigger)}`);
    if (target !== null) bits.push(`first target ${fmtUsd(target)}`);
    if (stop !== null) bits.push(`invalidates ${structuralDir === "SHORT" ? "above" : "below"} ${fmtUsd(stop)}`);
    return `The structural setup is a ${structuralDir} plan${bits.length ? ` — ${bits.join(", ")}` : ""}.`;
  })();
  const macroFrag = macroRiskOff
    ? "The broader market is risk-off right now, which is weighing on the short-term read."
    : (extension !== null && extension >= 60 ? "Price is extended near-term, so timing favors patience over chasing." : "");

  const parts = [];
  let headline = "Lane guide";
  let modelNotEntered = null;
  let earlyEntry = null;

  const diverge = (iv === "BUY" && (tv === "WAIT" || tv === "SETUP_FORMING"))
    || (tv === "BUY" && iv === "WAIT")
    || (sread?.ltf === "bearish" && iv === "BUY" && tv !== "BUY");

  if (iv === "BUY" && (tv === "WAIT" || tv === "SETUP_FORMING")) {
    headline = sread?.htf === "up"
      ? "Long-term thesis intact — short-term still choppy"
      : "Investor accumulate open — trader entry not yet triggered";
    if (trendFrag) parts.push(trendFrag);
    if (structuralFrag) parts.push(structuralFrag);
    parts.push(`Investor lane reads accumulate${invScore !== null ? ` (score ${invScore})` : ""} — the longer thesis is still in play.`);
    if (macroFrag) parts.push(macroFrag);
    modelNotEntered = trader?.why
      ? capitalize(trader.why) + "."
      : (tv === "SETUP_FORMING" ? "The setup is forming but the entry trigger has not fired." : "No trader entry signal yet.");
    earlyEntry = `Accumulating ahead of the model is reasonable ONLY inside the buy zone and stop line shown in Key levels below, with capped size and a hard invalidation${stop !== null ? ` — treat a close ${structuralDir === "SHORT" ? "above" : "below"} ${fmtUsd(stop)} as the line where the thesis breaks` : ""}.`;
  } else if (tv === "BUY" && iv !== "BUY") {
    headline = "Trader entry active — investor lane not yet accumulate";
    if (trendFrag) parts.push(trendFrag);
    if (structuralFrag) parts.push(structuralFrag);
    parts.push("The tactical trade is live on its own clock; the investor build has not opened yet.");
    if (investor?.why) modelNotEntered = capitalize(investor.why) + ".";
  } else if (tv === "BUY" && iv === "BUY") {
    headline = "Both lanes align — trade and build agree";
    if (trendFrag) parts.push(trendFrag);
    if (structuralFrag) parts.push(structuralFrag);
    parts.push("Trader entry and investor accumulate agree; size each lane by its own horizon rules.");
  } else if (tv === "SETUP_FORMING") {
    headline = "Setup building — confirmation pending";
    if (trendFrag) parts.push(trendFrag);
    if (structuralFrag) parts.push(structuralFrag);
    if (macroFrag) parts.push(macroFrag);
    modelNotEntered = trader?.why ? capitalize(trader.why) + "." : "The entry trigger has not fired yet.";
  } else if (["HOLD", "TIGHTEN", "SELL"].includes(tv) || ["HOLD", "TIGHTEN", "SELL"].includes(iv)) {
    headline = `Managing — trader ${tv.toLowerCase()}${iv !== "WAIT" ? `, investor ${iv.toLowerCase()}` : ""}`;
    if (trader?.why) parts.push(capitalize(trader.why) + ".");
    if (investor?.why && investor.why !== trader?.why) parts.push(capitalize(investor.why) + ".");
    if (macroFrag) parts.push(macroFrag);
  } else {
    headline = sread ? `${cap(sread.label)} — no lane action yet` : "No lane action yet";
    if (trendFrag) parts.push(trendFrag);
    if (structuralFrag) parts.push(structuralFrag);
    parts.push("Neither lane is actionable right now — wait for the next scoring pass or use the technical screener.");
    modelNotEntered = trader?.why ? capitalize(trader.why) + "." : (investor?.why ? capitalize(investor.why) + "." : null);
  }

  if (journey?.direction === "deteriorating" && (tv === "WAIT" || tv === "SETUP_FORMING")) {
    parts.push("The momentum journey is still deteriorating — let it turn before forcing an entry.");
  } else if (journey?.direction === "improving" && (tv === "WAIT" || tv === "SETUP_FORMING")) {
    parts.push("The momentum journey is improving, so the setup is trending toward a trigger.");
  }

  return {
    headline,
    narrative: parts.filter(Boolean).join(" "),
    model_not_entered: modelNotEntered,
    early_entry: earlyEntry,
    diverge: !!diverge,
    structural_direction: structuralDir || null,
    state_label: sread?.label || null,
    trader_verdict: tv,
    investor_verdict: iv,
  };
}

function capitalize(s) {
  const str = String(s || "").trim();
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}
function cap(s) { return capitalize(s); }

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
