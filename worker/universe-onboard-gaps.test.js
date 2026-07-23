import { describe, it, expect } from "vitest";
import { tickerHasUsableScore, classifyOnboardGap } from "./universe-onboard-gaps.js";

describe("tickerHasUsableScore", () => {
  it("accepts htf_score === 0 when price and sl are present", () => {
    expect(tickerHasUsableScore({ price: 165.27, htf_score: 0, sl: 166.33 })).toBe(true);
  });

  it("rejects missing latest / non-finite htf / missing sl", () => {
    expect(tickerHasUsableScore(null)).toBe(false);
    expect(tickerHasUsableScore({ price: 10, htf_score: null, sl: 9 })).toBe(false);
    expect(tickerHasUsableScore({ price: 10, htf_score: 12, sl: null })).toBe(false);
    expect(tickerHasUsableScore({ price: 0, htf_score: 12, sl: 9 })).toBe(false);
  });
});

describe("classifyOnboardGap", () => {
  it("treats quality/profile-only shortfalls as soft, not hard", () => {
    const g = classifyOnboardGap({
      missing: [],
      hasProfile: false,
      hasScore: true,
      avgQuality: 50,
      minQuality: 80,
    });
    expect(g.hard).toBe(false);
    expect(g.soft).toBe(true);
    expect(g.needsHeal).toBe(true);
  });

  it("treats missing TFs or unscored names as hard orphans", () => {
    expect(classifyOnboardGap({
      missing: ["D"],
      hasProfile: true,
      hasScore: true,
      avgQuality: 90,
      minQuality: 80,
    }).hard).toBe(true);
    expect(classifyOnboardGap({
      missing: [],
      hasProfile: true,
      hasScore: false,
      avgQuality: 90,
      minQuality: 80,
    }).hard).toBe(true);
  });
});
