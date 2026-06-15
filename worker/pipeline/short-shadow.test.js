// worker/pipeline/short-shadow.test.js
// Covers the 2026-06-13 short-book shadow mode (Part 3, R4). The evaluator
// must be observation-only: it stamps d.__short_shadow when a structurally
// bearish ticker in a flagged-weak sector below daily EMA21 would-be-shorted
// in a defensive regime, and stays silent otherwise. It must never throw.
import { describe, it, expect } from "vitest";
import { evaluateShortShadow } from "./tt-core-entry.js";

const defensiveCtx = {
  market: { monthlyCycle: "downtrend", monthlySectorBottom: ["Information Technology"] },
  daily: { e21: 100, px: 92, pct_above_e21: -8 },
  nowTs: 1_700_000_000_000,
};

describe("evaluateShortShadow (R4 shadow mode)", () => {
  it("stamps a shadow when defensive + weak sector + below EMA21", () => {
    const d = { ticker: "XYZ", _sector: "Information Technology", _sector_rating: "underweight" };
    evaluateShortShadow({ d, ctx: defensiveCtx, daCfg: {}, rejectMeta: { reason: "phase_i_short_no_spy_downtrend", rank: 88 } });
    expect(d.__short_shadow).toBeTruthy();
    expect(d.__short_shadow.mode).toBe("shadow");
    expect(d.__short_shadow.below_e21).toBe(true);
    expect(d.__short_shadow.weak_sector).toBe(true);
    expect(d.__short_shadow.suppressed_by).toBe("phase_i_short_no_spy_downtrend");
  });

  it("does NOT stamp when the ticker is above its EMA21", () => {
    const d = { ticker: "XYZ", _sector: "Information Technology", _sector_rating: "underweight" };
    const ctx = { ...defensiveCtx, daily: { e21: 100, px: 110, pct_above_e21: 10 } };
    evaluateShortShadow({ d, ctx, daCfg: {}, rejectMeta: { reason: "phase_i_short_no_spy_downtrend" } });
    expect(d.__short_shadow).toBeUndefined();
  });

  it("does NOT stamp when the sector is not flagged weak", () => {
    const d = { ticker: "XYZ", _sector: "Health Care", _sector_rating: "overweight" };
    evaluateShortShadow({ d, ctx: defensiveCtx, daCfg: {}, rejectMeta: {} });
    expect(d.__short_shadow).toBeUndefined();
  });

  it("respects the enabled kill-switch", () => {
    const d = { ticker: "XYZ", _sector: "Information Technology", _sector_rating: "underweight" };
    evaluateShortShadow({ d, ctx: defensiveCtx, daCfg: { deep_audit_short_shadow_enabled: "false" }, rejectMeta: {} });
    expect(d.__short_shadow).toBeUndefined();
  });

  it("never throws on malformed input", () => {
    expect(() => evaluateShortShadow({ d: null, ctx: null, daCfg: null, rejectMeta: null })).not.toThrow();
  });
});
