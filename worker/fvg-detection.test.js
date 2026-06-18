import { describe, expect, it } from "vitest";
import { detectFVGs } from "./indicators.js";

function bar(i, o, h, l, c) {
  return { ts: i * 60_000, o, h, l, c, v: 1000 };
}

describe("FVG detector parity", () => {
  it("ignores active gaps outside the 80-bar parity window", () => {
    const bars = [
      bar(0, 99.5, 100.0, 99.0, 99.8),
      bar(1, 100.5, 101.0, 100.2, 100.8),
      // Bull FVG vs bar 0: bottom 100.0, top 102.0.
      bar(2, 102.1, 102.5, 102.0, 102.2),
    ];
    for (let i = 3; i < 85; i += 1) {
      // Price remains inside the old gap but no new gaps form.
      bars.push(bar(i, 101.0, 101.5, 100.5, 101.0));
    }

    const fvg = detectFVGs(bars, 1);
    expect(fvg.inBullGap).toBe(false);
    expect(fvg.activeBull).toBe(0);
  });

  it("treats exact boundary touches as FVG mitigation", () => {
    const bullBars = [
      bar(0, 99.5, 100.0, 99.0, 99.8),
      bar(1, 100.5, 101.0, 100.2, 100.8),
      bar(2, 102.1, 102.5, 102.0, 102.2),
      // Exact touch of bull gap bottom mitigates the gap.
      bar(3, 101.0, 101.5, 100.0, 101.0),
    ];
    expect(detectFVGs(bullBars, 1).activeBull).toBe(0);

    const bearBars = [
      bar(0, 102.0, 103.0, 102.0, 102.5),
      bar(1, 101.0, 101.5, 100.8, 101.1),
      bar(2, 99.0, 101.0, 98.5, 99.5),
      // Exact touch of bear gap top mitigates the gap.
      bar(3, 101.0, 102.0, 100.5, 101.0),
    ];
    expect(detectFVGs(bearBars, 1).activeBear).toBe(0);
  });
});
