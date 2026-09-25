// worker/day-trade-thesis-exit.test.js
//
// 2026-09-25: SPY 763P / QQQ 737P were bought on opening-range breaks of
// 0.07 / 0.06 day-ATR that were reclaimed within 20 minutes; the lean went
// NEUTRAL and both books rode to the -50% premium stop.

import { describe, it, expect } from "vitest";
import { computeDayLean, OR_BREAK_BUFFER_ATR } from "./day-trade-game-plan.js";
import { evaluateDayTradeThesis, buildExecutionClock } from "./option-execution-clock.js";
import {
  classifyPaperEvent,
  describePaperExitReason,
  THESIS_LEAN_OFF_MS,
  THESIS_RECLAIM_MS,
} from "./option-day-trade-plan.js";
import { summarizeDayTradeGamePlan } from "./options-plays.js";

const ET = "-04:00";
const ts = (iso) => Date.parse(iso);
const T0 = ts(`2026-09-25T10:20:00${ET}`);

// SPY 2026-09-25 10:16: overnight 765.66-770.97, OR 767.77-770.28, day ATR
// 6.42, spot 767.33 (0.07 ATR under the OR low). The stored lean was -2.35 =
// under the overnight midpoint (-1) + OR break (-1.5) + research (+0.15).
const SPY = {
  anchor: 767.50,
  dayAtr: 6.42,
  overnightRange: { high: 770.97, low: 765.66 },
  openingRange: { high: 770.28, low: 767.77, resolved: true },
  trendBias: 0,
  researchBias: 0.3,
};

describe("computeDayLean — opening-range break buffer", () => {
  it("does not count a break smaller than the buffer (9/25 SPY)", () => {
    const withBuf = computeDayLean({ ...SPY, curPrice: 767.33 });
    const old = computeDayLean({ ...SPY, curPrice: 767.33, orBreakBufferAtr: 0 });
    expect(old.lean).toBe("SHORT");
    expect(old.score).toBe(-2.35);
    expect(old.reasons).toContain("broke the opening range low");
    expect(withBuf.reasons).not.toContain("broke the opening range low");
    expect(withBuf.lean).toBe("NEUTRAL");
  });

  it("still counts a real break", () => {
    const px = SPY.openingRange.low - (OR_BREAK_BUFFER_ATR + 0.05) * SPY.dayAtr;
    const l = computeDayLean({ ...SPY, curPrice: px });
    expect(l.reasons).toContain("broke the opening range low");
    expect(l.lean).toBe("SHORT");
  });
});

describe("summarizeDayTradeGamePlan — carries the resolved OR", () => {
  it("exposes or_low / or_high only once the OR has resolved", () => {
    expect(summarizeDayTradeGamePlan({ lean: "SHORT", opening_range: { high: 770.28, low: 767.77, resolved: true } }))
      .toMatchObject({ or_low: 767.77, or_high: 770.28 });
    expect(summarizeDayTradeGamePlan({ lean: "SHORT", opening_range: { high: 770, low: 767, resolved: false } }))
      .toMatchObject({ or_low: null, or_high: null });
  });
});

describe("evaluateDayTradeThesis", () => {
  const thesis = { lean: "SHORT", spot: 767.33, or_low: 767.77, or_high: 770.28 };

  it("applies only to a book the lean opened", () => {
    expect(evaluateDayTradeThesis({ isPut: true, spot: 768, lean: "NEUTRAL", entryThesis: { ...thesis, lean: "NEUTRAL" } })).toBeNull();
    expect(evaluateDayTradeThesis({ isPut: true, spot: 768, lean: "NEUTRAL", entryThesis: null })).toBeNull();
  });

  it("sees the lean leave, the OR low reclaimed, and the book red", () => {
    expect(evaluateDayTradeThesis({ isPut: true, spot: 768.10, lean: "NEUTRAL", entryThesis: thesis }))
      .toEqual({ red: true, lean_off: true, reclaimed: true, broken_level: 767.77 });
  });

  it("is not red while the put is working", () => {
    expect(evaluateDayTradeThesis({ isPut: true, spot: 766.50, lean: "NEUTRAL", entryThesis: thesis }).red).toBe(false);
  });

  it("no reclaim test when the ticket was not opened through the OR", () => {
    const inside = { ...thesis, spot: 768.50 };
    expect(evaluateDayTradeThesis({ isPut: true, spot: 769, lean: "SHORT", entryThesis: inside }).reclaimed).toBe(false);
  });

  it("mirrors for calls", () => {
    const c = { lean: "LONG", spot: 771, or_low: 767.77, or_high: 770.28 };
    expect(evaluateDayTradeThesis({ isPut: false, spot: 770.00, lean: "LONG", entryThesis: c }))
      .toMatchObject({ red: true, lean_off: false, reclaimed: true });
  });
});

