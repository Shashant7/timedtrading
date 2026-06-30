import { describe, it, expect } from "vitest";
import { diffInvestorPositionsVsLots } from "./investor-positions-repair.js";

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
