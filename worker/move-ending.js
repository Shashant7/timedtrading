// worker/move-ending.js
// ─────────────────────────────────────────────────────────────────────────────
//  B4 (2026-06-11) — Exit excellence: spot the move ENDING early.
//
//  "Spot moves early" applies to exits as much as entries. Most exit logic
//  is reactive (stops, doctrine thresholds, cloud breaks AFTER the damage).
//  The crown-jewel exits prove the forward-looking pattern works:
//  PHASE_LEAVE 100% WR (+$33K), SOFT_FUSE_RSI 94.3% WR (+$29K) — this
//  module systematizes that into one composite, ADVISORY-FIRST signal.
//
//  computeMoveEndingSignal(tickerData, openTrade)
//    → { score 0-100, level NONE|WATCH|TRIM|EXIT, evidence[] }
//    Composes existing payload intelligence (no new I/O):
//      completion band, Markov forecast deterioration, dwell exhaustion,
//      TD exhaustion, RSI extremes against the position, phase extremes,
//      SuperTrend slope loss, volume fade.
//
//  computeTrimLadder(tickerData, openTrade)
//    → explicit ladder against the ATR-fib targets (tp_trim/tp_exit/
//      tp_runner) with per-level status — the visible PLAN for the move.
//
//  buildPositionGuidance(...)
//    → deterministic plain-language guidance (where we are, the plan, what
//      changes the engine's mind, tomorrow's levels). No LLM, no "you/your"
//      (compliance), consumed by the nightly guidance lane + ticker rail.
//
//  Doctrine: ADVISORY FIRST. The signal is attached + ledger-graded (was
//  the engine right that the move was ending?) BEFORE any wiring into
//  kanban/exit enforcement. Enforcement comes only after the ledger shows
//  the signal earns it — same shadow-first contract as portfolio breakers.
//  Pure module — pinned by worker/move-ending.test.js.
// ─────────────────────────────────────────────────────────────────────────────

export const MOVE_ENDING_LEVELS = ["NONE", "WATCH", "TRIM", "EXIT"];

function dirSign(direction) {
  return String(direction || "LONG").toUpperCase() === "SHORT" ? -1 : 1;
}

/**
 * Composite move-ending score for an open position (or a hypothetical one
 * via `direction` in opts). 0-100 with evidence strings.
 */
export function computeMoveEndingSignal(tickerData, openTrade, opts = {}) {
  const t = tickerData || {};
  const direction = String(openTrade?.direction || opts.direction || "LONG").toUpperCase();
  const sgn = dirSign(direction);
  let score = 0;
  const evidence = [];
  const add = (pts, why) => { score += pts; evidence.push(`${why} (+${pts})`); };

  // 1. Completion band — late moves end.
  const comp = Number(t.completion);
  if (Number.isFinite(comp)) {
    if (comp >= 0.85) add(30, `move ${Math.round(comp * 100)}% complete (late band)`);
    else if (comp >= 0.7) add(20, `move ${Math.round(comp * 100)}% complete`);
    else if (comp >= 0.55) add(8, `move past midpoint (${Math.round(comp * 100)}%)`);
  }

  // 2. Markov forecast deterioration — the per-ticker transition matrix
  //    says the aligned state is unlikely to persist.
  const fc = t.regime_forecast;
  const state = String(t.state || "");
  const aligned = state === "HTF_BULL_LTF_BULL" || state === "HTF_BEAR_LTF_BEAR";
  if (fc && aligned) {
    const p5 = fc.p_5_bar && typeof fc.p_5_bar === "object" ? Number(fc.p_5_bar[state]) : NaN;
    if (Number.isFinite(p5) && p5 < 0.35) add(15, `Markov: ${Math.round(p5 * 100)}% odds the aligned state persists 25min`);
    else if (Number.isFinite(p5) && p5 < 0.5) add(8, `Markov: aligned-state persistence weakening (${Math.round(p5 * 100)}%)`);
  }

  // 3. Dwell exhaustion — run length > 2σ above mean for this state.
  if (t.regime_exhausted && Number(t.regime_exhausted.sigma_above_mean) >= 2) {
    add(15, `state dwell ${Number(t.regime_exhausted.sigma_above_mean).toFixed(1)}σ past typical`);
  }

  // 4. TD Sequential exhaustion against the position (D).
  const tdD = t.td_sequential?.per_tf?.D || t.td_sequential?.per_tf?.["1D"];
  if (tdD) {
    const against = direction === "LONG" ? Number(tdD.bearish_prep_count) : Number(tdD.bullish_prep_count);
    if (Number.isFinite(against) && against >= 9) add(12, `TD ${against}-count exhaustion against the position (D)`);
    else if (Number.isFinite(against) && against >= 7) add(6, `TD ${against}-count building against the position (D)`);
  }

  // 5. RSI extreme against the position (1H / D).
  const rsi1H = Number(t.entry_quality?.details?.rsi1H ?? t.tf_tech?.["60"]?.rsi);
  if (Number.isFinite(rsi1H)) {
    if ((direction === "LONG" && rsi1H >= 75) || (direction === "SHORT" && rsi1H <= 25)) {
      add(10, `1H RSI ${Math.round(rsi1H)} — stretched against continuation`);
    }
  }
  const rsiD = Number(t.tf_tech?.D?.rsi);
  if (Number.isFinite(rsiD)) {
    if ((direction === "LONG" && rsiD >= 75) || (direction === "SHORT" && rsiD <= 25)) {
      add(8, `daily RSI ${Math.round(rsiD)} — stretched`);
    }
  }

  // 6. Phase extreme (Saty phase oscillator zone).
  const phase = Number(t.phase_pct);
  if (Number.isFinite(phase) && Math.abs(phase) >= 90 && Math.sign(phase) === sgn) {
    add(10, `phase oscillator pinned at ${Math.round(phase)}%`);
  }

  // 7. SuperTrend slope loss on the management TFs (30m/60m).
  for (const tf of ["30", "60"]) {
    const st = t.tf_tech?.[tf];
    const stDir = Number(st?.stDir);
    const stSlope = Number(st?.stSlope);
    if (Number.isFinite(stDir) && stDir !== 0 && Math.sign(stDir) === sgn
        && Number.isFinite(stSlope) && Math.sign(stSlope) === -sgn) {
      add(5, `${tf}m SuperTrend slope rolling against the move`);
    }
  }

  // 8. Volume fade — participation leaving while the move matures.
  const volRatio = Number(t.tf_tech?.D?.volRatio ?? t.tf_tech?.D?.vol_ratio);
  if (Number.isFinite(volRatio) && volRatio > 0 && volRatio < 0.7 && Number.isFinite(comp) && comp >= 0.5) {
    add(5, `volume fading (${volRatio.toFixed(2)}x avg) past midpoint`);
  }

  score = Math.min(100, Math.round(score));
  const level = score >= 60 ? "EXIT" : score >= 40 ? "TRIM" : score >= 25 ? "WATCH" : "NONE";
  return { score, level, direction, evidence: evidence.slice(0, 8) };
}

