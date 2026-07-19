import { describe, it, expect } from "vitest";
import {
  thirdFridayYmd,
  isTripleWitchingMonth,
  opexEventName,
  listOpexMacroEvents,
  OPEX_RISK_WINDOW_HOURS,
} from "./opex-calendar.js";
import { classifyMarketEventKey } from "./daily-brief.js";
import { resolveMacroSeriesKey } from "./macro-event-canonical.js";

describe("opex-calendar", () => {
  it("computes known 3rd Fridays", () => {
    expect(thirdFridayYmd(2026, 7)).toBe("2026-07-17");
    expect(thirdFridayYmd(2026, 8)).toBe("2026-08-21");
    expect(thirdFridayYmd(2026, 9)).toBe("2026-09-18");
    expect(thirdFridayYmd(2025, 12)).toBe("2025-12-19");
    expect(thirdFridayYmd(2026, 3)).toBe("2026-03-20");
  });

  it("labels triple witching months", () => {
    expect(isTripleWitchingMonth(3)).toBe(true);
    expect(isTripleWitchingMonth(7)).toBe(false);
    expect(opexEventName("2026-09-18")).toMatch(/Triple Witching/i);
    expect(opexEventName("2026-08-21")).toMatch(/OpEx/i);
  });

  it("lists upcoming OpEx inside a date window", () => {
    const rows = listOpexMacroEvents({
      fromDate: "2026-07-01",
      toDate: "2026-09-30",
      months: 6,
    });
    expect(rows.map((r) => r.date)).toEqual(["2026-07-17", "2026-08-21", "2026-09-18"]);
    expect(rows.every((r) => r.kind === "opex" && r.impact === "high")).toBe(true);
    expect(OPEX_RISK_WINDOW_HOURS).toBe(8);
  });

  it("classifies OpEx names to OPEX event key", () => {
    expect(classifyMarketEventKey("Monthly Options Expiration (OpEx)")).toBe("OPEX");
    expect(classifyMarketEventKey("Monthly Options Expiration (Triple Witching)")).toBe("OPEX");
    expect(resolveMacroSeriesKey("Monthly Options Expiration (OpEx)")).toBe("opex");
  });
});
