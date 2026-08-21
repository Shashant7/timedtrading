import { describe, expect, it } from "vitest";
import {
  assembleStHoldSetup,
  compactStHold,
  detectEma233ReclaimFromSeries,
  detectSupertrendHoldFromSeries,
  detectTd13Then9,
  holdAgreesWithSide,
  isFlipExtendedChase,
  pineDirToSide,
} from "./supertrend-hold.js";
import { scoreRootConfluence } from "./root-strategy.js";
import { assembleTickerData, computeTDSequential, detectFlags } from "./indicators.js";

const PINE_BULL = -1;
const PINE_BEAR = 1;

function bar(i, { o, h, l, c }) {
  return { ts: i * 86_400_000, o, h, l, c, v: 1000 };
}

function fill(n, dir, line, px) {
  const bars = [];
  const stDir = [];
  const stLine = [];
  const ema21 = [];
  for (let i = 0; i < n; i++) {
    const close = typeof px === "function" ? px(i) : px;
    const lineV = typeof line === "function" ? line(i) : line;
    bars.push(bar(i, {
      o: close,
      h: close + 20,
      l: close - 20,
      c: close,
    }));
    stDir.push(dir);
    stLine.push(lineV);
    ema21.push(2550);
  }
  return { bars, stDir, stLine, ema21 };
}

describe("pineDirToSide", () => {
  it("maps Pine -1 to long and +1 to short", () => {
    expect(pineDirToSide(-1)).toBe(1);
    expect(pineDirToSide(1)).toBe(-1);
    expect(pineDirToSide(0)).toBe(0);
  });
});

describe("detectSupertrendHoldFromSeries", () => {
  it("flags an ETH-like monthly crash-base: flat ST tested and held", () => {
    // Crash, flip to bull, ST goes flat at 1550, July wick tests and holds,
    // August continues higher. 21 EMA stays overhead ~2550.
    const { bars, stDir, stLine, ema21 } = fill(20, PINE_BEAR, 2000, (i) => 3400 - i * 80);
    for (let i = 8; i < 20; i++) {
      stDir[i] = PINE_BULL;
      stLine[i] = 1550;
    }
    // July (bar 18): long-legged hammer into the flat ST.
    bars[18] = bar(18, { o: 1750, h: 1950, l: 1520, c: 1880 });
    stDir[18] = PINE_BULL;
    stLine[18] = 1550;
    // August (bar 19): continuation, still well above the held ST.
    bars[19] = bar(19, { o: 1900, h: 2380, l: 1850, c: 2321 });
    stDir[19] = PINE_BULL;
    stLine[19] = 1550;

    const hit = detectSupertrendHoldFromSeries({
      bars, stDir, stLine, ema21, atr: 400, lookback: 12,
    });

    expect(hit).toBeTruthy();
    expect(hit.held).toBe(true);
    expect(["st_hold", "st_pierce_held", "st_flip_retest"]).toContain(hit.kind);
    expect(hit.sideLabel).toBe("LONG");
    expect(hit.stLine).toBe(1550);
    expect(hit.recentlyFlat).toBe(true);
    expect(hit.tested).toBe(true);
  });

  it("classifies a fresh sloping flip far from the 21 EMA as a chase", () => {
    const { bars, stDir, stLine, ema21 } = fill(16, PINE_BEAR, 2800, 2700);
    for (let i = 14; i < 16; i++) {
      stDir[i] = PINE_BULL;
      stLine[i] = 3000 + (i - 14) * 80; // still sloping
      bars[i] = bar(i, { o: 3200, h: 3400, l: 3180, c: 3300 + (i - 14) * 50 });
    }
    for (let i = 0; i < 16; i++) ema21[i] = 2550;

    const hit = detectSupertrendHoldFromSeries({
      bars, stDir, stLine, ema21, atr: 200, lookback: 12,
    });

    expect(hit).toBeTruthy();
    expect(hit.kind).toBe("st_flip_extended");
    expect(hit.held).toBe(false);
    expect(hit.quality).toBe("low");
    expect(hit.distEma21Atr).toBeGreaterThan(1.5);
  });

  it("classifies flip then retest of the ST line near the 21 EMA as high quality", () => {
    const { bars, stDir, stLine, ema21 } = fill(16, PINE_BEAR, 2400, 2300);
    for (let i = 6; i < 16; i++) {
      stDir[i] = PINE_BULL;
      stLine[i] = 2500;
      ema21[i] = 2520;
      bars[i] = bar(i, { o: 2600, h: 2720, l: 2580, c: 2680 });
    }
    // Retest near the 21 EMA / ST line.
    bars[14] = bar(14, { o: 2560, h: 2580, l: 2495, c: 2540 });
    bars[15] = bar(15, { o: 2540, h: 2580, l: 2520, c: 2560 });
    stLine[14] = 2500;
    stLine[15] = 2500;

    const hit = detectSupertrendHoldFromSeries({
      bars, stDir, stLine, ema21, atr: 80, lookback: 12,
    });

    expect(hit).toBeTruthy();
    expect(hit.held).toBe(true);
    expect(hit.kind).toBe("st_flip_retest");
    expect(hit.quality).toBe("high");
    expect(hit.stLine).toBe(2500);
  });

  it("treats a one-bar pierce that fails as a hold", () => {
    const { bars, stDir, stLine, ema21 } = fill(10, PINE_BULL, 1550, 1800);
    // Momentary bear flip that immediately fails.
    stDir[8] = PINE_BEAR;
    bars[8] = bar(8, { o: 1600, h: 1620, l: 1480, c: 1500 });
    stLine[8] = 1550;
    stDir[9] = PINE_BULL;
    bars[9] = bar(9, { o: 1520, h: 1720, l: 1510, c: 1680 });
    stLine[9] = 1550;

    const hit = detectSupertrendHoldFromSeries({
      bars, stDir, stLine, ema21, atr: 200, lookback: 8,
    });

    expect(hit).toBeTruthy();
    expect(hit.held).toBe(true);
    expect(hit.kind).toBe("st_pierce_held");
    expect(hit.pierce).toBe(true);
  });
});

