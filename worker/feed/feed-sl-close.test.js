import { describe, it, expect } from "vitest";
import {
  buildTickerDataFromFeedSnap,
  detectFeedSlBreaches,
} from "./feed-sl-close.js";

describe("detectFeedSlBreaches", () => {
  const nvdaTrade = {
    ticker: "NVDA",
    direction: "LONG",
    status: "OPEN",
    entryPrice: 209.9,
    pnlPct: -4.13,
    history: [{ type: "ENTRY", sl_price: 198.81 }],
  };

  it("detects LONG breach when feed price is below published SL", () => {
    const prices = {
      NVDA: { p: 193.13, pc: 197.58, dc: -4.45, dp: -2.25 },
    };
    const breaches = detectFeedSlBreaches([nvdaTrade], prices, true);
    expect(breaches).toHaveLength(1);
    expect(breaches[0].sym).toBe("NVDA");
    expect(breaches[0].sl).toBeCloseTo(198.81, 2);
    expect(breaches[0].checkPx).toBeLessThanOrEqual(198.81);
  });

  it("does not flag when feed price is above SL", () => {
    const prices = { NVDA: { p: 205.5, pc: 197.58 } };
    const breaches = detectFeedSlBreaches([nvdaTrade], prices, true);
    expect(breaches).toHaveLength(0);
  });

  it("reads SL from entry history when trade.sl is null (production NVDA shape)", () => {
    const trade = { ...nvdaTrade, sl: null, stop_loss: null };
    const prices = { NVDA: { p: 193.13, pc: 197.58 } };
    const breaches = detectFeedSlBreaches([trade], prices, true);
    expect(breaches).toHaveLength(1);
    expect(breaches[0].sl).toBeCloseTo(198.81, 2);
  });

  it("uses PnL-implied price when feed alone would miss breach", () => {
    const trade = {
      ticker: "NVDA",
      direction: "LONG",
      status: "OPEN",
      entryPrice: 209.9,
      pnlPct: -8.0,
      sl: 198.81,
    };
    // Headline feed still above SL but loss implies worse print
    const prices = { NVDA: { p: 200.2, pc: 197.58 } };
    const breaches = detectFeedSlBreaches([trade], prices, true);
    expect(breaches).toHaveLength(1);
    expect(breaches[0].checkPx).toBeLessThan(198.81);
  });

  it("detects SHORT breach when feed price is above SL", () => {
    const trade = {
      ticker: "TSLA",
      direction: "SHORT",
      status: "OPEN",
      sl: 400,
    };
    const prices = { TSLA: { p: 410, pc: 425 } };
    const breaches = detectFeedSlBreaches([trade], prices, true);
    expect(breaches).toHaveLength(1);
    expect(breaches[0].direction).toBe("SHORT");
  });
});

describe("buildTickerDataFromFeedSnap", () => {
  it("sets close outside RTH for headline price helpers", () => {
    const obj = buildTickerDataFromFeedSnap("NVDA", { p: 193.13, pc: 197.58 }, false);
    expect(obj.close).toBeCloseTo(193.13, 2);
    expect(obj._live_price).toBeCloseTo(193.13, 2);
  });
});
