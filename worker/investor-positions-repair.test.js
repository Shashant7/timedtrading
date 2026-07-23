import { describe, it, expect } from "vitest";
import {
  diffInvestorPositionsVsLots,
  planInvestorConvenienceHeal,
  convenienceFieldsFromInvestorScore,
  serializeInvestorThesisInvalidation,
} from "./investor-positions-repair.js";

describe("diffInvestorPositionsVsLots", () => {
  it("flags cost_basis drift when shares match", () => {
    const { mismatches, total_cost_drift } = diffInvestorPositionsVsLots([{
      id: "inv-IWM",
      ticker: "IWM",
      total_shares: 5.5249,
      cost_basis: 772.97,
      lot_shares: 5.5249,
      lot_cost: 1404.3,
      lot_count: 17,
    }]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].cost_drift).toBeCloseTo(-631.33, 0);
    expect(total_cost_drift).toBeCloseTo(-631.33, 0);
  });

  it("flags share drift when cost matches", () => {
    const { mismatches } = diffInvestorPositionsVsLots([{
      id: "inv-IWM",
      ticker: "IWM",
      total_shares: 4.606,
      cost_basis: 1404.3,
      lot_shares: 5.525,
      lot_cost: 1404.3,
      lot_count: 17,
    }]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].share_drift).toBeCloseTo(-0.919, 2);
  });

  it("marks phantom positions with no lots for manual review", () => {
    const { mismatches } = diffInvestorPositionsVsLots([{
      id: "inv-STRL",
      ticker: "STRL",
      total_shares: 8.47,
      cost_basis: 7000,
      lot_shares: 0,
      lot_cost: 0,
      lot_count: 0,
    }]);
    expect(mismatches[0].needs_manual).toBe(true);
  });

  it("ignores rows within tolerance", () => {
    const { mismatches } = diffInvestorPositionsVsLots([{
      id: "inv-KO",
      ticker: "KO",
      total_shares: 87.13,
      cost_basis: 7000,
      lot_shares: 87.13,
      lot_cost: 7000,
      lot_count: 1,
    }]);
    expect(mismatches).toHaveLength(0);
  });
});

describe("convenienceFieldsFromInvestorScore", () => {
  it("serializes thesis + invalidation + notes from score row", () => {
    const fields = convenienceFieldsFromInvestorScore({
      stage: "accumulate",
      score: 64,
      stageReason: "compounder_dip_buy:growth_strong",
      thesis: "CF: Monthly uptrend",
      thesisInvalidation: ["Monthly SuperTrend flips bearish"],
    });
    expect(fields.thesis).toMatch(/Monthly uptrend/);
    expect(JSON.parse(fields.thesis_invalidation)).toHaveLength(1);
    expect(fields.notes).toMatch(/compounder_dip_buy/);
  });

  it("falls back to compounder why_hold when thesis missing", () => {
    const fields = convenienceFieldsFromInvestorScore({
      stage: "accumulate",
      score: 70,
      compounder: { why_hold: ["Revenue expanding", "Quality A"] },
    });
    expect(fields.thesis).toMatch(/Revenue expanding/);
  });
});

describe("planInvestorConvenienceHeal", () => {
  it("fills blank thesis/invalidation and enables DCA on accumulate", () => {
    const patch = planInvestorConvenienceHeal(
      {
        thesis: null,
        thesis_invalidation: null,
        investor_stage: "accumulate",
        notes: "Auto-initiated: accumulate (score 64)",
        dca_enabled: 0,
        total_shares: 40,
      },
      {
        stage: "accumulate",
        score: 64,
        thesis: "CF thesis",
        thesisInvalidation: ["inv1"],
      },
      { now: 1_700_000_000_000, autoDcaOnAccumulate: true, autoDcaAmountPct: 0.02 },
    );
    expect(patch.thesis).toBe("CF thesis");
    expect(patch.thesis_invalidation).toBe(serializeInvestorThesisInvalidation(["inv1"]));
    expect(patch.dca_enabled).toBe(1);
    expect(patch.dca_amount).toBe(2000);
  });

  it("returns null when already complete", () => {
    const patch = planInvestorConvenienceHeal(
      {
        thesis: "have it",
        thesis_invalidation: "[]",
        investor_stage: "accumulate",
        notes: "x",
        dca_enabled: 1,
        total_shares: 10,
      },
      { stage: "accumulate", thesis: "other" },
    );
    expect(patch).toBeNull();
  });
});
