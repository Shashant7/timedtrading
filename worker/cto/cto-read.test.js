import { describe, it, expect } from "vitest";
import { interpretCTORead } from "./cto-service.js";

describe("interpretCTORead", () => {
  it("labels tight dual-high setups as range map", () => {
    const read = interpretCTORead(
      { label: "R2", price: 742.76, regime_adjusted_prob: 0.83 },
      { label: "R1", price: 734.10, regime_adjusted_prob: 0.84 },
    );
    expect(read.kind).toBe("range");
    expect(read.label).toBe("Range map");
    expect(read.lean).toBeNull();
    expect(read.range_pct).toBeGreaterThan(0);
  });

  it("labels asymmetric setups as directional lean", () => {
    const read = interpretCTORead(
      { label: "R2", price: 717.65, regime_adjusted_prob: 0.97 },
      { label: "R1", price: 705.67, regime_adjusted_prob: 0.63 },
    );
    expect(read.kind).toBe("upside");
    expect(read.label).toBe("Upside lean");
    expect(read.lean).toBe("up");
  });

  it("labels downside lean when lower magnet dominates", () => {
    const read = interpretCTORead(
      { label: "R1", price: 100, regime_adjusted_prob: 0.55 },
      { label: "S1", price: 95, regime_adjusted_prob: 0.82 },
    );
    expect(read.kind).toBe("downside");
    expect(read.lean).toBe("down");
  });
});
