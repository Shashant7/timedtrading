import { describe, it, expect } from "vitest";
import { buildExecutionClock } from "./option-execution-clock.js";
import {
  sizeDayTradePlay,
  buildSatyDayTradePlan,
  classifyPaperEvent,
  buildDayTradeSignalEmbed,
  describePaperExitReason,
  computePremiumRr,
  shouldHoldOvernight,
  isOvernightCarry,
  formatExpirationShort,
  isOptionsBuyWindowEt,
  isOptionsSellWindowEt,
  buildDayTradePositionMgmtLine,
  shouldArmProfitLock,
  profitLockThreshold,
  profitLockFloor,
  HARD_STOP_PCT,
  REENTRY_COOLDOWN_MS,
} from "./option-day-trade-plan.js";

const ET = "-04:00";
const hardStopOf = (entry) => Math.round(entry * (1 + HARD_STOP_PCT / 100) * 100) / 100;
const ts = (iso) => Date.parse(iso);
const RTH_NOW = ts(`2026-08-20T10:12:00${ET}`);
const PREMARKET_NOW = ts(`2026-08-21T06:30:00${ET}`);

const clockBuy = {
  action: "BUY",
  sell_kind: null,
  why: "SPY is holding the 5-minute 21 EMA",
  premium_band: {
    expected_close: 762.5,
    pin: 0.5,
    fmv: 0.52,
    buy_ceil: 0.5,
    under: 0.4,
    over: 0.63,
    premium: 0.38,
    band: "under",
  },
  indicators: { ema21: 763.1, st_dir: 1, st_label: "short", tf: "5" },
  contract: { ticker: "SPY", flavor: "put", strike: 763, expiration: { dte: 1, iso: "2026-08-21" } },
};

describe("sizeDayTradePlay", () => {
  it("goes heavy on high conviction + ST with + under FMV", () => {
    const s = sizeDayTradePlay({
      leanConviction: "high",
      premiumBand: "under",
      stWith: true,
      premium: 0.38,
    });
    expect(s.label).toBe("heavy");
    expect(s.contracts).toBe(3);
    expect(s.debit_usd).toBe(114);
  });
  it("goes light when premium is rich", () => {
    const s = sizeDayTradePlay({
      leanConviction: "high",
      premiumBand: "over",
      stWith: true,
      premium: 0.95,
    });
    expect(s.label).toBe("light");
    // Two lots is the floor: a one-lot book cannot trim.
    expect(s.contracts).toBe(2);
  });
});

describe("computePremiumRr", () => {
  it("trims a $0.45 entry at 1R ($0.68), not $0.53", () => {
    const rr = computePremiumRr({
      entry: 0.45,
      strike: 763,
      flavor: "put",
      targetPx: 758,
      pin: 0.50,
    });
    expect(rr.stop).toBe(0.23);
    expect(rr.risk).toBe(0.23);
    expect(rr.trim).toBe(0.68);
    expect(rr.trim).toBeGreaterThan(0.53);
    expect(rr.exit).toBe(0.90);
    expect(rr.positive).toBe(true);
    expect(rr.rr).toBeGreaterThanOrEqual(1);
  });
  it("rejects a pin-only 763P when the print cannot cover the stop", () => {
    const rr = computePremiumRr({
      entry: 0.45,
      strike: 763,
      flavor: "put",
      targetPx: 762.50,
      pin: 0.50,
    });
    expect(rr.target_prem).toBe(0.5);
    expect(rr.positive).toBe(false);
    expect(rr.rr).toBeLessThan(1);
  });
});

describe("shouldHoldOvernight", () => {
  it("holds 1 DTE after 15:30 when SuperTrend agrees and leftover R:R is still ≥ 1", () => {
    expect(shouldHoldOvernight({
      dte: 1, stWith: true, invalidated: false,
      premium: 0.45, entry: 0.45, targetPrem: 2.00,
      minutes: 15 * 60 + 50,
    })).toBe(true);
  });
  it("does not mark overnight at 10:05 even when leftover R:R is large", () => {
    expect(shouldHoldOvernight({
      dte: 1, stWith: true, invalidated: false,
      premium: 0.45, entry: 0.45, targetPrem: 2.00,
      minutes: 10 * 60 + 5,
    })).toBe(false);
  });
  it("flattens before the close when leftover R:R is gone", () => {
    expect(shouldHoldOvernight({
      dte: 1, stWith: true, invalidated: false,
      premium: 0.48, entry: 0.45, targetPrem: 0.50,
      minutes: 15 * 60 + 50,
    })).toBe(false);
  });
});

