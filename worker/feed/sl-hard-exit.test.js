import { describe, it, expect } from "vitest";
import {
  applySlHardExitSafetyNet,
  ensurePublishedStopOnContext,
  isStopLossBreached,
  resolvePriceForStopCheck,
  resolvePublishedStopLoss,
} from "./sl-hard-exit.js";

describe("resolvePublishedStopLoss", () => {
  it("falls back from empty positions SL to trade SL", () => {
    const sl = resolvePublishedStopLoss({ sl: null }, { sl: 198.81 });
    expect(sl).toBeCloseTo(198.81, 2);
  });

  it("reads sl_price from entry history", () => {
    const sl = resolvePublishedStopLoss(null, {
      history: [{ type: "ENTRY", sl_price: 198.81 }],
    });
    expect(sl).toBeCloseTo(198.81, 2);
  });
});

describe("resolvePriceForStopCheck", () => {
  it("uses extended print for LONG when market closed", () => {
    const px = resolvePriceForStopCheck(
      { _ah_price: 195.58, price: 197.2 },
      197.2,
      "LONG",
      false,
    );
    expect(px).toBeCloseTo(195.58, 2);
  });
});

describe("applySlHardExitSafetyNet", () => {
  it("forces hard close when past published SL even if lane is defend", () => {
    const r = applySlHardExitSafetyNet({
      openTrade: { direction: "LONG", status: "OPEN", sl: 198.81 },
      openPositionContext: { sl: 198.81 },
      direction: "LONG",
      pxNow: 197.2,
      exitReasonRaw: "doctrine_force_exit",
      fuseExitFired: true,
      tickerData: {
        __force_defend_stage: true,
        __defend_reason: "soft_fuse_deferred_cloud_expanding",
        _ah_price: 195.58,
      },
      marketOpen: false,
    });
    expect(r.slHardClose).toBe(true);
    expect(r.exitReasonRaw).toBe("sl_breached");
    expect(r.fuseExitFired).toBe(false);
    expect(r.tickerData.__force_defend_stage).toBe(false);
    expect(isStopLossBreached("LONG", r.slCheckPrice, 198.81)).toBe(true);
  });

  it("does not fire when price is above SL", () => {
    const r = applySlHardExitSafetyNet({
      openTrade: { direction: "LONG", status: "OPEN", sl: 198.81 },
      openPositionContext: { sl: 198.81 },
      direction: "LONG",
      pxNow: 201,
      exitReasonRaw: "hold",
      fuseExitFired: false,
      tickerData: {},
      marketOpen: true,
    });
    expect(r.slHardClose).toBe(false);
  });
});

describe("ensurePublishedStopOnContext", () => {
  it("backfills positions context SL from trade row", () => {
    const { openPositionContext, openTrade } = ensurePublishedStopOnContext(
      { status: "OPEN", direction: "LONG", sl: null },
      { direction: "LONG", sl: 198.81, entryPrice: 209.9 },
    );
    expect(openPositionContext.sl).toBeCloseTo(198.81, 2);
    expect(openTrade.sl).toBeCloseTo(198.81, 2);
  });
});
