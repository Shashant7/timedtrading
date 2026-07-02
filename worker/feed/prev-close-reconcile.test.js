import { describe, it, expect } from "vitest";
import {
  reconcileDailyChange,
  adjustPrevCloseForSplit,
  matchSplitRatio,
  isOpenSplitArtifact,
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

  it("fixes MLI production split artifact (post-split price vs pre-split pc)", () => {
    const { pc, dp } = reconcileDailyChange(56.18, 122.83, -66.65, -54.26, { dailyOpen: 58.2 });
    expect(pc).toBeCloseTo(61.42, 1);
    expect(Math.abs(dp)).toBeLessThan(12);
    expect(dp).toBeLessThan(0);
  });

  it("fixes CRWD 4-for-1 split (Jul 2026) bogus -75% day change", () => {
    const { pc, dp } = reconcileDailyChange(195.14, 772.72, -577.58, -74.75, { dailyOpen: 198 });
    expect(pc).toBeCloseTo(193.18, 1);
    expect(Math.abs(dp)).toBeLessThan(3);
  });

  it("does not treat a real ~50% crash as a split when open confirms the drop", () => {
    const { pc, dp } = reconcileDailyChange(50, 100, -50, -50, { dailyOpen: 72 });
    expect(pc).toBe(100);
    expect(dp).toBe(-50);
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

  it("detects 2:1 reverse split ratio with split-day drift", () => {
    expect(matchSplitRatio(56.18, 122.83)).toBe(0.5);
  });
});

describe("isOpenSplitArtifact", () => {
  it("flags MLI split-day open vs stale pc", () => {
    expect(isOpenSplitArtifact(56.18, 122.83, 58.2)).toBe(true);
  });

  it("rejects a real intraday crash pattern", () => {
    expect(isOpenSplitArtifact(50, 100, 72)).toBe(false);
  });
});

describe("adjustPrevCloseForSplit", () => {
  it("returns split-adjusted prev close for MLI post-split drift", () => {
    const out = adjustPrevCloseForSplit(56.18, 122.83);
    expect(out?.pc).toBeCloseTo(61.42, 1);
    expect(Math.abs(out?.dp)).toBeLessThan(12);
  });

  it("returns split-adjusted prev close for CRWD 4:1", () => {
    const out = adjustPrevCloseForSplit(195.14, 772.72);
    expect(out?.pc).toBeCloseTo(193.18, 1);
    expect(Math.abs(out?.dp)).toBeLessThan(3);
  });
});
