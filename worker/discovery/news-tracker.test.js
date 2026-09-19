import { describe, it, expect } from "vitest";
import {
  attachNewsSummary,
  compactNewsStamp,
  headlineMentionsTicker,
  summarizeNewsRows,
} from "../discovery/news-tracker.js";
import { scoreContextConviction } from "../ranking/context-conviction.js";

describe("loadRecentNewsSummary filter", () => {
  it("headlineMentionsTicker rejects unrelated sector headlines", () => {
    expect(headlineMentionsTicker("Sandisk shares surge on NAND outlook", null, "AMZN")).toBe(false);
    expect(headlineMentionsTicker("Amazon AMZN raises AWS guidance", null, "AMZN")).toBe(true);
  });
});

describe("summarizeNewsRows + attachNewsSummary", () => {
  const beRows = [
    {
      headline: "Bloom Energy (BE) added to the S&P 500",
      source: "Reuters",
      datetime_utc: "2026-09-08T14:00:00Z",
      sentiment: "bullish",
      catalyst_strength: 8,
      is_catalyst: 1,
    },
    {
      headline: "BE wins data-center fuel-cell contract",
      source: "WSJ",
      datetime_utc: "2026-09-09T11:00:00Z",
      sentiment: "bullish",
      catalyst_strength: 6,
      is_catalyst: 1,
    },
    {
      headline: "Unrelated sector note on industrials",
      sentiment: "neutral",
      is_catalyst: 0,
    },
  ];

  it("builds the CIO/conviction shape and keeps promotion aliases", () => {
    const s = summarizeNewsRows("BE", beRows, { lookbackDays: 5 });
    expect(s.has_data).toBe(true);
    expect(s.dominant_sentiment).toBe("bullish");
    expect(s.bullish_catalyst_count).toBe(2);
    expect(s.top_catalyst.headline).toMatch(/S&P 500/);
    expect(s.max_catalyst).toBe(8);
    expect(s.top_catalyst_headline).toMatch(/S&P 500/);
    expect(s.latest_3.length).toBeGreaterThanOrEqual(2);
  });

  it("stamps only has_data summaries and feeds context conviction", () => {
    const map = { BE: summarizeNewsRows("BE", beRows) };
    const td = { ticker: "BE" };
    attachNewsSummary(td, map);
    expect(td._news_summary.has_data).toBe(true);
    expect(td._news_summary.dominant_sentiment).toBe("bullish");
    const empty = { ticker: "XYZ" };
    attachNewsSummary(empty, { XYZ: summarizeNewsRows("XYZ", []) });
    expect(empty._news_summary).toBeUndefined();
    expect(compactNewsStamp({ has_data: false, count: 0 })).toBeNull();

    const ctx = scoreContextConviction({ ticker: "BE", _news_summary: td._news_summary }, "LONG");
    expect(ctx.parts.sentiment).toBe(8);
    expect(ctx.parts.index_inclusion).toBe(6);
    expect(ctx.pts).toBe(14);
  });
});
