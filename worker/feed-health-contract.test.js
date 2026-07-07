import { describe, expect, it } from "vitest";
import { feedAgeMin, summarizeFeedHealth } from "./feed-health-contract.js";

describe("feed-health-contract", () => {
  it("feedAgeMin reads updated_at", () => {
    const now = 1_000_000;
    expect(feedAgeMin({ updated_at: now - 120_000 }, now)).toBe(2);
  });

  it("summarizeFeedHealth fails when fundamentals missing", () => {
    const out = summarizeFeedHealth({
      fundamentals: { SPY: null, QQQ: null, NVDA: null },
      macroEvents: { ts: Date.now() - 3_600_000 },
      macroCrossAsset: { computed_at: Date.now() - 3_600_000 },
      fsdAccuracy: { computed_at: Date.now() - 3_600_000 },
    });
    expect(out.fundamentals.ok).toBe(false);
    expect(out.ok).toBe(false);
    expect(out.failing).toContain("fundamentals");
  });

  it("summarizeFeedHealth passes when samples are fresh", () => {
    const now = Date.now();
    const out = summarizeFeedHealth({
      fundamentals: {
        SPY: { updated_at: now - 60_000 },
        QQQ: { updated_at: now - 60_000 },
        NVDA: { updated_at: now - 60_000 },
      },
      macroEvents: { ts: now - 60_000 },
      macroCrossAsset: { computed_at: now - 60_000 },
      fsdAccuracy: { computed_at: now - 60_000 },
    }, now);
    expect(out.ok).toBe(true);
    expect(out.failing).toEqual([]);
  });
});
