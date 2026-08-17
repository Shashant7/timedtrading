// ANET Jul 16 movie — wick through support ≠ confirmed invalidation exit.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_INVESTOR_CONFIG,
  resolvePrimaryInvalidationBreach,
  resolvePrimaryInvalidationMovie,
  detectDailyEma21Test,
  detectWeeklyBreakoutRetest,
  detectAccumulationZone,
  resolveInvestorMfeExtensionTrim,
  INVESTOR_STRUCTURAL_ANCHORS,
} from "./investor.js";

const floor = 167.85;

describe("resolvePrimaryInvalidationMovie", () => {
  const breach = { price: floor, label: "Weekly ATR support (-23.6%)", breachPct: -0.6 };

  it("defers RTH wick-through (ANET 2pm frame) instead of exiting", () => {
    const r = resolvePrimaryInvalidationMovie({
      breach,
      price: 166.81,
      priorState: null,
      cfg: DEFAULT_INVESTOR_CONFIG,
      now: 1,
      marketOpen: true,
      tickerData: { prev_close: 170 },
    });
    expect(r.fire).toBe(false);
    expect(r.state?.armed).toBe(true);
    expect(r.deferReason).toBe("awaiting_close_or_hold_below");
  });

  it("clears the arm when support is reclaimed above the floor", () => {
    const armed = resolvePrimaryInvalidationMovie({
      breach,
      price: 166.5,
      priorState: null,
      cfg: DEFAULT_INVESTOR_CONFIG,
      now: 1,
      marketOpen: true,
    });
    const cleared = resolvePrimaryInvalidationMovie({
      breach: null,
      price: 169.5,
      priorState: armed.state,
      cfg: DEFAULT_INVESTOR_CONFIG,
      now: 2,
      marketOpen: true,
    });
    expect(cleared.fire).toBe(false);
    expect(cleared.state).toBe(null);
    expect(cleared.deferReason).toBe("reclaimed_above_floor");
  });

  it("fires on session-close mark below the floor (market closed)", () => {
    const r = resolvePrimaryInvalidationMovie({
      breach,
      price: 166.81,
      priorState: { armed: true, armed_ts: 1, inv_price: floor },
      cfg: DEFAULT_INVESTOR_CONFIG,
      now: 2,
      marketOpen: false,
    });
    expect(r.fire).toBe(true);
    expect(r.confirm).toBe("session_close_mark");
  });

  it("fires when prior daily close already broke the floor and live is still below", () => {
    const r = resolvePrimaryInvalidationMovie({
      breach,
      price: 166.0,
      priorState: null,
      cfg: DEFAULT_INVESTOR_CONFIG,
      now: 1,
      marketOpen: true,
      tickerData: { prev_close: 166.5 },
    });
    expect(r.fire).toBe(true);
    expect(r.confirm).toBe("prior_daily_close");
  });

  it("fires on sustained hold-below without reclaim", () => {
    const holdMin = DEFAULT_INVESTOR_CONFIG.investor_invalidation_hold_below_minutes;
    const armedTs = 1_000_000;
    const r = resolvePrimaryInvalidationMovie({
      breach,
      price: 166.0,
      priorState: { armed: true, armed_ts: armedTs, inv_price: floor, breach_low: 165 },
      cfg: DEFAULT_INVESTOR_CONFIG,
      now: armedTs + holdMin * 60 * 1000 + 1,
      marketOpen: true,
      tickerData: { prev_close: 172 },
    });
    expect(r.fire).toBe(true);
    expect(r.confirm).toBe("sustained_hold_below");
  });

  it("legacy tick path still fires immediately when movie disabled", () => {
    const r = resolvePrimaryInvalidationMovie({
      breach,
      price: 166.81,
      cfg: { ...DEFAULT_INVESTOR_CONFIG, investor_invalidation_movie_enabled: false },
      marketOpen: true,
    });
    expect(r.fire).toBe(true);
    expect(r.confirm).toBe("legacy_tick");
  });
});

