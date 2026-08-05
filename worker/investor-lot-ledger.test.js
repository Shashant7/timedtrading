import { describe, it, expect } from "vitest";
import { replayInvestorLots, investorTrimSnapshot } from "./investor-lot-ledger.js";

describe("replayInvestorLots", () => {
  it("uses proportional cost removal on SELL (not sell proceeds)", () => {
    const lots = [
      { id: "b1", action: "BUY", shares: 10, price: 100, value: 1000, ts: 1 },
      { id: "s1", action: "SELL", shares: 5, price: 110, value: 550, ts: 2 },
    ];
    const r = replayInvestorLots(lots);
    expect(r.totalShares).toBeCloseTo(5, 6);
    expect(r.costBasis).toBeCloseTo(500, 6);
    expect(r.avgEntry).toBeCloseTo(100, 6);
    const buy = r.byLotId.get("b1");
    expect(buy.heldAfter).toBeCloseTo(10, 6);
    const sell = r.byLotId.get("s1");
    expect(sell.realizedPnl).toBeCloseTo(50, 6);
    expect(sell.realizedPnlPct).toBeCloseTo(10, 6);
    expect(sell.heldAfter).toBeCloseTo(5, 6);
  });

  it("tracks running heldAfter across DCA + partial trims", () => {
    const lots = [
      { id: "b1", action: "BUY", shares: 38.06, price: 131.37, value: 5000, ts: 1 },
      { id: "s1", action: "SELL", shares: 1.9, price: 128, value: 243.2, ts: 2 },
      { id: "d1", action: "DCA_BUY", shares: 16.21, price: 123.41, value: 2000, ts: 3 },
      { id: "s2", action: "SELL", shares: 5.22, price: 126.55, value: 660.6, ts: 4 },
    ];
    const r = replayInvestorLots(lots);
    expect(r.byLotId.get("b1").heldAfter).toBeCloseTo(38.06, 4);
    expect(r.byLotId.get("s1").heldAfter).toBeCloseTo(36.16, 4);
    expect(r.byLotId.get("d1").heldAfter).toBeCloseTo(52.37, 4);
    expect(r.byLotId.get("s2").heldAfter).toBeCloseTo(47.15, 4);
    expect(r.totalShares).toBeCloseTo(47.15, 4);
  });

  it("matches IWM-style trim band (~few % not 110%)", () => {
    const lots = [
      { id: "b1", action: "BUY", shares: 1.0764, price: 295.58, value: 318.16, ts: 1 },
      { id: "s1", action: "SELL", shares: 1.1514, price: 295.59, value: 340.34, ts: 2 },
    ];
    const r = replayInvestorLots(lots);
    const sell = r.byLotId.get("s1");
    expect(sell.realizedPnlPct).toBeGreaterThan(-5);
    expect(sell.realizedPnlPct).toBeLessThan(5);
  });

  it("does not treat net cash deployed as remaining cost_basis", () => {
    const lots = [
      { id: "b1", action: "BUY", shares: 24.0736, price: 254, value: 6118.95, ts: 1 },
      { id: "s1", action: "SELL", shares: 18.5487, price: 288, value: 5345.98, ts: 2 },
    ];
    const r = replayInvestorLots(lots);
    expect(r.totalShares).toBeCloseTo(5.5249, 3);
    expect(r.costBasis).toBeCloseTo(1404.3, 0);
    expect(r.avgEntry).toBeCloseTo(254.2, 0);
    expect(r.costBasis).not.toBeCloseTo(772.97, 0);
  });
});

describe("investorTrimSnapshot", () => {
  it("preserves avg_entry on partial trim", () => {
    const s = investorTrimSnapshot(1000, 10, 3);
    expect(s.remaining).toBeCloseTo(7, 6);
    expect(s.newCost).toBeCloseTo(700, 6);
    expect(s.avgEntry).toBeCloseTo(100, 6);
  });
});
