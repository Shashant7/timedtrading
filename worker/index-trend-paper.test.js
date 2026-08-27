import { describe, it, expect } from "vitest";
import {
  buildIndexTrendSignalId,
  classifyIndexTrendPaperEvent,
  computeUnderlyingR,
  defaultIndexTrendPaperShares,
} from "./index-trend-paper.js";

describe("index-trend-paper", () => {
  it("builds stable weekly signal ids", () => {
    const id = buildIndexTrendSignalId("SPY", "SPYU", "LONG", Date.UTC(2026, 7, 27));
    expect(id).toMatch(/^it:SPY:SPYU:LONG:2026-W\d+$/);
  });

  it("computes underlying R-multiples", () => {
    const r = computeUnderlyingR({
      direction: "LONG",
      entryUnderlying: 640,
      stopUnderlying: 628,
      currentUnderlying: 652,
    });
    expect(r).toBeGreaterThan(0.9);
    expect(r).toBeLessThan(1.1);
  });

  it("opens a BUY on flat book during RTH", () => {
    // Wednesday 2026-08-26 15:00 ET ≈ 19:00 UTC — RTH open
    const now = Date.UTC(2026, 7, 26, 19, 0, 0);
    const d = classifyIndexTrendPaperEvent({
      book: null,
      letfPrice: 120,
      underlyingPrice: 640,
      management: { stop_underlying: 628, target_underlying: 660 },
      direction: "LONG",
      activate: true,
      now,
      shares: 10,
    });
    expect(d.event).toBe("BUY");
    expect(d.nextBook?.shares).toBe(10);
  });

  it("trims at +1R", () => {
    const book = {
      status: "open",
      direction: "LONG",
      entry_underlying_price: 640,
      entry_letf_price: 120,
      stop_underlying: 628,
      shares: 8,
      shares_remaining: 8,
      trims_fired: [],
    };
    const d = classifyIndexTrendPaperEvent({
      book,
      letfPrice: 125,
      underlyingPrice: 652,
      management: {
        stop_underlying: 628,
        trim_ladder: [
          { at_r: 1, size: 0.25, label: "Trim 25% at +1R" },
          { at_r: 2, size: 0.25, label: "Trim 25% at +2R" },
        ],
      },
      direction: "LONG",
      activate: false,
      now: Date.UTC(2026, 7, 26, 19, 30, 0),
    });
    expect(d.event).toBe("TRIM");
    expect(d.trim_sell_qty).toBe(2);
    expect(d.nextBook?.trims_fired).toContain(1);
  });

  it("stops on underlying invalidation", () => {
    const book = {
      status: "open",
      direction: "LONG",
      entry_underlying_price: 640,
      entry_letf_price: 120,
      stop_underlying: 628,
      shares: 5,
      shares_remaining: 5,
      trims_fired: [],
    };
    const d = classifyIndexTrendPaperEvent({
      book,
      letfPrice: 110,
      underlyingPrice: 627,
      management: { stop_underlying: 628 },
      direction: "LONG",
      activate: false,
      now: Date.UTC(2026, 7, 26, 19, 30, 0),
    });
    expect(d.event).toBe("STOP");
    expect(d.reason).toBe("underlying_invalidation");
  });

  it("sizes default paper shares from budget", () => {
    expect(defaultIndexTrendPaperShares(100, 2000)).toBe(20);
    expect(defaultIndexTrendPaperShares(0)).toBe(1);
  });
});
