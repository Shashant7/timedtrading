import { describe, it, expect } from "vitest";
import { buildExecutionClock } from "./option-execution-clock.js";
import {
  sizeDayTradePlay,
  buildSatyDayTradePlan,
  classifyPaperEvent,
  buildDayTradeSignalEmbed,
  TP1_PCT,
} from "./option-day-trade-plan.js";

const ET = "-04:00";
const ts = (iso) => Date.parse(iso);

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
    expect(s.contracts).toBe(1);
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
        bear_target: 762.5,
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
    expect(plan.bracket.buy_limit).toBe(0.5);
    expect(plan.bracket.trim).toBeCloseTo(0.38 * 1.4, 2);
    expect(plan.size.label).toBe("heavy");
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

describe("classifyPaperEvent", () => {
  it("BUYs from flat when the clock says BUY", () => {
    const out = classifyPaperEvent({
      clock: clockBuy,
      book: null,
      premium: 0.38,
      size: { label: "medium", contracts: 2 },
    });
    expect(out.event).toBe("BUY");
    expect(out.nextBook.status).toBe("open");
    expect(out.nextBook.entry_premium).toBe(0.38);
  });
  it("does not re-BUY on every tick while still BUY", () => {
    const out = classifyPaperEvent({
      clock: clockBuy,
      book: { status: "open", entry_premium: 0.38, contracts: 2 },
      premium: 0.40,
    });
    expect(out.event).toBeNull();
  });
  it("TRIMs at +40% premium", () => {
    const out = classifyPaperEvent({
      clock: clockBuy,
      book: { status: "open", entry_premium: 0.38, contracts: 2 },
      premium: 0.38 * (1 + TP1_PCT / 100),
    });
    expect(out.event).toBe("TRIM");
    expect(out.nextBook.status).toBe("trimmed");
  });
  it("STOPs on underlying invalidation", () => {
    const out = classifyPaperEvent({
      clock: { ...clockBuy, action: "SELL", sell_kind: "invalidation", why: "SPY reclaimed 766" },
      book: { status: "open", entry_premium: 0.38 },
      premium: 0.22,
    });
    expect(out.event).toBe("STOP");
    expect(out.nextBook.status).toBe("closed");
    expect(out.nextBook.needs_wait).toBe(true);
  });
  it("EXITs after the 16:15 close-auction flatten", () => {
    const out = classifyPaperEvent({
      clock: { ...clockBuy, action: "SELL", sell_kind: "close_auction", why: "1 DTE close-auction window is done" },
      book: { status: "trimmed", entry_premium: 0.38 },
      premium: 0.60,
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
});

describe("buildDayTradeSignalEmbed", () => {
  it("carries the five-box plan and a bracket", () => {
    const plan = buildSatyDayTradePlan({
      ticker: "SPY",
      flavor: "put",
      strike: 763,
      expiration: { dte: 1 },
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
    expect(embed.title).toMatch(/HEAVY|MEDIUM|LIGHT/);
    const names = embed.fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["Setup / Thesis", "Trigger", "Entry", "Exits", "Stop", "Bracket"]));
    const blob = [embed.title, embed.description, ...embed.fields.map((f) => f.value)].join(" ");
    expect(blob.toLowerCase()).not.toMatch(/\byou(r)?\b/);
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
      now: ts(`2026-08-20T15:20:00${ET}`),
    });
    expect(force.action).toBe("SELL");
    expect(force.sell_kind).toBe("force_liq");

    const flat = buildExecutionClock({
      ticker: "SPY",
      flavor: "call",
      strike: 765,
      expiration: { dte: 1, iso: "2026-08-21" },
      spot: 764.2,
      premium: 1.2,
      indicators: { ema21: 764.1, st_dir: -1, st_label: "long", tf: "5" },
      gamePlan: { bull_target: 772, bear_trigger: 761 },
      management: { time_stop_et: "16:15", invalidation: { underlying_below: 761 } },
      now: ts(`2026-08-20T16:16:00${ET}`),
    });
    expect(flat.sell_kind).toBe("close_auction");
  });
});
