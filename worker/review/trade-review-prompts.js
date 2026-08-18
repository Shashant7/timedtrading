// worker/review/trade-review-prompts.js
//
// The reviewer's brief. Deliberately adversarial toward the engine: its
// job is to be the independent body that says "this entry was a chase"
// when the engine's own record says "TT Support Bounce, grade A".

export const TRADE_REVIEW_PROMPT_VERSION = "tr-1";
export const TRADE_REVIEW_CLOSED_PROMPT_VERSION = "tr-2-closed";

export const TRADE_REVIEW_SYSTEM_PROMPT = `You are the Trade Review Agent for a systematic trading desk. You are an INDEPENDENT reviewer, not part of the execution engine.

Your job is to grade a single executed leg of a trade — an ENTRY, a TRIM, or an EXIT — and explain the price action around it.

Rules of engagement:
1. The block labelled "engine_claim" is the ASSERTION BEING GRADED. It is never evidence. If the engine called something a "Support Bounce" but the tape shows price breaking down through the level, say so plainly.
2. The block labelled "tape" contains facts computed from candles: excursions, capture ratios, the dominant move in the window, and entry geometry. Use these numbers. Never invent or restate a number that contradicts them.
3. Be specific and falsifiable. "Momentum was weak" is useless. "Entered 0.9 into the 15m bar range with 15m and 30m structure at -1 and the hourly EMA-233 overhead" is useful.
4. Distinguish EXECUTION quality from OUTCOME. A well-reasoned entry that lost is not an F. A lucky fill that won is not an A. Grade the decision given what was knowable at the time, then note the outcome separately.
5. If the data is too thin to judge (no candles, synthesized leg with no receipt, missing stop), say so and grade "NA" rather than guessing.

Two separate required fields, and they are easy to confuse — read this twice:
- "grade" is a LETTER GRADE and nothing else. Exactly one of: A+, A, B, C, D, F, NA. No plus/minus other than A+, no words, no prose, never null. Use NA only when the tape block is genuinely too thin to judge.
- "verdict" is a CATEGORY CODE from the allowed list for this leg kind (see below). Never a letter grade and never a sentence.
Putting a verdict code in "grade", or a sentence in "verdict", makes the whole review unusable.

For ENTRY legs, judge:
- Is the entry valid: location, structure, confirmation, and whether it was a chase.
- Is the STOP valid: does it sit under real structure, or is it an arbitrary distance that either gets nicked by noise or risks too much?
- Is the TARGET valid and is the resulting R:R honest?
- probability_of_success: your calibrated estimate (0-1) that this trade reaches its target before its stop, judged at entry time.
- failure_modes: the specific, concrete ways this trade fails.

For TRIM and EXIT legs, judge:
- Was this a good action, or should the position have been held?
- How did realized P&L compare to the maximum favorable and adverse excursion?
- Overlaid on the dominant move in the window (tape.capture.big_move), how much did the trade actually capture, and what was left behind after the exit?
- If the action was premature, name what should have kept the position alive (a level, a signal, a time-based rule).

Output STRICT JSON only, matching this shape:
{
  "grade": "A+|A|B|C|D|F|NA",
  "verdict": "<one of the allowed verdicts for this leg kind>",
  "headline": "<= 140 chars, the single most important sentence",
  "price_action": "<2-4 sentences describing what the tape actually did around this leg>",
  "assessment": "<2-5 sentences grading the decision>",
  "probability_of_success": <number 0-1 or null; ENTRY legs only>,
  "failure_modes": ["<specific way this fails>", "..."],
  "capture_commentary": "<TRIM/EXIT only: realized vs MFE/MAE and vs the big move; null for ENTRY>",
  "should_have_held": <true|false|null; TRIM/EXIT only>,
  "confidence": <number 0-1, your confidence in this review>,
  "engine_findings": [
    {
      "finding": "<pattern this leg is evidence of>",
      "scope": "one_off|recurring",
      "kind": "config|engine|none",
      "config_key": "<model_config key if kind=config, else null>",
      "proposed_value": "<value if kind=config, else null>",
      "rationale": "<why this change follows from this leg>"
    }
  ]
}

Allowed verdicts:
- ENTRY: VALID_SETUP, VALID_BUT_LATE, CHASE, LOCATION_WRONG, STOP_INVALID, TARGET_UNREALISTIC, NO_EDGE, INSUFFICIENT_DATA
- TRIM: GOOD_TRIM, PREMATURE_TRIM, TOO_SMALL, TOO_LATE, SHOULD_NOT_HAVE_TRIMMED, INSUFFICIENT_DATA
- EXIT: GOOD_EXIT, PREMATURE_EXIT, LATE_EXIT, STOPPED_BY_NOISE, CORRECT_STOP, SHOULD_HAVE_HELD, INSUFFICIENT_DATA

engine_findings must be [] unless this leg is genuine evidence for a change. Do not propose a config change you cannot tie to a number in the tape block. Prefer "recurring" only when the context shows the pattern repeating.`;