describe("classifyPaperEvent — thesis exit", () => {
  const book = {
    status: "open",
    entry_premium: 1.47,
    entry_ts: T0 - 4 * 60_000,
    peak_premium: 1.47,
    contracts: 2,
    contracts_remaining: 2,
    entry_thesis: { lean: "SHORT", spot: 767.33, or_low: 767.77 },
  };
  const clock = (check) => ({ action: "WAIT", thesis_check: check, contract: { flavor: "put", strike: 763 } });
  const offOnly = { red: true, lean_off: true, reclaimed: false };
  const reclaim = { red: true, lean_off: true, reclaimed: true };

  it("waits out a lean flicker, then exits once it has been off long enough", () => {
    const first = classifyPaperEvent({ clock: clock(offOnly), book, premium: 1.30, now: T0 });
    expect(first.event).toBeNull();
    expect(first.nextBook.thesis_off_since).toBe(T0);
    const later = classifyPaperEvent({ clock: clock(offOnly), book: first.nextBook, premium: 1.20, now: T0 + THESIS_LEAN_OFF_MS });
    expect(later.event).toBe("STOP");
    expect(later.reason).toBe("thesis_lean_off");
  });

  it("exits sooner on a held reclaim of the broken OR level", () => {
    const first = classifyPaperEvent({ clock: clock(reclaim), book, premium: 1.25, now: T0 });
    const later = classifyPaperEvent({ clock: clock(reclaim), book: first.nextBook, premium: 1.17, now: T0 + THESIS_RECLAIM_MS });
    expect(later.event).toBe("STOP");
    expect(later.reason).toBe("thesis_reclaimed");
  });

  it("resets when the lean comes back or the book is green again", () => {
    const first = classifyPaperEvent({ clock: clock(offOnly), book, premium: 1.30, now: T0 });
    const back = classifyPaperEvent({ clock: clock({ red: false, lean_off: true, reclaimed: false }), book: first.nextBook, premium: 1.55, now: T0 + 60_000 });
    expect(back.nextBook.thesis_off_since).toBeNull();
    const later = classifyPaperEvent({ clock: clock(offOnly), book: back.nextBook, premium: 1.30, now: T0 + THESIS_LEAN_OFF_MS });
    expect(later.event).toBeNull();
  });

  it("leaves a trimmed book to its breakeven stop", () => {
    const trimmed = { ...book, status: "trimmed", profit_armed: true, thesis_off_since: T0 - THESIS_LEAN_OFF_MS };
    const out = classifyPaperEvent({ clock: clock(offOnly), book: trimmed, premium: 1.60, now: T0 });
    expect(out.reason).not.toBe("thesis_lean_off");
  });

  it("describes both exits", () => {
    expect(describePaperExitReason("thesis_reclaimed", { sym: "SPY", flavor: "put", mid: 1.17 })).toMatch(/back inside the opening range/);
    expect(describePaperExitReason("thesis_lean_off", { sym: "SPY", flavor: "put", mid: 1.17 })).toMatch(/day lean that opened this put is gone/);
  });
});

describe("buildExecutionClock — thesis plumbing", () => {
  const base = {
    ticker: "SPY",
    flavor: "put",
    strike: 763,
    expiration: { iso: "2026-09-28", dte: 1 },
    premium: 1.20,
    indicators: { ema21: 768.9, st_dir: 1, tf: "5" },
    now: ts(`2026-09-25T10:40:00${ET}`),
  };
  const gp = { lean: "NEUTRAL", lean_conviction: "low", or_low: 767.77, or_high: 770.28, inv_put: 770.97 };
  const openBook = { status: "open", entry_premium: 1.47, entry_thesis: { lean: "SHORT", spot: 767.33, or_low: 767.77 } };

  it("stamps the thesis a BUY would store and checks it for an open book", () => {
    const c = buildExecutionClock({ ...base, spot: 768.10, gamePlan: gp, openBook });
    expect(c.thesis).toMatchObject({ lean: "NEUTRAL", spot: 768.10, or_low: 767.77 });
    expect(c.thesis_check).toMatchObject({ red: true, lean_off: true, reclaimed: true });
  });

  it("is off with the kill switch", () => {
    const c = buildExecutionClock({ ...base, spot: 768.10, gamePlan: gp, openBook, thesisExit: false });
    expect(c.thesis_check).toBeNull();
  });
});