describe("isOvernightCarry", () => {
  it("treats a held_overnight stamp as a carry", () => {
    expect(isOvernightCarry({ status: "open", held_overnight: true })).toBe(true);
  });
  it("treats a prior-session entry as a carry", () => {
    expect(isOvernightCarry({
      status: "open",
      entry_ts: ts(`2026-08-20T15:50:00${ET}`),
    }, ts(`2026-08-21T09:35:00${ET}`))).toBe(true);
  });
  it("does not treat a same-session book as a carry", () => {
    expect(isOvernightCarry({
      status: "open",
      entry_ts: ts(`2026-08-21T10:05:00${ET}`),
    }, ts(`2026-08-21T10:20:00${ET}`))).toBe(false);
  });
});

describe("buildDayTradePositionMgmtLine", () => {
  it("names trim, exit, hard stop, and 3:45 flat for a same-day open book", () => {
    const line = buildDayTradePositionMgmtLine({
      book: {
        status: "open",
        flavor: "call",
        entry_premium: 0.74,
        trim_premium: 1.08,
        exit_premium: 1.44,
        peak_premium: 0.81,
        contracts: 3,
        contracts_remaining: 3,
        profit_lock_armed: false,
        held_overnight: false,
      },
      ticker: "SPY",
      management: { invalidation: { underlying_below: 764.5 } },
    });
    expect(line).toContain("Trim half at $1.08");
    expect(line).toContain("$1.44");
    expect(line).toContain("$0.37");
    expect(line).toContain("764.50");
    expect(line).toContain("15:45");
    expect(line).not.toContain("Carried overnight");
  });

  it("skips 3:45 flat on overnight carry", () => {
    const line = buildDayTradePositionMgmtLine({
      book: {
        status: "open",
        flavor: "call",
        entry_premium: 0.74,
        trim_premium: 1.08,
        exit_premium: 1.44,
        held_overnight: true,
        contracts: 3,
      },
      ticker: "SPY",
      now: ts(`2026-08-25T10:00:00${ET}`),
    });
    expect(line).not.toMatch(/Flat by 15:45/);
    expect(line).toContain("Carried overnight");
  });

  it("describes profit lock trail when armed", () => {
    const line = buildDayTradePositionMgmtLine({
      book: {
        status: "open",
        flavor: "call",
        entry_premium: 0.74,
        peak_premium: 1.20,
        profit_lock_armed: true,
        trim_premium: 1.08,
        exit_premium: 1.44,
        trail_stop_premium: 0.74,
        contracts: 1,
      },
      ticker: "SPY",
    });
    expect(line).toContain("Profit lock armed");
    expect(line).toContain("giveback");
  });
});

describe("buildSatyDayTradePlan", () => {
  it("fills the five boxes and a flip level", () => {
    const plan = buildSatyDayTradePlan({
      ticker: "SPY",
      flavor: "put",
      strike: 763,
      expiration: { dte: 1, iso: "2026-08-21", label: "1 DTE" },
      spot: 762.84,
      premium: 0.38,
      execution: clockBuy,
      gamePlan: {
        lean: "SHORT",
        lean_conviction: "high",
        bear_target: 758,
        bear_trigger: 764,
        bull_trigger: 766,
      },
      management: { invalidation: { underlying_above: 766 } },
    });
    expect(plan.setup).toMatch(/763P/);
    expect(plan.trigger).toMatch(/SuperTrend short/);
    expect(plan.entry).toMatch(/0\.50/);
    expect(plan.exits).toMatch(/half/);
    expect(plan.stop).toMatch(/766/);
    expect(plan.flip).toMatch(/766/);
    expect(plan.bracket.buy_limit).toBeCloseTo(0.437, 2);
    expect(plan.bracket.trim).toBeGreaterThan(0.53);
    expect(plan.bracket.rr_positive).toBe(true);
    expect(plan.hold_overnight).toBe(false);
    expect(plan.exits).toMatch(/15:45/);
    expect(plan.size.label).toBe("heavy");
  });
  it("can hold overnight when the clock grants it after 15:30", () => {
    const plan = buildSatyDayTradePlan({
      ticker: "SPY",
      flavor: "put",
      strike: 763,
      expiration: { dte: 1, iso: "2026-08-21", label: "1 DTE" },
      spot: 762.84,
      premium: 0.80,
      execution: { ...clockBuy, hold_overnight: true },
      gamePlan: {
        lean: "SHORT",
        lean_conviction: "high",
        bear_target: 758,
        bear_trigger: 764,
        bull_trigger: 766,
      },
      management: { invalidation: { underlying_above: 766 } },
    });
    expect(plan.hold_overnight).toBe(true);
    expect(plan.exits).toMatch(/overnight/i);
    expect(plan.exits).toMatch(/09:45/);
  });
  it("does not use you/your", () => {
    const plan = buildSatyDayTradePlan({
      ticker: "SPY",
      flavor: "put",
      strike: 763,
      expiration: { dte: 1 },
      spot: 762.8,
      premium: 0.38,
      execution: clockBuy,
      gamePlan: { lean: "SHORT", bear_target: 762.5, bull_trigger: 766 },
    });
    const blob = [plan.setup, plan.trigger, plan.entry, plan.exits, plan.stop, plan.flip].join(" ");
    expect(blob.toLowerCase()).not.toMatch(/\byou(r)?\b/);
  });
});