function fmt(v, digits = 2) {
  if (v == null || !Number.isFinite(Number(v))) return "n/a";
  return Number(v).toFixed(digits);
}

function isoOrNa(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "n/a";
  return new Date(n).toISOString().replace(".000Z", "Z");
}

/**
 * Render the leg context as a compact, human-readable brief. Plain text
 * beats raw JSON here: the model reads the tape facts far more reliably
 * when they are labelled prose, and it keeps the token cost predictable.
 */
export function buildTradeReviewUserPrompt(context) {
  const t = context?.trade || {};
  const claim = context?.engine_claim || {};
  const leg = context?.leg || {};
  const tape = context?.tape || {};
  const cap = tape.capture || {};
  const geo = tape.geometry || {};
  const big = cap.big_move || null;

  const lines = [];
  lines.push(`LEG UNDER REVIEW: ${leg.kind}${leg.seq ? ` #${leg.seq + 1}` : ""} on ${t.ticker} ${t.direction}`);
  lines.push(`Executed ${isoOrNa(leg.ts)} at ${fmt(leg.price, 4)}${leg.qty_pct != null ? ` for ${fmt(leg.qty_pct, 0)}% of the position` : ""}.`);
  if (leg.reason) lines.push(`Engine's stated reason for this leg: ${leg.reason}`);
  if (!leg.from_receipt) {
    lines.push(`NOTE: this leg was reconstructed from trade summary columns, not an execution receipt. Timestamps may be approximate.`);
  }
  lines.push("");

  lines.push("ENGINE CLAIM (the assertion you are grading — not evidence):");
  lines.push(`- Setup: ${claim.setup_name || "n/a"} (grade ${claim.setup_grade || "n/a"}, path ${claim.entry_path || "n/a"})`);
  lines.push(`- Engine rank ${claim.rank ?? "n/a"}, claimed R:R ${fmt(claim.rr)}, risk budget ${fmt(claim.risk_budget)}`);
  lines.push(`- Stop ${fmt(claim.stop_loss, 4)} / target ${fmt(claim.take_profit, 4)} (source: ${claim.levels_source || "unknown"})`);
  if (claim.market_state) lines.push(`- Market state at entry: ${claim.market_state}`);
  if (claim.exit_reason) lines.push(`- Exit reason recorded: ${claim.exit_reason}`);
  if (claim.cio_decision) {
    lines.push(`- Pre-trade AI CIO gate: ${claim.cio_decision.decision} (conf ${fmt(claim.cio_decision.confidence)}) — "${claim.cio_decision.reasoning}"`);
  }
  lines.push("");

  lines.push(`TAPE FACTS (computed from ${tape.bar_count || 0} ${tape.timeframe || "?"} candles — treat as ground truth):`);
  // Coverage first: a review built on two bars is not the same artefact as
  // one built on two hundred, and the model must be able to tell.
  const barsIn = Number(cap.bars_in_trade) || 0;
  lines.push(`- Candle coverage while the position was open: ${barsIn} bar${barsIn === 1 ? "" : "s"}${cap.exit ? `, plus ${Number(cap.bars_after_exit) || 0} after the exit` : ""}`);
  if (barsIn < 3) {
    lines.push(`- WARNING: the tape barely covers this trade. Excursion and capture numbers below are unreliable. Prefer grade "NA" with verdict INSUFFICIENT_DATA unless the leg is judgeable from the entry geometry and the multi-timeframe read alone.`);
  }
  lines.push(`- Entry ${fmt(cap.entry?.price, 4)} at ${isoOrNa(cap.entry?.ts)}`);
  if (cap.exit) lines.push(`- Exit ${fmt(cap.exit.price, 4)} at ${isoOrNa(cap.exit.ts)} (${cap.exit.reason || "no reason recorded"})`);
  else lines.push(`- Position still open`);
  lines.push(`- While open: MFE ${fmt(cap.mfe_pct)}% (at ${isoOrNa(cap.mfe_ts)}), MAE ${fmt(cap.mae_pct)}%`);
  lines.push(`- Heat taken before the payoff arrived: ${fmt(cap.heat_before_payoff_pct)}%`);
  lines.push(`- Realized: ${fmt(cap.realized_pct)}% (${fmt(cap.realized_usd)} USD)`);
  lines.push(`- Capture of the in-trade MFE: ${cap.capture_ratio == null ? "n/a" : `${fmt(cap.capture_ratio * 100, 0)}%`}`);
  if (big) {
    lines.push(`- DOMINANT MOVE in the window: ${fmt(big.pct)}% from ${fmt(big.from_price, 4)} (${isoOrNa(big.from_ts)}) to ${fmt(big.to_price, 4)} (${isoOrNa(big.to_ts)})`);
    lines.push(`- Share of that dominant move captured: ${cap.big_move_capture_ratio == null ? "n/a" : `${fmt(cap.big_move_capture_ratio * 100, 0)}%`}`);
    // Capturing half of a move that only began after the exit is a
    // different failure from being shaken out of a move already underway.
    const exitTs = Number(cap.exit?.ts);
    if (Number.isFinite(exitTs) && Number(big.from_ts) > exitTs) {
      lines.push(`- NOTE: that move BEGAN AFTER the exit — the position was flat for all of it. The question is whether the exit was wrong, or whether re-entry was the missed action.`);
    } else if (Number.isFinite(exitTs) && Number(big.to_ts) > exitTs) {
      lines.push(`- NOTE: that move was still running when the position was closed.`);
    }
  } else {
    // Say it plainly: absent is not the same as zero.
    lines.push(`- Dominant move in the window: NOT COMPUTABLE (insufficient candle coverage). Do not conclude there was no move.`);
  }
  if (cap.post_exit_pct != null) {
    lines.push(`- AFTER the exit, price still ran ${fmt(cap.post_exit_pct)}% in the trade's favour (peak ${isoOrNa(cap.post_exit_extreme_ts)}) over the next ${cap.lookahead_days} days`);
  }
  if (cap.stored_mfe_pct != null && cap.mfe_pct != null && Math.abs(cap.stored_mfe_pct - cap.mfe_pct) > 1) {
    lines.push(`- DISCREPANCY: engine recorded MFE ${fmt(cap.stored_mfe_pct)}% but the tape shows ${fmt(cap.mfe_pct)}%`);
  }
  lines.push("");

  lines.push("ENTRY GEOMETRY:");
  if (geo.stop_loss == null && geo.take_profit == null) {
    // Never print a fabricated stop. If we could not attribute this trade's
    // own levels, say so — the reviewer must not grade risk on a guess.
    lines.push(`- Stop and target: NOT RECOVERABLE for this trade. Do not grade the stop or the R:R; note the gap instead.`);
  } else {
    lines.push(`- Stop distance ${fmt(geo.sl_distance_pct)}% / target distance ${fmt(geo.tp_distance_pct)}% → R:R ${fmt(geo.rr)}`);
  }
  lines.push(`- Fill position within the entry bar: ${geo.entry_in_bar_range == null ? "n/a" : fmt(geo.entry_in_bar_range, 2)} (1.0 = filled at the worst end of the bar)`);
  lines.push("");

  if (Array.isArray(context.prior_legs) && context.prior_legs.length) {
    lines.push("LEGS ALREADY EXECUTED ON THIS TRADE:");
    for (const l of context.prior_legs) {
      lines.push(`- ${l.kind} at ${fmt(l.price, 4)} on ${isoOrNa(l.ts)}${l.qty_pct != null ? ` (${fmt(l.qty_pct, 0)}%)` : ""}${l.reason ? ` — ${l.reason}` : ""}`);
    }
    lines.push("");
  }

  const sigIn = context.signals_at_entry;
  if (sigIn) {
    lines.push("MULTI-TIMEFRAME READ AT ENTRY (supertrend: +1 bull / -1 bear; ema_structure -1..+1):");
    for (const [tf, v] of Object.entries(sigIn)) {
      lines.push(`- ${tf}: bias ${v.bias ?? "n/a"}, ST ${v.supertrend ?? "n/a"}, struct ${v.ema_structure ?? "n/a"}, RSI ${v.rsi ?? "n/a"}`);
    }
    lines.push("");
  }
  const sigOut = context.signals_at_exit;
  if (sigOut && leg.kind !== "ENTRY") {
    lines.push("MULTI-TIMEFRAME READ AT EXIT:");
    for (const [tf, v] of Object.entries(sigOut)) {
      lines.push(`- ${tf}: bias ${v.bias ?? "n/a"}, ST ${v.supertrend ?? "n/a"}, struct ${v.ema_structure ?? "n/a"}, RSI ${v.rsi ?? "n/a"}`);
    }
    lines.push("");
  }

  lines.push(`Grade this ${leg.kind} leg. Respond with JSON only.`);
  return lines.join("\n");
}

/**
 * One review for a closed trade: entry + trims + exit as a single story.
 * Same JSON contract as the per-leg reviewer so the admin page and
 * normalizer stay unchanged. Verdicts are the TRADE set.
 */
export const TRADE_REVIEW_TRADE_SYSTEM_PROMPT = `You are the Trade Review Agent for a systematic trading desk. You are an INDEPENDENT reviewer, not part of the execution engine.

Your job is to grade ONE CLOSED TRADE as a single story — the entry, any trims, and the exit — and explain the price action across the hold.

Rules of engagement:
1. The block labelled "engine_claim" is the ASSERTION BEING GRADED. It is never evidence.
2. The block labelled "tape" contains facts computed from candles. Use these numbers. Never invent a number that contradicts them.
3. Be specific and falsifiable. Grade the decision given what was knowable at the time, then note the outcome separately.
4. If the data is too thin to judge, say so and grade "NA" rather than guessing.
5. Do NOT treat a winner as a bad location. If the trade paid, location was good enough — any miss is management (LEFT_MONEY), not LOCATION_WRONG / BAD_ENTRY.
6. Do NOT treat a max-loss, hard stop, or cloud-pivot exit with no leftover runner as premature. Tiny post-exit noise (under ~1%) is not a leftover runner. LEFT_MONEY / PREMATURE requires a real continuation after a valid location (the USO class: trimmed and exited while the dominant move was still running).
7. Do not invent one-pagers. engine_findings must be [] unless this trade is genuine evidence for a change.

Two separate required fields:
- "grade" is a LETTER GRADE and nothing else. Exactly one of: A+, A, B, C, D, F, NA.
- "verdict" is a CATEGORY CODE from the TRADE list below. Never a letter grade and never a sentence.

TRADE verdicts:
- GOOD_TRADE: location valid, management reasonable; outcome is secondary
- BAD_ENTRY: location/setup was the miss (never ran, CHOP-spec, support-in-CHOP)
- LEFT_MONEY: location was valid; trim or exit cut a real leftover runner
- CORRECT_LOSS: bad outcome but the stop / max-loss / cloud-pivot was the right bookkeeping
- NO_EDGE: tape too thin or the setup never had an edge
- MIXED: location and management are both only partly right
- INSUFFICIENT_DATA: missing candles/config

Output STRICT JSON only, matching this shape:
{
  "grade": "A+|A|B|C|D|F|NA",
  "verdict": "GOOD_TRADE|BAD_ENTRY|LEFT_MONEY|CORRECT_LOSS|NO_EDGE|MIXED|INSUFFICIENT_DATA",
  "headline": "<= 140 chars, the single most important sentence about the whole trade",
  "price_action": "<2-4 sentences covering entry location, the hold, trims, and the exit>",
  "assessment": "<2-5 sentences grading the trade as one story>",
  "probability_of_success": <number 0-1 or null; judged at entry time>,
  "failure_modes": ["<specific way this trade fails>", "..."],
  "capture_commentary": "<realized vs MFE/MAE and vs the big move; what trims banked vs left>",
  "should_have_held": <true|false|null; true only when a real leftover runner existed>,
  "confidence": <number 0-1>,
  "engine_findings": []
}`;

export function buildClosedTradeUserPrompt(context) {
  const t = context?.trade || {};
  const claim = context?.engine_claim || {};
  const tape = context?.tape || {};
  const cap = tape.capture || {};
  const geo = tape.geometry || {};
  const big = cap.big_move || null;
  const allLegs = Array.isArray(context?.all_legs_full)
    ? context.all_legs_full
    : Array.isArray(context?.all_legs)
      ? context.all_legs
      : [];

  const lines = [];
  lines.push(`CLOSED TRADE UNDER REVIEW: ${t.ticker || "?"} ${t.direction || "?"}`);
  lines.push(`Entry ${isoOrNa(cap.entry?.ts || t.entry_ts)} at ${fmt(cap.entry?.price ?? t.entry_price, 4)} → exit ${isoOrNa(cap.exit?.ts)} at ${fmt(cap.exit?.price, 4)} (${cap.exit?.reason || claim.exit_reason || "no reason"}).`);
  lines.push(`Realized ${fmt(cap.realized_pct)}% (${fmt(cap.realized_usd)} USD). Status ${t.status || "?"}.`);
  lines.push("");

  lines.push("ENGINE CLAIM (the assertion you are grading — not evidence):");
  lines.push(`- Setup: ${claim.setup_name || "n/a"} (grade ${claim.setup_grade || "n/a"}, path ${claim.entry_path || "n/a"})`);
  lines.push(`- Engine rank ${claim.rank ?? "n/a"}, claimed R:R ${fmt(claim.rr)}, risk budget ${fmt(claim.risk_budget)}`);
  lines.push(`- Stop ${fmt(claim.stop_loss, 4)} / target ${fmt(claim.take_profit, 4)} (source: ${claim.levels_source || "unknown"})`);
  if (claim.market_state) lines.push(`- Market state at entry: ${claim.market_state}`);
  if (claim.cio_decision) {
    lines.push(`- Pre-trade AI CIO gate: ${claim.cio_decision.decision} (conf ${fmt(claim.cio_decision.confidence)}) — "${claim.cio_decision.reasoning}"`);
  }
  lines.push("");

  lines.push("LEGS (the whole story — grade the trade, not each line in isolation):");
  if (allLegs.length === 0) {
    lines.push("- No execution receipts; using the trade summary only.");
  } else {
    for (const l of allLegs) {
      const kind = l.kind || l.leg_kind;
      const extra = l.reason ? ` — ${l.reason}` : "";
      const qty = l.qty_pct != null ? ` (${fmt(l.qty_pct, 0)}%)` : "";
      lines.push(`- ${kind} at ${fmt(l.price, 4)} on ${isoOrNa(l.ts)}${qty}${extra}`);
    }
  }
  lines.push("");

  lines.push(`TAPE FACTS (computed from ${tape.bar_count || 0} ${tape.timeframe || "?"} candles — treat as ground truth):`);
  const barsIn = Number(cap.bars_in_trade) || 0;
  lines.push(`- Candle coverage while the position was open: ${barsIn} bar${barsIn === 1 ? "" : "s"}${cap.exit ? `, plus ${Number(cap.bars_after_exit) || 0} after the exit` : ""}`);
  if (barsIn < 3) {
    lines.push(`- WARNING: the tape barely covers this trade. Prefer grade "NA" with verdict INSUFFICIENT_DATA unless the geometry alone is judgeable.`);
  }
  lines.push(`- While open: MFE ${fmt(cap.mfe_pct)}% (at ${isoOrNa(cap.mfe_ts)}), MAE ${fmt(cap.mae_pct)}%`);
  lines.push(`- Heat taken before the payoff arrived: ${fmt(cap.heat_before_payoff_pct)}%`);
  lines.push(`- Capture of the in-trade MFE: ${cap.capture_ratio == null ? "n/a" : `${fmt(cap.capture_ratio * 100, 0)}%`}`);
  if (big) {
    lines.push(`- DOMINANT MOVE in the window: ${fmt(big.pct)}% from ${fmt(big.from_price, 4)} (${isoOrNa(big.from_ts)}) to ${fmt(big.to_price, 4)} (${isoOrNa(big.to_ts)})`);
    lines.push(`- Share of that dominant move captured: ${cap.big_move_capture_ratio == null ? "n/a" : `${fmt(cap.big_move_capture_ratio * 100, 0)}%`}`);
    const exitTs = Number(cap.exit?.ts);
    if (Number.isFinite(exitTs) && Number(big.from_ts) > exitTs) {
      lines.push(`- NOTE: that move BEGAN AFTER the exit — the position was flat for all of it.`);
    } else if (Number.isFinite(exitTs) && Number(big.to_ts) > exitTs) {
      lines.push(`- NOTE: that move was still running when the position was closed.`);
    }
  } else {
    lines.push(`- Dominant move in the window: NOT COMPUTABLE (insufficient candle coverage). Do not conclude there was no move.`);
  }
  if (cap.post_exit_pct != null) {
    lines.push(`- AFTER the exit, price still ran ${fmt(cap.post_exit_pct)}% in the trade's favour (peak ${isoOrNa(cap.post_exit_extreme_ts)}) over the next ${cap.lookahead_days} days`);
    if (Number(cap.post_exit_pct) < 1) {
      lines.push(`- NOTE: leftover under 1% is noise, not LEFT_MONEY.`);
    }
  }
  lines.push("");

  lines.push("ENTRY GEOMETRY:");
  if (geo.stop_loss == null && geo.take_profit == null) {
    lines.push(`- Stop and target: NOT RECOVERABLE for this trade. Do not grade the stop or the R:R; note the gap instead.`);
  } else {
    lines.push(`- Stop distance ${fmt(geo.sl_distance_pct)}% / target distance ${fmt(geo.tp_distance_pct)}% → R:R ${fmt(geo.rr)}`);
  }
  lines.push(`- Fill position within the entry bar: ${geo.entry_in_bar_range == null ? "n/a" : fmt(geo.entry_in_bar_range, 2)} (1.0 = filled at the worst end of the bar)`);
  lines.push("");

  const sigIn = context.signals_at_entry;
  if (sigIn) {
    lines.push("MULTI-TIMEFRAME READ AT ENTRY (supertrend: +1 bull / -1 bear; ema_structure -1..+1):");
    for (const [tf, v] of Object.entries(sigIn)) {
      lines.push(`- ${tf}: bias ${v.bias ?? "n/a"}, ST ${v.supertrend ?? "n/a"}, struct ${v.ema_structure ?? "n/a"}, RSI ${v.rsi ?? "n/a"}`);
    }
    lines.push("");
  }
  const sigOut = context.signals_at_exit;
  if (sigOut) {
    lines.push("MULTI-TIMEFRAME READ AT EXIT:");
    for (const [tf, v] of Object.entries(sigOut)) {
      lines.push(`- ${tf}: bias ${v.bias ?? "n/a"}, ST ${v.supertrend ?? "n/a"}, struct ${v.ema_structure ?? "n/a"}, RSI ${v.rsi ?? "n/a"}`);
    }
    lines.push("");
  }

  lines.push("Grade this closed trade as one story (entry, trims if any, exit). Respond with JSON only.");
  return lines.join("\n");
}
