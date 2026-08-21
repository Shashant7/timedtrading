// worker/supertrend-hold.js
//
// SuperTrend test-and-hold detector.
//
// Pine SuperTrend convention (production tf_tech / computeTfBundle):
//   dir -1 = bull (line below price as support)
//   dir +1 = bear (line above price as resistance)
//
// Operator insight (ETHUSD monthly, Aug 2026):
//   A SuperTrend flip while stretched off the 21 EMA is the riskier entry —
//   the mean-reversion pullback can stop the trade out. A flat SuperTrend
//   that is tested and holds (even a momentary pierce that fails) is the
//   better setup: risk is defined at the ST line.
//
//   Quality:
//     high  — hold near the 21 EMA (continuation, defined risk at the mean)
//     base  — flat ST tested far below/above the 21 EMA (ETH-style reversal)
//     medium — held, neither extreme
//     low   — fresh flip, still sloping, no retest (chase)
//
// This module is pure. It does not import indicators.js.

export const PINE_ST_BULL = -1;
export const PINE_ST_BEAR = 1;

const FLAT_ATR = 0.08;
const TEST_ABOVE_ATR = 0.15;
const TEST_BELOW_ATR = 0.50;
const HOLD_CLOSE_ATR = 0.08;
const EXTENDED_EMA_ATR = 1.5;
const NEAR_EMA_ATR = 0.8;
const DEFAULT_LOOKBACK = 12;
const TD13_THEN_9_WINDOW = 12;
const TF_RANK = { M: 4, W: 3, D: 2, "4H": 1, "240": 1 };

export function pineDirToSide(dir) {
  const n = Number(dir);
  if (!Number.isFinite(n) || n === 0) return 0;
  return n < 0 ? 1 : -1;
}

export function sideLabelFromDir(dir) {
  const s = pineDirToSide(dir);
  if (s > 0) return "LONG";
  if (s < 0) return "SHORT";
  return "NEUTRAL";
}

function emaAt(ema21, i) {
  if (Array.isArray(ema21)) return Number(ema21[i]);
  return Number(ema21);
}

function isFlatDelta(cur, prev, atr) {
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || !(atr > 0)) return false;
  return Math.abs(cur - prev) / atr < FLAT_ATR;
}

function bullTest(low, line, atr) {
  return Number.isFinite(low)
    && low <= line + TEST_ABOVE_ATR * atr
    && low >= line - TEST_BELOW_ATR * atr;
}

function bearTest(high, line, atr) {
  return Number.isFinite(high)
    && high >= line - TEST_ABOVE_ATR * atr
    && high <= line + TEST_BELOW_ATR * atr;
}

function bullHeldClose(close, line, atr) {
  return Number.isFinite(close) && close >= line - HOLD_CLOSE_ATR * atr;
}

function bearHeldClose(close, line, atr) {
  return Number.isFinite(close) && close <= line + HOLD_CLOSE_ATR * atr;
}

function qualityFor({ kind, held, distEma21Atr, recentlyFlat }) {
  if (kind === "st_flip_extended") return "low";
  if (held && Number.isFinite(distEma21Atr) && distEma21Atr <= NEAR_EMA_ATR && recentlyFlat) {
    return "high";
  }
  if (held && Number.isFinite(distEma21Atr) && distEma21Atr > EXTENDED_EMA_ATR) {
    return "base";
  }
  if (held) return "medium";
  return "low";
}

/**
 * Detect a SuperTrend test-and-hold (or a stretched flip-without-retest).
 *
 * @param {object} args
 * @param {Array<{h:number,l:number,c:number}>} args.bars
 * @param {number[]} args.stDir   Pine dir series (-1 bull, +1 bear)
 * @param {number[]} args.stLine  SuperTrend line series
 * @param {number|number[]} args.ema21
 * @param {number} args.atr
 * @param {number} [args.lookback=12]
 * @returns {object|null}
 */