describe("formatExpirationShort", () => {
  it("prints Aug 22 from ISO, not 1 DTE", () => {
    expect(formatExpirationShort({ dte: 1, iso: "2026-08-22", label: "1 DTE" })).toBe("Aug 22");
    expect(formatExpirationShort({ dte: 1, label: "1 DTE" })).toBe("");
  });
});

describe("isOptionsBuyWindowEt", () => {
  it("is closed at 06:30 ET and open at 10:12 ET", () => {
    expect(isOptionsBuyWindowEt(PREMARKET_NOW)).toBe(false);
    expect(isOptionsBuyWindowEt(ts(`2026-08-20T09:35:00${ET}`))).toBe(false);
    expect(isOptionsBuyWindowEt(RTH_NOW)).toBe(true);
    expect(isOptionsBuyWindowEt(ts(`2026-08-20T16:00:00${ET}`))).toBe(false);
  });
});

describe("isOptionsSellWindowEt", () => {
  it("is live 09:30 to before 16:15 on trading days, not premarket", () => {
    expect(isOptionsSellWindowEt(PREMARKET_NOW)).toBe(false);
    expect(isOptionsSellWindowEt(ts(`2026-08-20T09:29:00${ET}`))).toBe(false);
    expect(isOptionsSellWindowEt(ts(`2026-08-20T09:30:00${ET}`))).toBe(true);
    expect(isOptionsSellWindowEt(ts(`2026-08-20T09:35:00${ET}`))).toBe(true);
    expect(isOptionsSellWindowEt(RTH_NOW)).toBe(true);
    expect(isOptionsSellWindowEt(ts(`2026-08-20T16:14:00${ET}`))).toBe(true);
    expect(isOptionsSellWindowEt(ts(`2026-08-20T16:15:00${ET}`))).toBe(false);
  });
  it("is closed on weekends even during the 09:30-16:15 window", () => {
    expect(isOptionsSellWindowEt(ts(`2026-08-23T16:12:00${ET}`))).toBe(false);
  });
});

describe("classifyPaperEvent — re-entry cooldown per underlying", () => {
  // 2026-09-23/24: all 12 re-entries fired within 10 minutes of the previous
  // close on the same underlying lost; the winners came later.
  const buy = (lastUnderlyingCloseTs, extra = {}) => classifyPaperEvent({
    clock: clockBuy,
    book: null,
    premium: 0.38,
    size: { label: "medium", contracts: 2 },
    now: RTH_NOW,
    lastUnderlyingCloseTs,
    ...extra,
  });

  it("refuses a BUY one minute after a round on the underlying closed", () => {
    const out = buy(RTH_NOW - 60_000);
    expect(out.event).toBeNull();
    expect(out.blocked).toBe("reentry_cooldown");
  });

  it("allows the BUY once the cooldown has passed", () => {
    expect(REENTRY_COOLDOWN_MS).toBe(10 * 60 * 1000);
    expect(buy(RTH_NOW - REENTRY_COOLDOWN_MS).event).toBe("BUY");
    expect(buy(RTH_NOW - 13 * 60_000).event).toBe("BUY");
  });

  it("does nothing when no round has closed on the underlying today", () => {
    expect(buy(null).event).toBe("BUY");
  });

  it("honours an overridden window", () => {
    expect(buy(RTH_NOW - 3 * 60_000, { reentryCooldownMs: 2 * 60_000 }).event).toBe("BUY");
  });

  it("never blocks a SELL on an open book", () => {
    const out = classifyPaperEvent({
      clock: { ...clockBuy, action: "SELL" },
      book: { status: "open", entry_premium: 0.4, contracts: 2, contracts_remaining: 2 },
      premium: 0.2,
      size: { label: "medium", contracts: 2 },
      now: RTH_NOW,
      lastUnderlyingCloseTs: RTH_NOW - 60_000,
    });
    expect(out.blocked).toBeUndefined();
    expect(out.event).not.toBe("BUY");
  });
});