/**
 * Explicit trim ladder for an open position against the ATR-fib targets.
 * Returns { levels: [{ name, price, trim_pct, status }], next, sl } —
 * the visible PLAN, consumed by guidance + the ticker rail.
 */
export function computeTrimLadder(tickerData, openTrade) {
  const t = tickerData || {};
  const direction = String(openTrade?.direction || "LONG").toUpperCase();
  const sgn = dirSign(direction);
  const px = Number(t.price) || Number(t.close) || 0;
  const entry = Number(openTrade?.entryPrice ?? openTrade?.entry_price) || 0;
  const trimmedPct = Math.max(0, Math.min(1, Number(openTrade?.trimmedPct ?? openTrade?.trimmed_pct) || 0));

  const defs = [
    { name: "TRIM_1", price: Number(t.tp_trim), trim_pct: 33, basis: "0.618x weekly ATR" },
    { name: "TRIM_2", price: Number(t.tp_exit), trim_pct: 33, basis: "1.0x weekly ATR" },
    { name: "RUNNER", price: Number(t.tp_runner), trim_pct: 34, basis: "1.618x weekly ATR (trail from here)" },
  ].filter((l) => Number.isFinite(l.price) && l.price > 0);
  if (defs.length === 0) return null;

  let next = null;
  const levels = defs.map((l) => {
    const hit = px > 0 && (sgn > 0 ? px >= l.price : px <= l.price);
    const status = hit ? "reached" : "ahead";
    if (!hit && !next) next = { name: l.name, price: l.price, distance_pct: px > 0 ? Math.round(((l.price - px) / px) * sgn * 1000) / 10 : null };
    return { ...l, status };
  });

  return {
    direction,
    entry: entry || null,
    price: px || null,
    trimmed_pct: Math.round(trimmedPct * 100),
    levels,
    next,
    sl: Number(t.sl) || Number(openTrade?.sl) || null,
  };
}

/**
 * Deterministic plain-language guidance for one position. Compliance: no
 * "you/your" — speak as "the engine / this position / the plan".
 */
export function buildPositionGuidance(tickerData, openTrade, opts = {}) {
  const t = tickerData || {};
  const sym = String(t.ticker || openTrade?.ticker || "").toUpperCase();
  const direction = String(openTrade?.direction || "LONG").toUpperCase();
  const moveEnding = opts.moveEnding || computeMoveEndingSignal(t, openTrade);
  const ladder = opts.ladder || computeTrimLadder(t, openTrade);
  const comp = Number(t.completion);
  const stage = String(t.kanban_stage || "hold");

  const whereParts = [];
  whereParts.push(`${direction} position in stage "${stage}"`);
  if (Number.isFinite(comp)) whereParts.push(`move ~${Math.round(comp * 100)}% complete`);
  if (moveEnding.level !== "NONE") whereParts.push(`move-ending signal: ${moveEnding.level} (${moveEnding.score}/100)`);

  const planParts = [];
  if (ladder?.next) {
    planParts.push(`next level: ${ladder.next.name} at $${ladder.next.price}${ladder.next.distance_pct != null ? ` (${ladder.next.distance_pct > 0 ? "+" : ""}${ladder.next.distance_pct}% away)` : ""}`);
  }
  if (ladder && ladder.trimmed_pct > 0) planParts.push(`${ladder.trimmed_pct}% already trimmed`);
  if (ladder?.sl) planParts.push(`invalidation stop at $${ladder.sl}`);

  const mindChangers = [];
  if (ladder?.sl) mindChangers.push(`a close through $${ladder.sl} invalidates the setup`);
  for (const ev of moveEnding.evidence.slice(0, 3)) mindChangers.push(ev.replace(/ \(\+\d+\)$/, ""));

  return {
    ticker: sym,
    direction,
    generated_at: Number(opts.nowMs) || Date.now(),
    where: whereParts.join(" · "),
    plan: planParts.join(" · ") || "hold per current doctrine",
    what_changes_the_call: mindChangers.slice(0, 4),
    move_ending: { score: moveEnding.score, level: moveEnding.level },
    ladder,
  };
}
