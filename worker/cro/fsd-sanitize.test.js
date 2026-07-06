import { describe, it, expect } from "vitest";
import { sanitizeFsdCopy, sanitizeFsdTitle } from "./fsd-sanitize.js";

describe("sanitizeFsdCopy", () => {
  it("removes credentialed author byline (author – headline)", () => {
    const out = sanitizeFsdCopy("Mark L. Newton, CMT – Monday's Technology rebound has helped $SPX attempt");
    expect(out).not.toMatch(/Mark L\. Newton/);
    expect(out).not.toMatch(/CMT/);
    expect(out).toContain("Monday's Technology rebound");
  });

  it("removes 'Fundstrat' / 'Fundstrat Direct' / FSD mentions", () => {
    expect(sanitizeFsdCopy("Fundstrat Direct research view: SPY holding support")).not.toMatch(/Fundstrat/i);
    expect(sanitizeFsdCopy("Fundstrat Direct research view: SPY holding support")).toContain("research view: SPY holding support");
    expect(sanitizeFsdCopy("Per Fundstrat, breadth is improving.")).not.toMatch(/Fundstrat/i);
    expect(sanitizeFsdCopy("FSD note: watch 5850")).not.toMatch(/\bFSD\b/);
  });

  it("handles CFA/PhD/CFP credentials as well", () => {
    expect(sanitizeFsdCopy("Jane Doe, CFA — bullish setup")).not.toMatch(/Jane Doe|CFA/);
    expect(sanitizeFsdCopy("John Smith, PhD - macro thesis")).not.toMatch(/John Smith|PhD/);
  });

  it("returns null / empty for null / empty input", () => {
    expect(sanitizeFsdCopy(null)).toBe(null);
    expect(sanitizeFsdCopy("")).toBe("");
  });

  it("collapses whitespace and strips brand + trailing punctuation", () => {
    const out = sanitizeFsdCopy("Fundstrat Direct - SPY test");
    expect(out).toBe("SPY test");
  });
});

describe("sanitizeFsdTitle", () => {
  it("falls back to provided default when sanitisation empties the string", () => {
    expect(sanitizeFsdTitle("Fundstrat", "Market Intel update")).toBe("Market Intel update");
    expect(sanitizeFsdTitle("", "Market Intel update")).toBe("Market Intel update");
    expect(sanitizeFsdTitle(null)).toBe("Market Intel update");
  });

  it("preserves usable headlines after scrub", () => {
    expect(sanitizeFsdTitle("Mark L. Newton, CMT – SPY back above 640"))
      .toBe("SPY back above 640");
  });
});
