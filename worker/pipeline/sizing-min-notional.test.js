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
