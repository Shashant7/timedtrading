import { describe, it, expect } from "vitest";
import {
  parseEconNumber,
  classifySurprise,
  computeMacroPollSchedule,
  macroEventNormKey,
  macroReleaseIsTrustworthy,
  ruleBasedReleaseSummary,
} from "./macro-release-alerts.js";
import { dropCopiedForecastActual } from "./cro/macro-event-extractor.js";

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

describe("macroReleaseIsTrustworthy", () => {
  it("trusts authoritative FRED / curated actuals", () => {
    expect(macroReleaseIsTrustworthy({ actual: "139K", estimate: "85K", actual_source: "fred" })).toBe(true);
    expect(macroReleaseIsTrustworthy({ actual: "55.7", estimate: "55.7", actual_source: "fred" })).toBe(true);
    expect(macroReleaseIsTrustworthy({ actual: "50.0", estimate: "50.0", actual_source: "curated" })).toBe(true);
  });

  it("rejects FSD actual that equals estimate (copied-forecast fabrication)", () => {
    // The exact Jun S&P Manufacturing PMI bug: 55.7 actual / 55.7 est / IN LINE.
    expect(macroReleaseIsTrustworthy({
      name: "Jun F S&P Manu PMI", actual: "55.7", estimate: "55.7", actual_source: "fsd",
    })).toBe(false);
  });

  it("rejects FSD actual with no estimate to corroborate", () => {
    expect(macroReleaseIsTrustworthy({ actual: "55.7", estimate: null, actual_source: "fsd" })).toBe(false);
  });

  it("allows FSD actual that is genuinely distinct from consensus (real X vs Ye)", () => {
    expect(macroReleaseIsTrustworthy({
      name: "Jun ISM Manufacturing PMI", actual: "53.9", estimate: "51.6", actual_source: "fsd",
    })).toBe(true);
  });
});

describe("dropCopiedForecastActual", () => {
  it("clears an actual that mirrors the estimate", () => {
    const row = { name: "Jun F S&P Manu PMI", actual: "55.7", estimate: "55.7", actual_source: "fsd" };
    dropCopiedForecastActual(row);
    expect(row.actual).toBeNull();
    expect(row.actual_source).toBeNull();
    expect(row.estimate).toBe("55.7");
  });

  it("keeps a distinct actual vs estimate", () => {
    const row = { actual: "53.9", estimate: "51.6", actual_source: "fsd" };
    dropCopiedForecastActual(row);
    expect(row.actual).toBe("53.9");
  });

  it("leaves rows without an actual untouched", () => {
    const row = { actual: null, estimate: "55.7" };
    dropCopiedForecastActual(row);
    expect(row.actual).toBeNull();
    expect(row.estimate).toBe("55.7");
  });
});

describe("macroEventNormKey", () => {
  it("normalizes names to canonical series keys", () => {
    expect(macroEventNormKey("2026-06-30", "May JOLTS Job Openings"))
      .toBe("2026-06-30|jolts");
    expect(macroEventNormKey("2026-06-30", "May JOLTS"))
      .toBe("2026-06-30|jolts");
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