describe("detectTd13Then9", () => {
  it("fires on monthly TD13 then a later TD9", () => {
    const hit = detectTd13Then9({
      M: {
        td9_bullish: true,
        last_td9_bullish_bars_ago: 0,
        last_td13_bullish_bars_ago: 2,
      },
    });
    expect(hit).toEqual({
      tf: "M",
      side: "LONG",
      td13_bars_ago: 2,
      td9_bars_ago: 0,
    });
  });

  it("does not treat the normal 9-then-13 sequence as 13-then-9", () => {
    expect(detectTd13Then9({
      M: {
        td13_bullish: true,
        last_td9_bullish_bars_ago: 4,
        last_td13_bullish_bars_ago: 0,
      },
    })).toBeNull();
  });
});

describe("computeTDSequential last-completion stamps", () => {
  it("records bars-ago 0 on a just-completed TD9", () => {
    const closes = [20, 20, 20, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11];
    const bars = closes.map((c, i) => ({
      ts: i * 86_400_000, o: c, h: c + 1, l: c - 2, c, v: 1000,
    }));
    const td = computeTDSequential(bars, "M");
    expect(td.td9_bullish).toBe(true);
    expect(td.last_td9_bullish_bars_ago).toBe(0);
  });
});

describe("detectEma233ReclaimFromSeries", () => {
  it("flags a reclaim after price was below the 233 EMA", () => {
    const closes = [];
    const ema233 = [];
    for (let i = 0; i < 20; i++) {
      ema233.push(100);
      closes.push(i < 12 ? 90 : 110);
    }
    const hit = detectEma233ReclaimFromSeries({ closes, ema233, lookback: 20 });
    expect(hit.above).toBe(true);
    expect(hit.reclaim).toBe(true);
    expect(hit.barsSinceReclaim).toBe(7);
  });
});

