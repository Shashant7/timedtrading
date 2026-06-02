// worker/options-plays.test.js
//
// Unit tests for the options-plays module. Focuses on bug-fixes and
// the at-target estimator (the live-exit projection).
//
// Past bugs these pin:
//
//   1) "Max gain at target: $0" surfaced on the SPY long-call Discord
//      embed even when the builder explicitly returned null (because
//      TP < option breakeven). Root cause: compactOptionsPlay used
//      Number(play.max_gain_usd) and Number(null) === 0, then
//      Number.isFinite(0) is true → rendered as $0. Fix: check
//      `!= null` BEFORE Number(...).
//
//   2) "Max gain at target" framing itself was misleading — assumed
//      hold-to-expiration, when in reality the trade exits at TP or
//      SL with whatever the option is worth THEN. Operator quote:
//      "the option premium is unknown at those junctures but I
//      doubt we let this trade go to zero or not take profit."
//      Fix: added estimateOptionAtTargetPrice() + est_at_tp /
//      est_at_sl fields surfaced via Live Exit Projections.

import { describe, it, expect } from "vitest";
import {
  estimateOptionAtTargetPrice,
  blackScholes,
  compactOptionsPlay,
  optionsPlayDiscordField,
  optionsPlayEmailHtml,
} from "./options-plays.js";

describe("blackScholes", () => {
  it("prices an ATM call sensibly", async () => {
    const r = blackScholes({ S: 100, K: 100, T: 30 / 365, sigma: 0.30, type: "C" });
    expect(r).not.toBeNull();
    expect(r.price).toBeGreaterThan(2);
    expect(r.price).toBeLessThan(6);
    expect(r.delta).toBeGreaterThan(0.4);
    expect(r.delta).toBeLessThan(0.65);
  });

  it("returns null for invalid inputs", () => {
    expect(blackScholes({ S: 0, K: 100, T: 30 / 365, sigma: 0.3, type: "C" })).toBeNull();
    expect(blackScholes({ S: 100, K: 100, T: 0, sigma: 0.3, type: "C" })).toBeNull();
    expect(blackScholes({ S: 100, K: 100, T: 30 / 365, sigma: 0, type: "C" })).toBeNull();
  });
});

describe("estimateOptionAtTargetPrice", () => {
  it("projects positive P&L when call's intrinsic at target far exceeds premium", () => {
    /* SPY-like setup, deep enough TP. */
    const r = estimateOptionAtTargetPrice({
      currentPrice: 100, targetPrice: 130, strike: 100, type: "C",
      currentDte: 30, premiumPaid: 4.00, contracts: 1, atrPct: 0.015,
    });
    expect(r).not.toBeNull();
    expect(r.total_pl_usd).toBeGreaterThan(2000);
  });

  it("projects negative P&L when TP is below breakeven (the SPY long-call bug)", () => {
    /* User screenshot scenario: price=757.61, TP=777.13, strike=760,
       premium=30.68 → breakeven=790.68, so TP is BELOW breakeven.
       We must report this as a LOSS, not zero, not positive. */
    const r = estimateOptionAtTargetPrice({
      currentPrice: 757.61, targetPrice: 777.13, strike: 760, type: "C",
      currentDte: 24, premiumPaid: 30.68, contracts: 1, atrPct: 0.012,
    });
    expect(r).not.toBeNull();
    expect(r.total_pl_usd).toBeLessThan(0);
    expect(r.est_premium).toBeGreaterThan(0);
    expect(r.hold_days).toBeGreaterThan(0);
    expect(r.hold_days).toBeLessThan(24);
  });

  it("projects negative P&L when SL is hit on a long call", () => {
    const r = estimateOptionAtTargetPrice({
      currentPrice: 757.61, targetPrice: 746.52, strike: 760, type: "C",
      currentDte: 24, premiumPaid: 30.68, contracts: 1, atrPct: 0.012,
    });
    expect(r).not.toBeNull();
    expect(r.total_pl_usd).toBeLessThan(0);
    expect(r.est_premium).toBeLessThan(30.68);
  });

  it("respects explicit holdDays override", () => {
    const fast = estimateOptionAtTargetPrice({
      currentPrice: 100, targetPrice: 110, strike: 100, type: "C",
      currentDte: 30, premiumPaid: 4, contracts: 1, atrPct: 0.015,
      holdDays: 1,
    });
    const slow = estimateOptionAtTargetPrice({
      currentPrice: 100, targetPrice: 110, strike: 100, type: "C",
      currentDte: 30, premiumPaid: 4, contracts: 1, atrPct: 0.015,
      holdDays: 20,
    });
    // Faster hold → less theta burn → higher remaining premium.
    expect(fast.est_premium).toBeGreaterThan(slow.est_premium);
  });

  it("returns null for invalid inputs", () => {
    expect(estimateOptionAtTargetPrice({
      currentPrice: 0, targetPrice: 100, strike: 100, type: "C",
      currentDte: 30, premiumPaid: 4,
    })).toBeNull();
    expect(estimateOptionAtTargetPrice({
      currentPrice: 100, targetPrice: 100, strike: 100, type: "C",
      currentDte: 0, premiumPaid: 4,
    })).toBeNull();
    expect(estimateOptionAtTargetPrice({
      currentPrice: 100, targetPrice: 100, strike: 100, type: "C",
      currentDte: 30, premiumPaid: 0,
    })).toBeNull();
  });

  it("multiplies P&L by contracts", () => {
    const one = estimateOptionAtTargetPrice({
      currentPrice: 100, targetPrice: 110, strike: 100, type: "C",
      currentDte: 30, premiumPaid: 4, contracts: 1, atrPct: 0.015,
    });
    const five = estimateOptionAtTargetPrice({
      currentPrice: 100, targetPrice: 110, strike: 100, type: "C",
      currentDte: 30, premiumPaid: 4, contracts: 5, atrPct: 0.015,
    });
    expect(five.total_pl_usd).toBe(one.total_pl_usd * 5);
  });
});

