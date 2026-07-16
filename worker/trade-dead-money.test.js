import { describe, it, expect } from "vitest";
import {
  enrichLiveOpenPositionContext,
  resolveDeadMoneyMfePct,
  shouldDeadMoneyFlatten,
  shouldEarlyDeadMoneyFlatten,
} from "./trade-dead-money.js";

describe("resolveDeadMoneyMfePct", () => {
  it("reads MFE from __tradeRef when context itself is bare (UNP live bug)", () => {
    expect(resolveDeadMoneyMfePct({
      sl: 277.92,
      __tradeRef: { maxFavorableExcursion: 0.7183 },
    })).toBe(0.7183);
  });

  it("takes the max across context and trade ref", () => {
    expect(resolveDeadMoneyMfePct({
      maxFavorableExcursion: 0.4,
      __tradeRef: { max_favorable_excursion: 0.72 },
    })).toBe(0.72);
  });
});

describe("enrichLiveOpenPositionContext", () => {
  it("copies MFE/trim/signals and attaches __tradeRef", () => {
    const trade = {
      direction: "LONG",
      entryPrice: 289.58,
      maxFavorableExcursion: 0.7183,
      maxAdverseExcursion: -1.3675,
      trimmedPct: 0.65,
      entrySignals: { has_adverse_phase_div: true },
      entryPath: "tt_ath_breakout",
      sl: 277.92,
    };
    const ctx = enrichLiveOpenPositionContext({ status: "OPEN", sl: 277.92 }, trade);
    expect(ctx.maxFavorableExcursion).toBe(0.7183);
    expect(ctx.trimmedPct).toBe(0.65);
    expect(ctx.entrySignals.has_adverse_phase_div).toBe(true);
    expect(ctx.__tradeRef).toBe(trade);
  });
});

describe("shouldEarlyDeadMoneyFlatten", () => {
  it("would have fired on UNP if MFE was missing (the false path)", () => {
    expect(shouldEarlyDeadMoneyFlatten({
      positionAgeMarketMin: 600,
      mfePct: 0,
      pnlPct: -1.25,
      trimmedPct: 0,
    })).toMatchObject({ flatten: true, reason: "early_dead_money" });
  });

  it("does not flatten UNP once true MFE is visible", () => {
    expect(shouldEarlyDeadMoneyFlatten({
      positionAgeMarketMin: 600,
      mfePct: 0.7183,
      pnlPct: -1.25,
      trimmedPct: 0.65,
    })).toMatchObject({ flatten: false, reason: "already_trimmed" });
  });

  it("does not flatten when MFE already cleared the 0.5% bar", () => {
    expect(shouldEarlyDeadMoneyFlatten({
      positionAgeMarketMin: 600,
      mfePct: 0.72,
      pnlPct: -1.25,
      trimmedPct: 0,
    })).toMatchObject({ flatten: false, reason: "had_mfe" });
  });
});

describe("shouldDeadMoneyFlatten", () => {
  it("exempts meaningfully trimmed runners", () => {
    expect(shouldDeadMoneyFlatten({
      positionAgeMarketMin: 1500,
      mfePct: 0.3,
      pnlPct: -1.2,
      trimmedPct: 0.5,
    })).toMatchObject({ flatten: false, reason: "already_trimmed" });
  });
});
