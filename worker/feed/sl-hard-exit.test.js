import { describe, it, expect } from "vitest";
import {
  applySlHardExitSafetyNet,
  collectStopCheckPriceCandidates,
  ensurePublishedStopOnContext,
  isStopLossBreached,
  mergeFreshQuoteIntoTickerData,
  resolvePriceForStopCheck,
  resolvePublishedStopLoss,
  shouldRefreshQuoteForStopCheck,
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

  it("uses worst-case print during RTH when headline lags (NVDA-class)", () => {
    const trade = { direction: "LONG", entryPrice: 209.9, pnlPct: -7.41 };
    const px = resolvePriceForStopCheck(
      { _ah_price: 200.2, __exit_meta: { pnl_pct: -7.41 } },
      200.2,
      "LONG",
      true,
      trade,
    );
    expect(px).toBeLessThan(198.81);
    expect(px).toBeCloseTo(194.35, 0);
  });
});

describe("shouldRefreshQuoteForStopCheck", () => {
  it("requests refresh when loss implies past SL but headline is above stop", () => {
    const need = shouldRefreshQuoteForStopCheck({
      direction: "LONG",
      sl: 198.81,
      checkPx: 200.2,
      entryPx: 209.9,
      pxNow: 200.2,
      doctrinePnlPct: -7.41,
      tickerData: { __exit_meta: { pnl_pct: -7.41 } },
      openTrade: { direction: "LONG", entryPrice: 209.9 },
    });
    expect(need).toBe(true);
  });
});

describe("applySlHardExitSafetyNet", () => {
  it("forces hard close when PnL-implied price is past SL with stale headline", () => {
    const r = applySlHardExitSafetyNet({
      openTrade: { direction: "LONG", status: "OPEN", sl: 198.81, entryPrice: 209.9, pnlPct: -7.41 },
      openPositionContext: { sl: 198.81 },
      direction: "LONG",
      pxNow: 200.2,
      exitReasonRaw: "doctrine_force_exit",
      fuseExitFired: true,
      tickerData: {
        __force_defend_stage: true,
        __defend_reason: "soft_fuse_deferred_cloud_expanding",
        _ah_price: 200.2,
        __exit_meta: { pnl_pct: -7.41 },
      },
      marketOpen: true,
    });
    expect(r.slHardClose).toBe(true);
    expect(r.exitReasonRaw).toBe("sl_breached");
    expect(r.slCheckPrice).toBeLessThan(198.81);
  });

  it("fires on actual market 194.27 with stale headline 200.2", () => {
    const r = applySlHardExitSafetyNet({
      openTrade: {
        direction: "LONG",
        status: "OPEN",
        history: [{ type: "ENTRY", sl_price: 198.81 }],
        entryPrice: 209.9,
      },
      openPositionContext: null,
      direction: "LONG",
      pxNow: 200.2,
      exitReasonRaw: "doctrine_force_exit",
      fuseExitFired: false,
      tickerData: { price: 194.27, _live_price: 194.27 },
      marketOpen: true,
    });
    expect(r.slHardClose).toBe(true);
    expect(r.slCheckPrice).toBeCloseTo(194.27, 2);
  });
});

describe("ensurePublishedStopOnContext", () => {
  it("backfills trade SL from entry history", () => {
    const { openTrade, slBackfilled } = ensurePublishedStopOnContext(
      null,
      { direction: "LONG", entryPrice: 209.9, history: [{ type: "ENTRY", sl_price: 198.81 }] },
    );
    expect(openTrade.sl).toBeCloseTo(198.81, 2);
    expect(slBackfilled).toBe(true);
  });
});
