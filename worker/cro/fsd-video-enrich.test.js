import { describe, it, expect } from "vitest";
import { VIDEO_POST_TITLE_PATTERNS, countMacroMinuteIngested } from "./fsd-ingestion.js";

/** Emulate SQLite `lower(title) LIKE pattern` for the enrichment query. */
function likeMatches(pattern, title) {
  const re = new RegExp(
    "^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$",
    "i",
  );
  return re.test(String(title).toLowerCase());
}
const anyPatternMatches = (title) => VIDEO_POST_TITLE_PATTERNS.some((p) => likeMatches(p, title));

describe("VIDEO_POST_TITLE_PATTERNS", () => {
  it("matches the two series that publish as video", () => {
    expect(anyPatternMatches("Video: Macro Minute: 5 reasons a Fed hike hurts")).toBe(true);
    expect(anyPatternMatches("Technical Strategy 08/14/2026")).toBe(true);
  });

  // The intraday Newton flashes are plain text. Matching them would re-fetch
  // every short post on every pass, since the enrichment retries anything thin.
  it("does not match Newton's intraday text flashes", () => {
    expect(anyPatternMatches("Mark L. Newton, CMT – All quiet ahead of CPI tomorrow am")).toBe(false);
    expect(anyPatternMatches("Mark L. Newton, CMT – Today's move in Litecoin is negative")).toBe(false);
  });

  it("does not match other FSD research posts", () => {
    expect(anyPatternMatches("Upticks – August 2026")).toBe(false);
    expect(anyPatternMatches("Bets on Rate Hikes Recede, Boosting Stocks")).toBe(false);
    expect(anyPatternMatches("Tom Lee, CFA – The latest U Mich consumer survey")).toBe(false);
  });
});

describe("countMacroMinuteIngested", () => {
  const result = {
    results: [
      { pub_id: "1", title: "Video: Macro Minute: CPI day", ok: true, vimeo: { chars: 5000 } },
      { pub_id: "2", title: "Technical Strategy 08/14/2026", ok: true, vimeo: { chars: 9767 } },
      { pub_id: "3", title: "Video: Macro Minute: failed one", ok: false, vimeo: null },
    ],
  };

  // The night-take sync is Tom Lee only; a Newton video must not trigger it.
  it("counts only Macro Minute episodes that actually gained a transcript", () => {
    expect(countMacroMinuteIngested(result)).toBe(1);
  });

  it("is safe on empty or malformed input", () => {
    expect(countMacroMinuteIngested(null)).toBe(0);
    expect(countMacroMinuteIngested({})).toBe(0);
    expect(countMacroMinuteIngested({ results: [{ ok: true, vimeo: {} }] })).toBe(0);
  });
});
