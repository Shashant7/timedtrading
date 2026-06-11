// worker/fair-value.test.js
// Pins the Fair Value & Quality engine semantics (B6).

import { describe, it, expect } from "vitest";
import {
  computeQualityScore,
  qualityGrade,
  extractFairValueSignal,
  computeFairValueTiltMagnitude,
  fairValueLineage,
  FAIR_VALUE_TILT_CAP,
} from "./fair-value.js";

const NOW = Date.UTC(2026, 5, 11, 12, 0, 0);

function snapshot(overrides = {}) {
  return {
    ticker: "NVDA",
    as_of: NOW - 2 * 86400000, // 2 days old → fresh
    valuation: {
      fair_value_price: 150,
      fair_value_premium_pct: -20, // 20% BELOW fair value
      fair_value_class: "discount",
      fair_value_basis: "blend_median",
    },
    growth: {
      eps_growth_class: "strong",
      rev_growth_class: "positive",
      roe_ttm_pct: 25,
      profit_margin_pct: 20,
    },
    earnings: {
      beat_rate_pct: 87.5,
      avg_surprise_pct: 12,
    },
    capital_structure: {
      free_cash_flow_ttm: 22e9,
    },
    ...overrides,
  };
}

describe("computeQualityScore / qualityGrade", () => {
  it("scores a great business as grade A", () => {
    const { score } = computeQualityScore(snapshot());
    // strong eps 15 + positive rev 5 + beat 20 + surprise 10 + roe 15 + margin 10 + fcf 5 = 80
    expect(score).toBe(80);
    expect(qualityGrade(score)).toBe("A");
  });

  it("scores an empty snapshot as 0 / F", () => {
    const { score } = computeQualityScore({});
    expect(score).toBe(0);
    expect(qualityGrade(score)).toBe("F");
  });
});

describe("extractFairValueSignal", () => {
  it("builds a fresh discount signal with growth detection", () => {
    const sig = extractFairValueSignal(snapshot(), { nowMs: NOW });
    expect(sig.stale).toBe(false);
    expect(sig.fv_class).toBe("discount");
    expect(sig.fv_premium_pct).toBe(-20);
    expect(sig.quality_grade).toBe("A");
    expect(sig.growth_detected).toBe(true); // strong eps + positive rev + 87.5% beat
  });

  it("marks snapshots older than 8 days stale", () => {
    const sig = extractFairValueSignal(
      snapshot({ as_of: NOW - 12 * 86400000 }),
      { nowMs: NOW },
    );
    expect(sig.stale).toBe(true);
  });

  it("returns null for empty/non-equity snapshots", () => {
    expect(extractFairValueSignal(null)).toBeNull();
    expect(extractFairValueSignal({ ticker: "SPY", valuation: {}, growth: {}, earnings: {} }, { nowMs: NOW })).toBeNull();
  });
});

describe("computeFairValueTiltMagnitude", () => {
  it("deep discount + grade A quality → strong positive tilt", () => {
    const sig = extractFairValueSignal(snapshot(), { nowMs: NOW });
    const tilt = computeFairValueTiltMagnitude(sig);
    // depth = min(2, 20/25) = 0.8 × A mult 2 = 1.6, + growth kicker 1 = 2.6
    expect(tilt).toBeCloseTo(2.6, 5);
  });

  it("rich premium + weak quality → negative tilt; quality A barely penalized", () => {
    const weak = extractFairValueSignal(snapshot({
      valuation: { fair_value_price: 80, fair_value_premium_pct: 40, fair_value_class: "premium" },
      growth: { eps_growth_class: "declining", rev_growth_class: "declining" },
      earnings: { beat_rate_pct: 25, avg_surprise_pct: -2 },
      capital_structure: {},
    }), { nowMs: NOW });
    expect(weak.quality_grade).toBe("F");
    expect(computeFairValueTiltMagnitude(weak)).toBe(-3);

    const strong = extractFairValueSignal(snapshot({
      valuation: { fair_value_price: 80, fair_value_premium_pct: 40, fair_value_class: "premium" },
    }), { nowMs: NOW });
    expect(strong.quality_grade).toBe("A");
    // -0.5 premium drag + 1 growth kicker = +0.5 (quality earns the premium)
    expect(computeFairValueTiltMagnitude(strong)).toBeCloseTo(0.5, 5);
  });

  it("stale snapshot → tilt 0 (freshness doctrine)", () => {
    const sig = extractFairValueSignal(
      snapshot({ as_of: NOW - 30 * 86400000 }),
      { nowMs: NOW },
    );
    expect(computeFairValueTiltMagnitude(sig)).toBe(0);
  });

  it("is bounded by the cap in both directions", () => {
    const deep = extractFairValueSignal(snapshot({
      valuation: { fair_value_price: 300, fair_value_premium_pct: -60, fair_value_class: "discount" },
    }), { nowMs: NOW });
    const tilt = computeFairValueTiltMagnitude(deep);
    expect(tilt).toBeLessThanOrEqual(FAIR_VALUE_TILT_CAP);
    expect(tilt).toBeGreaterThan(0);
  });

  it("null/missing signal → 0", () => {
    expect(computeFairValueTiltMagnitude(null)).toBe(0);
  });
});

describe("fairValueLineage", () => {
  it("compacts the signal for lineage stamping", () => {
    const lin = fairValueLineage(extractFairValueSignal(snapshot(), { nowMs: NOW }));
    expect(lin).toMatchObject({
      fair_value: 150,
      fv_premium_pct: -20,
      fv_class: "discount",
      quality_grade: "A",
      growth_detected: true,
      stale: false,
    });
    expect(fairValueLineage(null)).toBeNull();
  });
});
