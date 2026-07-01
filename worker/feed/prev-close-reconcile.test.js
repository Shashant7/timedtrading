import { describe, it, expect } from "vitest";
import {
  reconcileDailyChange,
  adjustPrevCloseForSplit,
  matchSplitRatio,
} from "./prev-close-reconcile.js";

describe("reconcileDailyChange", () => {
  it("fixes KLAC split-day mismatch (~10x prev_close)", () => {
    const { pc, dp } = reconcileDailyChange(2411.64, 213.56, 2198.08, 1029.24);
    expect(pc).toBeCloseTo(2135.6, 0);
    expect(dp).toBeCloseTo(12.92, 1);
  });

  it("fixes MLI 2-for-1 split (Jul 2026) bogus +100% day change", () => {
    const { pc, dp, dc } = reconcileDailyChange(122.93, 61.42, 61.52, 100.16);
    expect(pc).toBeCloseTo(122.84, 1);
    expect(Math.abs(dp)).toBeLessThan(1);
    expect(Math.abs(dc)).toBeLessThan(1);
  });

  it("passes through sane quotes unchanged", () => {
    const { pc, dp } = reconcileDailyChange(105, 100, 5, 5);
    expect(pc).toBe(100);
    expect(dp).toBe(5);
  });
});

describe("matchSplitRatio", () => {
  it("detects 2:1 forward split ratio", () => {
    expect(matchSplitRatio(122.93, 61.42)).toBe(2);
  });
});

describe("adjustPrevCloseForSplit", () => {
  it("returns split-adjusted prev close for MLI", () => {
    const out = adjustPrevCloseForSplit(122.93, 61.42);
    expect(out?.pc).toBeCloseTo(122.84, 1);
    expect(Math.abs(out?.dp)).toBeLessThan(1);
  });
});