export function detectSupertrendHoldFromSeries({
  bars,
  stDir,
  stLine,
  ema21,
  atr,
  lookback = DEFAULT_LOOKBACK,
} = {}) {
  if (!Array.isArray(bars) || !Array.isArray(stDir) || !Array.isArray(stLine)) return null;
  const n = bars.length - 1;
  if (n < 2) return null;
  const atrN = Number(atr);
  if (!Number.isFinite(atrN) || atrN <= 0) return null;
  if (stDir.length < bars.length || stLine.length < bars.length) return null;

  const curDir = stDir[n];
  const curLine = Number(stLine[n]);
  const curClose = Number(bars[n]?.c);
  if (!Number.isFinite(curDir) || !Number.isFinite(curLine) || !Number.isFinite(curClose)) return null;

  const curEma = emaAt(ema21, n);
  const side = pineDirToSide(curDir);
  const sideLabel = side > 0 ? "LONG" : side < 0 ? "SHORT" : "NEUTRAL";
  const distEma21Atr = Number.isFinite(curEma) ? Math.abs(curClose - curEma) / atrN : null;

  const start = Math.max(1, n - lookback);

  let lastFlip = -1;
  for (let i = n; i >= start; i--) {
    if (stDir[i] !== stDir[i - 1] && Number.isFinite(stDir[i]) && Number.isFinite(stDir[i - 1])) {
      lastFlip = i;
      break;
    }
  }

  let flatBars = 0;
  for (let i = start; i <= n; i++) {
    if (isFlatDelta(Number(stLine[i]), Number(stLine[i - 1]), atrN)) flatBars++;
  }
  const currentlyFlat = isFlatDelta(curLine, Number(stLine[n - 1]), atrN);
  const recentlyFlat = currentlyFlat || flatBars >= 1;

  let testIdx = -1;
  let holdIdx = -1;
  let pierceIdx = -1;

  for (let i = start; i <= n; i++) {
    const bar = bars[i];
    const line = Number(stLine[i]);
    const dir = stDir[i];
    if (!bar || !Number.isFinite(line) || !Number.isFinite(dir)) continue;
    const dirSide = pineDirToSide(dir);
    const low = Number(bar.l);
    const high = Number(bar.h);
    const close = Number(bar.c);

    if (dirSide > 0) {
      if (bullTest(low, line, atrN)) {
        testIdx = i;
        if (bullHeldClose(close, line, atrN)) holdIdx = i;
      }
    } else if (dirSide < 0) {
      if (bearTest(high, line, atrN)) {
        testIdx = i;
        if (bearHeldClose(close, line, atrN)) holdIdx = i;
      }
    }

    // One-bar flip against the prior side that the next bar immediately reclaims.
    if (i > 0 && i < n && stDir[i] !== stDir[i - 1] && stDir[i + 1] === stDir[i - 1]) {
      const nextClose = Number(bars[i + 1]?.c);
      const nextLine = Number(stLine[i + 1]);
      const prevSide = pineDirToSide(stDir[i - 1]);
      if (prevSide > 0 && bullHeldClose(nextClose, nextLine, atrN)) pierceIdx = i;
      if (prevSide < 0 && bearHeldClose(nextClose, nextLine, atrN)) pierceIdx = i;
    }
  }

  // Recovered on the current bar after a one-bar opposite print.
  if (n >= 2 && stDir[n] !== stDir[n - 1] && stDir[n] === stDir[n - 2]) {
    pierceIdx = n - 1;
  }

  const barsSinceFlip = lastFlip >= 0 ? n - lastFlip : null;
  const flipRecent = lastFlip >= 0 && barsSinceFlip <= 2;
  const tested = testIdx >= 0;
  const heldFromTest = holdIdx >= 0;
  const held = heldFromTest || pierceIdx >= 0;
  const flipThenRetest = lastFlip >= 0 && testIdx > lastFlip && held;

  let kind = null;
  if (pierceIdx >= 0 && recentlyFlat) {
    kind = "st_pierce_held";
  } else if (flipThenRetest) {
    kind = "st_flip_retest";
  } else if (held && recentlyFlat) {
    kind = "st_hold";
  } else if (flipRecent && !held && Number.isFinite(distEma21Atr) && distEma21Atr > EXTENDED_EMA_ATR) {
    kind = "st_flip_extended";
  } else if (held) {
    kind = "st_hold";
  }

  if (!kind) return null;

  const quality = qualityFor({
    kind,
    held: kind !== "st_flip_extended" && held,
    distEma21Atr,
    recentlyFlat,
  });

  return {
    kind,
    side,
    sideLabel,
    stLine: Math.round(curLine * 100) / 100,
    ema21: Number.isFinite(curEma) ? Math.round(curEma * 100) / 100 : null,
    distEma21Atr: Number.isFinite(distEma21Atr) ? Math.round(distEma21Atr * 100) / 100 : null,
    quality,
    held: kind !== "st_flip_extended" && held,
    tested,
    recentlyFlat,
    currentlyFlat,
    barsSinceFlip,
    testBarsAgo: testIdx >= 0 ? n - testIdx : null,
    pierce: pierceIdx >= 0,
  };
}

