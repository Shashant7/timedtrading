import { describe, it, expect } from "vitest";
import { overlayBrokerPositionMarks, summarizeBrokerAccountMarks } from "./broker-positions-enrich.js";

describe("overlayBrokerPositionMarks", () => {
  it("keeps Webull last_price and unrealized_pnl even when TD is allowed", () => {
    const it = overlayBrokerPositionMarks({
      ticker: "AXON",
      broker_qty: 2,
      avg_cost: 100,
      last_price: 110,
      price: 110,
      market_value: 220,
      unrealized_pnl: 17.5,
      unrealized_pnl_pct: 8.75,
      day_pnl: 1.2,
    }, {
      pricesAllowed: true,
      tdRow: { p: 999, pc: 100, dc: 0, dp: 0 },
    });
    expect(it.price).toBe(110);
    expect(it.last_price).toBe(110);
    expect(it.unrealized_pnl).toBe(17.5);
    expect(it.unrealized_pnl_pct).toBe(8.75);
    expect(it.day_pnl).toBe(1.2);
    expect(it.day_pnl_source).toBe("broker");
    expect(it.prev_close).toBe(100);
    expect(it.day_change).toBe(0);
  });

  it("does not invent today's P&L from a zeroed TwelveData dc", () => {
    const it = overlayBrokerPositionMarks({
      ticker: "AAPL",
      broker_qty: 10,
      avg_cost: 190,
      last_price: 195,
      unrealized_pnl: 50,
    }, {
      pricesAllowed: true,
      tdRow: { p: 195, pc: 195, dc: 0, dp: 0 },
    });
    expect(it.unrealized_pnl).toBe(50);
    expect(it.day_pnl).toBeUndefined();
    expect(it.day_pnl_source).toBeUndefined();
  });

  it("fills price from TD only when the broker sent none", () => {
    const it = overlayBrokerPositionMarks({
      ticker: "MSFT",
      broker_qty: 1,
      avg_cost: 400,
    }, {
      pricesAllowed: true,
      tdRow: { p: 420, pc: 410, dc: 10, dp: 2.44 },
    });
    expect(it.price).toBe(420);
    expect(it.day_pnl).toBe(10);
    expect(it.day_pnl_source).toBe("td");
    expect(it.unrealized_pnl).toBe(20);
    expect(it.unrealized_pnl_source).toBe("computed");
  });

  it("keeps broker marks when licensed prices are gated", () => {
    const it = overlayBrokerPositionMarks({
      ticker: "NVDA",
      broker_qty: 3,
      last_price: 130,
      unrealized_pnl: -4,
      day_pnl: 0.5,
    }, { pricesAllowed: false, tdRow: { p: 999, dc: 5 } });
    expect(it.price).toBe(130);
    expect(it.unrealized_pnl).toBe(-4);
    expect(it.day_pnl).toBe(0.5);
    expect(it.day_change).toBeUndefined();
  });
});

describe("summarizeBrokerAccountMarks", () => {
  it("sums native open P&L without requiring day P&L", () => {
    const s = summarizeBrokerAccountMarks([
      { broker_qty: 2, market_value: 220, unrealized_pnl: 17.5, last_price: 110 },
      { broker_qty: 0, unrealized_pnl: 99 },
    ]);
    expect(s.positions_value).toBe(220);
    expect(s.unrealized_pnl).toBe(17.5);
    expect(s.has_open_pnl).toBe(true);
    expect(s.has_day_pnl).toBe(false);
    expect(s.day_pnl).toBeNull();
  });
});
