/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { computeTfBundle } from "../worker/indicators.js";

function makeBars(n, start = 100, step = 0.5) {
  const bars = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const o = px;
    px += step;
    bars.push({ ts: i * 60000, o, h: px + 0.2, l: o - 0.1, c: px, v: 1000 });
  }
  return bars;
}

describe("ripster D 20/21 and D 50/55 clouds", () => {
  it("computes c20_21 and c50_55 on tf bundles", () => {
    const bars = makeBars(260, 50, 0.15);
    const b = computeTfBundle(bars);
    expect(b.ripsterClouds?.c20_21).toBeTruthy();
    expect(b.ripsterClouds?.c50_55).toBeTruthy();
    expect(typeof b.ripsterClouds.c20_21.bull).toBe("boolean");
    expect(typeof b.ripsterClouds.c50_55.above).toBe("boolean");
    expect(Number.isFinite(b.e20)).toBe(true);
    expect(Number.isFinite(b.e21)).toBe(true);
    expect(Number.isFinite(b.e55)).toBe(true);
  });
});