describe("classifyPaperEvent", () => {
  it("BUYs from flat when the clock says BUY", () => {
    const out = classifyPaperEvent({
      clock: clockBuy,
      book: null,
      premium: 0.38,
      size: { label: "medium", contracts: 2 },
      now: RTH_NOW,
    });
    expect(out.event).toBe("BUY");
    expect(out.nextBook.status).toBe("open");
    expect(out.nextBook.entry_premium).toBe(0.38);
  });
  it("does not paper-BUY at 06:30 ET even if a stale clock still says BUY", () => {
    const out = classifyPaperEvent({
      clock: clockBuy,
      book: null,
      premium: 1.45,
      size: { label: "light", contracts: 1 },
      now: PREMARKET_NOW,
    });
    expect(out.event).toBeNull();
  });
  it("does not paper-STOP on invalidation before 09:30 ET", () => {
    const out = classifyPaperEvent({
      clock: { ...clockBuy, action: "SELL", sell_kind: "invalidation", why: "QQQ lost 710" },
      book: { status: "open", entry_premium: 1.45, held_overnight: true },
      premium: 0.60,
      now: PREMARKET_NOW,
    });
    expect(out.event).toBeNull();
    expect(out.nextBook.status).toBe("open");
  });
  it("does not re-BUY on every tick while still BUY", () => {
    const out = classifyPaperEvent({
      clock: clockBuy,
      book: { status: "open", entry_premium: 0.38, contracts: 2 },
      premium: 0.40,
    });
    expect(out.event).toBeNull();
  });
  it("TRIMs an overnight book on open_trim instead of exiting the whole book", () => {
    const out = classifyPaperEvent({
      clock: { ...clockBuy, action: "TRIM", sell_kind: "open_trim", why: "Overnight book — trim at the open" },
      book: { status: "open", entry_premium: 0.45, trim_premium: 0.68, held_overnight: true, contracts: 2 },
      premium: 0.72,
      now: ts(`2026-08-21T09:35:00${ET}`),
    });
    expect(out.event).toBe("TRIM");
    expect(out.nextBook.status).toBe("trimmed");
  });
  it("EXITs an overnight book on open_exit at the first print", () => {
    const out = classifyPaperEvent({
      clock: { ...clockBuy, action: "SELL", sell_kind: "open_exit", why: "Overnight book — take the open exit" },
      book: { status: "trimmed", entry_premium: 0.45, exit_premium: 0.90, held_overnight: true },
      premium: 0.95,
      now: ts(`2026-08-21T09:35:00${ET}`),
    });
    expect(out.event).toBe("EXIT");
    expect(out.reason).toBe("open_exit");
  });
  it("does not TRIM a $0.45 book at $0.53 — waits for 1R", () => {
    const early = classifyPaperEvent({
      clock: clockBuy,
      book: { status: "open", entry_premium: 0.45, trim_premium: 0.68, contracts: 2 },
      premium: 0.53,
      now: RTH_NOW,
    });
    expect(early.event).toBeNull();
    const hit = classifyPaperEvent({
      clock: clockBuy,
      book: { status: "open", entry_premium: 0.45, trim_premium: 0.68, contracts: 2 },
      premium: 0.68,
      now: RTH_NOW,
    });
    expect(hit.event).toBe("TRIM");
  });
  it("STOPs on underlying invalidation", () => {
    const out = classifyPaperEvent({
      clock: { ...clockBuy, action: "SELL", sell_kind: "invalidation", why: "SPY reclaimed 766" },
      book: { status: "open", entry_premium: 0.38 },
      premium: 0.22,
      now: ts(`2026-08-20T09:30:00${ET}`),
    });
    expect(out.event).toBe("STOP");
    expect(out.nextBook.status).toBe("closed");
    expect(out.nextBook.needs_wait).toBe(true);
  });
  it("EXITs on the 15:45 session-close flatten", () => {
    const out = classifyPaperEvent({
      clock: { ...clockBuy, action: "SELL", sell_kind: "session_close", why: "Flatten by 15:45 ET — before the cash close" },
      book: { status: "trimmed", entry_premium: 0.38 },
      premium: 0.60,
      now: ts(`2026-08-20T15:50:00${ET}`),
    });
    expect(out.event).toBe("EXIT");
  });
  it("does not re-enter until a WAIT re-arms the book", () => {
    const blocked = classifyPaperEvent({
      clock: clockBuy,
      book: { status: "closed", needs_wait: true, entry_premium: 0.38 },
      premium: 0.38,
    });
    expect(blocked.event).toBeNull();
    const armed = classifyPaperEvent({
      clock: { ...clockBuy, action: "WAIT" },
      book: { status: "closed", needs_wait: true, entry_premium: 0.38 },
      premium: 0.38,
    });
    expect(armed.nextBook.status).toBe("flat");
    expect(armed.nextBook.needs_wait).toBe(false);
  });
  it("flat + SELL after hours is silent (no position)", () => {
    const out = classifyPaperEvent({
      clock: { ...clockBuy, action: "SELL", sell_kind: "close_auction" },
      book: null,
      premium: 0.60,
    });
    expect(out.event).toBeNull();
  });

  it("PROTECTs a single-contract book at 1R instead of TRIM", () => {
    const out = classifyPaperEvent({
      clock: clockBuy,
      book: { status: "open", entry_premium: 1.25, trim_premium: 1.88, exit_premium: 2.50, contracts: 1 },
      premium: 1.90,
      size: { label: "light", contracts: 1 },
      now: RTH_NOW,
    });
    expect(out.event).toBe("PROTECT");
    expect(out.nextBook.profit_armed).toBe(true);
    expect(out.nextBook.trail_stop_premium).toBe(1.25);
    expect(out.nextBook.status).toBe("open");
  });

  it("EXITs single-contract book on trail giveback from peak", () => {
    const out = classifyPaperEvent({
      clock: clockBuy,
      book: {
        status: "open",
        entry_premium: 1.25,
        trim_premium: 1.88,
        exit_premium: 2.50,
        contracts: 1,
        profit_armed: true,
        trail_stop_premium: 1.25,
        peak_premium: 2.11,
      },
      premium: 1.26,
      size: { label: "light", contracts: 1 },
      now: RTH_NOW,
    });
    expect(out.event).toBe("EXIT");
    expect(out.reason).toBe("trail_stop");
  });

  it("STOPs trimmed runner at breakeven after giveback", () => {
    const out = classifyPaperEvent({
      clock: clockBuy,
      book: {
        status: "trimmed",
        entry_premium: 1.25,
        trim_premium: 1.88,
        exit_premium: 2.50,
        contracts: 2,
        profit_armed: true,
        trail_stop_premium: 1.25,
        peak_premium: 1.95,
      },
      premium: 1.24,
      now: RTH_NOW,
    });
    expect(out.event).toBe("STOP");
    expect(out.reason).toBe("breakeven_stop");
  });

  // 2026-08-25 — QQQ 711C class: a runner that peaked well into profit but
  // never tagged 1R (so profit_armed was never set) must still be protected.
  it("trails a big never-trimmed winner off its peak instead of riding to the hard stop", () => {
    const out = classifyPaperEvent({
      clock: clockBuy,
      book: {
        status: "open",
        entry_premium: 1.19,
        trim_premium: 1.79,
        exit_premium: 2.38,
        contracts: 1,
        // peaked +207% but profit_armed was never set (book never saw 1R)
        peak_premium: 3.65,
      },
      premium: 2.10,
      size: { label: "light", contracts: 1 },
      now: RTH_NOW,
    });
    expect(out.event).toBe("EXIT");
    expect(out.reason).toBe("trail_stop");
    expect(out.nextBook.status).toBe("closed");
  });

  // A +12% peak is ~0.06% of the underlying on a 0.4-delta 1DTE contract.
  // It arms the safety net, but it has not earned a zero-tolerance stop.
  it("does not scratch a never-trimmed +12% peak the moment it touches entry", () => {
    const out = classifyPaperEvent({
      clock: clockBuy,
      book: {
        status: "open",
        entry_premium: 1.19,
        trim_premium: 1.79,
        exit_premium: 2.38,
        contracts: 1,
        peak_premium: 1.33, // +12% — clears the 10% / $0.08 lock
      },
      premium: 1.18, // back to breakeven
      size: { label: "light", contracts: 1 },
      now: RTH_NOW,
    });
    expect(out.event).toBeNull();
  });

  it("does not ride a modest winner down to the -50% hard stop", () => {
    const out = classifyPaperEvent({
      clock: clockBuy,
      book: {
        status: "open",
        entry_premium: 1.19,
        trim_premium: 1.79,
        exit_premium: 2.38,
        contracts: 1,
        peak_premium: 1.33, // was green
      },
      premium: 0.56,
      size: { label: "light", contracts: 1 },
      now: RTH_NOW,
    });
    expect(out.event).toBe("STOP");
    expect(out.reason).toBe("profit_lock_stop");
    // Floor is 0.80, comfortably above the 0.60 hard stop.
    expect(profitLockFloor(1.19, 1.33)).toBeGreaterThan(hardStopOf(1.19));
  });

  // A 1R trim banks half the position, so the runner may risk nothing. That
  // breakeven is earned; the peak lock's is not. Keep them distinguishable.
  it("keeps the earned breakeven pinned at entry after a trim", () => {
    const out = classifyPaperEvent({
      clock: clockBuy,
      book: {
        status: "trimmed",
        entry_premium: 1.19,
        trim_premium: 1.79,
        exit_premium: 2.38,
        contracts: 2,
        profit_armed: true,
        peak_premium: 1.33,
      },
      premium: 1.18,
      now: RTH_NOW,
    });
    expect(out.event).toBe("STOP");
    expect(out.reason).toBe("breakeven_stop");
  });

  it("arms lock from the post-entry mark high even when the last poll mid never printed that peak", () => {
    const out = classifyPaperEvent({
      clock: { ...clockBuy, path_peak_since_entry: 2.10 },
      book: {
        status: "open",
        entry_premium: 1.19,
        entry_ts: RTH_NOW,
        trim_premium: 1.79,
        exit_premium: 2.38,
        contracts: 1,
        peak_premium: 1.22, // last poll only saw +3%
      },
      premium: 1.50,
      size: { label: "light", contracts: 1 },
      now: RTH_NOW,
    });
    expect(out.nextBook.profit_lock_armed).toBe(true);
    expect(out.nextBook.peak_premium).toBe(2.10);
    expect(out.event).toBeNull();
  });

  it("trails off the post-entry mark high, not the last poll", () => {
    const out = classifyPaperEvent({
      clock: { ...clockBuy, path_peak_since_entry: 2.10 },
      book: {
        status: "open",
        entry_premium: 1.19,
        entry_ts: RTH_NOW,
        trim_premium: 1.79,
        exit_premium: 2.38,
        contracts: 1,
        peak_premium: 1.22,
      },
      premium: 1.20, // 2.10 * 0.60 = 1.26 floor
      size: { label: "light", contracts: 1 },
      now: RTH_NOW,
    });
    expect(out.event).toBe("EXIT");
    expect(out.reason).toBe("trail_stop");
  });

  it("still hard-stops a contract that never ran into profit", () => {
    const out = classifyPaperEvent({
      clock: clockBuy,
      book: {
        status: "open",
        entry_premium: 1.19,
        trim_premium: 1.79,
        exit_premium: 2.38,
        contracts: 1,
        peak_premium: 1.24, // +4% — below the 10% / $0.08 lock
      },
      premium: 0.56,
      size: { label: "light", contracts: 1 },
      now: RTH_NOW,
    });
    expect(out.event).toBe("STOP");
    expect(out.reason).toBe("premium_stop");
  });
});

