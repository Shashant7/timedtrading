// worker/trust-spine/entry-quality.js
// ─────────────────────────────────────────────────────────────────────────────
//  ENTRY QUALITY — grading a detector on the only thing it controls.
//
//  A paper/shadow detector claims ONE thing: "enter here, in this direction."
//  It does not choose the stop, the trim, the ratchet or the exit — those come
//  from the shared management layer every family runs through. So grading a
//  detector on realized P&L grades it on someone else's work, and the verdict
//  is wrong in the expensive direction: a detector that calls a real move and
//  hands it to a management layer that gives it all back looks identical to a
//  detector that called nothing.
//
//  That is not hypothetical. 60-day live book, book-wide baseline MFE:MAE 1.62
//  and 50% of entries reaching +2%:
//
//    setup                  MFE:MAE  hit+2%  realized  capture
//    TT Cloud Pivot SHORT      3.34     64%    +1.57%      29%
//    TT Support Bounce LONG    1.81     54%    +0.20%       5%   <-- see below
//    TT Cloud Pivot LONG       1.48     48%    -1.12%     -29%
//    TT ATH Breakout LONG      0.78     35%    -0.68%     -38%
//
//  Support Bounce reads as a bleeder on P&L (29% win rate, PF 0.84) and was
//  sitting on the demotion list. Its ENTRIES beat the book on both axes; it
//  converts 5% of what it is handed. Demoting it would have deleted the second
//  best entry signal in the book to fix a management bug. ATH Breakout, by
//  contrast, is genuinely blind — 0.78 MFE:MAE means it walks into more heat
//  than opportunity — and deserved the block it has.
//
//  WHAT THIS MEASURES
//  MFE and MAE are both fixed the instant the trade opens and the market
//  moves; no exit rule can change either. Their ratio asks "did this entry get
//  more opportunity than heat?" and the hit rates ask "how often did it reach
//  a tradeable move at all?" Both are graded RELATIVE to the same book over
//  the same window, so the verdict survives a quiet tape — in a flat month
//  every number drops and the comparison still holds.
//
//  WHAT THIS DOES NOT MEASURE
//  Whether the money was kept. That is management's grade (capture rate, in
//  family-attribution.js) and it is the reason `entry_edge: "confirmed"` alone
//  must never widen size — a good entry run through a leaky exit just loses
//  faster at 1x than at 0.1x. The two grades are meant to be read together:
//  they say WHICH layer to go fix.
// ─────────────────────────────────────────────────────────────────────────────

/** Below this many closed trades the sample decides nothing. */
export const ENTRY_GRADE_MIN_N = 8;

/** Favourable-excursion thresholds a "tradeable move" is measured against. */
export const ENTRY_HIT_THRESHOLDS_PCT = Object.freeze([2, 5]);

/**
 * How far below the book an entry has to sit on BOTH axes before we call the
 * edge absent. Either axis alone being soft is noise, not a verdict.
 */
export const ENTRY_EDGE_ABSENT_RATIO = 0.85;

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, places = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/**
 * Normalize one closed trade to the two excursions, both as positive percents.
 *
 * MAE is stored signed (adverse, so negative) on `trades` but has appeared
 * unsigned on replay/backtest rows. Take the magnitude either way — the
 * direction is already implied by which field it is.
 */
export function readExcursions(row) {
  const mfe = finiteOrNull(
    row?.mfe_pct ?? row?.max_favorable_excursion ?? row?.maxFavorableExcursion,
  );
  const maeRaw = finiteOrNull(
    row?.mae_pct ?? row?.max_adverse_excursion ?? row?.maxAdverseExcursion,
  );
  if (mfe == null || mfe < 0) return null;
  return { mfe, mae: maeRaw == null ? null : Math.abs(maeRaw) };
}

/**
 * Management-independent entry statistics for a set of closed trades.
 *
 * Returns null when nothing in the set carries usable excursions.
 */
export function summarizeEntryExcursions(closed) {
  let mfeSum = 0;
  let maeSum = 0;
  let maeN = 0;
  let n = 0;
  const hits = new Map(ENTRY_HIT_THRESHOLDS_PCT.map((t) => [t, 0]));
  for (const row of closed || []) {
    const ex = readExcursions(row);
    if (!ex) continue;
    n++;
    mfeSum += ex.mfe;
    if (ex.mae != null) { maeSum += ex.mae; maeN++; }
    for (const t of ENTRY_HIT_THRESHOLDS_PCT) {
      if (ex.mfe >= t) hits.set(t, hits.get(t) + 1);
    }
  }
  if (n === 0) return null;
  const avgMfe = mfeSum / n;
  const avgMae = maeN > 0 ? maeSum / maeN : null;
  const hitRates = {};
  for (const t of ENTRY_HIT_THRESHOLDS_PCT) {
    hitRates[`hit_rate_${t}pct`] = round((hits.get(t) / n) * 100, 1);
  }
  return {
    n,
    avg_mfe_pct: round(avgMfe),
    avg_mae_pct: round(avgMae),
    // >1 means the entry was handed more opportunity than heat.
    mfe_mae_ratio: avgMae != null && avgMae > 0 ? round(avgMfe / avgMae) : null,
    ...hitRates,
  };
}

