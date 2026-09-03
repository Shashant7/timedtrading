import { describe, it, expect } from "vitest";
import {
  computeDayLean,
  buildOvernightDayTradeGamePlan,
  computeOvernightRangeFromM5,
  computeOpeningRangeFromM5,
  gamePlanSessionBounds,
  structuralDayTradeInvalidation,
} from "./day-trade-game-plan.js";
import { sessionBoundsUtc } from "./foundation/trading-calendar.js";

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

  it("research desk posture tilts the lean and is surfaced, but never overrides the tape", () => {
    // Strong intraday SHORT evidence; a constructive desk tilt should NOT flip
    // it to long — it only nudges (bounded ±0.5).
    const r = computeDayLean({
      curPrice: 98, anchor: 100, dayAtr: 4,
      overnightRange: { high: 101, low: 99 },
      openingRange: { high: 99.5, low: 98.5, resolved: true },
      trendBias: 0,
      researchBias: 0.6, // desk constructive
    });
    expect(r.lean).toBe("SHORT");
    expect(r.reasons).toContain("research desk constructive");
    // A flat tape + a defensive desk read surfaces the reason without forcing a lean.
    const flat = computeDayLean({
      curPrice: 100.01, anchor: 100, dayAtr: 4,
      overnightRange: { high: 100.4, low: 99.6 },
      researchBias: -0.4,
    });
    expect(flat.reasons).toContain("research desk defensive");
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

function bar(utcIso, o, h, l, c) {
  return { ts: Date.parse(utcIso), o, h, l, c };
}

describe("game-plan session windows are DST-correct", () => {
  it("EDT (Sep 2026): cash open 13:30Z, prior close 20:00Z", () => {
    const b = gamePlanSessionBounds(new Date("2026-09-02T15:10:00.000Z"));
    expect(b.sessionDate).toBe("2026-09-02");
    expect(b.priorDate).toBe("2026-09-01");
    expect(b.openMs).toBe(Date.UTC(2026, 8, 2, 13, 30));
    expect(b.priorCloseMs).toBe(Date.UTC(2026, 8, 1, 20, 0));
    expect(sessionBoundsUtc("2026-09-02").openMs).toBe(b.openMs);
  });

  it("EST (Jan 2026): cash open 14:30Z, prior close 21:00Z", () => {
    const b = gamePlanSessionBounds(new Date("2026-01-15T16:10:00.000Z"));
    expect(b.sessionDate).toBe("2026-01-15");
    expect(b.openMs).toBe(Date.UTC(2026, 0, 15, 14, 30));
    expect(b.priorCloseMs).toBe(Date.UTC(2026, 0, 14, 21, 0));
  });

  it("Monday session uses Friday close, not UTC-day-2", () => {
    const b = gamePlanSessionBounds(new Date("2026-06-15T14:00:00.000Z")); // Mon EDT
    expect(b.sessionDate).toBe("2026-06-15");
    expect(b.priorDate).toBe("2026-06-12");
    expect(b.priorCloseMs).toBe(Date.UTC(2026, 5, 12, 20, 0));
  });
});

describe("opening / overnight ranges do not eat the cash bounce (2026-09-02)", () => {
  // Live SPY 5m: cash open 761.78 → 762.93 by 10:00 ET, then 764+.
  // Hardcoded 14:30Z treated 09:30–10:30 as overnight and 10:30–11:00 as OR.
  const spyBars = [
    bar("2026-09-01T19:50:00.000Z", 761.04, 761.04, 760.85, 760.85), // still Tue RTH
    bar("2026-09-02T13:30:00.000Z", 761.78, 762.33, 761.78, 762.33),
    bar("2026-09-02T13:35:00.000Z", 762.33, 762.33, 762.23, 762.23),
    bar("2026-09-02T13:40:00.000Z", 762.23, 762.68, 762.23, 762.58),
    bar("2026-09-02T13:45:00.000Z", 762.58, 762.58, 762.18, 762.18),
    bar("2026-09-02T13:50:00.000Z", 762.18, 762.46, 762.18, 762.46),
    bar("2026-09-02T13:55:00.000Z", 762.46, 762.93, 762.46, 762.93),
    bar("2026-09-02T14:00:00.000Z", 762.93, 763.48, 762.93, 763.48),
    bar("2026-09-02T14:05:00.000Z", 763.48, 764.00, 763.48, 763.88),
    bar("2026-09-02T14:25:00.000Z", 764.14, 765.37, 764.14, 765.37),
    bar("2026-09-02T14:40:00.000Z", 765.54, 766.31, 765.54, 766.31),
    bar("2026-09-02T14:55:00.000Z", 765.38, 765.38, 765.19, 765.19),
  ];

  it("OR is 09:30–10:00 ET (761.78–762.93), not the 10:30 chop", () => {
    const or = computeOpeningRangeFromM5(spyBars, new Date("2026-09-02T15:10:00.000Z"));
    expect(or.low).toBe(761.78);
    expect(or.high).toBe(762.93);
    expect(or.resolved).toBe(true);
    expect(or.bars).toBe(6);
  });

  it("overnight fallback never includes today's RTH bounce", () => {
    const ov = computeOvernightRangeFromM5(spyBars, new Date("2026-09-02T15:10:00.000Z"));
    expect(ov.high).toBeLessThan(762);
    expect(ov.source).toBe("pre_open_fallback");
    expect(ov.high).toBe(761.04);
  });

  it("after the real OR high breaks, lean is LONG calls — not WAIT puts", () => {
    const now = new Date("2026-09-02T14:10:00.000Z"); // 10:10 ET, 764
    const overnightRange = computeOvernightRangeFromM5(spyBars, now);
    const openingRange = computeOpeningRangeFromM5(spyBars, now);
    const lean = computeDayLean({
      curPrice: 764.14,
      anchor: 761.78,
      dayAtr: 4.79,
      overnightRange,
      openingRange,
      trendBias: 0,
      researchBias: 0.3,
    });
    expect(openingRange.resolved).toBe(true);
    expect(lean.reasons).toContain("broke the opening range high");
    expect(lean.reasons).not.toContain("broke the opening range low");
    expect(lean.lean).toBe("LONG");
    expect(lean.conviction).not.toBe("low");
  });
});

describe("structuralDayTradeInvalidation", () => {
  it("put invalidation is overnight/OR/prior close — not spot + 0.25 ATR", () => {
    const inv = structuralDayTradeInvalidation({
      overnight_range: { high: 764.49, low: 760.81 },
      opening_range: { high: 762.93, low: 761.78, resolved: true },
    }, { prevClose: 761.78 });
    expect(inv.inv_put).toBe(764.49);
    expect(inv.inv_call).toBe(760.81);
    expect(inv.or_resolved).toBe(true);
    // Chasing trigger would be ~765.5 and never print. 766.35 clears structure.
    expect(766.35).toBeGreaterThan(inv.inv_put);
  });

  it("does not use an unresolved OR high as put invalidation", () => {
    const inv = structuralDayTradeInvalidation({
      overnight_range: { high: 762.0, low: 760.5 },
      opening_range: { high: 766.0, low: 765.0, resolved: false },
    }, { prevClose: 761.78 });
    expect(inv.inv_put).toBe(762);
    expect(inv.or_resolved).toBe(false);
  });
});
