import { describe, it, expect } from "vitest";
import {
  formatCROBriefAddendumFromNote,
  formatCRONoteForBriefUI,
  noteNeedsMacroMinuteRefresh,
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

describe("Tom Lee night take on the CRO note", () => {
  it("surfaces the spoken excerpt in the brief addendum", () => {
    const addendum = formatCROBriefAddendumFromNote({
      as_of_date: "2026-08-13",
      verdict: "Range-bound into CPI.",
      night_take: {
        pub_id: "1548863",
        has_transcript: true,
        published_at: "2026-08-12T22:10:00",
        excerpt: "SPX still range-bound; watch oil if Iran headlines heat up.",
      },
    });
    expect(addendum).toContain("Tom Lee night take");
    expect(addendum).toContain("range-bound");
  });

  it("forces a CRO refresh until the note cites the current episode", () => {
    expect(noteNeedsMacroMinuteRefresh(null, "1548863", true)).toBe(true);
    expect(noteNeedsMacroMinuteRefresh({ night_take: { pub_id: "old" } }, "1548863", true)).toBe(true);
    expect(noteNeedsMacroMinuteRefresh({ night_take: { pub_id: "1548863" } }, "1548863", true)).toBe(false);
    expect(noteNeedsMacroMinuteRefresh({}, "1548863", false)).toBe(false);
  });
});
