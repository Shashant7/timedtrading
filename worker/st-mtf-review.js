// Reconstruct SuperTrend state at trade entry across the MTF stack
// (10m, 30m, 1H, 4H, D, W, M) plus synthesized 6.5H / 9H session charts.
//
// Used by scripts/analyze-st-mtf-trades.mjs and by the live trigger
// (treatment of hold vs flip-retest vs slope vs chase).

import { atrSeries, emaSeries, superTrendSeries } from "./indicators.js";
import { detectSupertrendHoldFromSeries, pineDirToSide } from "./supertrend-hold.js";
import { synthesizeNineHourBars, synthesizeRthSessionBars } from "./session-tfs.js";

export const NATIVE_REVIEW_TFS = ["10", "30", "60", "240", "D", "W", "M"];
export const SESSION_REVIEW_TFS = ["6.5H", "9H"];
export const REVIEW_TFS = [...NATIVE_REVIEW_TFS, ...SESSION_REVIEW_TFS];

export const HTF_REVIEW = new Set(["240", "D", "W", "M", "6.5H", "9H"]);
export const LTF_REVIEW = new Set(["10", "30", "60"]);

const FLAT_ATR = 0.08;
const MIN_BARS = 20;

export const ST_CLASSES = [
  "st_hold",
  "st_flip_retest",
  "st_pierce_held",
  "st_flip_extended",
  "sloping_agree",
  "flat_no_test",
  "agree_no_setup",
  "against",
  "insufficient",
];

const HELD_CLASSES = new Set(["st_hold", "st_flip_retest", "st_pierce_held"]);

export function barsAtOrBefore(bars, ts) {
  if (!Array.isArray(bars) || !Number.isFinite(Number(ts))) return [];
  const cut = Number(ts);
  return bars.filter((b) => Number(b?.ts) <= cut);
}

export function barsBetween(bars, fromTs, toTs) {
  if (!Array.isArray(bars)) return [];
  const a = Number(fromTs);
  const b = Number(toTs);
  return bars.filter((x) => {
    const t = Number(x?.ts);
    if (!Number.isFinite(t)) return false;
    if (Number.isFinite(a) && t <= a) return false;
    if (Number.isFinite(b) && t > b) return false;
    return true;
  });
}

function lastAtr(bars) {
  const atr = atrSeries(bars, 10);
  const v = atr[atr.length - 1];
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Classify SuperTrend at the last bar of `bars` relative to the trade side.
 * Pine dir: -1 bull / +1 bear.
 */
export function classifyStAtEntry({ bars, tradeSide } = {}) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) {
    return { class: "insufficient", held: false, agree: false };
  }
  const st = superTrendSeries(bars, 3.0, 10);
  const closes = bars.map((b) => Number(b.c));
  const ema21 = emaSeries(closes, 21);
  const atrN = lastAtr(bars);
  const n = bars.length - 1;
  const curDir = st.dir[n];
  const curLine = Number(st.line[n]);
  const prevLine = Number(st.line[n - 1]);
  const dirSide = pineDirToSide(curDir);
  const trade = String(tradeSide || "LONG").toUpperCase() === "SHORT" ? -1 : 1;
  const agree = dirSide !== 0 && dirSide === trade;
  const sloping = Number.isFinite(curLine) && Number.isFinite(prevLine) && atrN
    ? Math.abs(curLine - prevLine) / atrN >= FLAT_ATR
    : false;
  const slopeDir = Number.isFinite(curLine) && Number.isFinite(prevLine)
    ? (curLine > prevLine ? 1 : curLine < prevLine ? -1 : 0)
    : 0;
  const slopeAgrees = trade > 0 ? slopeDir > 0 : slopeDir < 0;

  let hold = null;
  if (atrN) {
    hold = detectSupertrendHoldFromSeries({
      bars,
      stDir: st.dir,
      stLine: st.line,
      ema21,
      atr: atrN,
      lookback: 12,
    });
  }

  const base = {
    held: !!(hold?.held),
    tested: !!(hold?.tested),
    agree,
    sloping,
    slopeAgrees,
    stDir: curDir,
    stLine: Number.isFinite(curLine) ? Math.round(curLine * 100) / 100 : null,
    ema21: Number.isFinite(ema21[n]) ? Math.round(ema21[n] * 100) / 100 : null,
    distEma21Atr: hold?.distEma21Atr ?? null,
    quality: hold?.quality || null,
    kind: hold?.kind || null,
    barsSinceFlip: hold?.barsSinceFlip ?? null,
    currentlyFlat: !!(hold?.currentlyFlat) || !sloping,
  };

  if (!agree) return { ...base, class: "against" };
  if (hold?.held && hold.kind) return { ...base, class: hold.kind };
  if (hold?.kind === "st_flip_extended") return { ...base, class: "st_flip_extended" };
  if (sloping && slopeAgrees) return { ...base, class: "sloping_agree" };
  if (!sloping) return { ...base, class: "flat_no_test" };
  return { ...base, class: "agree_no_setup" };
}