describe("compactOptionsPlay — null→0 regression", () => {
  it("does NOT convert null max_gain_usd to 0", () => {
    /* Critical regression: builder returns null when intrinsic < premium.
       Prior compact code used Number(null) === 0 → rendered as $0. */
    const compact = compactOptionsPlay({
      archetype: "long_call",
      label: "Long Call (ATM)",
      legs: [{ action: "BUY", optionType: "CALL", strike: 760, expiration: "2026-06-26", qty: 1, premium_mid: 30.68, leg_cost_usd: 3068, side_label: "debit" }],
      expiration: { iso: "2026-06-26", dte: 24, label: "24DTE" },
      max_loss_usd: 3068,
      max_gain_usd: null, // ← BUG: was becoming 0
      breakeven: 790.68,
    }, { ticker: "SPY", mode: "trader" });
    expect(compact).not.toBeNull();
    expect(compact.max_gain_usd).toBeNull();
    expect(compact.max_loss_usd).toBe(3068);
  });

  it("preserves est_at_tp and est_at_sl through compact", () => {
    const compact = compactOptionsPlay({
      archetype: "long_call",
      label: "Long Call (ATM)",
      legs: [{ action: "BUY", optionType: "CALL", strike: 760, expiration: "2026-06-26", qty: 1, premium_mid: 30.68, leg_cost_usd: 3068, side_label: "debit" }],
      expiration: { iso: "2026-06-26", dte: 24, label: "24DTE" },
      max_loss_usd: 3068,
      max_gain_usd: null,
      breakeven: 790.68,
      target_clears_breakeven: false,
      est_at_tp: { est_premium: 25.5, hold_days: 5, total_pl_usd: -518 },
      est_at_sl: { est_premium: 18.0, hold_days: 3, total_pl_usd: -1268 },
    }, { ticker: "SPY", mode: "trader" });
    expect(compact.target_clears_breakeven).toBe(false);
    expect(compact.est_at_tp.total_pl_usd).toBe(-518);
    expect(compact.est_at_sl.total_pl_usd).toBe(-1268);
  });
});

describe("optionsPlayDiscordField — live-exit projection", () => {
  function buildCompact(over = {}) {
    return compactOptionsPlay({
      archetype: "long_call",
      label: "Long Call (ATM)",
      legs: [{ action: "BUY", optionType: "CALL", strike: 760, expiration: "2026-06-26", qty: 1, premium_mid: 30.68, leg_cost_usd: 3068, side_label: "debit" }],
      expiration: { iso: "2026-06-26", dte: 24, label: "24DTE" },
      max_loss_usd: 3068,
      max_gain_usd: null,
      breakeven: 790.68,
      target_clears_breakeven: false,
      est_at_tp: { est_premium: 25.5, hold_days: 5, total_pl_usd: -518 },
      est_at_sl: { est_premium: 18.0, hold_days: 3, total_pl_usd: -1268 },
      ...over,
    }, { ticker: "SPY", mode: "trader" });
  }

  it("renders the live-exit projection lines", () => {
    const field = optionsPlayDiscordField(buildCompact());
    expect(field).not.toBeNull();
    expect(field.value).toMatch(/Live exit projections/i);
    expect(field.value).toMatch(/If TP hit/);
    expect(field.value).toMatch(/If SL hit/);
    expect(field.value).toMatch(/-\$518/);
    expect(field.value).toMatch(/-\$1,268/);
  });

  it("warns when TP is below breakeven", () => {
    const field = optionsPlayDiscordField(buildCompact());
    expect(field.value).toMatch(/TP below breakeven/);
  });

  it("does NOT show 'Max gain at target: $0' anymore", () => {
    const field = optionsPlayDiscordField(buildCompact());
    expect(field.value).not.toMatch(/Max gain at target: \$0/);
  });

  it("qualifies max loss as expiration-only", () => {
    const field = optionsPlayDiscordField(buildCompact());
    expect(field.value).toMatch(/Max loss \(if held to exp\)/);
  });
});

describe("optionsPlayEmailHtml — live-exit projection", () => {
  it("renders the live-exit panel with color-coded P&L", () => {
    const compact = compactOptionsPlay({
      archetype: "long_call",
      label: "Long Call (ATM)",
      legs: [{ action: "BUY", optionType: "CALL", strike: 760, expiration: "2026-06-26", qty: 1, premium_mid: 30.68, leg_cost_usd: 3068, side_label: "debit" }],
      expiration: { iso: "2026-06-26", dte: 24, label: "24DTE" },
      max_loss_usd: 3068, max_gain_usd: null,
      breakeven: 790.68, target_clears_breakeven: false,
      est_at_tp: { est_premium: 25.5, hold_days: 5, total_pl_usd: -518 },
      est_at_sl: { est_premium: 18.0, hold_days: 3, total_pl_usd: -1268 },
    }, { ticker: "SPY", mode: "trader" });
    const html = optionsPlayEmailHtml(compact);
    expect(html).toMatch(/Live Exit Projections/);
    expect(html).toMatch(/If TP hit/);
    expect(html).toMatch(/-\$518/);
    expect(html).toMatch(/TP below breakeven/);
  });
});
