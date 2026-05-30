// worker/futures-pairs.js
//
// ─────────────────────────────────────────────────────────────────────────────
//  TT Index Quartet — Pairs + SMT (Smart Money Technique)
// ─────────────────────────────────────────────────────────────────────────────
//
//  Four US index futures form the institutional liquidity grid:
//    ES  — S&P 500   (SPY equivalent) — broad market
//    NQ  — Nasdaq    (QQQ equivalent) — tech/growth
//    YM  — Dow 30    (DIA equivalent) — large-cap value
//    RTY — Russell   (IWM equivalent) — small caps / breadth
//
//  We blend TWO frameworks on top of these four:
//
//  ── John Carter — pair direction + leadership + gap-and-go ─────────────
//    NQ vs ES leadership, gap holds, two-index gate for single-name entries,
//    VIX overlay. See pre-existing logic below.
//
//  ── Michael Huddleston (ICT) — SMT (Smart Money Technique) ──────────────
//    Institutions cannot synchronize a manipulative sweep across all four
//    correlated indices at the same time. When one sweeps a key level
//    (PDH, PDL, weekly H/L, overnight H/L) and the others refuse to
//    confirm, that divergence is the institutional fingerprint of a
//    reversal in progress.
//
//    Stage 1: HTF SMT — one index sweeps a marked HTF level, the others
//             refuse + displace away. 60-65% standalone win rate.
//    Stage 2: LTF confirmation in one of two forms:
//             Form A — Another SMT on a smaller level (session/15min/ON)
//             Form B — PSP (Precision Swing Point): one index closes a
//                      bar in the opposite direction of the other two
//                      on the same TF at the same time.
//             Combined Stage 1 + Stage 2 win rate: ~81%.
//
//  Output of this module feeds:
//    - Root-Strategy L5 (Carter) as a bonus confluence signal
//    - Right Rail "SMT Status" chip on index tickers
//    - Today page intraday alert when Stage 2 prints
//    - Moonshot ignition criterion (SMT-confirmed RIDE = strongest signal)
//
//  Authored 2026-05-30, expanded 2026-05-30 (afternoon).
//
//  1. **ES vs NQ relative strength**
//     - NQ leading ES = tech outperforming = look for breakouts in tech names
//     - ES leading NQ = defensive rotation = trim tech, rotate to value
//     - Both moving same direction in sync = clean trend day
//     - Divergence (one up, one down) = chop / risk-off in tech vs broad
//
//  2. **Premarket gap-and-go**
//     - ES gaps up >0.5% premarket AND holds the gap by 10am ET → LONG bias
//     - ES gaps down >0.5% AND holds → SHORT bias
//     - Gap-and-fail (price reverses through prior close in first hour) =
//       trap; bias inverts
//
//  3. **Carter's "two index rule"**
//     - Don't trade single names long when BOTH ES and NQ are bearish on
//       the day's open structure (5-min ORB).
//     - Don't trade single names short when BOTH are bullish.
//     - This is the macro filter that catches most chop days.
//
//  4. **VIX relationship**
//     - VIX up >5% intraday + ES down = real risk-off
//     - VIX down + ES flat = complacency, watch for catalyst
//
//  Output: a `futuresPairsState` object that callers can use to:
//    - Bias the Trader entry path (single-name LONGs gated by ES/NQ bullish)
//    - Bias the Daily Brief intraday pulse
//    - Inform the Root-Strategy L2 (Newton) layer
//    - Surface as a chip on the Today page
//
//  Authored 2026-05-30.

// Helper: normalize change-pct field across snapshot shapes.
function _pct(t) {
  if (!t) return 0;
  return Number(t.dayChangePct ?? t.day_change_pct ?? t.percent_change ?? t.dp ?? 0);
}

/**
 * Compute the full quartet state — pair direction, leadership, gap, VIX,
 * AND quartet-level SMT divergence check.
 *
 * @param {object} marketData - shape: { ES, NQ, YM, RTY, VIX, SPY, QQQ, DIA, IWM }
 *                              Futures preferred; ETF equivalents fallback.
 * @param {object} [opts]     - { levels: { ES: {pdh,pdl,wkh,wkl}, NQ:..., YM:..., RTY:... } }
 *                              For SMT key-level analysis (optional).
 * @returns {object}
 */