export function attachSessionCandles(candlesByTf) {
  const out = { ...(candlesByTf || {}) };
  if (!out["6.5H"]?.length && out["30"]?.length) {
    out["6.5H"] = synthesizeRthSessionBars(out["30"]);
  }
  if (!out["9H"]?.length) {
    const src = out["60"]?.length ? out["60"] : out["30"];
    if (src?.length) out["9H"] = synthesizeNineHourBars(src);
  }
  return out;
}

function laterHold(bars, entryTs, exitTs, tradeSide) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return null;
  const after = barsBetween(bars, entryTs, exitTs).slice(0, 16);
  if (!after.length) return null;
  const lastScanTs = Number(after[after.length - 1].ts);
  const prefix = barsAtOrBefore(bars, lastScanTs);
  if (prefix.length < MIN_BARS) return null;
  const st = superTrendSeries(prefix, 3.0, 10);
  const closes = prefix.map((b) => Number(b.c));
  const ema21 = emaSeries(closes, 21);
  const atr = atrSeries(prefix, 10);
  const trade = String(tradeSide || "LONG").toUpperCase() === "SHORT" ? -1 : 1;
  let first = null;
  for (let i = 0; i < prefix.length; i++) {
    if (Number(prefix[i].ts) <= Number(entryTs)) continue;
    const window = prefix.slice(0, i + 1);
    if (window.length < MIN_BARS) continue;
    const atrN = atr[i];
    if (!(atrN > 0)) continue;
    const hit = detectSupertrendHoldFromSeries({
      bars: window,
      stDir: st.dir.slice(0, i + 1),
      stLine: st.line.slice(0, i + 1),
      ema21: ema21.slice(0, i + 1),
      atr: atrN,
      lookback: 12,
    });
    if (!hit?.held) continue;
    if (pineDirToSide(st.dir[i]) !== trade) continue;
    first = {
      class: hit.kind,
      ts: prefix[i].ts,
      barsAfterEntry: after.findIndex((b) => Number(b.ts) === Number(prefix[i].ts)) + 1,
      stLine: hit.stLine,
      quality: hit.quality,
    };
    break;
  }
  return first;
}

export function classifyTradeAcrossTfs(trade, candlesByTf) {
  const side = String(trade.direction || trade.side || "LONG").toUpperCase();
  const entryTs = Number(trade.entry_ts);
  const exitTs = Number(trade.exit_ts);
  const candles = attachSessionCandles(candlesByTf);
  const perTf = {};
  for (const tf of REVIEW_TFS) {
    const series = candles[tf] || [];
    const atEntry = barsAtOrBefore(series, entryTs);
    const state = classifyStAtEntry({ bars: atEntry, tradeSide: side });
    let post = null;
    if (HTF_REVIEW.has(tf) && !state.held && state.class !== "insufficient") {
      try {
        post = laterHold(series, entryTs, exitTs, side);
      } catch (_) {
        post = null;
      }
    }
    perTf[tf] = { ...state, later_hold: post };
  }
  const status = String(trade.status || "").toUpperCase();
  const pnlPct = Number(trade.pnl_pct);
  return {
    trade_id: trade.trade_id || trade.id || null,
    ticker: String(trade.ticker || "").toUpperCase(),
    book: trade.book || "st",
    setup: trade.setup_name || trade.setup || null,
    side,
    status: trade.status || null,
    win: status === "WIN" || (status !== "LOSS" && Number.isFinite(pnlPct) && pnlPct > 0),
    pnl_pct: Number(trade.pnl_pct),
    entry_ts: entryTs,
    per_tf: perTf,
    htf_held: REVIEW_TFS.some((tf) => HTF_REVIEW.has(tf) && HELD_CLASSES.has(perTf[tf]?.class)),
    ltf_chase: LTF_REVIEW.has("10") && (perTf["10"]?.class === "st_flip_extended" || perTf["30"]?.class === "st_flip_extended"),
    htf_against: ["D", "W", "M"].some((tf) => perTf[tf]?.class === "against"),
    later_htf_hold: REVIEW_TFS.some((tf) => HTF_REVIEW.has(tf) && perTf[tf]?.later_hold),
  };
}