describe("shouldArmProfitLock", () => {
  it("uses the larger of +10% and +$0.08", () => {
    expect(profitLockThreshold(1.19)).toBe(1.31);
    expect(shouldArmProfitLock(1.19, 1.30)).toBe(false);
    expect(shouldArmProfitLock(1.19, 1.31)).toBe(true);
    expect(profitLockThreshold(0.45)).toBe(0.53);
    expect(shouldArmProfitLock(0.45, 0.52)).toBe(false);
    expect(shouldArmProfitLock(0.45, 0.53)).toBe(true);
  });
});

describe("buildDayTradeSignalEmbed", () => {
  it("carries the five-box plan and a bracket", () => {
    const plan = buildSatyDayTradePlan({
      ticker: "SPY",
      flavor: "put",
      strike: 763,
      expiration: { dte: 1, iso: "2026-08-21" },
      spot: 762.8,
      premium: 0.38,
      execution: clockBuy,
      gamePlan: { lean: "SHORT", bear_target: 762.5, bull_trigger: 766, bear_trigger: 764 },
    });
    const embed = buildDayTradeSignalEmbed({
      event: "BUY",
      ticker: "SPY",
      plan,
      size: plan.size,
      execution: clockBuy,
      premium: 0.38,
      spot: 762.8,
    });
    expect(embed.title).toMatch(/BUY/);
    expect(embed.title).toMatch(/Aug 21/);
    expect(embed.title).toMatch(/1 DTE/);
    expect(embed.title).toMatch(/HEAVY|MEDIUM|LIGHT/);
    expect(embed.description).toMatch(/Aug 21/);
    const names = embed.fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["Setup / Thesis", "Trigger", "Entry", "Exits", "Stop", "Bracket"]));
    const blob = [embed.title, embed.description, ...embed.fields.map((f) => f.value)].join(" ");
    expect(blob.toLowerCase()).not.toMatch(/\byou(r)?\b/);
  });

  it("STOP embed shows exit recap, not the entry playbook", () => {
    const plan = buildSatyDayTradePlan({
      ticker: "QQQ",
      flavor: "call",
      strike: 713,
      expiration: { dte: 1, iso: "2026-08-26" },
      spot: 712.5,
      premium: 0.86,
      execution: clockBuy,
      gamePlan: { lean: "LONG", bull_target: 720, bull_trigger: 708.38 },
    });
    const book = {
      status: "open",
      entry_premium: 1.72,
      trim_premium: 2.29,
      exit_premium: 3.15,
      peak_premium: 2.10,
      contracts: 1,
      profit_lock_armed: false,
    };
    const embed = buildDayTradeSignalEmbed({
      event: "STOP",
      ticker: "QQQ",
      plan,
      size: plan.size,
      execution: clockBuy,
      premium: 0.86,
      spot: 711.2,
      reason: "premium_stop",
      book,
    });
    expect(embed.title).toMatch(/STOP OUT/);
    const names = embed.fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["Exit / Why", "Fill recap", "Planned exits (at entry)"]));
    expect(names).not.toEqual(expect.arrayContaining(["Setup / Thesis", "Trigger", "Entry", "Bracket"]));
    const why = embed.fields.find((f) => f.name === "Exit / Why")?.value || "";
    expect(why).toMatch(/hard stop/i);
    expect(why).toMatch(/\$0\.86/);
    const recap = embed.fields.find((f) => f.name === "Fill recap")?.value || "";
    expect(recap).toMatch(/Entry \$1\.72/);
    expect(recap).toMatch(/Exit \$0\.86/);
    expect(embed.description).not.toMatch(/BUY limit/);
  });

  it("breakeven_stop reason is not labeled as premium hard stop", () => {
    const text = describePaperExitReason("breakeven_stop", {
      entry: 0.86,
      mid: 0.86,
      peak: 1.20,
      flavor: "call",
      sym: "QQQ",
    });
    expect(text).toMatch(/breakeven/i);
    expect(text).not.toMatch(/hard stop/i);
  });

  it("profit_lock_stop says it was a giveback floor, not a breakeven", () => {
    const text = describePaperExitReason("profit_lock_stop", {
      entry: 0.64,
      mid: 0.44,
      peak: 0.74,
      flavor: "put",
      sym: "IWM",
    });
    expect(text).toMatch(/profit-lock giveback/i);
    expect(text).toMatch(/\$0\.44/);
    // The floor, not the entry, is the level that fired.
    expect(text).toMatch(/\$0\.44/);
    expect(text).not.toMatch(/^Breakeven stop/);
  });
});