export function compactStHold(hold) {
  if (!hold) return undefined;
  return {
    k: hold.kind,
    s: hold.side,
    held: !!hold.held,
    q: hold.quality,
    line: hold.stLine,
    e21: hold.ema21,
    d21: hold.distEma21Atr,
  };
}

/**
 * Monthly (or HTF) TD13 followed by a later TD9 — ETH-style exhaustion then setup.
 * Prefers M, then W. 9 must be more recent than 13 (new setup after countdown).
 */
export function detectTd13Then9(perTf, { tfs = ["M", "W"] } = {}) {
  if (!perTf || typeof perTf !== "object") return null;
  for (const tf of tfs) {
    const row = perTf[tf]
      || (tf === "M" ? perTf["1M"] : null)
      || (tf === "W" ? perTf["1W"] : null);
    if (!row) continue;
    const td9Bull = row.last_td9_bullish_bars_ago ?? (row.td9_bullish ? 0 : null);
    const td13Bull = row.last_td13_bullish_bars_ago;
    const td9Bear = row.last_td9_bearish_bars_ago ?? (row.td9_bearish ? 0 : null);
    const td13Bear = row.last_td13_bearish_bars_ago;

    if (Number.isFinite(td13Bull) && Number.isFinite(td9Bull)
      && td9Bull < td13Bull && td13Bull <= TD13_THEN_9_WINDOW) {
      return { tf, side: "LONG", td13_bars_ago: td13Bull, td9_bars_ago: td9Bull };
    }
    if (Number.isFinite(td13Bear) && Number.isFinite(td9Bear)
      && td9Bear < td13Bear && td13Bear <= TD13_THEN_9_WINDOW) {
      return { tf, side: "SHORT", td13_bars_ago: td13Bear, td9_bars_ago: td9Bear };
    }
  }
  return null;
}

export function detectEma233ReclaimFromSeries({
  closes,
  ema233,
  lookback = 24,
} = {}) {
  if (!Array.isArray(closes) || !Array.isArray(ema233) || closes.length < 3) return null;
  const n = closes.length - 1;
  const lastC = Number(closes[n]);
  const lastE = Number(ema233[n]);
  if (!Number.isFinite(lastC) || !Number.isFinite(lastE)) return null;
  const above = lastC >= lastE;
  if (!above) return { above: false, reclaim: false, barsSinceReclaim: null };

  const start = Math.max(0, n - lookback);
  let wasBelow = false;
  let reclaimIdx = -1;
  for (let i = start; i <= n; i++) {
    const c = Number(closes[i]);
    const e = Number(ema233[i]);
    if (!Number.isFinite(c) || !Number.isFinite(e)) continue;
    if (c < e) wasBelow = true;
    if (i > start) {
      const pc = Number(closes[i - 1]);
      const pe = Number(ema233[i - 1]);
      if (Number.isFinite(pc) && Number.isFinite(pe) && pc < pe && c >= e) {
        reclaimIdx = i;
      }
    }
  }
  if (!wasBelow) return { above: true, reclaim: false, barsSinceReclaim: null };
  return {
    above: true,
    reclaim: reclaimIdx >= 0 || wasBelow,
    barsSinceReclaim: reclaimIdx >= 0 ? n - reclaimIdx : null,
  };
}

