import { describe, it, expect } from "vitest";
import {
  computeSpxSpyRatio,
  translateSpxLevelToSpy,
  translateSpyLevelToSpx,
  publicationMentionsSpx,
  tickersIncludeMemoryTheme,
  summarizeCTOForPrompt,
  MEMORY_THEME_TICKERS,
} from "./fsd-model-context.js";

describe("fsd-model-context", () => {
  it("uses live SPX/SPY ratio instead of fixed 10:1", () => {
    const spx = 7378.82;
    const spy = 734.94;
    const ratio = computeSpxSpyRatio(spx, spy);
    expect(ratio).toBeCloseTo(10.039, 2);
    expect(translateSpxLevelToSpy(7415, ratio)).toBeCloseTo(7415 / ratio, 1);
    expect(translateSpyLevelToSpx(spy, ratio)).toBeCloseTo(spx, 0);
    // Naive ÷10 would give 741.5 — wrong vs live ratio
    expect(translateSpxLevelToSpy(7415, 10)).toBe(741.5);
    expect(translateSpxLevelToSpy(7415, ratio)).not.toBe(741.5);
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