// The floor has to be monotone in the peak and bracketed by the two levels
// it interpolates between, or it is not a ratchet.
describe("profitLockFloor", () => {
  it("is the hard stop until the book has been green", () => {
    expect(profitLockFloor(1.00, null)).toBe(0.50);
    expect(profitLockFloor(1.00, 0.90)).toBe(0.54);
  });

  it("never sits below the hard stop or above breakeven", () => {
    for (let peak = 0.5; peak <= 4; peak += 0.05) {
      const floor = profitLockFloor(1.00, peak);
      expect(floor).toBeGreaterThanOrEqual(0.50);
      expect(floor).toBeLessThanOrEqual(1.00);
    }
  });

  it("rises monotonically with the peak", () => {
    let prev = -Infinity;
    for (let peak = 0.5; peak <= 4; peak += 0.05) {
      const floor = profitLockFloor(1.00, peak);
      expect(floor).toBeGreaterThanOrEqual(prev);
      prev = floor;
    }
  });

  it("reaches breakeven once the giveback floor gets there on its own", () => {
    expect(profitLockFloor(1.00, 1.60)).toBe(0.96);
    expect(profitLockFloor(1.00, 1.67)).toBe(1.00);
    expect(profitLockFloor(1.00, 3.00)).toBe(1.00);
  });

  it("returns null when there is no entry to measure from", () => {
    expect(profitLockFloor(null, 1.5)).toBeNull();
    expect(profitLockFloor(0, 1.5)).toBeNull();
  });

  // Production books, 2026-09-23/24. Every one of these was stopped at its
  // own entry price by the old rule; none was anywhere near its 1R trim.
  it("holds the seven books the old zero-tolerance breakeven scratched", () => {
    const scratched = [
      // entry, peak, the mid the old rule exited at
      [2.15, 2.76, 2.11], // QQQ 738P
      [1.55, 1.80, 1.48], // QQQ 736P
      [0.67, 0.78, 0.66], // IWM 282P
      [0.61, 0.66, 0.51], // IWM 281P
      [0.88, 0.98, 0.85], // SPY 763P
      [0.64, 0.74, 0.63], // IWM 279P
      [0.88, 1.02, 0.80], // IWM 280P
    ];
    for (const [entry, peak, exitMid] of scratched) {
      expect(exitMid).toBeLessThanOrEqual(entry); // the old rule fired
      expect(profitLockFloor(entry, peak)).toBeLessThan(exitMid);
    }
  });

  // 2026-08-24 QQQ 711C: peaked +207%, rode the giveback to a -53% stop.
  // That is the case the profit lock exists for and it must still be caught.
  it("still protects the round-trip the profit lock was added for", () => {
    const entry = 1.19;
    const floor = profitLockFloor(entry, 3.65); // +207%
    expect(floor).toBe(entry); // pinned at breakeven, nothing given back
  });
});

