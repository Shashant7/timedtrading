import { describe, it, expect } from "vitest";
import { computeRealizedFromLedger, ledgerRowSide } from "./bridge-notifications.js";

const DAY = 86_400_000;
const YESTERDAY = 1_700_000_000_000;
const TODAY = YESTERDAY + DAY;

describe("ledgerRowSide", () => {
  it("maps explicit sides and event types", () => {
    expect(ledgerRowSide({ side: "BUY" })).toBe("BUY");
    expect(ledgerRowSide({ side: "SELL" })).toBe("SELL");
    expect(ledgerRowSide({ side: "TRIM" })).toBe("SELL");
    expect(ledgerRowSide({ event_type: "ENTRY" })).toBe("BUY");
    expect(ledgerRowSide({ event_type: "EXIT" })).toBe("SELL");
  });

  it("returns null for a fill with no direction", () => {
    expect(ledgerRowSide({ event_type: "FILL" })).toBeNull();
  });
});

describe("computeRealizedFromLedger", () => {
  it("prices today's sell against the weighted-average cost of prior buys", () => {
    const r = computeRealizedFromLedger([
      { ts: YESTERDAY, ticker: "AAPL", side: "BUY", qty: 10, price: 100 },
      { ts: YESTERDAY, ticker: "AAPL", side: "BUY", qty: 10, price: 120 },
      { ts: TODAY, ticker: "AAPL", side: "SELL", qty: 10, price: 130 },
    ], { sinceMs: TODAY });

    // avg cost 110, sold 10 @ 130 -> +200
    expect(r.realized).toBeCloseTo(200, 2);
    expect(r.sell_count).toBe(1);
    expect(r.partial).toBe(false);
  });

  it("excludes sells that happened before today", () => {
    const r = computeRealizedFromLedger([
      { ts: YESTERDAY, ticker: "MSFT", side: "BUY", qty: 5, price: 200 },
      { ts: YESTERDAY, ticker: "MSFT", side: "SELL", qty: 5, price: 250 },
    ], { sinceMs: TODAY });

    expect(r.realized).toBe(0);
    expect(r.sell_count).toBe(0);
  });

  it("reports a loss as a negative number", () => {
    const r = computeRealizedFromLedger([
      { ts: YESTERDAY, ticker: "NVDA", side: "BUY", qty: 4, price: 500 },
      { ts: TODAY, ticker: "NVDA", side: "SELL", qty: 4, price: 450 },
    ], { sinceMs: TODAY });

    expect(r.realized).toBeCloseTo(-200, 2);
  });

  it("falls back to the live broker average cost for adopted positions", () => {
    const r = computeRealizedFromLedger([
      { ts: TODAY, ticker: "TSLA", side: "SELL", qty: 2, price: 300 },
    ], { sinceMs: TODAY, avgCostByTicker: { TSLA: 250 } });

    expect(r.realized).toBeCloseTo(100, 2);
    expect(r.partial).toBe(false);
    expect(r.estimated_sells).toBe(1);
  });

  // The ledger started mid-life, so a position can have some recorded buys and
  // still be larger than the walk ever saw. The book average must not be
  // stretched over shares it never covered.
  it("prices only the recorded shares at the book average when a sell exceeds it", () => {
    const r = computeRealizedFromLedger([
      { ts: YESTERDAY, ticker: "AMZN", side: "BUY", qty: 5, price: 100 },
      { ts: TODAY, ticker: "AMZN", side: "SELL", qty: 17, price: 120 },
    ], { sinceMs: TODAY, avgCostByTicker: { AMZN: 110 } });

    // 5 shares from the book at 100 (+100), 12 residual at the broker avg 110 (+120)
    expect(r.realized).toBeCloseTo(220, 2);
    expect(r.estimated_sells).toBe(1);
    expect(r.partial).toBe(false);
  });

  it("flags a sell as partial when the residual has no basis anywhere", () => {
    const r = computeRealizedFromLedger([
      { ts: YESTERDAY, ticker: "AMZN", side: "BUY", qty: 5, price: 100 },
      { ts: TODAY, ticker: "AMZN", side: "SELL", qty: 17, price: 120 },
    ], { sinceMs: TODAY });

    // Only the 5 recorded shares contribute; the other 12 are excluded, not guessed.
    expect(r.realized).toBeCloseTo(100, 2);
    expect(r.unattributed_sells).toBe(1);
    expect(r.partial).toBe(true);
  });

  it("does not stretch the book average over unrecorded shares", () => {
    const withBadBasis = (5 * 20) + (12 * 20); // what the old code produced
    const r = computeRealizedFromLedger([
      { ts: YESTERDAY, ticker: "AMZN", side: "BUY", qty: 5, price: 100 },
      { ts: TODAY, ticker: "AMZN", side: "SELL", qty: 17, price: 120 },
    ], { sinceMs: TODAY });

    expect(r.realized).not.toBeCloseTo(withBadBasis, 2);
  });

  it("flags the total as partial when a sell has no basis at all", () => {
    const r = computeRealizedFromLedger([
      { ts: TODAY, ticker: "AMD", side: "SELL", qty: 3, price: 150 },
    ], { sinceMs: TODAY });

    expect(r.realized).toBe(0);
    expect(r.sell_count).toBe(1);
    expect(r.unattributed_sells).toBe(1);
    expect(r.partial).toBe(true);
  });

  it("keeps the remaining basis intact after a partial sell", () => {
    const r = computeRealizedFromLedger([
      { ts: YESTERDAY, ticker: "GOOGL", side: "BUY", qty: 10, price: 100 },
      { ts: TODAY, ticker: "GOOGL", side: "SELL", qty: 4, price: 120 },
      { ts: TODAY + 1000, ticker: "GOOGL", side: "SELL", qty: 6, price: 110 },
    ], { sinceMs: TODAY });

    // 4 @ +20 = 80, then 6 @ +10 = 60
    expect(r.realized).toBeCloseTo(140, 2);
    expect(r.sell_count).toBe(2);
    expect(r.partial).toBe(false);
  });

  it("handles EXIT/ENTRY event types with no side column", () => {
    const r = computeRealizedFromLedger([
      { ts: YESTERDAY, ticker: "BA", event_type: "ENTRY", qty: 2, price: 200 },
      { ts: TODAY, ticker: "BA", event_type: "EXIT", qty: 2, price: 230 },
    ], { sinceMs: TODAY });

    expect(r.realized).toBeCloseTo(60, 2);
  });

  it("ignores malformed rows instead of throwing", () => {
    const r = computeRealizedFromLedger([
      { ts: TODAY, ticker: "", side: "SELL", qty: 1, price: 10 },
      { ts: TODAY, ticker: "X", side: "SELL", qty: 0, price: 10 },
      { ts: TODAY, ticker: "X", side: "SELL", qty: 1, price: 0 },
      null,
    ], { sinceMs: TODAY });

    expect(r.realized).toBe(0);
    expect(r.sell_count).toBe(0);
  });
});
