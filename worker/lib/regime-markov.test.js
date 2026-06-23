import { describe, it, expect } from "vitest";
import { forecastBundle, REGIME_STATES } from "./regime-markov.js";

describe("forecastBundle", () => {
  it("includes p_4h horizon (48 five-minute bars)", () => {
    const n = REGIME_STATES.length;
    const P = Array.from({ length: n }, (_, i) => {
      const row = Array.from({ length: n }, (_, j) => (i === j ? 0.7 : 0.1 / (n - 1)));
      const sum = row.reduce((a, b) => a + b, 0);
      return row.map((v) => v / sum);
    });
    const fc = forecastBundle(P, REGIME_STATES[0]);
    expect(fc).toBeTruthy();
    expect(fc.p_4h).toBeTruthy();
    expect(typeof fc.p_4h[REGIME_STATES[0]]).toBe("number");
    const sum = Object.values(fc.p_4h).reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(0.99);
    expect(sum).toBeLessThan(1.01);
  });
});
