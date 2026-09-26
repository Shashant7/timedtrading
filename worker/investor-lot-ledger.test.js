import { describe, it, expect } from "vitest";
import {
  replayInvestorLots,
  investorTrimSnapshot,
  fetchInvestorLotsForPositions,
  replayInvestorLotsByPosition,
  INVESTOR_LOT_IN_CHUNK,
  D1_MAX_BOUND_PARAMS,
} from "./investor-lot-ledger.js";

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

describe("fetchInvestorLotsForPositions", () => {
  it("chunks IN lists under the D1 100-bind cap", async () => {
    const binds = [];
    const db = {
      prepare(sql) {
        return {
          bind(...args) {
            binds.push({ sql, n: args.length, args });
            return {
              async all() {
                return { results: args.map((id, i) => ({
                  id: `lot-${id}`,
                  position_id: id,
                  action: "BUY",
                  shares: 1,
                  price: 10,
                  value: 10,
                  ts: i + 1,
                })) };
              },
            };
          },
        };
      },
    };
    // 161 ids is the live Long Term book size that previously blew the cap.
    const ids = Array.from({ length: 161 }, (_, i) => `inv-pos-${i}`);
    const rows = await fetchInvestorLotsForPositions(db, ids);
    expect(rows.length).toBe(161);
    expect(binds.length).toBe(Math.ceil(161 / INVESTOR_LOT_IN_CHUNK));
    for (const b of binds) {
      expect(b.n).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS - 1);
      expect(b.n).toBeLessThanOrEqual(INVESTOR_LOT_IN_CHUNK);
    }
  });

  it("replayInvestorLotsByPosition groups sells with cost basis", () => {
    const lots = [
      { id: "b1", position_id: "p1", action: "BUY", shares: 10, price: 100, value: 1000, ts: 1 },
      { id: "s1", position_id: "p1", action: "SELL", shares: 4, price: 125, value: 500, ts: 2 },
      { id: "b2", position_id: "p2", action: "BUY", shares: 2, price: 50, value: 100, ts: 1 },
    ];
    const by = replayInvestorLotsByPosition(lots);
    expect(by.p1.byLotId.get("s1").realizedPnl).toBeCloseTo(100, 6);
    expect(by.p2.totalShares).toBeCloseTo(2, 6);
  });
});
