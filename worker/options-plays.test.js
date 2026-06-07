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
  buildOptionsLadder,
  buildDayTradePlay,
  pickExpirationForProfile,
  attachIndexDayTradeFallback,
  shouldAllowIndexDirectional,
  buildOptionsSetupGuidance,
  buildOptionsModelDisposition,
} from "./options-plays.js";

const SPY_CONTRACT = {
  ticker: "SPY",
  price: 540,
  direction: "LONG",
  sl: 530,
  tp1: 560,
  stage: "swing",
  atr_pct: 0.012,
  mode: "trader",
};

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

describe("index ETF profile alignment", () => {
  // Tuesday 2026-06-02 15:00 UTC (~11 AM ET) — weekday, before close.
  const TUESDAY_OPEN = new Date("2026-06-02T15:00:00.000Z").getTime();

  it("pickExpirationForProfile uses 0DTE for Speculator on index ETFs", () => {
    const exp = pickExpirationForProfile(SPY_CONTRACT, "speculator", TUESDAY_OPEN);
    expect(exp.dte).toBeLessThanOrEqual(1);
  });

  it("pickExpirationForProfile uses weekly swing for Conservative on index ETFs", () => {
    const exp = pickExpirationForProfile(SPY_CONTRACT, "conservative");
    expect(exp.dte).toBeGreaterThanOrEqual(14);
  });

  it("Speculator SPY ladder prefers single-leg long call over vertical spread on DRIFT", () => {
    const ladder = buildOptionsLadder(
      { ...SPY_CONTRACT, _asOf: TUESDAY_OPEN },
      { profile: "speculator", confluence: { mode: "DRIFT", side: "LONG" }, now: TUESDAY_OPEN },
    );
    expect(ladder).not.toBeNull();
    expect(ladder.primary.archetype).toBe("long_call");
    expect(ladder.expiration.dte).toBeLessThanOrEqual(1);
    expect(ladder.ladder.some((s) => s.archetype === "vertical_spread")).toBe(false);
  });

  it("Conservative SPY ladder can headline a vertical spread on DRIFT", () => {
    const ladder = buildOptionsLadder(SPY_CONTRACT, {
      profile: "conservative",
      confluence: { mode: "DRIFT", side: "LONG" },
    });
    expect(ladder).not.toBeNull();
    expect(["vertical_spread", "leap_call", "stock_long"]).toContain(ladder.primary.archetype);
    expect(ladder.expiration.dte).toBeGreaterThanOrEqual(14);
  });

  it("WAIT suppresses index directional plays (no bet per root-strategy)", () => {
    const ladder = buildOptionsLadder(
      { ...SPY_CONTRACT, direction: "SHORT" },
      {
        profile: "speculator",
        confluence: { mode: "WAIT", side: "LONG" },
        now: TUESDAY_OPEN,
      },
    );
    expect(ladder.primary).toBeNull();
    expect(ladder.direction_alignment?.reason).toBe("wait_no_directional_bet");
  });

  it("RIDE with aligned SHORT surfaces long_put for speculator", () => {
    const ladder = buildOptionsLadder(
      { ...SPY_CONTRACT, direction: "SHORT" },
      {
        profile: "speculator",
        confluence: { mode: "RIDE", side: "SHORT" },
        now: TUESDAY_OPEN,
      },
    );
    expect(ladder.primary?.archetype).toBe("long_put");
    expect(ladder.direction_alignment?.allow).toBe(true);
  });

  it("DRIFT blocks when contract conflicts with confluence side", () => {
    expect(shouldAllowIndexDirectional({
      verdictMode: "DRIFT",
      verdictSide: "LONG",
      direction: "SHORT",
    }).allow).toBe(false);
  });

  it("buildDayTradePlay rejects WAIT mismatch", () => {
    expect(buildDayTradePlay({
      ticker: "SPY",
      price: 737.55,
      direction: "SHORT",
      atrPct: 0.012,
      verdict: { mode: "WAIT", side: "LONG" },
      profile: "speculator",
      expiration: { iso: "2026-06-06", dte: 0, label: "0DTE" },
    })).toBeNull();
  });

  it("attachIndexDayTradeFallback skips WAIT mismatch", () => {
    const ladder = attachIndexDayTradeFallback(
      { ladder: [], primary: null },
      {
        ticker: "SPY",
        price: 737.55,
        direction: "SHORT",
        atrPct: 0.012,
        verdict: { mode: "WAIT", side: "LONG" },
        profile: "speculator",
        expiration: { iso: "2026-06-06", dte: 0, label: "0DTE" },
      },
    );
    expect(ladder.primary).toBeNull();
  });

  it("buildDayTradePlay skips straddle for Speculator on neutral days", () => {
    const play = buildDayTradePlay({
      ticker: "SPY",
      price: 540,
      direction: "",
      atrPct: 0.015,
      verdict: { mode: "WAIT", side: "NEUTRAL" },
      profile: "speculator",
    });
    expect(play).toBeNull();
  });

  it("buildDayTradePlay allows straddle for Conservative on neutral high-vol days", () => {
    const play = buildDayTradePlay({
      ticker: "SPY",
      price: 540,
      direction: "",
      atrPct: 0.015,
      verdict: { mode: "WAIT", side: "NEUTRAL" },
      profile: "conservative",
      expiration: { iso: "2026-06-09", dte: 1, label: "1DTE" },
    });
    expect(play).not.toBeNull();
    expect(play.archetype).toBe("day_trade_straddle");
  });
});