describe("assembleStHoldSetup + flags + tf_tech", () => {
  it("prefers a held monthly setup over a daily chase flip", () => {
    const setup = assembleStHoldSetup({
      bundles: {
        M: {
          stHold: {
            kind: "st_hold", side: 1, sideLabel: "LONG", held: true,
            quality: "base", stLine: 1550, ema21: 2550, distEma21Atr: 2.1,
          },
        },
        D: {
          stHold: {
            kind: "st_flip_extended", side: 1, sideLabel: "LONG", held: false,
            quality: "low", stLine: 3100, ema21: 2550, distEma21Atr: 2.8,
          },
        },
      },
      tdSeq: {
        per_tf: {
          M: { td9_bullish: true, last_td9_bullish_bars_ago: 0, last_td13_bullish_bars_ago: 1 },
        },
      },
      tfTech: {
        "4H": { ema233Reclaim: { above: true, reclaim: true, barsSinceReclaim: 6 } },
      },
    });
    expect(setup.best.tf).toBe("M");
    expect(setup.best.held).toBe(true);
    expect(setup.td13_then_9.tf).toBe("M");
    expect(setup.ema233_reclaim.reclaim).toBe(true);
    expect(setup.confluence).toEqual({
      st_hold: true,
      td13_then_9: true,
      ema233_reclaim: true,
    });
  });

  it("emits stLine + compact stHold on tf_tech and monthly_bundle", () => {
    const hold = {
      kind: "st_hold", side: 1, sideLabel: "LONG", held: true,
      quality: "base", stLine: 1550, ema21: 2550, distEma21Atr: 0.57,
    };
    const b = {
      px: 2321, stDir: -1, stLine: 1550, stSlopeUp: false, stSlopeDn: false,
      stHold: hold,
      e21: 2550, e200: 2100, emaDepth: 3, emaStructure: 0.1, emaMomentum: 0.2,
      atr14: 400, rsi: 45, phaseOsc: 10,
    };
    const data = assembleTickerData("ETHUSD", { M: b, D: b });
    expect(data.tf_tech.D.stLine).toBe(1550);
    expect(data.tf_tech.D.stHold).toEqual(compactStHold(hold));
    expect(data.monthly_bundle.st_hold.held).toBe(true);
    expect(data.monthly_bundle.st_hold.line).toBe(1550);
    expect(data.flags.st_hold_M).toBe(true);
    expect(data.flags.st_hold_D).toBe(true);
    expect(data.st_hold_setup?.best?.held).toBe(true);
  });

  it("sets st_hold flags from bundles", () => {
    const flags = detectFlags({
      M: { stHold: { held: true, kind: "st_hold" } },
      W: { stHold: { held: false, kind: "st_flip_extended" } },
      D: { stHold: { held: true, kind: "st_flip_retest" } },
      240: { stHold: { held: true, kind: "st_hold" } },
    });
    expect(flags.st_hold_M).toBe(true);
    expect(flags.st_hold_W).toBeUndefined();
    expect(flags.st_hold_D).toBe(true);
    expect(flags.st_hold_4h).toBe(true);
    expect(flags.st_hold).toBe(true);
    expect(flags.st_flip_extended).toBe(true);
  });
});

