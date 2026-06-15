// worker/investor-discipline.test.js
// Covers the 2026-06-13 investor execution-discipline knobs (Part 3, R6).
import { describe, it, expect } from "vitest";
import { loadInvestorConfig, DEFAULT_INVESTOR_CONFIG } from "./investor.js";

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