describe("shouldAllowIndexDirectional — compression call timing", () => {
  it("allows LONG call when timing overlay fires on WAIT split", () => {
    const align = shouldAllowIndexDirectional({
      verdictMode: "WAIT",
      verdictSide: "SHORT",
      direction: "LONG",
      effectiveDirection: "LONG",
      confluence: {
        timing: {
          call_opportunity: true,
          long_opportunity: true,
          compression_score: 65,
          bias: "COMPRESSION",
          posture: "RISK_ON_BUY",
        },
      },
    });
    expect(align.allow).toBe(true);
    expect(align.reason).toBe("compression_call_timing");
    expect(align.timing_override).toBe(true);
  });
});

describe("shouldAllowIndexDirectional — extension put timing", () => {
  it("allows SHORT put when timing overlay fires on WAIT split", () => {
    const align = shouldAllowIndexDirectional({
      verdictMode: "WAIT",
      verdictSide: "LONG",
      direction: "SHORT",
      effectiveDirection: "SHORT",
      confluence: {
        timing: {
          put_opportunity: true,
          short_opportunity: true,
          extension_score: 65,
          posture: "RISK_OFF",
        },
      },
    });
    expect(align.allow).toBe(true);
    expect(align.reason).toBe("extension_put_timing");
    expect(align.timing_override).toBe(true);
  });
});

