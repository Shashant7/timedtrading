import { describe, it, expect } from "vitest";
import {
  dedupeMacroEventsByCanonical,
  macroEventCanonicalKey,
  mergeMacroEventRow,
  pickPreferredMacroName,
} from "./macro-event-canonical.js";

describe("macroEventCanonicalKey", () => {
  it("maps JOLTS name variants to the same series key", () => {
    expect(macroEventCanonicalKey("2026-06-30", "May JOLTS Job Openings")).toBe("2026-06-30|jolts");
    expect(macroEventCanonicalKey("2026-06-30", "May JOLTS")).toBe("2026-06-30|jolts");
    expect(macroEventCanonicalKey("2026-06-30", "JOLTS")).toBe("2026-06-30|jolts");
  });

  it("keeps distinct series on the same date separate", () => {
    expect(macroEventCanonicalKey("2026-06-05", "May Non-Farm Payrolls")).toBe("2026-06-05|nfp");
    expect(macroEventCanonicalKey("2026-06-05", "May Unemployment Rate")).toBe("2026-06-05|unrate");
  });
});

describe("mergeMacroEventRow", () => {
  it("prefers the longer curated title and merges FSD actual", () => {
    const merged = mergeMacroEventRow(
      {
        date: "2026-06-30",
        time_et: "10:00 AM",
        name: "May JOLTS Job Openings",
        impact: "medium",
        kind: "jobs",
        source: "curated",
      },
      {
        date: "2026-06-30",
        name: "May JOLTS",
        actual: "7.4M",
        actual_source: "fsd",
        source: "fsd",
      },
    );
    expect(merged.name).toBe("May JOLTS Job Openings");
    expect(merged.actual).toBe("7.4M");
    expect(merged.time_et).toBe("10:00 AM");
    expect(merged.source).toBe("merged");
  });

  it("pickPreferredMacroName favors descriptive titles", () => {
    expect(pickPreferredMacroName("May JOLTS", "May JOLTS Job Openings"))
      .toBe("May JOLTS Job Openings");
  });
});

describe("dedupeMacroEventsByCanonical", () => {
  it("collapses duplicate JOLTS rows into one", () => {
    const out = dedupeMacroEventsByCanonical([
      { date: "2026-06-30", time_et: "10:00 AM", name: "May JOLTS Job Openings", impact: "medium" },
      { date: "2026-06-30", name: "May JOLTS", actual: "7.4M", actual_source: "fsd" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("May JOLTS Job Openings");
    expect(out[0].actual).toBe("7.4M");
  });
});
