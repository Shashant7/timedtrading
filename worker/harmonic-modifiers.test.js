import { describe, it, expect } from "vitest";
import {
  computeHarmonicInvestorBias,
  computeHarmonicSizeMult,
  computeHarmonicTiltMagnitude,
  computeHarmonicTrimAdvisory,
  condenseHarmonicCycle,
  compactHarmonicForPayload,
  resolveHarmonicGateConfig,
  HARMONIC_TILT_MAX,
} from "./harmonic-modifiers.js";

const sampleHarmonic = {
  ok: true,
  label: "late cycle / approaching peak",
  direction: "falling",
  phase_pct: 0.62,
  primary_period: 180,
  rank_tilt_base: -2.5,
  rank_tilt: -1.25,
  investor_bias: "reduce_favor",
};

describe("computeHarmonicTiltMagnitude", () => {
  it("favors LONG at trough with rising composite", () => {
    const tilt = computeHarmonicTiltMagnitude({
      label: "early cycle / trough zone",
      direction: "rising",
      phase_pct: 0.1,
    });
    expect(tilt).toBeGreaterThan(0);
    expect(tilt).toBeLessThanOrEqual(HARMONIC_TILT_MAX);
  });

  it("penalizes LONG at past peak", () => {
    const tilt = computeHarmonicTiltMagnitude({
      label: "past peak / down-cycle",
      direction: "falling",
      phase_pct: 0.8,
    });
    expect(tilt).toBeLessThan(0);
  });
});

describe("computeHarmonicSizeMult", () => {
  it("boosts size when harmonic aligns with LONG", () => {
    const mult = computeHarmonicSizeMult(
      { label: "recovery / rising", direction: "rising", phase_pct: 0.3 },
      "LONG",
      0.5,
    );
    expect(mult).toBeGreaterThan(1);
    expect(mult).toBeLessThanOrEqual(1.08);
  });

  it("haircuts size when harmonic conflicts with LONG", () => {
    const mult = computeHarmonicSizeMult(sampleHarmonic, "LONG", 1);
    expect(mult).toBeLessThan(1);
  });
});

describe("computeHarmonicTrimAdvisory", () => {
  it("suggests trim for LONG winner in late cycle", () => {
    const adv = computeHarmonicTrimAdvisory({
      harmonic: sampleHarmonic,
      direction: "LONG",
      pnlPct: 4.2,
      trimmedPct: 0,
    });
    expect(adv).toBeTruthy();
    expect(adv.suggested_trim_pct).toBeGreaterThan(0);
    expect(adv.reasons).toContain("harmonic_late_cycle");
  });

  it("skips when position already heavily trimmed", () => {
    const adv = computeHarmonicTrimAdvisory({
      harmonic: sampleHarmonic,
      direction: "LONG",
      pnlPct: 4.2,
      trimmedPct: 0.6,
    });
    expect(adv).toBeNull();
  });
});

describe("computeHarmonicInvestorBias", () => {
  it("marks accumulate favor in recovery rising", () => {
    expect(computeHarmonicInvestorBias({
      label: "recovery / rising",
      direction: "rising",
    })).toBe("accumulate_favor");
  });

  it("marks reduce favor at past peak", () => {
    expect(computeHarmonicInvestorBias({
      label: "past peak / down-cycle",
      direction: "falling",
    })).toBe("reduce_favor");
  });
});

describe("condenseHarmonicCycle", () => {
  it("includes trim advisory when stamped on ticker", () => {
    const out = condenseHarmonicCycle({
      harmonic_cycle: sampleHarmonic,
      __harmonic_trim_advisory: {
        suggested_trim_pct: 0.15,
        strength: "standard",
        reasons: ["harmonic_late_cycle"],
      },
    });
    expect(out.label).toContain("late cycle");
    expect(out.trim_advisory.suggested_trim_pct).toBe(0.15);
  });
});

describe("resolveHarmonicGateConfig", () => {
  it("defaults to enabled with soft calibration weight", () => {
    const cfg = resolveHarmonicGateConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.calibrationWeight).toBe(0.5);
  });

  it("respects explicit disable", () => {
    const cfg = resolveHarmonicGateConfig({ harmonic_rank_boost_enabled: "false" });
    expect(cfg.enabled).toBe(false);
  });
});

describe("compactHarmonicForPayload", () => {
  it("scales rank tilt by calibration weight", () => {
    const out = compactHarmonicForPayload({
      ok: true,
      label: "recovery / rising",
      direction: "rising",
      phase_pct: 0.35,
      primary_period: 180,
      composite_value: 0.12,
      dominant_periods: [180],
      bars: 300,
      source: "harmonic-cycle.v2",
    }, { calibrationWeight: 0.5 });
    expect(out.rank_tilt_base).toBeGreaterThan(0);
    expect(Math.abs(out.rank_tilt)).toBeLessThan(Math.abs(out.rank_tilt_base));
  });
});