export function computeFuturesPairsState(marketData, opts = {}) {
  if (!marketData) return { ok: false, error: "no_market_data" };

  // Resolve quartet — prefer futures, fall back to ETF equivalents.
  const es  = marketData.ES  || marketData["ES1!"]  || marketData.SPY || null;
  const nq  = marketData.NQ  || marketData["NQ1!"]  || marketData.QQQ || null;
  const ym  = marketData.YM  || marketData["YM1!"]  || marketData.DIA || null;
  const rty = marketData.RTY || marketData["RTY1!"] || marketData.IWM || null;
  const vix = marketData.VIX || marketData["VX1!"]  || null;

  if (!es || !nq) return { ok: false, error: "missing_es_or_nq" };

  const esPct  = _pct(es);
  const nqPct  = _pct(nq);
  const ymPct  = _pct(ym);
  const rtyPct = _pct(rty);
  const vixPct = vix ? _pct(vix) : null;

  // Relative strength: NQ minus ES (in percentage points).
  const rs = nqPct - esPct;

  // ── 1. Pair direction ──────────────────────────────────────────────
  let pair_direction = "MIXED";
  if (esPct >= 0.2 && nqPct >= 0.2) pair_direction = "BOTH_BULL";
  else if (esPct <= -0.2 && nqPct <= -0.2) pair_direction = "BOTH_BEAR";
  else if (esPct >= 0.2 && nqPct <= -0.2) pair_direction = "DIVERGENT_ES_BULL";
  else if (esPct <= -0.2 && nqPct >= 0.2) pair_direction = "DIVERGENT_NQ_BULL";

  // ── 2. Leadership ──────────────────────────────────────────────────
  let leadership = "BALANCED";
  if (rs >= 0.4) leadership = "NQ_LEADING";       // Tech outperforming → growth bias
  else if (rs <= -0.4) leadership = "ES_LEADING"; // Broad outperforming → value bias

  // ── 3. Carter's "two index rule" — directional gate ────────────────
  let two_index_gate = "ALLOW_BOTH";
  if (pair_direction === "BOTH_BULL") two_index_gate = "LONGS_ONLY";
  else if (pair_direction === "BOTH_BEAR") two_index_gate = "SHORTS_ONLY";
  else if (pair_direction.startsWith("DIVERGENT")) two_index_gate = "PICK_YOUR_SPOT";

  // ── 4. VIX overlay ─────────────────────────────────────────────────
  let vix_state = "NEUTRAL";
  if (vixPct != null) {
    if (vixPct >= 5 && esPct <= -0.5) vix_state = "RISK_OFF_CONFIRMED";
    else if (vixPct <= -5 && esPct >= 0.5) vix_state = "RISK_ON_CONFIRMED";
    else if (vixPct >= 3) vix_state = "VOL_RISING";
    else if (vixPct <= -3) vix_state = "VOL_COMPRESSING";
  }

  // ── 5. Gap-and-go analysis ─────────────────────────────────────────
  // Did ES open with a meaningful gap? (Open vs prior close.)
  const esOpen = Number(es.open ?? es.dayOpen);
  const esPrev = Number(es.prev_close ?? es.previousClose ?? es.previous_close ?? es.pc);
  const esPrice = Number(es.price ?? es.close ?? es.last);
  let gap_state = "NO_GAP";
  let gap_pct = null;
  if (esOpen > 0 && esPrev > 0) {
    gap_pct = ((esOpen - esPrev) / esPrev) * 100;
    if (gap_pct >= 0.5 && esPrice >= esOpen * 0.998) gap_state = "GAP_UP_HOLDING";
    else if (gap_pct >= 0.5 && esPrice < esOpen * 0.998) gap_state = "GAP_UP_FILLING";
    else if (gap_pct <= -0.5 && esPrice <= esOpen * 1.002) gap_state = "GAP_DN_HOLDING";
    else if (gap_pct <= -0.5 && esPrice > esOpen * 1.002) gap_state = "GAP_DN_FILLING";
  }

  // ── 6. Recommended single-name bias ────────────────────────────────
  // Combines pair direction, leadership, and gap state into one signal
  // for single-name trade entry filtering.
  let recommended_bias = "NEUTRAL";
  const reasons = [];
  if (two_index_gate === "LONGS_ONLY" && gap_state.startsWith("GAP_UP")) {
    recommended_bias = "STRONG_LONG";
    reasons.push("ES+NQ both bull", "gap-up holding");
  } else if (two_index_gate === "LONGS_ONLY") {
    recommended_bias = "LONG";
    reasons.push("ES+NQ both bull");
  } else if (two_index_gate === "SHORTS_ONLY" && gap_state.startsWith("GAP_DN")) {
    recommended_bias = "STRONG_SHORT";
    reasons.push("ES+NQ both bear", "gap-down holding");
  } else if (two_index_gate === "SHORTS_ONLY") {
    recommended_bias = "SHORT";
    reasons.push("ES+NQ both bear");
  } else if (two_index_gate === "PICK_YOUR_SPOT") {
    reasons.push("divergence — bias by ticker beta");
  }
  if (vix_state === "RISK_OFF_CONFIRMED") {
    recommended_bias = recommended_bias === "STRONG_LONG" ? "NEUTRAL" : "SHORT";
    reasons.push("VIX risk-off");
  } else if (vix_state === "RISK_ON_CONFIRMED" && recommended_bias === "LONG") {
    recommended_bias = "STRONG_LONG";
    reasons.push("VIX risk-on");
  }

  // ── 7. Quartet alignment — full four-index check ───────────────────
  // When ALL four agree, signal is bulletproof. Disagreement at the
  // small-cap (RTY) end is a leadership tell (small caps lead risk-on,
  // lag risk-off).
  const pctList = [
    { name: "ES", pct: esPct }, { name: "NQ", pct: nqPct },
    { name: "YM", pct: ymPct }, { name: "RTY", pct: rtyPct },
  ].filter(x => Number.isFinite(x.pct));
  const bullCount = pctList.filter(x => x.pct >= 0.2).length;
  const bearCount = pctList.filter(x => x.pct <= -0.2).length;
  let quartet_alignment = "MIXED";
  if (bullCount === 4) quartet_alignment = "ALL_FOUR_BULL";
  else if (bearCount === 4) quartet_alignment = "ALL_FOUR_BEAR";
  else if (bullCount === 3) quartet_alignment = "THREE_BULL_ONE_DIVERGENT";
  else if (bearCount === 3) quartet_alignment = "THREE_BEAR_ONE_DIVERGENT";
  else if (bullCount === bearCount) quartet_alignment = "SPLIT";

  // Identify the divergent one (the refusing index — SMT fingerprint).
  let divergent_index = null;
  if (quartet_alignment === "THREE_BULL_ONE_DIVERGENT") {
    divergent_index = pctList.find(x => x.pct < 0.2)?.name || null;
  } else if (quartet_alignment === "THREE_BEAR_ONE_DIVERGENT") {
    divergent_index = pctList.find(x => x.pct > -0.2)?.name || null;
  }

  // ── 8. Quartet-level SMT key-level check (optional) ─────────────────
  // If the caller supplied { levels: { ES: {pdh,pdl,...}, ... } } we can
  // run the full sweep-refusal check. Otherwise skip.
  let smt = { stage1: null, stage2: null, status: "no_levels_supplied" };
  if (opts.levels && typeof opts.levels === "object") {
    smt = detectSMTAtLevels({
      ES: { price: esPrice, ...(opts.levels.ES || {}) },
      NQ: { price: Number(nq.price ?? nq.close), ...(opts.levels.NQ || {}) },
      YM: { price: Number(ym?.price ?? ym?.close), ...(opts.levels.YM || {}) },
      RTY:{ price: Number(rty?.price ?? rty?.close), ...(opts.levels.RTY || {}) },
    });
  }

  return {
    ok: true,
    generated_at: Date.now(),
    es:  { pct: esPct,  price: esPrice, open: esOpen, prev_close: esPrev },
    nq:  { pct: nqPct,  price: Number(nq.price ?? nq.close) || null },
    ym:  ym  ? { pct: ymPct,  price: Number(ym.price  ?? ym.close)  || null } : null,
    rty: rty ? { pct: rtyPct, price: Number(rty.price ?? rty.close) || null } : null,
    vix: vix ? { pct: vixPct, price: Number(vix.price ?? vix.close) || null } : null,
    relative_strength: Math.round(rs * 100) / 100, // NQ - ES (legacy)
    pair_direction,
    leadership,
    two_index_gate,
    vix_state,
    gap_pct: gap_pct != null ? Math.round(gap_pct * 100) / 100 : null,
    gap_state,
    recommended_bias,
    rationale: reasons.join(" · "),
    // Quartet additions:
    quartet_alignment,
    divergent_index,
    bull_count: bullCount,
    bear_count: bearCount,
    quartet_count: pctList.length,
    // SMT block:
    smt,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SMT (Smart Money Technique) — Cross-Asset Divergence Detection
// ═══════════════════════════════════════════════════════════════════════════
//
// Institutions cannot move 4 correlated indices in perfect lockstep when
// they're engineering a reversal. The asset that breaks the triad pattern
// at a marked level is leaking the truth: one sweeps, the others refuse,
// reversal is in progress.
//
// We detect TWO stages:
//
// Stage 1 (HTF SMT):
//   One index sweeps a marked HTF level (PDH/PDL/WKH/WKL/ATH).
//   The others test the same level but DO NOT sweep it.
//   Followed by displacement (price moves AWAY from the swept level).
//
// Stage 2 (LTF confirmation, EITHER form):
//   Form A — Another SMT on a smaller level (session/15min/ON H-L).
//   Form B — PSP (Precision Swing Point): one index closes a bar in the
//            opposite direction of the others on the SAME timeframe at
//            the same time. The odd-one-out is the lagger refusing to
//            confirm the move.

/**
 * Detect Stage 1 SMT at marked levels.
 *
 * @param {object} indices - { ES: {price, pdh, pdl, wkh, wkl}, NQ, YM, RTY }
 * @returns {object} { stage1, divergent_index, level_type, direction, status }
 */
export function detectSMTAtLevels(indices) {
  const names = ["ES", "NQ", "YM", "RTY"];
  const tolerance = 0.0005; // 0.05% of price = "near the level"

  // Check each level type for divergence.
  const levelTypes = [
    { key: "pdh", direction: "BEAR", side: "above" }, // sweep PDH = bull trap = bear reversal
    { key: "pdl", direction: "BULL", side: "below" },
    { key: "wkh", direction: "BEAR", side: "above" },
    { key: "wkl", direction: "BULL", side: "below" },
    { key: "ath", direction: "BEAR", side: "above" }, // all-time high sweep = exhaustion
    { key: "atl", direction: "BULL", side: "below" },
  ];

  for (const lt of levelTypes) {
    // For each level type, check if exactly ONE index swept it.
    const sweepers = [];
    const refusers = [];
    for (const name of names) {
      const idx = indices[name];
      if (!idx || !Number.isFinite(idx.price) || !Number.isFinite(idx[lt.key])) continue;
      const lvl = idx[lt.key];
      const px  = idx.price;
      const swept = lt.side === "above" ? px > lvl : px < lvl;
      const tested = Math.abs(px - lvl) / lvl <= 0.01; // within 1%
      if (swept) sweepers.push(name);
      else if (tested) refusers.push(name);
    }
    if (sweepers.length === 1 && refusers.length >= 2) {
      return {
        stage1: true,
        divergent_index: sweepers[0],
        level_type: lt.key.toUpperCase(),
        direction: lt.direction,
        sweepers,
        refusers,
        status: `SMT detected: ${sweepers[0]} swept ${lt.key.toUpperCase()} while ${refusers.join("+")} refused. Reversal bias: ${lt.direction}.`,
      };
    }
  }
  return { stage1: false, status: "no_smt_at_marked_levels" };
}

/**
 * Detect a PSP (Precision Swing Point) — divergent candle close.
 *
 * @param {object} closes - { ES: { close, prev_close }, NQ, YM, RTY }
 *                          Each leg must carry the candle's close + the
 *                          PRIOR bar's close so we can determine direction.
 * @returns {object} { psp, divergent_index, direction, status }
 */
export function detectPSP(closes) {
  const names = ["ES", "NQ", "YM", "RTY"];
  const bullCloses = [];
  const bearCloses = [];
  for (const name of names) {
    const c = closes[name];
    if (!c || !Number.isFinite(c.close) || !Number.isFinite(c.prev_close)) continue;
    if (c.close > c.prev_close) bullCloses.push(name);
    else if (c.close < c.prev_close) bearCloses.push(name);
  }
  const total = bullCloses.length + bearCloses.length;
  if (total < 3) return { psp: false, status: "insufficient_data" };

  // PSP: at least 3 indices close + exactly ONE in the minority.
  if (bullCloses.length >= 2 && bearCloses.length === 1) {
    return {
      psp: true,
      divergent_index: bearCloses[0],
      direction: "BULL", // the majority direction = trade direction
      majority: bullCloses,
      minority: bearCloses[0],
      status: `PSP: ${bearCloses[0]} closed bearish while ${bullCloses.join("+")} closed bullish. Bull confirmation; trade strongest bull index.`,
    };
  }
  if (bearCloses.length >= 2 && bullCloses.length === 1) {
    return {
      psp: true,
      divergent_index: bullCloses[0],
      direction: "BEAR",
      majority: bearCloses,
      minority: bullCloses[0],
      status: `PSP: ${bullCloses[0]} closed bullish while ${bearCloses.join("+")} closed bearish. Bear confirmation; trade strongest bear index.`,
    };
  }
  return { psp: false, status: "all_indices_agree" };
}

/**
 * Combine Stage 1 SMT + Stage 2 confirmation (LTF SMT OR PSP).
 * Returns a synthesized verdict for entry triggering.
 */
export function combineSMTStages(stage1, stage2Smt, stage2Psp) {
  if (!stage1?.stage1) return { confirmed: false, status: stage1?.status || "no_stage1" };
  const stage2 = stage2Smt?.stage1 || stage2Psp?.psp;
  if (!stage2) return {
    confirmed: false,
    stage1, stage2_smt: stage2Smt, stage2_psp: stage2Psp,
    status: `Stage 1 only: ${stage1.status}. Awaiting LTF SMT or PSP.`,
  };
  const directions = [stage1.direction];
  if (stage2Smt?.direction) directions.push(stage2Smt.direction);
  if (stage2Psp?.direction) directions.push(stage2Psp.direction);
  const aligned = directions.every(d => d === directions[0]);
  return {
    confirmed: aligned,
    direction: directions[0],
    stage1, stage2_smt: stage2Smt, stage2_psp: stage2Psp,
    status: aligned
      ? `🎯 SMT 2-stage CONFIRMED ${directions[0]}: HTF + LTF both flag the reversal. ~81% historical win rate.`
      : `Stage 2 fired but direction mismatch (${directions.join(" / ")}) — wait.`,
  };
}

/**
 * Filter a list of trader-signal tickers by the two-index gate.
 * Returns the subset whose direction matches the futures pair bias.
 *
 * @param {Array} tickers - array of { ticker, direction } objects
 * @param {object} pairState - output of computeFuturesPairsState
 * @returns {Array} filtered subset
 */
export function applyTwoIndexGate(tickers, pairState) {
  if (!pairState || !pairState.ok) return tickers;
  if (pairState.two_index_gate === "ALLOW_BOTH") return tickers;
  return tickers.filter((t) => {
    const dir = String(t.direction || "").toUpperCase();
    if (pairState.two_index_gate === "LONGS_ONLY") return dir === "LONG";
    if (pairState.two_index_gate === "SHORTS_ONLY") return dir === "SHORT";
    return true;
  });
}

/**
 * Returns a compact human-readable summary for embedding in the Daily Brief.
 * Shows quartet pct, leadership, SMT status if any, recommended bias.
 */
export function summarizeFuturesPairs(state) {
  if (!state || !state.ok) return "Index quartet data unavailable.";
  const parts = [
    `ES ${state.es.pct >= 0 ? "+" : ""}${state.es.pct.toFixed(2)}%`,
    `NQ ${state.nq.pct >= 0 ? "+" : ""}${state.nq.pct.toFixed(2)}%`,
    state.ym  && `YM ${state.ym.pct  >= 0 ? "+" : ""}${state.ym.pct.toFixed(2)}%`,
    state.rty && `RTY ${state.rty.pct >= 0 ? "+" : ""}${state.rty.pct.toFixed(2)}%`,
    state.vix && `VIX ${state.vix.pct >= 0 ? "+" : ""}${state.vix.pct.toFixed(2)}%`,
  ].filter(Boolean).join(" · ");
  const align = state.quartet_alignment === "ALL_FOUR_BULL" ? " ✅ all four bull"
              : state.quartet_alignment === "ALL_FOUR_BEAR" ? " ⚠ all four bear"
              : state.divergent_index ? ` ⚡ ${state.divergent_index} diverging`
              : "";
  const leadStr = state.leadership === "NQ_LEADING" ? " · Tech leading"
               : state.leadership === "ES_LEADING" ? " · Broad leading"
               : "";
  const smtStr = state.smt?.status && state.smt.stage1
    ? ` · SMT: ${state.smt.divergent_index} swept ${state.smt.level_type} → ${state.smt.direction}`
    : "";
  const biasStr = state.recommended_bias && state.recommended_bias !== "NEUTRAL"
    ? ` → ${state.recommended_bias}`
    : "";
  return `${parts}${align}${leadStr}${smtStr}${biasStr}`;
}
