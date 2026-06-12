import { describe, it, expect } from "vitest";
import { reconcileDailyChange } from "./prev-close-reconcile.js";

describe("reconcileDailyChange", () => {
  it("fixes KLAC split-day mismatch (~10x prev_close)", () => {
    const { pc, dp } = reconcileDailyChange(2411.64, 213.56, 2198.08, 1029.24);
    expect(pc).toBeCloseTo(2135.6, 0);
    expect(dp).toBeCloseTo(12.92, 1);
  });

  it("passes through sane quotes unchanged", () => {
    const { pc, dp } = reconcileDailyChange(105, 100, 5, 5);
    expect(pc).toBe(100);
    expect(dp).toBe(5);
  });
});
