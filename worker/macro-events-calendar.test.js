import { describe, it, expect } from "vitest";
import { CURATED_UPCOMING_MACRO } from "./macro-events-calendar.js";

describe("CURATED_UPCOMING_MACRO", () => {
  it("includes the rest of 2026 FOMC decision days", () => {
    const fomc = CURATED_UPCOMING_MACRO.filter((e) => e.kind === "fomc").map((e) => e.date);
    expect(fomc).toContain("2026-09-16");
    expect(fomc).toContain("2026-10-28");
    expect(fomc).toContain("2026-12-09");
  });
});
