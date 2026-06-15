import { describe, it, expect } from "vitest";
import {
  cycleFromRegime, indexCyclesFromRegimes, breadthAwareMarketCycle,
  resolveTickerCycle, pearson, logReturnsByTs, bestIndexForTicker, CYCLE_INDEXES,
} from "./market-regime-index.js";

describe("cycleFromRegime (replay-parity formula)", () => {
  it("uptrend when ema_regime_daily >= 2", () => {
    expect(cycleFromRegime(2, 5)).toBe("uptrend");   // SPY today: edr=2, htf weak
    expect(cycleFromRegime(2, -100)).toBe("uptrend"); // edr dominates the OR
  });
  it("uptrend when htf >= 15 even if edr < 2", () => {
    expect(cycleFromRegime(1, 16)).toBe("uptrend");
  });
  it("downtrend at edr<=-2 or htf<=-15", () => {
    expect(cycleFromRegime(-2, 0)).toBe("downtrend");
    expect(cycleFromRegime(0, -20)).toBe("downtrend");
  });
  it("transitional in the middle", () => {
    expect(cycleFromRegime(1, 5)).toBe("transitional");
    expect(cycleFromRegime(-1, -5)).toBe("transitional");
  });
  it("null when no usable input", () => {
    expect(cycleFromRegime(null, null)).toBe(null);
    expect(cycleFromRegime(undefined, "x")).toBe(null);
  });
});

describe("indexCyclesFromRegimes", () => {
  it("maps the live snapshot (SPY/QQQ transitional-ish but edr=2 -> uptrend; IWM/DIA strong)", () => {
    const cycles = indexCyclesFromRegimes({
      SPY: { ema_regime_daily: 2, htf_score: 5.2 },
      QQQ: { ema_regime_daily: 2, htf_score: 15.3 },
      IWM: { ema_regime_daily: 2, htf_score: 38.9 },
      DIA: { ema_regime_daily: 2, htf_score: 34.1 },
      RSP: { ema_regime_daily: 2, htf_score: 41.7 },
    });
    expect(cycles).toEqual({ SPY: "uptrend", QQQ: "uptrend", IWM: "uptrend", DIA: "uptrend", RSP: "uptrend" });
  });
  it("skips indices with no data", () => {
    const c = indexCyclesFromRegimes({ SPY: { ema_regime_daily: 2, htf_score: 5 } });
    expect(Object.keys(c)).toEqual(["SPY"]);
  });
});

describe("breadthAwareMarketCycle", () => {
  it("breadth outvotes a lagging SPY (3 uptrend indices beat SPY transitional)", () => {
    const c = breadthAwareMarketCycle({ SPY: "transitional", QQQ: "transitional", IWM: "uptrend", DIA: "uptrend", RSP: "uptrend" });
    expect(c).toBe("uptrend"); // 3*+1 > SPY 0 + QQQ 0
  });
  it("SPY weight matters on a thin read (SPY uptrend alone)", () => {
    expect(breadthAwareMarketCycle({ SPY: "uptrend" })).toBe("uptrend");
  });
  it("downtrend when the weight is net negative", () => {
    expect(breadthAwareMarketCycle({ SPY: "downtrend", IWM: "downtrend", DIA: "transitional" })).toBe("downtrend");
  });
  it("null with no data", () => {
    expect(breadthAwareMarketCycle({})).toBe(null);
  });
});

describe("resolveTickerCycle (per-index mapping)", () => {
  const cycles = { SPY: "transitional", QQQ: "transitional", IWM: "uptrend", DIA: "uptrend" };
  it("uses the home index's cycle (CAT->IWM uptrend, not SPY transitional)", () => {
    const r = resolveTickerCycle("CAT", { CAT: "IWM" }, cycles, "transitional");
    expect(r.cycle).toBe("uptrend");
    expect(r.index).toBe("IWM");
    expect(r.source).toBe("home_index");
  });
  it("falls back to the breadth composite when unmapped", () => {
    const r = resolveTickerCycle("FOO", {}, cycles, "uptrend");
    expect(r.cycle).toBe("uptrend");
    expect(r.source).toBe("breadth_fallback");
  });
  it("falls back when the mapped index has no cycle", () => {
    const r = resolveTickerCycle("X", { X: "RSP" }, cycles, "transitional");
    expect(r.index).toBe(null);
    expect(r.cycle).toBe("transitional");
  });
});

describe("bestIndexForTicker (trailing-beta map)", () => {
  it("picks the index with the highest correlation when it beats SPY by the edge", () => {
    // ticker tracks IWM tightly, SPY loosely
    const ts = Array.from({ length: 40 }, (_, i) => i);
    const iwm = {}; const spy = {}; const tk = {};
    for (const t of ts) { const x = Math.sin(t); iwm[t] = x; tk[t] = x + (Math.random() - 0.5) * 0.05; spy[t] = Math.sin(t / 3); }
    const r = bestIndexForTicker(tk, { SPY: spy, IWM: iwm });
    expect(r.index).toBe("IWM");
  });
  it("defaults to SPY when nothing clears the edge over SPY", () => {
    const ts = Array.from({ length: 40 }, (_, i) => i);
    const spy = {}; const iwm = {}; const tk = {};
    for (const t of ts) { const x = Math.sin(t); spy[t] = x; tk[t] = x; iwm[t] = x; } // equally correlated
    const r = bestIndexForTicker(tk, { SPY: spy, IWM: iwm });
    expect(r.index).toBe("SPY");
  });
  it("defaults to SPY on insufficient data", () => {
    expect(bestIndexForTicker({ 1: 0.1, 2: 0.2 }, { SPY: { 1: 0.1 } }).index).toBe("SPY");
  });
});

describe("logReturnsByTs + pearson", () => {
  it("computes log returns keyed by ts", () => {
    const r = logReturnsByTs([[1, 100], [2, 110], [3, 99]]);
    expect(Object.keys(r)).toEqual(["2", "3"]);
    expect(r[2]).toBeCloseTo(Math.log(110 / 100), 6);
  });
  it("pearson is 1 for identical series", () => {
    const xs = Array.from({ length: 30 }, (_, i) => i + Math.sin(i));
    expect(pearson(xs, xs)).toBeCloseTo(1, 6);
  });
  it("pearson null on too-few points", () => {
    expect(pearson([1, 2, 3], [1, 2, 3])).toBe(null);
  });
});

describe("CYCLE_INDEXES", () => {
  it("covers the four majors + equal-weight breadth", () => {
    expect(CYCLE_INDEXES).toEqual(["SPY", "QQQ", "IWM", "DIA", "RSP"]);
  });
});
