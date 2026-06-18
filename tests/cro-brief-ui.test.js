import { describe, it, expect } from "vitest";
import {
  formatCROBriefAddendumFromNote,
  formatCRONoteForBriefUI,
} from "../worker/cro/cro-service.js";

describe("formatCRONoteForBriefUI", () => {
  it("returns null for empty note", () => {
    expect(formatCRONoteForBriefUI(null)).toBeNull();
    expect(formatCRONoteForBriefUI({})).toBeNull();
  });

  it("maps verdict, observations, and summary for the brief card", () => {
    const ui = formatCRONoteForBriefUI({
      note_id: "n1",
      as_of_date: "2026-06-15",
      produced_at: 1718467200000,
      verdict: "Energy-led tape confirms supply-shock playbook.",
      observations: [{ section: "Rotation", text: "XLE +2.1% led while XLK lagged." }],
      full_note_md: "## Desk note\nLonger synthesis body.",
    });
    expect(ui.noteId).toBe("n1");
    expect(ui.asOfDate).toBe("2026-06-15");
    expect(ui.verdict).toContain("Energy-led");
    expect(ui.observations).toHaveLength(1);
    expect(ui.summaryMd).toContain("Longer synthesis");
  });
});

describe("formatCROBriefAddendumFromNote evening slot", () => {
  it("includes evening wrap instruction and larger excerpt budget", () => {
    const addendum = formatCROBriefAddendumFromNote({
      as_of_date: "2026-06-15",
      verdict: "Risk-off rotation persisted.",
      observations: [{ section: "Breadth", text: "Leaders narrow." }],
      full_note_md: "x".repeat(3000),
    }, { slot: "evening" });
    expect(addendum).toContain("EVENING WRAP INSTRUCTION");
    expect(addendum).toContain("day-end wrap");
    expect(addendum.length).toBeLessThan(4500);
  });
});