function confluenceLongBase(overrides = {}) {
  return {
    ticker: "ETHUSD",
    price: 2321,
    _strategy_stance: { stance: "overweight", multiplier: 1.25, tier: "core" },
    rs: { rsRank: 82 },
    ichimoku_d: { position: "above", tkBull: true, cloudBullish: true },
    ema_regime_daily: 2,
    regime_forecast: { p_1d: { HTF_BULL_LTF_BULL: 0.62, HTF_BULL_LTF_PULLBACK: 0.18 } },
    fvg_D: { activeBull: 4, activeBear: 0, inBullGap: true },
    saty_phase_pct: 0.55,
    atr_levels: { anchor: 2200, levels: { "+38.2%": 2600, "-38.2%": 2000 } },
    td_sequential: {
      per_tf: {
        M: {
          td9_bullish: true,
          last_td9_bullish_bars_ago: 0,
          last_td13_bullish_bars_ago: 2,
        },
        D: { td9_bullish: true },
      },
    },
    tf_tech: {
      D: {
        ew: { dir: 1, fiboMatch: 1.618, detected: true },
        fvg: { activeBull: 4, activeBear: 0, inBullGap: true },
        pdz: { zone: "discount" },
        sma200: 2000,
        sq: { r: 1 },
        ema: { ema21: 2550 },
        stDir: -1,
        stSlope: 0,
        ripster: { c72_89: { above: true } },
        stLine: 1550,
        stHold: compactStHold({
          kind: "st_hold", side: 1, held: true, quality: "base",
          stLine: 1550, ema21: 2550, distEma21Atr: 0.57,
        }),
      },
      "4H": { fvg: { activeBull: 2, activeBear: 0 } },
      "1H": {},
    },
    st_hold_setup: {
      best: {
        kind: "st_hold", side: 1, sideLabel: "LONG", held: true,
        quality: "base", stLine: 1550, tf: "M", ema21: 2550,
        distEma21Atr: 0.57, recentlyFlat: true,
      },
      td13_then_9: { tf: "M", side: "LONG", td13_bars_ago: 2, td9_bars_ago: 0 },
    },
    ...overrides,
  };
}

describe("scoreRootConfluence ST hold gate", () => {
  it("treats a held flat SuperTrend as ignition (RIDE), not a wait", () => {
    const c = scoreRootConfluence(confluenceLongBase());
    expect(c.layers_agreeing).toBeGreaterThanOrEqual(6);
    expect(c.mode).toBe("RIDE");
    expect(c.side).toBe("LONG");
    expect(c.st_hold?.held).toBe(true);
    expect(c.actionable_summary).toMatch(/ST hold/i);
    expect(holdAgreesWithSide(c.st_hold, "LONG")).toBe(true);
  });

  it("stays READY on a stretched flip even when slope agrees", () => {
    const c = scoreRootConfluence(confluenceLongBase({
      tf_tech: {
        D: {
          ew: { dir: 1, fiboMatch: 1.618, detected: true },
          fvg: { activeBull: 4, activeBear: 0, inBullGap: true },
          pdz: { zone: "discount" },
          sma200: 2000,
          sq: { r: 1 },
          ema: { ema21: 2550 },
          stDir: -1,
          stSlope: 1,
          ripster: { c72_89: { above: true } },
        },
        "4H": { stDir: -1, stSlope: 1, fvg: { activeBull: 2, activeBear: 0 } },
        "1H": { stDir: -1, stSlope: 1 },
      },
      st_hold_setup: {
        best: {
          kind: "st_flip_extended", side: 1, sideLabel: "LONG", held: false,
          quality: "low", stLine: 3100, tf: "D", ema21: 2550, distEma21Atr: 2.4,
        },
      },
    }));
    expect(c.layers_agreeing).toBeGreaterThanOrEqual(6);
    expect(c.supertrend_trigger.triggered).toBe(true);
    expect(c.mode).toBe("READY");
    expect(isFlipExtendedChase(c.st_hold, "LONG")).toBe(true);
    expect(c.actionable_summary).toMatch(/retest/i);
  });

  it("keeps READY when confluence is high and ST is flat with no hold", () => {
    const c = scoreRootConfluence(confluenceLongBase({
      st_hold_setup: null,
      tf_tech: {
        D: {
          ew: { dir: 1, fiboMatch: 1.618, detected: true },
          fvg: { activeBull: 4, activeBear: 0, inBullGap: true },
          pdz: { zone: "discount" },
          sma200: 2000,
          sq: { r: 1 },
          ema: { ema21: 2550 },
          stDir: -1,
          stSlope: 0,
          ripster: { c72_89: { above: true } },
        },
        "4H": { fvg: { activeBull: 2, activeBear: 0 } },
        "1H": {},
      },
    }));
    expect(c.layers_agreeing).toBeGreaterThanOrEqual(6);
    expect(c.mode).toBe("READY");
  });
});
