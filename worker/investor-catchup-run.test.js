import { describe, it, expect } from "vitest";
import { planInvestorCatchupOps } from "./investor-catchup-run.js";

const baseLot = {
  id: "lot-CRDO-dca-1",
  position_id: "inv-CRDO-auto-1",
  ticker: "CRDO",
  action: "DCA_BUY",
  shares: 11.3,
  price: 177.04,
  ts: Date.UTC(2026, 6, 29, 20, 30, 0),
  reason: "dca_pullback",
};

describe("planInvestorCatchupOps", () => {
  it("plans a DCA when thesis/price intact and not yet mirrored", () => {
    const out = planInvestorCatchupOps({
      lots: [baseLot],
      ring: [],
      scores: { CRDO: { stage: "accumulate", score: 70 } },
      livePrices: { CRDO: 178 },
    });
    expect(out.planned).toHaveLength(1);
    expect(out.planned[0].kind).toBe("dca");
    expect(out.planned[0].ticker).toBe("CRDO");
    expect(out.skipped_gates).toHaveLength(0);
  });

  it("skips when bridge already has a successful order id", () => {
    const out = planInvestorCatchupOps({
      lots: [baseLot],
      ring: [{
        trade_id: "inv-CRDO-auto-1",
        side: "buy",
        status: "ok",
        broker_order_id: "wb-123",
      }],
      scores: { CRDO: { stage: "accumulate", score: 70 } },
      livePrices: { CRDO: 178 },
    });
    expect(out.planned).toHaveLength(0);
  });

  it("does not treat dedupe_skip (ok, null order id) as mirrored", () => {
    const out = planInvestorCatchupOps({
      lots: [baseLot],
      ring: [{
        trade_id: "inv-CRDO-auto-1",
        side: "buy",
        status: "ok",
        broker_order_id: null,
      }],
      scores: { CRDO: { stage: "accumulate", score: 70 } },
      livePrices: { CRDO: 178 },
    });
    expect(out.planned).toHaveLength(1);
  });

  it("gates buys that chased above max drift", () => {
    const out = planInvestorCatchupOps({
      lots: [baseLot],
      ring: [],
      scores: { CRDO: { stage: "accumulate", score: 70 } },
      livePrices: { CRDO: 200 },
      maxBuyDriftPct: 5,
    });
    expect(out.planned).toHaveLength(0);
    expect(out.skipped_gates[0].skip_reason).toBe("price_drift_above");
  });

  it("always plans sells even when stage is reduce", () => {
    const sell = {
      ...baseLot,
      id: "lot-CRDO-sell-1",
      action: "SELL",
      reason: "PRE_EARNINGS_RISK_REDUCTION",
      shares: 2,
    };
    const out = planInvestorCatchupOps({
      lots: [sell],
      ring: [],
      scores: { CRDO: { stage: "reduce", score: 20 } },
      livePrices: { CRDO: 190 },
    });
    expect(out.planned).toHaveLength(1);
    expect(out.planned[0].kind).toBe("trim");
  });

  it("skipBuys defers DCA/add until RTH (Webull fractional)", () => {
    const out = planInvestorCatchupOps({
      lots: [baseLot],
      ring: [],
      scores: { CRDO: { stage: "accumulate", score: 70 } },
      livePrices: { CRDO: 178 },
      skipBuys: true,
    });
    expect(out.planned).toHaveLength(0);
    expect(out.skipped_gates[0].skip_reason).toBe("rth_closed_buy");
  });

  it("dedupes twin lots on the same position/action/day", () => {
    const twin = {
      ...baseLot,
      id: "lot-CRDO-dca-2",
      ts: baseLot.ts + 300,
    };
    const out = planInvestorCatchupOps({
      lots: [baseLot, twin],
      ring: [],
      scores: { CRDO: { stage: "accumulate", score: 70 } },
      livePrices: { CRDO: 178 },
    });
    expect(out.planned).toHaveLength(1);
    expect(out.planned[0].lot_id).toBe(baseLot.id);
  });
});
