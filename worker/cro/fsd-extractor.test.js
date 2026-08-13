import { describe, it, expect } from "vitest";
import {
  isSectorAllocationPublication,
  applyPublicationTypeHints,
  categorizeProposal,
} from "./fsd-extractor.js";

describe("sector allocation publication classification", () => {
  it("detects sector allocation from title", () => {
    expect(isSectorAllocationPublication("June 2026 Sector Allocation Update", "")).toBe(true);
    expect(isSectorAllocationPublication("Daily Technical Strategy", "")).toBe(false);
  });

  it("forces structural classification for sector allocation decks", () => {
    const parsed = applyPublicationTypeHints(
      { classification: "tactical", tactical_signals_add: [{ signal: "x" }] },
      { title: "June 2026 Sector Allocation Update", text: "Health Care XLV 9.5%" },
    );
    expect(parsed.classification).toBe("structural");
    expect(categorizeProposal(parsed)).toBe("structural");
  });

  it("leaves tactical dailies unchanged", () => {
    const parsed = applyPublicationTypeHints(
      { classification: "tactical", tactical_signals_add: [{ signal: "x" }] },
      { title: "Mark Newton — SPX consolidation risk", text: "RSP/SPY ratio" },
    );
    expect(parsed.classification).toBe("tactical");
    expect(categorizeProposal(parsed)).toBe("actionable");
  });

  it("marks Macro Minute as on-theme tactical so trusted FSD can auto-apply", () => {
    const parsed = applyPublicationTypeHints(
      { classification: "tactical", self_assessment: { confidence: 0.4, on_theme: false, review_recommended: true } },
      { title: "Video: Macro Minute: CPI day", text: "--- VIDEO TRANSCRIPT ---\nGood evening" },
    );
    expect(parsed.classification).toBe("tactical");
    expect(parsed.self_assessment.on_theme).toBe(true);
    expect(parsed.self_assessment.review_recommended).toBe(false);
    expect(parsed.self_assessment.confidence).toBe(0.85);
  });
});
