import { describe, it, expect } from "vitest";
import {
  buildIndexTrendSignalId,
  buildIndexTrendSignalEmbed,
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
    expect(d.nextBook?.needs_wait).toBe(true);
    expect(d.nextBook?.shares_remaining).toBe(0);
  });

  it("does not re-BUY the same weekly play after trail_giveback EXIT", () => {
    const book = {
      status: "trimmed",
      direction: "LONG",
      entry_underlying_price: 640,
      entry_letf_price: 34.9,
      stop_underlying: 628,
      shares: 32,
      shares_remaining: 32,
      trims_fired: [1, 2],
      peak_underlying_r: 3.0,
    };
    const now = Date.UTC(2026, 7, 27, 18, 30, 0); // 2:30 PM ET
    const mgmt = {
      stop_underlying: 628,
      target_underlying: 680,
      trim_ladder: [
        { at_r: 1, size: 0.25 },
        { at_r: 2, size: 0.25 },
        { trail_remainder: true },
      ],
    };
    // peak 3R, floor 1.8R; 640+12*1.5=658 → 1.5R giveback.
    const exit = classifyIndexTrendPaperEvent({
      book,
      letfPrice: 35.63,
      underlyingPrice: 658,
      management: mgmt,
      direction: "LONG",
      activate: true,
      now,
    });
    expect(exit.event).toBe("EXIT");
    expect(exit.reason).toBe("trail_giveback");
    expect(exit.nextBook?.status).toBe("closed");
    expect(exit.nextBook?.needs_wait).toBe(true);
    expect(exit.nextBook?.shares_remaining).toBe(0);

    const again = classifyIndexTrendPaperEvent({
      book: exit.nextBook,
      letfPrice: 35.55,
      underlyingPrice: 769.60,
      management: mgmt,
      direction: "LONG",
      activate: true,
      now: now + 30 * 60 * 1000,
    });
    expect(again.event).toBeNull();
    expect(again.nextBook?.status).toBe("flat");
    expect(again.nextBook?.needs_wait).toBe(true);
  });

  it("EXIT embed does not claim original size as shares remaining", () => {
    const emb = buildIndexTrendSignalEmbed({
      event: "EXIT",
      underlying: "SPY",
      letfTicker: "SPYU",
      direction: "LONG",
      letfPrice: 35.55,
      underlyingPrice: 769.60,
      reason: "trail_giveback",
      book: {
        entry_letf_price: 34.9,
        shares: 32,
        shares_remaining: 0,
      },
    });
    const rem = (emb.fields || []).find((f) => f.name === "Shares remaining");
    expect(rem?.value).toMatch(/0/);
    expect(rem?.value).not.toBe("32");
    const summary = (emb.fields || []).find((f) => f.name === "Trade Summary");
    expect(summary?.value).toContain("Qty 32");
  });

  it("sizes default paper shares from budget", () => {
    expect(defaultIndexTrendPaperShares(100, 2000)).toBe(20);
    expect(defaultIndexTrendPaperShares(0)).toBe(1);
  });

  it("exit Discord embed includes Trade Summary with entry and PnL", () => {
    const emb = buildIndexTrendSignalEmbed({
      event: "EXIT",
      underlying: "SPY",
      letfTicker: "SPYU",
      direction: "LONG",
      letfPrice: 35.55,
      underlyingPrice: 770,
      reason: "target_deadline",
      book: {
        entry_letf_price: 34.5,
        shares_remaining: 43,
        stop_underlying: 764.77,
        target_underlying: 791.08,
      },
      management: { stop_underlying: 764.77, target_underlying: 791.08, exit_by: "Month-end" },
    });
    expect(emb.title).toMatch(/SHORT TERM · Exit: SPYU LONG/);
    expect(emb.title).toMatch(/\+/);
    const summary = (emb.fields || []).find((f) => f.name === "Trade Summary");
    expect(summary?.value).toContain("Entry $34.50");
    expect(summary?.value).toContain("Exit $35.55");
    expect(summary?.value).toMatch(/P&L \+/);
  });
});
