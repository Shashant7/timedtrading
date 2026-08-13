import { describe, it, expect } from "vitest";
import {
  extractTickersFromText,
  parseMacroFromText,
  extractLevelsFromText,
  buildWireDiscordEmbed,
  buildWireRowFromTweet,
  decodeXWireText,
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

  it("ships Delta One as the sole default watchlist account", () => {
    expect(DEFAULT_X_WATCHLIST.length).toBe(1);
    expect(DEFAULT_X_WATCHLIST[0].handle).toBe("DeItaone");
    expect(DEFAULT_X_WATCHLIST[0].reason).toMatch(/Delta One/i);
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

  it("decodes X API HTML entities (S&amp;P → S&P)", () => {
    const raw = "YARDENI LIFTS S&amp;P 500 TARGET TO 8,400\n\nEd Yardeni raised his S&amp;P 500 target to 8,400.";
    expect(decodeXWireText(raw)).toBe(
      "YARDENI LIFTS S&P 500 TARGET TO 8,400\n\nEd Yardeni raised his S&P 500 target to 8,400.",
    );
    expect(decodeXWireText("AT&amp;T &lt; NVDA &gt; &#39;quote&#39;")).toBe("AT&T < NVDA > 'quote'");
    // Already-decoded text stays stable.
    expect(decodeXWireText("S&P 500")).toBe("S&P 500");
  });

  it("persists decoded text from X API tweet payloads", () => {
    const row = buildWireRowFromTweet("DeItaone", "macro_wire", {
      id: "999",
      text: "YARDENI LIFTS S&amp;P 500 TARGET TO 8,400",
      created_at: "2026-08-13T10:49:00.000Z",
    });
    expect(row).not.toBeNull();
    expect(row.text).toBe("YARDENI LIFTS S&P 500 TARGET TO 8,400");
    expect(row.text).not.toContain("&amp;");
  });

  it("Discord embed description decodes entities for legacy D1 rows", () => {
    const embed = buildWireDiscordEmbed({
      handle: "DeItaone",
      kind: "macro_wire",
      text: "YARDENI LIFTS S&amp;P 500 TARGET TO 8,400\n\nHe now expects 2026 S&amp;P 500 earnings of $375.",
      post_id: "456",
      url: "https://x.com/DeItaone/status/456",
      tickers_json: "[]",
      levels_json: null,
      macro_json: null,
      created_at: "2026-08-13T10:49:00.000Z",
    }, { reason: "Delta One — Walter Bloomberg real-time macro wire" });
    expect(embed.description).toContain("S&P 500");
    expect(embed.description).not.toContain("&amp;");
  });
});