/**
 * MANAGEMENT's grade: total percent kept over total percent offered.
 *
 * Lives here next to the entry grade because the pair is the point — one
 * number for the layer that picks the trade, one for the layer that runs it.
 * A per-trade mean of pnl/mfe is not usable for this: the denominator is how
 * far the trade ran, so a trade that never ran dominates the average (ULTA,
 * +0.104% peak into a -5.13% close, scored -49.21 on its own).
 */
export function aggregateMfeCapture(closed) {
  let pnlSum = 0;
  let mfeSum = 0;
  let n = 0;
  for (const c of closed || []) {
    const ex = readExcursions(c);
    const pnl = finiteOrNull(c?.pnl_pct);
    if (!ex || ex.mfe <= 0 || pnl == null) continue;
    pnlSum += pnl;
    mfeSum += ex.mfe;
    n++;
  }
  if (n === 0 || mfeSum <= 0) return null;
  return Math.round((pnlSum / mfeSum) * 1000) / 1000;
}

/**
 * Grade a detector's entries against the book it trades inside.
 *
 * @param {Array}  closed   closed trades attributed to this detector
 * @param {object} baseline summarizeEntryExcursions() over the comparison
 *                          cohort (same window, all setups). Omit and the
 *                          grade is reported without a verdict — an absolute
 *                          MFE:MAE means nothing on its own.
 * @returns {{ ...stats, baseline, vs_baseline, entry_edge, why }|null}
 */
export function gradeEntryQuality(closed, baseline = null) {
  const stats = summarizeEntryExcursions(closed);
  if (!stats) return null;

  const base = baseline && Number(baseline.n) > 0 ? baseline : null;
  const ratio = stats.mfe_mae_ratio;
  const baseRatio = base?.mfe_mae_ratio ?? null;
  const hit = stats.hit_rate_2pct;
  const baseHit = base?.hit_rate_2pct ?? null;

  const comparable = ratio != null && baseRatio != null && baseRatio > 0
    && hit != null && baseHit != null;

  const ratioVsBase = comparable ? round(ratio / baseRatio, 3) : null;
  const hitVsBase = comparable ? round(hit - baseHit, 1) : null;

  let edge = null;
  let why = null;
  if (stats.n < ENTRY_GRADE_MIN_N) {
    edge = "insufficient";
    why = `${stats.n} closed trades — need ${ENTRY_GRADE_MIN_N} before the entries mean anything`;
  } else if (!comparable) {
    edge = "ungraded";
    why = "no comparable book baseline for this window";
  } else if (ratioVsBase >= 1 && hitVsBase >= 0) {
    edge = "confirmed";
    why = `finds more opportunity than heat vs the book (MFE:MAE ${ratio} vs ${baseRatio}, `
      + `reaches +2% on ${hit}% vs ${baseHit}%)`;
  } else if (ratioVsBase < ENTRY_EDGE_ABSENT_RATIO && hitVsBase < 0) {
    edge = "absent";
    why = `walks into more heat than the book for less opportunity (MFE:MAE ${ratio} vs ${baseRatio}, `
      + `reaches +2% on ${hit}% vs ${baseHit}%)`;
  } else {
    edge = "neutral";
    why = `indistinguishable from the book (MFE:MAE ${ratio} vs ${baseRatio}, `
      + `reaches +2% on ${hit}% vs ${baseHit}%)`;
  }

  return {
    ...stats,
    baseline: base
      ? { n: base.n, mfe_mae_ratio: baseRatio, hit_rate_2pct: baseHit, avg_mfe_pct: base.avg_mfe_pct }
      : null,
    vs_baseline: comparable
      ? { mfe_mae_ratio_x: ratioVsBase, hit_rate_2pct_delta: hitVsBase }
      : null,
    entry_edge: edge,
    why,
  };
}

/**
 * Read the entry grade and the management grade together and say which layer
 * owns the problem.
 *
 * The routing matters more than the label. "Bleeding" is the observation;
 * these are the four different things it can mean, and they need four
 * different people to do four different jobs.
 *
 * @param {string|null} entryEdge   from gradeEntryQuality()
 * @param {number|null} captureRate aggregate kept/offered, 0..1
 * @param {number}      captureBar  capture required to size up
 */
export function diagnoseLayer(entryEdge, captureRate, captureBar = 0.35) {
  const capture = finiteOrNull(captureRate);
  const converts = capture != null && capture >= captureBar;

  if (entryEdge === "insufficient" || entryEdge === "ungraded" || entryEdge == null) {
    return { owner: "none", verdict: "keep_running", why: "not enough evidence to route yet" };
  }
  if (entryEdge === "absent") {
    return {
      owner: "entry",
      verdict: "retire_or_rework_detector",
      why: "the signal is not finding moves — better exits cannot fix a bad entry",
    };
  }
  if (!converts) {
    return {
      owner: "management",
      verdict: "fix_management",
      why: capture == null
        ? "entries hold up; there is no capture reading to judge the exits by"
        : `entries hold up but only ${Math.round(capture * 100)}% of the move is kept — `
          + "do NOT demote the detector for this",
    };
  }
  return {
    owner: "none",
    verdict: entryEdge === "confirmed" ? "widen_candidate" : "keep_running",
    why: `entries ${entryEdge} and the book keeps ${Math.round(capture * 100)}% of what they find`,
  };
}