export function detectEma233Reclaim(tfTech) {
  if (!tfTech || typeof tfTech !== "object") return null;
  const row4 = tfTech["4H"] || tfTech["240"];
  const row1 = tfTech["1H"] || tfTech["60"];
  const pick = (row, tf) => {
    if (!row) return null;
    const rec = row.ema233Reclaim || row.ema?.ema233Reclaim;
    if (rec && typeof rec === "object") return { tf, ...rec };
    if (row.ema?.priceAboveEma233 === true && row.ema?.reclaimedEma233) {
      return { tf, above: true, reclaim: true, barsSinceReclaim: null };
    }
    return null;
  };
  const a = pick(row4, "4H");
  if (a?.reclaim) return a;
  const b = pick(row1, "1H");
  if (b?.reclaim) return b;
  return a || b;
}

function holdRank(h) {
  if (!h) return -1;
  const q = { high: 3, medium: 2, base: 2, low: 0 }[h.quality] ?? 0;
  let s = q * 10 + (TF_RANK[h.tf] || 0);
  if (h.held) s += 20;
  if (h.kind === "st_flip_retest" || h.kind === "st_pierce_held") s += 8;
  else if (h.kind === "st_hold") s += 4;
  if (h.kind === "st_flip_extended") s -= 15;
  return s;
}

/**
 * Pick the best ST-hold across M / W / D / 4H and attach TD + 233.
 * 6.5H / 9H stay on tf_tech for against-veto; they do not win RIDE.
 */
export function assembleStHoldSetup({ bundles, tdSeq, tfTech } = {}) {
  const map = {
    M: bundles?.M,
    W: bundles?.W,
    D: bundles?.D,
    "4H": bundles?.["4H"] || bundles?.["240"],
  };
  const holds = [];
  for (const [tf, b] of Object.entries(map)) {
    if (b?.stHold) holds.push({ tf, ...b.stHold });
  }
  holds.sort((a, b) => holdRank(b) - holdRank(a));
  const best = holds[0] || null;
  const td13_then_9 = detectTd13Then9(tdSeq?.per_tf || tdSeq);
  const ema233_reclaim = detectEma233Reclaim(tfTech)
    || (map["4H"]?.ema233Reclaim
      ? { tf: "4H", ...map["4H"].ema233Reclaim }
      : null);
  if (!best && !td13_then_9 && !ema233_reclaim?.reclaim) return null;
  return {
    best,
    holds,
    td13_then_9,
    ema233_reclaim: ema233_reclaim || null,
    confluence: {
      st_hold: !!(best?.held),
      td13_then_9: !!td13_then_9,
      ema233_reclaim: !!ema233_reclaim?.reclaim,
    },
  };
}

function holdSideLabel(hold) {
  if (!hold) return "";
  if (hold.sideLabel === "LONG" || hold.sideLabel === "SHORT") return hold.sideLabel;
  if (hold.side === "LONG" || hold.side === "SHORT") return hold.side;
  if (hold.side === 1) return "LONG";
  if (hold.side === -1) return "SHORT";
  return "";
}

export function holdAgreesWithSide(hold, dominantSide) {
  if (!hold?.held || !dominantSide) return false;
  return holdSideLabel(hold) === dominantSide;
}

export function isFlipExtendedChase(hold, dominantSide) {
  if (!hold || hold.kind !== "st_flip_extended") return false;
  if (!dominantSide) return true;
  return holdSideLabel(hold) === dominantSide;
}

export function refreshStHoldSetup(tickerData, bundles) {
  if (!tickerData || !bundles) return tickerData;
  const setup = assembleStHoldSetup({
    bundles,
    tdSeq: tickerData.td_sequential,
    tfTech: tickerData.tf_tech,
  });
  if (setup) tickerData.st_hold_setup = setup;
  return tickerData;
}