describe("buildOptionsSetupGuidance — setup quality tiers", () => {
  it("compression call timing → valid with CALL window copy", () => {
    const g = buildOptionsSetupGuidance({
      confluence: {
        mode: "WAIT",
        side: "SHORT",
        score: 22,
        timing: { call_opportunity: true, add_on_dips: true, compression_score: 60, bias: "COMPRESSION" },
      },
      contract: { ticker: "SPY", atr_pct: 0.012 },
      directionAlignment: {
        allow: true,
        reason: "compression_call_timing",
        contractDir: "LONG",
        side: "LONG",
        timing_override: true,
      },
      primary: { archetype: "long_call" },
    });
    expect(g.tier).toBe("valid");
    expect(g.why).toMatch(/CALL window/i);
  });

  it("extension put timing → valid with PUT window copy", () => {
    const g = buildOptionsSetupGuidance({
      confluence: {
        mode: "WAIT",
        side: "LONG",
        score: 22,
        timing: { put_opportunity: true, trim_winners: true, extension_score: 60 },
      },
      contract: { ticker: "SPY", atr_pct: 0.012 },
      directionAlignment: {
        allow: true,
        reason: "extension_put_timing",
        contractDir: "SHORT",
        side: "SHORT",
        timing_override: true,
      },
      primary: { archetype: "long_put" },
    });
    expect(g.tier).toBe("valid");
    expect(g.why).toMatch(/PUT window/i);
  });

  it("WAIT → not_good with timing emphasis", () => {
    const g = buildOptionsSetupGuidance({
      confluence: { mode: "WAIT", side: "LONG", score: 22 },
      contract: { ticker: "SPY", atr_pct: 0.012 },
      directionAlignment: { allow: false, reason: "wait_no_directional_bet", contractDir: "SHORT", side: "LONG" },
      primary: null,
    });
    expect(g.tier).toBe("not_good");
    expect(g.label).toBe("NOT A GOOD SETUP");
    expect(g.action).toMatch(/sit out/i);
    expect(g.why).toMatch(/suppressed on purpose/i);
    expect(g.timing_note).toMatch(/timing/i);
  });

  it("READY → forming", () => {
    const g = buildOptionsSetupGuidance({
      confluence: { mode: "READY", side: "LONG", score: 68, supertrend_trigger: { freshness: "none" } },
      contract: { ticker: "NVDA", atr_pct: 0.04 },
      primary: null,
    });
    expect(g.tier).toBe("forming");
    expect(g.high_volatility).toBe(true);
    expect(g.why).toMatch(/do not chase/i);
  });

  it("RIDE + fresh ST + play → good", () => {
    const g = buildOptionsSetupGuidance({
      confluence: {
        mode: "RIDE", side: "LONG", score: 82,
        supertrend_trigger: { freshness: "fresh", side: "LONG" },
      },
      contract: { ticker: "SPY", atr_pct: 0.012 },
      primary: { archetype: "long_call" },
    });
    expect(g.tier).toBe("good");
    expect(g.label).toBe("GOOD SETUP");
    expect(g.why).toMatch(/fresh/i);
  });

  it("DRIFT with play → valid", () => {
    const g = buildOptionsSetupGuidance({
      confluence: { mode: "DRIFT", side: "SHORT", score: 55, supertrend_trigger: { freshness: "in_motion" } },
      contract: { ticker: "TSLA", atr_pct: 0.05 },
      primary: { archetype: "vertical_spread" },
    });
    expect(g.tier).toBe("valid");
    expect(g.why).toMatch(/defined-risk/i);
    expect(g.why).not.toMatch(/iron condor/i);
  });

  it("ladder includes setup_guidance", () => {
    const ladder = buildOptionsLadder(SPY_CONTRACT, {
      profile: "speculator",
      confluence: { mode: "RIDE", side: "LONG", score: 80, supertrend_trigger: { freshness: "fresh", side: "LONG" } },
    });
    expect(ladder.setup_guidance?.tier).toBe("good");
    expect(ladder.setup_guidance?.action).toBeTruthy();
    expect(ladder.setup_guidance?.why).toBeTruthy();
  });

  it("ladder includes model_disposition", () => {
    const ladder = buildOptionsLadder(SPY_CONTRACT, {
      profile: "speculator",
      confluence: { mode: "RIDE", side: "LONG", score: 80, supertrend_trigger: { freshness: "fresh", side: "LONG" } },
    });
    expect(ladder.model_disposition?.stance).toBe("enter");
    expect(ladder.model_disposition?.would_model_enter).toBe(true);
    expect(ladder.effective_direction).toBe("LONG");
  });
});

describe("buildOptionsModelDisposition — fade / weak fusion", () => {
  it("FADE flip SHORT contract → LONG play is counter-trend timing", () => {
    const sg = buildOptionsSetupGuidance({
      confluence: { mode: "FADE", side: "LONG", score: 6, supertrend_trigger: { freshness: "in_motion", side: "SHORT" } },
      contract: { ticker: "UHS", atr_pct: 0.03 },
      primary: { archetype: "long_call" },
    });
    const d = buildOptionsModelDisposition({
      confluence: { mode: "FADE", side: "LONG", score: 6 },
      contractDirection: "SHORT",
      effectiveDirection: "LONG",
      directionFlipped: true,
      setupGuidance: sg,
      primary: { archetype: "long_call" },
    });
    expect(d.stance).toBe("fade_risk");
    expect(d.stance_label).toMatch(/COUNTER-TREND/i);
    expect(d.summary).toMatch(/SHORT/);
    expect(d.summary).toMatch(/LONG/);
    expect(d.fusion_band).toBe("weak");
    expect(d.valid_play).toBe(true);
    expect(d.would_model_enter).toBe(false);
  });

  it("WAIT with no play → sit out", () => {
    const sg = buildOptionsSetupGuidance({
      confluence: { mode: "WAIT", side: "NEUTRAL", score: 12 },
      contract: { ticker: "XYZ", atr_pct: 0.02 },
      primary: null,
    });
    const d = buildOptionsModelDisposition({
      confluence: { mode: "WAIT", side: "NEUTRAL", score: 12 },
      contractDirection: "LONG",
      effectiveDirection: "LONG",
      directionFlipped: false,
      setupGuidance: sg,
      primary: null,
    });
    expect(d.stance).toBe("sit_out");
    expect(d.valid_play).toBe(false);
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
