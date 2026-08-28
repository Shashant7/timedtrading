import { describe, it, expect } from "vitest";
import {
  priceMapFromTimedPrices,
  markTraderOpen,
  markInvestorOpen,
  assembleAccountSummary,
  combineAccountBooks,
  applyLiveMarkToEquityPoints,
} from "./account-summary.js";

describe("priceMapFromTimedPrices", () => {
  it("reads timed:prices short keys", () => {
    const map = priceMapFromTimedPrices({
      prices: { NVDA: { p: 180.5 }, AAPL: { price: 220 } },
    });
    expect(map.NVDA).toBe(180.5);
    expect(map.AAPL).toBe(220);
  });
});

describe("markTraderOpen", () => {
  it("includes leftover after trimmed_pct", () => {
    const m = markTraderOpen([
      { ticker: "NVDA", direction: "LONG", entry_price: 100, shares: 10, trimmed_pct: 0.5 },
    ], { NVDA: 120 });
    expect(m.openCount).toBe(1);
    expect(m.unrealized).toBe(100); // 5 shares * $20
    expect(m.markToMarket).toBe(600);
  });

  it("flips short P&L", () => {
    const m = markTraderOpen([
      { ticker: "QQQ", direction: "SHORT", entry_price: 500, shares: 2, trimmed_pct: 0 },
    ], { QQQ: 480 });
    expect(m.unrealized).toBe(40);
  });
});

describe("markInvestorOpen", () => {
  it("uses cost_basis vs live mark", () => {
    const m = markInvestorOpen([
      { ticker: "MSFT", total_shares: 20, cost_basis: 6000 },
    ], { MSFT: 400 });
    expect(m.openCount).toBe(1);
    expect(m.unrealized).toBe(2000);
    expect(m.markToMarket).toBe(8000);
  });
});

describe("assemble + combine", () => {
  it("NAV = start + realized + open", () => {
    const book = assembleAccountSummary({
      mode: "investor",
      startCash: 100000,
      cash: 20000,
      totalRealized: 1500,
      unrealized: 8500,
      costBasis: 80000,
      markToMarket: 88500,
      openCount: 12,
    });
    expect(book.accountValue).toBe(110000);
    expect(book.totalPnl).toBe(10000);
    expect(book.growthPct).toBe(10);
  });

  it("combined includes both books' open P&L", () => {
    const trader = assembleAccountSummary({
      mode: "trader", startCash: 100000, cash: 90000,
      totalRealized: -200, unrealized: 1200,
      costBasis: 10000, markToMarket: 11200, openCount: 3,
    });
    const investor = assembleAccountSummary({
      mode: "investor", startCash: 100000, cash: 10000,
      totalRealized: 4000, unrealized: 20000,
      costBasis: 90000, markToMarket: 110000, openCount: 18,
    });
    const c = combineAccountBooks(trader, investor);
    expect(c.unrealized).toBe(21200);
    expect(c.totalRealized).toBe(3800);
    expect(c.totalPnl).toBe(25000);
    expect(c.accountValue).toBe(225000);
    expect(c.openCount).toBe(21);
  });
});

describe("applyLiveMarkToEquityPoints", () => {
  it("replaces today's realized-only point with full NAV", () => {
    const points = [
      { date: "2026-08-26", equity: 108000, dayPnl: 200, dayTrades: 1, drawdownPct: 0 },
      { date: "2026-08-27", equity: 108200, dayPnl: 200, dayTrades: 2, drawdownPct: 0 },
    ];
    const live = {
      startCash: 100000,
      totalRealized: 8200,
      unrealized: 15000,
      cash: 12000,
      markToMarket: 103000,
      openCount: 14,
    };
    const out = applyLiveMarkToEquityPoints(points, live, "2026-08-27");
    expect(out).toHaveLength(2);
    expect(out[1].equity).toBe(123200);
    expect(out[1].live_mark).toBe(true);
    expect(out[1].openPositions).toBe(14);
    expect(out[1].dayPnl).toBe(200);
  });

  it("appends a live tip when the curve has no today row", () => {
    const points = [
      { date: "2026-08-26", equity: 108000, dayPnl: 0, dayTrades: 0, drawdownPct: 0 },
    ];
    const live = { startCash: 100000, totalRealized: 8000, unrealized: 5000, cash: 0, markToMarket: 0, openCount: 4 };
    const out = applyLiveMarkToEquityPoints(points, live, "2026-08-28");
    expect(out).toHaveLength(2);
    expect(out[1].date).toBe("2026-08-28");
    expect(out[1].equity).toBe(113000);
  });
});
