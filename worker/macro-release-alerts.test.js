import { describe, it, expect } from "vitest";
import {
  parseEconNumber,
  classifySurprise,
  computeMacroPollSchedule,
  macroEventNormKey,
  ruleBasedReleaseSummary,
} from "./macro-release-alerts.js";

describe("parseEconNumber", () => {
  it("parses K/M suffixes and percents", () => {
    expect(parseEconNumber("+85K")).toBe(85000);
    expect(parseEconNumber("0.30%")).toBe(0.3);
    expect(parseEconNumber("7.5M")).toBe(7500000);
  });
});

describe("classifySurprise", () => {
  it("labels above/below/inline", () => {
    expect(classifySurprise("0.35%", "0.30%").direction).toBe("above");
    expect(classifySurprise("0.25%", "0.30%").direction).toBe("below");
    expect(classifySurprise("0.30%", "0.30%").direction).toBe("inline");
  });
});

describe("computeMacroPollSchedule", () => {
  it("polls fast inside release window", () => {
    // Wednesday 2026-06-30 10:05 ET — JOLTS at 10:00 AM
    const now = new Date("2026-06-30T14:05:00.000Z"); // 10:05 ET (EDT)
    const schedule = computeMacroPollSchedule([
      { date: "2026-06-30", time_et: "10:00 AM", name: "JOLTS", is_today: true },
    ], now);
    expect(schedule.poll_interval_ms).toBeLessThanOrEqual(60_000);
    expect(schedule.reason).toBe("release_window");
  });

  it("polls slowly on quiet days", () => {
    const now = new Date("2026-06-30T14:05:00.000Z");
    const schedule = computeMacroPollSchedule([
      { date: "2026-07-02", time_et: "8:30 AM", name: "NFP" },
    ], now);
    expect(schedule.poll_interval_ms).toBeGreaterThanOrEqual(300_000);
  });
});

describe("macroEventNormKey", () => {
  it("normalizes names", () => {
    expect(macroEventNormKey("2026-06-30", "May JOLTS Job Openings"))
      .toBe("2026-06-30|may jolts job openings");
  });
});

describe("ruleBasedReleaseSummary", () => {
  it("mentions actual and surprise", () => {
    const s = ruleBasedReleaseSummary(
      { name: "May CPI", actual: "0.3%", estimate: "0.2%", kind: "inflation" },
      { label: "ABOVE consensus", direction: "above" },
    );
    expect(s).toContain("Actual 0.3%");
    expect(s).toContain("ABOVE consensus");
  });
});
