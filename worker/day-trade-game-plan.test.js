import { describe, it, expect } from "vitest";
import { computeDayLean, buildOvernightDayTradeGamePlan } from "./day-trade-game-plan.js";

describe("computeDayLean", () => {
  it("leans SHORT when gapping below prior close, under overnight mid, OR-low break, daily down", () => {
    const r = computeDayLean({
      curPrice: 98,
      anchor: 100,
      dayAtr: 4,
      overnightRange: { high: 101, low: 99 },
      openingRange: { high: 99.5, low: 98.5, resolved: true },
      trendBias: -1,
    });
    expect(r.lean).toBe("SHORT");
    expect(r.score).toBeLessThan(0);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("leans LONG on the mirror-image bullish setup", () => {
    const r = computeDayLean({
      curPrice: 102,
      anchor: 100,
      dayAtr: 4,
      overnightRange: { high: 101, low: 99 },
      openingRange: { high: 101.5, low: 100.5, resolved: true },
      trendBias: 1,
    });
    expect(r.lean).toBe("LONG");
    expect(r.score).toBeGreaterThan(0);
  });

  it("is NEUTRAL when evidence is mixed / price hugs prior close", () => {
    const r = computeDayLean({
      curPrice: 100.02,
      anchor: 100,
      dayAtr: 4,
      overnightRange: { high: 100.5, low: 99.5 },
      openingRange: { high: 100.4, low: 99.6, resolved: false },
      trendBias: 0,
    });
    expect(r.lean).toBe("NEUTRAL");
  });

  it("ignores an unresolved opening range (no OR-break credit before the window closes)", () => {
    const withUnresolved = computeDayLean({
      curPrice: 97,
      anchor: 100,
      dayAtr: 4,
      overnightRange: { high: 101, low: 99 },
      openingRange: { high: 98, low: 97.5, resolved: false }, // px below OR low but unresolved
      trendBias: 0,
    });
    // gap-down (-1) + under overnight mid (-1) = -2 → SHORT, but no OR credit
    expect(withUnresolved.reasons).not.toContain("broke the opening range low");
  });

  it("surfaces the lean on the built game plan (snake_case)", () => {
    const plan = buildOvernightDayTradeGamePlan({
      curPrice: 98, anchor: 100, dayAtr: 4,
      overnightRange: { high: 101, low: 99 },
      openingRange: { high: 99.5, low: 98.5, resolved: true },
      trendBias: -1,
      snakeCase: true,
    });
    expect(plan.lean).toBe("SHORT");
    expect(plan.bear_trigger).toBeLessThan(plan.bull_trigger);
    expect(Array.isArray(plan.lean_reasons)).toBe(true);
  });
});
