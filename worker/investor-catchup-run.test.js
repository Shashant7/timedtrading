import { describe, it, expect } from "vitest";
import {
  planInvestorCatchupOps,
  suppressOffsettingCatchupBuys,
  ringSidesForLotAction,
} from "./investor-catchup-run.js";

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

  it("treats ring side=trim as mirrored for a SELL lot (CRS/CW/NVDA re-fire)", () => {
    const sell = {
      ...baseLot,
      id: "lot-CRS-sell-1",
      position_id: "inv-CRS-auto-1780326044329",
      ticker: "CRS",
      action: "SELL",
      reason: "PRE_FOMC_RISK_REDUCTION",
      shares: 0.5925,
    };
    const out = planInvestorCatchupOps({
      lots: [sell],
      ring: [{
        trade_id: "inv-CRS-auto-1780326044329",
        side: "trim",
        status: "ok",
        rh_order_id: "wb-trim-1",
      }],
      scores: { CRS: { stage: "reduce", score: 40 } },
      livePrices: { CRS: 500 },
    });
    expect(out.planned).toHaveLength(0);
    expect(ringSidesForLotAction("SELL")).toContain("trim");
  });

  it("defers DCA when an unmatched trim exists for the same trade (no buy+sell churn)", () => {
    const dca = {
      ...baseLot,
      id: "lot-CRS-dca",
      position_id: "inv-CRS-auto-1",
      ticker: "CRS",
      action: "DCA_BUY",
      shares: 3.44554,
      price: 500,
      reason: "dca_pullback",
    };
    const sell = {
      ...baseLot,
      id: "lot-CRS-sell",
      position_id: "inv-CRS-auto-1",
      ticker: "CRS",
      action: "SELL",
      shares: 0.5925,
      price: 538,
      reason: "PRE_FOMC_RISK_REDUCTION",
      ts: dca.ts + 86400000,
    };
    const out = planInvestorCatchupOps({
      lots: [dca, sell],
      ring: [],
      scores: { CRS: { stage: "accumulate", score: 70 } },
      livePrices: { CRS: 501 },
    });
    expect(out.planned.map((p) => p.kind)).toEqual(["trim"]);
    expect(out.skipped_gates.some((s) => s.skip_reason === "offsetting_sell_same_trade")).toBe(true);
  });
});

describe("suppressOffsettingCatchupBuys", () => {
  it("drops buys when sells share the trade_id", () => {
    const { planned, skipped_offsetting } = suppressOffsettingCatchupBuys([
      { trade_id: "inv-A", kind: "dca", ticker: "A" },
      { trade_id: "inv-A", kind: "trim", ticker: "A" },
      { trade_id: "inv-B", kind: "dca", ticker: "B" },
    ]);
    expect(planned.map((p) => `${p.trade_id}:${p.kind}`).sort()).toEqual([
      "inv-A:trim",
      "inv-B:dca",
    ]);
    expect(skipped_offsetting).toHaveLength(1);
    expect(skipped_offsetting[0].skip_reason).toBe("offsetting_sell_same_trade");
  });
});
