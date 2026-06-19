// worker/investor-discipline.test.js
// Covers the 2026-06-13 investor execution-discipline knobs (Part 3, R6).
import { describe, it, expect } from "vitest";
import {
  loadInvestorConfig,
  DEFAULT_INVESTOR_CONFIG,
  resolvePrimaryInvalidationBreach,
  resolveStickyPrimaryInvalidation,
  classifyInvestorStage,
  isStructuralInvestorReduce,
} from "./investor.js";

describe("investor R6 discipline defaults", () => {
  it("ships the operator-intended defaults", () => {
    expect(DEFAULT_INVESTOR_CONFIG.max_new_positions_per_day).toBe(3);
    expect(DEFAULT_INVESTOR_CONFIG.auto_init_require_accumulate).toBe(true);
    expect(DEFAULT_INVESTOR_CONFIG.auto_init_min_score).toBe(65);
    expect(DEFAULT_INVESTOR_CONFIG.reduce_trim_min_sessions).toBe(2);
    expect(DEFAULT_INVESTOR_CONFIG.reduce_trim_pct).toBeCloseTo(0.30);
    expect(DEFAULT_INVESTOR_CONFIG.auto_dca_on_accumulate).toBe(true);
  });

  it("applies bounds-checked overrides from daCfg", () => {
    const c = loadInvestorConfig({
      deep_audit_investor_max_new_positions_per_day: "5",
      deep_audit_investor_auto_init_min_score: "70",
      deep_audit_investor_reduce_trim_min_sessions: "3",
      deep_audit_investor_reduce_trim_pct: "0.33",
      deep_audit_investor_auto_init_require_accumulate: "false",
      deep_audit_investor_auto_dca_on_accumulate: "false",
      deep_audit_investor_auto_dca_amount_pct: "0.03",
      deep_audit_investor_auto_dca_frequency: "weekly",
    });
    expect(c.max_new_positions_per_day).toBe(5);
    expect(c.auto_init_min_score).toBe(70);
    expect(c.reduce_trim_min_sessions).toBe(3);
    expect(c.reduce_trim_pct).toBeCloseTo(0.33);
    expect(c.auto_init_require_accumulate).toBe(false);
    expect(c.auto_dca_on_accumulate).toBe(false);
    expect(c.auto_dca_amount_pct).toBeCloseTo(0.03);
    expect(c.auto_dca_frequency).toBe("weekly");
  });

  it("rejects nonsense values and keeps defaults", () => {
    const c = loadInvestorConfig({
      deep_audit_investor_max_new_positions_per_day: "-1",
      deep_audit_investor_reduce_trim_pct: "2",        // >1 invalid
      deep_audit_investor_auto_dca_frequency: "daily", // not allowed
    });
    expect(c.max_new_positions_per_day).toBe(3);
    expect(c.reduce_trim_pct).toBeCloseTo(0.30);
    expect(c.auto_dca_frequency).toBe("monthly");
  });
});

describe("primary invalidation breach", () => {
  it("detects close below the primary invalidation floor", () => {
    const breach = resolvePrimaryInvalidationBreach(372.55, {
      primaryInvalidation: { price: 375.44, label: "Daily ATR support" },
    });
    expect(breach).toMatchObject({
      price: 375.44,
      label: "Daily ATR support",
    });
    expect(breach.breachPct).toBeLessThan(0);
  });

  it("returns null when price is above invalidation", () => {
    expect(resolvePrimaryInvalidationBreach(257.7, {
      primaryInvalidation: { price: 256.04, label: "Daily ATR support" },
    })).toBeNull();
  });

  it("keeps the published floor sticky after price drops below it", () => {
    const prev = { price: 375.44, label: "Daily ATR support", distancePct: 4.5 };
    const fresh = { price: 350.21, label: "Weekly EMA(21)", distancePct: 6.0 };
    const sticky = resolveStickyPrimaryInvalidation(prev, fresh, 372.55, true);
    expect(sticky.price).toBe(375.44);
    expect(sticky.breached).toBe(true);
  });

  it("classifies owned positions as reduce on primary invalidation breach", () => {
    const stage = classifyInvestorStage(
      { ticker: "CLS", price: 372.55, _live_price: 372.55 },
      57,
      { avg_entry: 461.01, total_shares: 6.35 },
      {
        rsRank: 80,
        marketHealth: 50,
        accumZone: null,
        primaryInvalidation: { price: 375.44, label: "Daily ATR support" },
      },
    );
    expect(stage.stage).toBe("reduce");
    expect(stage.reason).toBe("primary_invalidation_breach");
  });

  it("treats rs_rank_declining as structural reduce for execution bypass", () => {
    expect(isStructuralInvestorReduce("rs_rank_declining")).toBe(true);
    expect(isStructuralInvestorReduce("choppy_regime_losing")).toBe(false);
  });
});
