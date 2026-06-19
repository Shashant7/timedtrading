// worker/growth-compounder.test.js
// Pins growth compounder / Tenet-style revenue trajectory semantics.

import { describe, it, expect } from "vitest";
import {
  buildRevenueTrajectory,
  classifyGrowthCompounder,
  buildWhyWeHoldBullets,
  detectCompounderDipBuy,
  computeCompounderScoreBoost,
  extractGrowthCompounderSignal,
} from "./growth-compounder.js";
import { extractFairValueSignal } from "./fair-value.js";

function muLikeSnapshot() {
  return {
    ticker: "MU",
    valuation: {
      market_cap: 180e9,
      ps_ratio: 3.1,
      fair_value_price: 1200,
      fair_value_premium_pct: 15,
      fair_value_class: "premium",
    },
    growth: {
      rev_growth_pct: 94,
      eps_growth_pct: 120,
      rev_growth_class: "explosive",
      eps_growth_class: "explosive",
      roe_ttm_pct: 18,
      profit_margin_pct: 22,
    },
    earnings: {
      beat_rate_pct: 87.5,
      avg_surprise_pct: 12,
      revenue_history: [
        { date: "2023-03-01", revenue_actual: 3.7e9 },
        { date: "2023-06-01", revenue_actual: 3.8e9 },
        { date: "2023-09-01", revenue_actual: 4.0e9 },
        { date: "2023-12-01", revenue_actual: 4.7e9 },
        { date: "2024-03-01", revenue_actual: 5.8e9 },
        { date: "2024-06-01", revenue_actual: 6.8e9 },
        { date: "2024-09-01", revenue_actual: 7.7e9 },
        { date: "2024-12-01", revenue_actual: 8.7e9 },
      ],
    },
    capital_structure: {
      free_cash_flow_ttm: 22e9,
    },
  };
}

describe("buildRevenueTrajectory", () => {
  it("builds LTM, forward estimates, and CAGR from quarterly revenue", () => {
    const traj = buildRevenueTrajectory(muLikeSnapshot());
    expect(traj.ok).toBe(true);
    expect(traj.ltm_b).toBeGreaterThan(20);
    expect(traj.points.some((p) => p.kind === "ltm")).toBe(true);
    expect(traj.points.some((p) => p.kind === "estimate")).toBe(true);
    expect(traj.cagr_pct).not.toBeNull();
    expect(traj.forward_step_up_pct).toBeGreaterThan(50);
  });

  it("falls back to market cap / P/S when revenue rows are sparse", () => {
    const traj = buildRevenueTrajectory({
      valuation: { market_cap: 100e9, ps_ratio: 5 },
      growth: { rev_growth_pct: 40 },
    });
    expect(traj.ltm_b).toBe(20);
    expect(traj.points.some((p) => p.kind === "estimate")).toBe(true);
  });
});

describe("classifyGrowthCompounder", () => {
  it("classifies explosive revenue + quality A as growth_elite", () => {
    const snap = muLikeSnapshot();
    const fv = extractFairValueSignal(snap);
    const comp = classifyGrowthCompounder(snap, fv);
    expect(comp.tier).toBe("growth_elite");
    expect(comp.eligible).toBe(true);
    expect(comp.why_hold.length).toBeGreaterThan(0);
  });

  it("returns growth_watch for weak growth profile", () => {
    const comp = classifyGrowthCompounder({
      growth: { rev_growth_class: "strong", rev_growth_pct: 30 },
      earnings: {},
    });
    expect(comp.tier).toBe("growth_watch");
    expect(comp.eligible).toBe(false);
  });
});

describe("buildWhyWeHoldBullets", () => {
  it("includes portfolio compounder guidance for growth_elite", () => {
    const snap = muLikeSnapshot();
    const fv = extractFairValueSignal(snap);
    const traj = buildRevenueTrajectory(snap);
    const bullets = buildWhyWeHoldBullets(snap, fv, traj, "growth_elite");
    expect(bullets.some((b) => /Portfolio compounder/i.test(b))).toBe(true);
  });
});

describe("detectCompounderDipBuy", () => {
  it("detects timing bottom + weekly pullback as dip", () => {
    const dip = detectCompounderDipBuy(
      {
        price: 100,
        tf_tech: {
          W: { rsi: { r5: 48 }, ema: { priceAboveEma21: true, e21: 98 } },
        },
        monthly_bundle: { rsi: 55 },
      },
      { timing_primary: "BOTTOM", add_on_dips: true },
      null,
    );
    expect(dip.isDip).toBe(true);
    expect(dip.signals).toContain("timing_bottom");
  });
});

describe("computeCompounderScoreBoost", () => {
  it("adds extra boost on dip days", () => {
    const elite = { eligible: true, tier: "growth_elite" };
    expect(computeCompounderScoreBoost(elite, { isDip: false })).toBe(5);
    expect(computeCompounderScoreBoost(elite, { isDip: true })).toBe(7);
  });
});

describe("extractGrowthCompounderSignal", () => {
  it("returns compact compounder payload", () => {
    const sig = extractGrowthCompounderSignal(muLikeSnapshot());
    expect(sig.tier).toBe("growth_elite");
    expect(sig.trajectory?.ltm_b).toBeGreaterThan(0);
    expect(Array.isArray(sig.why_hold)).toBe(true);
  });
});
