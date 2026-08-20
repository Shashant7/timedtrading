import { describe, it, expect, beforeEach } from "vitest";
import { computeRiskBasedSize, resetSizingConfig, getSizingConfig } from "./sizing.js";

describe("computeRiskBasedSize — MIN_NOTIONAL floor always applies", () => {
  beforeEach(() => resetSizingConfig());

  it("tier sizing still floors to MIN_NOTIONAL (no more sub-$1k primes)", () => {
    const env = {};
    const cfg = getSizingConfig(env);
    // Wide stop relative to 2% risk → raw notional would be tiny without a floor.
    // entry=600, SL=100 → risk/share=500; 2% of 100k = $2000 → shares=4 → notional=$2400 (above floor).
    // entry=600, SL=50 → risk=550; $2000/550*600 ≈ $2182.
    // Use a very wide stop: entry=600, SL= - wait need SL such that notional < 1000.
    // notional = maxRisk * entry / riskPerShare = 2000 * 600 / R < 1000 → R > 1200.
    const r = computeRiskBasedSize(
      0.9,          // confidence
      100000,       // account
      600,          // entry (AXON-class)
      600 - 1500,   // absurdly wide stop → raw notional << MIN_NOTIONAL
      18,           // vix
      env,
      0.02,         // Prime tier risk
    );
    expect(r.method).toBe("risk_based");
    expect(r.notional).toBeGreaterThanOrEqual(cfg.MIN_NOTIONAL);
    expect(r.shares).toBeCloseTo(cfg.MIN_NOTIONAL / 600, 5);
  });

  it("AXON-shaped stop at Prime risk produces full ~20% cap before haircuts", () => {
    // entry 596.89, SL 554.29, risk/share 42.6, 2% of 100k = $2000
    // → notional ≈ $28k → capped at 20% = $20k
    const r = computeRiskBasedSize(
      0.85, 100000, 596.89, 554.29, 16, {}, 0.02,
    );
    expect(r.notional).toBeCloseTo(20000, 0);
    expect(r.shares).toBeGreaterThan(30);
  });
});

// 2026-08-20 — Conviction-weighted sizing (alignment stack).
import { computeConvictionSizeMult, convictionAwareMinNotional } from "./sizing.js";

describe("computeConvictionSizeMult", () => {
  const ON = { deep_audit_conviction_sizing_enabled: "true" };
  const riskOff = { overall: "risk_off", sector_rotation: { state: "risk_off" } };
  const riskOn = { overall: "risk_on", sector_rotation: { state: "risk_on" } };

  it("neutral 1.0 when flag off", () => {
    const r = computeConvictionSizeMult({ grade: "Prime", daCfg: {} });
    expect(r.enabled).toBe(false);
    expect(r.mult).toBe(1.0);
  });

  it("best case: Prime + tier-1 OW + FSD top + aligned tape → clamped 2.0", () => {
    // 1.30 * 1.25 * 1.30 * 1.15 = 2.43 → clamp 2.0
    const r = computeConvictionSizeMult({
      grade: "Prime",
      stance: { stance: "overweight", tier: "tier_1" },
      fsdCoreIdea: { conviction: "top" },
      side: "LONG",
      sector: "Energy",
      internals: riskOff,
      daCfg: ON,
    });
    expect(r.mult).toBe(2.0);
    expect(r.breakdown.raw).toBeCloseTo(2.429, 2);
  });

  it("worst case: Speculative + UW + FSD bottom + misaligned → clamped 0.40", () => {
    // 0.60 * 0.70 * 0.50 * 0.70 = 0.147 → clamp 0.40
    const r = computeConvictionSizeMult({
      grade: "Speculative",
      stance: { stance: "underweight" },
      fsdCoreIdea: { conviction: "bottom" },
      side: "LONG",
      sector: "Information Technology",
      internals: riskOff,
      daCfg: ON,
    });
    expect(r.mult).toBe(0.40);
  });

  it("the SNOW class: Speculative offense LONG in risk_off, no stance → 0.42", () => {
    // 0.60 * 1.0 * 1.0 * 0.70 = 0.42
    const r = computeConvictionSizeMult({
      grade: "Speculative",
      side: "LONG",
      sector: "Information Technology",
      internals: riskOff,
      daCfg: ON,
    });
    expect(r.mult).toBeCloseTo(0.42, 3);
  });

  it("the USO class: Confirmed Energy LONG in risk_off → 1.15 (aligned pond)", () => {
    const r = computeConvictionSizeMult({
      grade: "Confirmed",
      side: "LONG",
      sector: "Energy",
      internals: riskOff,
      daCfg: ON,
    });
    expect(r.mult).toBeCloseTo(1.15, 3);
  });

  it("offense LONG in risk_on gets the tailwind (1.15 tape)", () => {
    const r = computeConvictionSizeMult({
      grade: "Confirmed",
      side: "LONG",
      sector: "Information Technology",
      internals: riskOn,
      daCfg: ON,
    });
    expect(r.mult).toBeCloseTo(1.15, 3);
  });

  it("SHORT on offense in risk_off sized up (aligned short)", () => {
    const r = computeConvictionSizeMult({
      grade: "Confirmed",
      side: "SHORT",
      sector: "Information Technology",
      internals: riskOff,
      daCfg: ON,
    });
    expect(r.mult).toBeCloseTo(1.15, 3);
  });

  it("missing inputs read neutral — thin payload can never crush size", () => {
    const r = computeConvictionSizeMult({ daCfg: ON });
    expect(r.mult).toBe(1.0);
  });

  it("honors custom clamp knobs", () => {
    const r = computeConvictionSizeMult({
      grade: "Prime",
      stance: { stance: "overweight", tier: "tier_1" },
      fsdCoreIdea: { conviction: "top" },
      side: "LONG",
      sector: "Energy",
      internals: riskOff,
      daCfg: { ...ON, deep_audit_conviction_sizing_max: "3.0" },
    });
    expect(r.mult).toBeCloseTo(2.429, 2); // raw survives the wider clamp
  });
});

describe("convictionAwareMinNotional", () => {
  it("keeps the base floor when disabled or mult >= 1", () => {
    expect(convictionAwareMinNotional(1000, 0.5, false)).toBe(1000);
    expect(convictionAwareMinNotional(1000, 1.5, true)).toBe(1000);
  });

  it("scales the floor down with the multiplier when enabled", () => {
    expect(convictionAwareMinNotional(1000, 0.42, true)).toBe(420);
    expect(convictionAwareMinNotional(1000, 0.7, true)).toBe(700);
  });

  it("never drops below $250", () => {
    expect(convictionAwareMinNotional(1000, 0.1, true)).toBe(250);
  });
});
