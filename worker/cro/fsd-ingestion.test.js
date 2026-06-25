import { describe, it, expect } from "vitest";
import {
  extractCashtagsFromText,
  expandResearchDeskTickerTags,
  researchDeskIntelQueryTickers,
  publicationMentionsTicker,
  buildMarketIntelDiscordTitle,
  MARKET_INTEL_DISCORD_TITLE_MAX,
  RESEARCH_DESK_INDEX_ALIASES,
} from "./fsd-ingestion.js";

describe("research desk SPX alias mapping", () => {
  it("maps SPX index tokens to SPY, ES1!, and ES when tagging", () => {
    expect(RESEARCH_DESK_INDEX_ALIASES.SPX).toEqual(["SPY", "ES1!", "ES"]);
    expect(expandResearchDeskTickerTags(["SPX"])).toEqual(["SPX", "SPY", "ES1!", "ES"]);
  });

  it("extracts ^SPX prose and expands tradeable proxies", () => {
    const tags = extractCashtagsFromText(
      "Structurally, ^SPX needs to clear 6775 before a larger rally.",
    );
    expect(tags).toContain("SPX");
    expect(tags).toContain("SPY");
    expect(tags).toContain("ES1!");
    expect(tags).toContain("ES");
  });

  it("extracts $SPX cashtags and expands proxies", () => {
    const tags = extractCashtagsFromText("$SPX closed above 7600 while RSP/SPY rotated.");
    expect(tags).toContain("SPY");
    expect(tags).toContain("ES1!");
  });

  it("includes SPX in intel queries for SPY and ES1!", () => {
    expect(researchDeskIntelQueryTickers("SPY")).toEqual(expect.arrayContaining(["SPY", "SPX"]));
    expect(researchDeskIntelQueryTickers("ES1!")).toEqual(expect.arrayContaining(["ES1!", "SPX"]));
    expect(researchDeskIntelQueryTickers("ES")).toEqual(expect.arrayContaining(["ES", "SPX"]));
  });

  it("matches SPX mentions when filtering intel for SPY", () => {
    const title = "Time to Favor Equal-Weighted SPX over Cap-Weighted";
    const excerpt = "^SPX closed > 7,600 on a 9-day win streak.";
    expect(publicationMentionsTicker(title, excerpt, "SPY")).toBe(true);
    expect(publicationMentionsTicker(title, excerpt, "ES1!")).toBe(true);
    expect(publicationMentionsTicker(title, excerpt, "AAPL")).toBe(false);
  });
});

describe("Market Intel Discord title", () => {
  it("includes tickers and TT headline so same-tag flashes look distinct", () => {
    const title = buildMarketIntelDiscordTitle(
      ["MAGS", "SPY"],
      "QQQ faces resistance near 732-734 amid mixed market signals",
    );
    expect(title).toBe(
      "📡 Market Intel — MAGS, SPY · QQQ faces resistance near 732-734 amid mixed market signals",
    );
  });

  it("truncates long headlines to the Discord embed title limit", () => {
    const longHeadline = "A".repeat(300);
    const title = buildMarketIntelDiscordTitle(["SPY"], longHeadline);
    expect(title.length).toBeLessThanOrEqual(MARKET_INTEL_DISCORD_TITLE_MAX);
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("📡 Market Intel — SPY · ")).toBe(true);
  });

  it("shows overflow ticker count when more than three match", () => {
    const title = buildMarketIntelDiscordTitle(
      ["MAGS", "SPY", "QQQ", "IWM"],
      "Breadth improving into the close",
    );
    expect(title).toContain("MAGS, SPY, QQQ +1 · Breadth improving into the close");
  });
});
