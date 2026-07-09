import { describe, it, expect } from "vitest";
import {
  extractTickersFromText,
  parseMacroFromText,
  extractLevelsFromText,
  buildWireDiscordEmbed,
  DEFAULT_X_WATCHLIST,
} from "./x-wire-tracker.js";

describe("x-wire-tracker parsing", () => {
  it("extracts cashtags and index symbols", () => {
    const tickers = extractTickersFromText("$NVDA ripping while SPY holds 580");
    expect(tickers).toContain("NVDA");
    expect(tickers).toContain("SPY");
  });

  it("parses DeItaone-style macro prints", () => {
    const macro = parseMacroFromText("US MAY JOB OPENINGS 7.594M; EST. 7.296M");
    expect(macro).not.toBeNull();
    expect(macro.event_name).toMatch(/JOB OPENINGS/i);
    expect(macro.actual).toBe("7.594M");
    expect(macro.estimate).toBe("7.296M");
  });

  it("extracts support/resistance levels", () => {
    const levels = extractLevelsFromText("SPY holds support 580, resistance at 595");
    expect(levels.length).toBeGreaterThanOrEqual(2);
    expect(levels.some((l) => l.price === 580)).toBe(true);
    expect(levels.some((l) => l.price === 595)).toBe(true);
  });

  it("ships operator watchlist under 10 accounts", () => {
    expect(DEFAULT_X_WATCHLIST.length).toBeLessThan(10);
    expect(DEFAULT_X_WATCHLIST.map((a) => a.handle)).toContain("DeItaone");
    expect(DEFAULT_X_WATCHLIST.map((a) => a.handle)).toContain("fundstrat");
  });

  it("builds Discord embed with macro and tickers", () => {
    const embed = buildWireDiscordEmbed({
      handle: "DeItaone",
      kind: "macro_wire",
      text: "US MAY JOB OPENINGS 7.594M; EST. 7.296M",
      post_id: "123",
      url: "https://x.com/DeItaone/status/123",
      tickers_json: "[]",
      levels_json: null,
      macro_json: JSON.stringify({ event_name: "MAY JOB OPENINGS", actual: "7.594M", estimate: "7.296M" }),
      created_at: new Date().toISOString(),
    }, { reason: "objective real-time news" });
    expect(embed.title).toContain("DeItaone");
    expect(embed.fields.some((f) => f.name === "Macro print")).toBe(true);
    expect(embed.fields.some((f) => f.name === "Why we follow")).toBe(true);
  });
});