function emptyStat() {
  return { n: 0, wins: 0, losses: 0, sum_pnl: 0 };
}

function addStat(s, row) {
  s.n += 1;
  if (row.win) s.wins += 1;
  else s.losses += 1;
  if (Number.isFinite(row.pnl_pct)) s.sum_pnl += row.pnl_pct;
}

function finalizeStat(s, baselineWr = null) {
  const wr = s.n ? s.wins / s.n : 0;
  return {
    n: s.n,
    wins: s.wins,
    losses: s.losses,
    wr: Math.round(wr * 1000) / 1000,
    avg_pnl_pct: s.n ? Math.round((s.sum_pnl / s.n) * 1000) / 1000 : 0,
    lift_wr: baselineWr == null ? null : Math.round((wr - baselineWr) * 1000) / 1000,
  };
}

export function aggregateStMtfReview(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const baseline = emptyStat();
  for (const r of list) addStat(baseline, r);
  const baseWr = baseline.n ? baseline.wins / baseline.n : 0;

  const byTfClass = {};
  const bySetup = {};
  const byBook = {};
  const byFeature = {
    htf_held: emptyStat(),
    ltf_chase: emptyStat(),
    htf_against: emptyStat(),
    later_htf_hold: emptyStat(),
    htf_held_and_not_chase: emptyStat(),
    slope_only_no_hold: emptyStat(),
  };

  for (const r of list) {
    const book = r.book || "st";
    byBook[book] = byBook[book] || emptyStat();
    addStat(byBook[book], r);
    const setup = r.setup || "(none)";
    bySetup[setup] = bySetup[setup] || emptyStat();
    addStat(bySetup[setup], r);

    if (r.htf_held) addStat(byFeature.htf_held, r);
    if (r.ltf_chase) addStat(byFeature.ltf_chase, r);
    if (r.htf_against) addStat(byFeature.htf_against, r);
    if (r.later_htf_hold) addStat(byFeature.later_htf_hold, r);
    if (r.htf_held && !r.ltf_chase) addStat(byFeature.htf_held_and_not_chase, r);

    let anyHold = false;
    let anySlope = false;
    for (const tf of REVIEW_TFS) {
      const cls = r.per_tf?.[tf]?.class || "insufficient";
      const key = `${tf}::${cls}`;
      byTfClass[key] = byTfClass[key] || emptyStat();
      addStat(byTfClass[key], r);
      if (HELD_CLASSES.has(cls) && HTF_REVIEW.has(tf)) anyHold = true;
      if (cls === "sloping_agree" && HTF_REVIEW.has(tf)) anySlope = true;
    }
    if (anySlope && !anyHold) addStat(byFeature.slope_only_no_hold, r);
  }

  const fin = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = finalizeStat(v, baseWr);
    return out;
  };

  return {
    n: list.length,
    baseline: finalizeStat(baseline, null),
    by_tf_class: fin(byTfClass),
    by_setup: fin(bySetup),
    by_book: fin(byBook),
    by_feature: fin(byFeature),
  };
}

/**
 * Translate the review tables into the live treatment order.
 * Rules are conservative: only fire when a cell has enough trades and a
 * meaningful lift vs the book baseline.
 */
