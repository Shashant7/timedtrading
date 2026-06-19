import { describe, it, expect } from "vitest";
import {
  computeProtectiveStopTighten,
  resolveEffectiveStopLoss,
  slDrawdownPct,
} from "../worker/sanity-stop-heal.js";

describe("sanity-stop-heal", () => {
  it("caps long stop drawdown to 20% from current price", () => {
    const px = 1133.99;
    const oldSl = 843.42;
    const newSl = computeProtectiveStopTighten("LONG", px, oldSl, 20);
    expect(newSl).toBeGreaterThan(oldSl);
    const dd = slDrawdownPct("LONG", px, newSl);
    expect(dd).toBeLessThanOrEqual(20.01);
    expect(dd).toBeGreaterThan(19);
  });

  it("prefers tighter long stop from KV trade over stale D1 row", () => {
    expect(resolveEffectiveStopLoss("LONG", 843.42, 950)).toBe(950);
    expect(resolveEffectiveStopLoss("LONG", 950, 843.42)).toBe(950);
  });

  it("flags wide drawdown before tighten", () => {
    expect(slDrawdownPct("LONG", 1133.99, 843.42)).toBeCloseTo(25.6, 0);
  });
});