describe("clock sell_kind", () => {
  it("tags force-liq and close-auction", () => {
    const force = buildExecutionClock({
      ticker: "SPY",
      flavor: "call",
      strike: 765,
      expiration: { dte: 0, iso: "2026-08-20" },
      spot: 764.2,
      premium: 1.2,
      indicators: { ema21: 764.1, st_dir: -1, st_label: "long", tf: "5" },
      gamePlan: { bull_target: 772, bear_trigger: 761 },
      management: { time_stop_et: "12:00", invalidation: { underlying_below: 761 } },
      openBook: { status: "open", entry_premium: 1.2, entry_ts: ts(`2026-08-20T09:45:00${ET}`) },
      now: ts(`2026-08-20T15:20:00${ET}`),
    });
    expect(force.action).toBe("SELL");
    expect(force.sell_kind).toBe("force_liq");

    const flat = buildExecutionClock({
      ticker: "SPY",
      flavor: "put",
      strike: 763,
      expiration: { dte: 1, iso: "2026-08-21" },
      spot: 762.9,
      premium: 0.38,
      indicators: { ema21: 763.05, st_dir: 1, st_label: "short", tf: "5" },
      gamePlan: { bear_target: 762.50, bear_trigger: 764, bull_trigger: 766 },
      management: { time_stop_et: "16:15", invalidation: { underlying_above: 766 } },
      openBook: { status: "open", entry_premium: 0.38, entry_ts: ts(`2026-08-20T10:00:00${ET}`) },
      now: ts(`2026-08-20T16:00:00${ET}`),
    });
    expect(flat.action).toBe("SELL");
    expect(flat.hold_overnight).toBe(false);
    expect(flat.sell_kind).toBe("session_close");

    const afterClose = buildExecutionClock({
      ticker: "SPY",
      flavor: "put",
      strike: 763,
      expiration: { dte: 1, iso: "2026-08-21" },
      spot: 762.9,
      premium: 0.38,
      indicators: { ema21: 763.05, st_dir: 1, st_label: "short", tf: "5" },
      gamePlan: { bear_target: 762.50, bear_trigger: 764, bull_trigger: 766 },
      management: { time_stop_et: "16:15", invalidation: { underlying_above: 766 } },
      now: ts(`2026-08-20T16:16:00${ET}`),
    });
    expect(afterClose.action).toBe("WAIT");
    expect(afterClose.why).toMatch(/16:15/);
  });
});