export function recommendStTreatment(agg, { minN = 25, lift = 0.04 } = {}) {
  const recs = [];
  const feat = agg?.by_feature || {};
  const tfClass = agg?.by_tf_class || {};

  const htfHold = feat.htf_held;
  if (htfHold?.n >= minN && (htfHold.lift_wr ?? 0) >= lift) {
    recs.push({
      id: "prefer_htf_hold",
      action: "RIDE on HTF SuperTrend test-and-hold (4H/D/W/M/6.5H/9H) even if the line is still flat",
      evidence: htfHold,
    });
  }

  const chase = feat.ltf_chase;
  if (chase?.n >= minN && (chase.lift_wr ?? 0) <= -lift) {
    recs.push({
      id: "haircut_ltf_chase",
      action: "READY (do not chase) when 10m/30m SuperTrend just flipped extended off the 21 EMA",
      evidence: chase,
    });
  }

  const against = feat.htf_against;
  if (against?.n >= minN && (against.lift_wr ?? 0) <= -lift) {
    recs.push({
      id: "block_htf_against",
      action: "Do not ignite off LTF slope when D/W/M SuperTrend is against the trade",
      evidence: against,
    });
  }

  const later = feat.later_htf_hold;
  if (later?.n >= minN && (later.lift_wr ?? 0) >= 0) {
    recs.push({
      id: "wait_for_retest",
      action: "A later HTF test-and-hold after entry is common — prefer that print over the stretch flip",
      evidence: later,
    });
  }

  const slopeOnly = feat.slope_only_no_hold;
  if (slopeOnly?.n >= minN && htfHold?.n >= minN && (htfHold.wr ?? 0) > (slopeOnly.wr ?? 0) + lift) {
    recs.push({
      id: "hold_beats_slope",
      action: "Rank HTF hold / flip-retest above flip-and-slope as the ignition",
      evidence: { hold: htfHold, slope_only: slopeOnly },
    });
  }

  // Per-TF: session charts earn a live slot only if they separate the book.
  for (const tf of SESSION_REVIEW_TFS) {
    const held = tfClass[`${tf}::st_hold`] || tfClass[`${tf}::st_flip_retest`];
    const heldN = (tfClass[`${tf}::st_hold`]?.n || 0) + (tfClass[`${tf}::st_flip_retest`]?.n || 0)
      + (tfClass[`${tf}::st_pierce_held`]?.n || 0);
    const heldWins = (tfClass[`${tf}::st_hold`]?.wins || 0) + (tfClass[`${tf}::st_flip_retest`]?.wins || 0)
      + (tfClass[`${tf}::st_pierce_held`]?.wins || 0);
    const heldWr = heldN ? heldWins / heldN : 0;
    const againstTf = tfClass[`${tf}::against`];
    if (heldN >= minN && heldWr - (agg?.baseline?.wr || 0) >= lift) {
      recs.push({
        id: `promote_${tf}`,
        action: `Include ${tf} SuperTrend hold in the live MTF stack`,
        evidence: { held_n: heldN, held_wr: Math.round(heldWr * 1000) / 1000, sample: held },
      });
    }
    if (againstTf?.n >= minN && (againstTf.lift_wr ?? 0) <= -lift) {
      recs.push({
        id: `respect_${tf}_against`,
        action: `${tf} SuperTrend against the trade is a real veto — do not ignore it`,
        evidence: againstTf,
      });
    }
  }

  recs.push({
    id: "include_wm_trigger",
    action: "Weekly and monthly SuperTrend belong in the swing trigger (not only 1H/4H/D)",
    evidence: { reason: "mtf_completeness" },
  });

  return recs;
}

export function pickStTreatment(perTf) {
  const htf = ["M", "W", "D", "9H", "6.5H", "240"];
  let bestHold = null;
  let chase = false;
  let against = false;
  let slope = false;
  for (const tf of htf) {
    const s = perTf?.[tf];
    if (!s) continue;
    if (s.class === "against") against = true;
    if (s.class === "st_flip_extended") chase = true;
    if (s.class === "sloping_agree") slope = true;
    if (HELD_CLASSES.has(s.class)) {
      bestHold = { tf, class: s.class, quality: s.quality };
      break;
    }
  }
  if (bestHold) return { treatment: "hold", ...bestHold };
  if (chase) return { treatment: "chase" };
  if (slope && !against) return { treatment: "slope" };
  if (against) return { treatment: "against" };
  return { treatment: "flat" };
}
