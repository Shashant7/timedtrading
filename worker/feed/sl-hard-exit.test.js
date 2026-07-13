import { describe, it, expect } from "vitest";
import {
  applySlHardExitSafetyNet,
  collectStopCheckPriceCandidates,
  ensurePublishedStopOnContext,
  isStopLossBreached,
  mergeFreshQuoteIntoTickerData,
  resolvePriceForStopCheck,
  resolvePublishedStopLoss,
  resolveAuthoritativeEntryPrice,
  entryPriceSourcesDiverge,
  shouldDeferFeedSlOutsideRth,
  shouldRefreshQuoteForStopCheck,
  shouldRefreshQuoteForTradeMgmt,
  priceDivergencePct,
  evaluateSlCloseFreshQuote,
} from "./sl-hard-exit.js";

describe("resolveAuthoritativeEntryPrice", () => {
  it("prefers D1 position VWAP over stale KV trade entry", () => {
    const px = resolveAuthoritativeEntryPrice(
      { entryPrice: 83.39 },
      { avg_entry_price: 80.34 },
    );
    expect(px).toBeCloseTo(80.34, 2);
  });
});

describe("entryPriceSourcesDiverge", () => {
  it("flags KO-class trim drift between KV and D1", () => {
    expect(entryPriceSourcesDiverge(
      { entryPrice: 83.39 },
      { avg_entry_price: 80.34 },
    )).toBe(true);
  });
});

describe("shouldDeferFeedSlOutsideRth", () => {
  it("defers when only check price is past SL but feed is above stop", () => {
    const r = shouldDeferFeedSlOutsideRth({
      marketOpen: false,
      direction: "LONG",
      checkPx: 81.20,
      feedPx: 81.55,
      sl: 81.50,
      entryPx: 80.34,
      pnlPct: -2.39,
    });
    expect(r.defer).toBe(true);
    expect(r.reason).toBe("pnl_implied_only_outside_rth");
  });

  it("allows material feed breach outside RTH", () => {
    const r = shouldDeferFeedSlOutsideRth({
      marketOpen: false,
      direction: "LONG",
      checkPx: 80.50,
      feedPx: 80.50,
      sl: 82.00,
      entryPx: 83.39,
    });
    expect(r.defer).toBe(false);
    expect(r.reason).toBe("material_feed_breach");
  });
});

describe("collectStopCheckPriceCandidates", () => {
  it("skips PnL-implied marks when KV entry diverges from D1 VWAP", () => {
    const cands = collectStopCheckPriceCandidates(
      {},
      81.40,
      { direction: "LONG", entryPrice: 83.39, pnlPct: -2.39 },
      { avg_entry_price: 80.34 },
    );
    expect(cands).toEqual([81.40]);
  });
});

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

describe("shouldRefreshQuoteForTradeMgmt", () => {
  it("requests refresh when scoring bundle diverges from timed:prices feed", () => {
    const reason = shouldRefreshQuoteForTradeMgmt({
      bundlePx: 1078.48,
      pfPx: 1045.17,
      pfTickFresh: true,
      pxNow: 1045.17,
    });
    expect(reason).toBe("bundle_vs_feed");
  });

  it("requests refresh when pxNow jumps away from a recent exit advisory", () => {
    const reason = shouldRefreshQuoteForTradeMgmt({
      bundlePx: 1078.48,
      pfPx: 1078.48,
      pfTickFresh: true,
      pxNow: 1078.48,
      recentAdvisoryPx: 1045.17,
    });
    expect(reason).toBe("px_vs_recent_advisory");
  });

  it("returns null when sources agree within tolerance", () => {
    const reason = shouldRefreshQuoteForTradeMgmt({
      bundlePx: 1045.17,
      pfPx: 1046.0,
      pfTickFresh: true,
      pxNow: 1045.17,
      recentAdvisoryPx: 1045.17,
    });
    expect(reason).toBeNull();
  });
});

describe("priceDivergencePct", () => {
  it("measures percent gap between two positive prices", () => {
    expect(priceDivergencePct(1078.48, 1045.17)).toBeCloseTo(3.19, 1);
  });
});

describe("evaluateSlCloseFreshQuote", () => {
  it("defers SL close when fresh quote is above stop (GEV-class stale low)", () => {
    const r = evaluateSlCloseFreshQuote({
      direction: "LONG",
      sl: 1073.06,
      checkPx: 1042.0,
      freshPx: 1093.0,
    });
    expect(r.action).toBe("defer");
    expect(r.reason).toBe("fresh_quote_not_past_sl");
  });

  it("allows close when fresh quote confirms SL breach", () => {
    const r = evaluateSlCloseFreshQuote({
      direction: "LONG",
      sl: 1073.06,
      checkPx: 1042.0,
      freshPx: 1040.0,
    });
    expect(r.action).toBe("close");
    expect(r.freshPx).toBeCloseTo(1040.0, 2);
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
