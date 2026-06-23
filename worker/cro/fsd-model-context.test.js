import { describe, it, expect } from "vitest";
import {
  spxLevelToSpy,
  spyPriceToSpx,
  publicationMentionsSpx,
  tickersIncludeMemoryTheme,
  summarizeCTOForPrompt,
  MEMORY_THEME_TICKERS,
} from "./fsd-model-context.js";

describe("fsd-model-context", () => {
  it("converts SPX levels to SPY proxy", () => {
    expect(spxLevelToSpy(7415)).toBe(741.5);
    expect(spxLevelToSpy(7513)).toBe(751.3);
    expect(spyPriceToSpx(744.48)).toBe(7444.8);
  });

  it("detects SPX and memory mentions", () => {
    expect(publicationMentionsSpx("^SPX needs to hold 7415")).toBe(true);
    expect(publicationMentionsSpx("NVDA rally")).toBe(false);
    expect(tickersIncludeMemoryTheme(["MU", "AAPL"])).toBe(true);
    expect(tickersIncludeMemoryTheme(["AAPL"])).toBe(false);
  });

  it("summarizes CTO payload for prompt", () => {
    const line = summarizeCTOForPrompt("MU", {
      current_price: 120.5,
      top_upside: [{ label: "Fib 38.2%", price: 125.2, regime_adjusted_prob: 0.62 }],
      top_downside: [{ label: "Pivot S1", price: 115.0, regime_adjusted_prob: 0.55 }],
      read: { label: "Upside lean" },
    });
    expect(line).toContain("CTO MU:");
    expect(line).toContain("anchor=$120.50");
    expect(line).toContain("upside=");
  });

  it("lists memory theme tickers including SNDK and WDC", () => {
    expect(MEMORY_THEME_TICKERS).toEqual(expect.arrayContaining(["MU", "SNDK", "WDC", "STX"]));
  });
});
