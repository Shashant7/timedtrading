import { describe, it, expect } from "vitest";
import { headlineMentionsTicker } from "../discovery/news-tracker.js";
import {
  buildFundamentalsHeroNarrative,
  buildCatalystsStreetBuzz,
} from "./rail-narratives.js";

describe("headlineMentionsTicker", () => {
  it("matches cashtag and bare symbol", () => {
    expect(headlineMentionsTicker("Amazon $AMZN beats estimates", null, "AMZN")).toBe(true);
    expect(headlineMentionsTicker("Western Digital (WDC) rises", null, "WDC")).toBe(true);
    expect(headlineMentionsTicker("Western Digital rises on NAND demand", null, "AMZN")).toBe(false);
  });
});

describe("buildFundamentalsHeroNarrative", () => {
  it("returns headline, bullets, tone", () => {
    const n = buildFundamentalsHeroNarrative({
      as_of: Date.now(),
      profile: { name: "Acme Corp", sector: "Technology", industry: "Software" },
      valuation: { fair_value_premium_pct: 12 },
      growth: { eps_growth_pct: 30, rev_growth_pct: 15, eps_growth_class: "strong" },
      earnings: { beat_rate_pct: 75 },
      compounder: { tier: "elite" },
    });
    expect(n.headline).toBeTruthy();
    expect(n.bullets.length).toBe(3);
    expect(["bullish", "neutral", "cautious"]).toContain(n.tone);
  });
});

describe("buildCatalystsStreetBuzz", () => {
  it("returns quiet vibe when no news", () => {
    const n = buildCatalystsStreetBuzz({ news: { count: 0, has_data: false } });
    expect(n.vibe).toBe("quiet");
  });

  it("returns bullish when dominant sentiment is bullish", () => {
    const n = buildCatalystsStreetBuzz({
      news: {
        count: 3,
        has_data: true,
        dominant_sentiment: "bullish",
        top_catalyst: { headline: "AMZN cloud growth accelerates" },
      },
    });
    expect(n.vibe).toBe("bullish");
    expect(n.top_drivers.length).toBeGreaterThan(0);
  });
});
