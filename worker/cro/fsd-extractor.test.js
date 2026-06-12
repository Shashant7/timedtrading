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
});