describe("detectDailyEma21Test", () => {
  it("flags a reclaim after testing Daily 21", () => {
    const r = detectDailyEma21Test({
      price: 172,
      day_low: 169.8,
      tf_tech: { D: { ema: { ema21: 170, priceAboveEma21: true } } },
    });
    expect(r.tested).toBe(true);
    expect(r.reclaimed).toBe(true);
    expect(r.signal).toBe("daily_ema21_test_reclaim");
  });

  it("keeps ANET structural anchor in memory map", () => {
    expect(INVESTOR_STRUCTURAL_ANCHORS.ANET.daily_ema21_respect).toBe(true);
  });
});

describe("detectWeeklyBreakoutRetest (CAT)", () => {
  const catBounce = {
    ticker: "CAT",
    price: 876.54,
    week_low: 804.57,
    // The weekly SuperTrend PRICE lives on weekly_bundle. `st_support` is keyed
    // under `.map.<tf>` and holds {dir, slope, aligned}, never a level — this
    // fixture used to assert against `st_support.W`, a shape production has
    // never produced.
    st_support: { map: { W: { dir: "bull", slope: "rising", aligned: true } } },
    weekly_bundle: { ema21: 808, supertrend_line: 810 },
    tf_tech: { W: { ema: { ema21: 808, priceAboveEma21: true }, low: 804.57 } },
  };

  it("flags week-low EMA21 + Weekly ST confluence after bounce", () => {
    const r = detectWeeklyBreakoutRetest(catBounce);
    expect(r.emaTested).toBe(true);
    expect(r.stTested).toBe(true);
    expect(r.emaReclaimed).toBe(true);
    expect(r.confluence).toBe(true);
    expect(r.signal).toBe("weekly_breakout_retest");
  });

  it("puts accum zone in weekly_breakout_retest with CAT memory", () => {
    const z = detectAccumulationZone(catBounce);
    expect(z.inZone).toBe(true);
    expect(z.zoneType).toBe("weekly_breakout_retest");
    expect(z.signals).toContain("weekly_breakout_retest");
    expect(z.signals).toContain("memory_weekly_breakout_retest");
    expect(z.confidence).toBeGreaterThanOrEqual(40);
  });

  it("keeps CAT structural anchors in memory map", () => {
    expect(INVESTOR_STRUCTURAL_ANCHORS.CAT.weekly_breakout_retest).toBe(true);
    expect(INVESTOR_STRUCTURAL_ANCHORS.CAT.weekly_ema21_respect).toBe(true);
    expect(INVESTOR_STRUCTURAL_ANCHORS.CAT.weekly_st_respect).toBe(true);
  });
});

describe("resolveInvestorMfeExtensionTrim", () => {
  it("trims when peak extends ≥10% and price is still extended", () => {
    const r = resolveInvestorMfeExtensionTrim({
      avgEntry: 171.17,
      price: 188,
      peakPrice: 190,
      priorTrimmed: false,
      cfg: DEFAULT_INVESTOR_CONFIG,
    });
    expect(r.fire).toBe(true);
    expect(r.reason).toBe("MFE_EXTENSION_TRIM");
    expect(r.trimPct).toBeCloseTo(0.25, 2);
  });

  it("does not re-trim after prior MFE extension trim", () => {
    const r = resolveInvestorMfeExtensionTrim({
      avgEntry: 171.17,
      price: 188,
      peakPrice: 190,
      priorTrimmed: true,
      cfg: DEFAULT_INVESTOR_CONFIG,
    });
    expect(r.fire).toBe(false);
  });
});

describe("resolvePrimaryInvalidationBreach", () => {
  it("still detects live breach for arming", () => {
    const b = resolvePrimaryInvalidationBreach(166.81, {
      primaryInvalidation: { price: floor, label: "Weekly ATR support" },
    });
    expect(b).not.toBeNull();
    expect(b.price).toBe(floor);
  });
});
