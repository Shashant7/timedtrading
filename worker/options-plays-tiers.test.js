import { describe, it, expect } from "vitest";
import {
  buildDayTradeTiers,
  pickBreathingExpiration,
  pickItmStrike,
  pickDayTradeExpiration,
  applyHonestyGate,
  attachOptionManagement,
  attachManagementToTiers,
  shouldIndexAutoMirror,
  buildIndexSwingPlay,
  pickIndexSwingExpiration,
  buildScorecardHeadline,
} from "./options-plays.js";

describe("pickItmStrike", () => {
  it("puts an ITM call strike below spot on a $1 grid", () => {
    // spot 772.67 → 1% ITM = 764.9 → round 765
    expect(pickItmStrike(772.67, "call")).toBe(765);
  });
  it("puts an ITM put strike above spot", () => {
    expect(pickItmStrike(772.67, "put")).toBe(780);
  });
  it("returns null on bad spot", () => {
    expect(pickItmStrike(0, "call")).toBeNull();
    expect(pickItmStrike(null, "put")).toBeNull();
  });
});

describe("pickBreathingExpiration", () => {
  it("returns a target-N-session ISO date and dte", () => {
    // pick a Wednesday so 3 sessions forward = Monday (5 calendar days)
    const wed = Date.UTC(2026, 7, 19, 15, 0, 0); // Aug 19, 2026 is a Wednesday
    const out = pickBreathingExpiration(wed, { targetSessions: 3 });
    expect(out.dte).toBe(3);
    // Wed + 3 trading sessions = Mon
    expect(out.iso).toBe("2026-08-24");
    expect(out.label).toContain("breathing");
  });
  it("skips weekends", () => {
    // Friday
    const fri = Date.UTC(2026, 7, 21, 15, 0, 0);
    const out = pickBreathingExpiration(fri, { targetSessions: 3 });
    expect(out.iso).toBe("2026-08-26"); // Fri +3 = Wed
    expect(out.dte).toBe(3);
  });
  it("clamps target sessions to a sane range", () => {
    const out = pickBreathingExpiration(Date.now(), { targetSessions: 999 });
    expect(out.dte).toBeLessThanOrEqual(10);
    expect(out.dte).toBeGreaterThan(0);
  });
});

describe("buildDayTradeTiers", () => {
  const now = Date.UTC(2026, 7, 19, 14, 0, 0); // Wed 10am ET-ish
  const spy = {
    ticker: "SPY",
    price: 772.67,
    direction: "SHORT",
    atrPct: 0.008,
    profile: "speculator",
    now,
    dayLean: "SHORT",
    dayLeanConviction: "medium",
    verdict: {
      mode: "WAIT",
      side: "NEUTRAL",
      timing: { call_opportunity: false, put_opportunity: false },
    },
    expiration: pickDayTradeExpiration(now),
  };

  it("returns three tiers on a real put day-lean", () => {
    const out = buildDayTradeTiers(spy);
    expect(out).toBeTruthy();
    expect(out.tier_count).toBe(3);
    const kinds = out.tiers.map((t) => t._tier);
    expect(kinds).toContain("gamma");
    expect(kinds).toContain("safety");
    expect(kinds).toContain("breathing");
  });

  it("speculator headlines Gamma", () => {
    const out = buildDayTradeTiers(spy);
    expect(out.primary_tier).toBe("gamma");
    expect(out.tiers[0]._tier).toBe("gamma");
  });

  it("aggressive headlines Safety", () => {
    const out = buildDayTradeTiers({ ...spy, profile: "aggressive" });
    expect(out.primary_tier).toBe("safety");
    expect(out.tiers[0]._tier).toBe("safety");
  });

  it("moderate + conservative headline Breathing", () => {
    for (const profile of ["moderate", "conservative"]) {
      const out = buildDayTradeTiers({ ...spy, profile });
      expect(out.primary_tier).toBe("breathing");
      expect(out.tiers[0]._tier).toBe("breathing");
    }
  });

  it("safety tier uses an ITM strike and 1 DTE", () => {
    const out = buildDayTradeTiers(spy);
    const safety = out.tiers.find((t) => t._tier === "safety");
    expect(safety).toBeTruthy();
    // Put spec: ITM strike is ABOVE spot
    expect(safety.strikes.primary).toBeGreaterThan(spy.price);
    expect(safety.expiration.dte).toBe(1);
    expect(safety.label).toContain("ITM");
  });

  it("breathing tier uses ~3 DTE ATM", () => {
    const out = buildDayTradeTiers(spy);
    const breathing = out.tiers.find((t) => t._tier === "breathing");
    expect(breathing).toBeTruthy();
    expect(breathing.expiration.dte).toBe(3);
    // ATM (within a dollar)
    expect(Math.abs(breathing.strikes.primary - spy.price)).toBeLessThanOrEqual(1);
    expect(breathing.label).toContain("breathing");
  });

  it("rejects non-day-trade tickers", () => {
    expect(buildDayTradeTiers({ ...spy, ticker: "AAPL" })).toBeNull();
  });

  it("does NOT return a straddle for a directional day-lean", () => {
    const out = buildDayTradeTiers({ ...spy, direction: "SHORT" });
    expect(out).toBeTruthy();
    // Any tier we return must be a call or a put, not a straddle.
    for (const t of out.tiers) {
      expect(String(t.archetype).includes("straddle")).toBe(false);
    }
  });

  it("straddle plays return only one tier (Gamma)", () => {
    const straddleCtx = {
      ...spy,
      direction: "",
      dayLean: "",
      dayLeanConviction: "",
      atrPct: 0.02,
      profile: "conservative",
      verdict: { mode: "WAIT", side: "NEUTRAL", timing: {} },
    };
    const out = buildDayTradeTiers(straddleCtx);
    if (out) {
      // Either no play (build_failed → null) or single-tier straddle.
      expect(out.tier_count).toBe(1);
      expect(out.tiers[0]._tier).toBe("gamma");
    }
  });
});

describe("applyHonestyGate (Stage 3)", () => {
  const tiers = [
    { _tier: "gamma" },
    { _tier: "safety" },
    { _tier: "breathing" },
  ];

  it("no-op when confluence is not WAIT", () => {
    const out = applyHonestyGate({
      tiers, primary_tier: "gamma", day_lean: "SHORT", day_lean_conviction: "medium",
      confluence: { mode: "DRIFT", side: "LONG" },
    });
    expect(out.primary_tier).toBe("gamma");
    expect(out.veto_reason).toBeNull();
  });

  it("no-op when day_lean conviction is high (trust the tape)", () => {
    const out = applyHonestyGate({
      tiers, primary_tier: "gamma", day_lean: "SHORT", day_lean_conviction: "high",
      confluence: { mode: "WAIT", side: "LONG" },
    });
    expect(out.primary_tier).toBe("gamma");
  });

  it("no-op when confluence agrees with the day_lean", () => {
    const out = applyHonestyGate({
      tiers, primary_tier: "gamma", day_lean: "LONG", day_lean_conviction: "medium",
      confluence: { mode: "WAIT", side: "LONG" },
    });
    expect(out.primary_tier).toBe("gamma");
  });

  it("downgrades gamma → safety on WAIT + opposing side + medium conviction", () => {
    const out = applyHonestyGate({
      tiers, primary_tier: "gamma", day_lean: "SHORT", day_lean_conviction: "medium",
      confluence: { mode: "WAIT", side: "LONG" },
    });
    expect(out.primary_tier).toBe("safety");
    expect(out.veto_reason).toBe("wait_long_confluence_opposes_short_lean_medium");
  });

  it("downgrades safety → breathing on the same class if already at safety", () => {
    const out = applyHonestyGate({
      tiers, primary_tier: "safety", day_lean: "LONG", day_lean_conviction: "medium",
      confluence: { mode: "WAIT", side: "SHORT" },
    });
    expect(out.primary_tier).toBe("breathing");
  });

  it("caps at breathing (never inverts, never publishes a fourth tier)", () => {
    const out = applyHonestyGate({
      tiers, primary_tier: "breathing", day_lean: "LONG", day_lean_conviction: "medium",
      confluence: { mode: "WAIT", side: "SHORT" },
    });
    expect(out.primary_tier).toBe("breathing");
    expect(out.veto_reason).toBeNull();
  });

  it("no-op when the target tier is not in the tier list", () => {
    const out = applyHonestyGate({
      tiers: [{ _tier: "gamma" }],
      primary_tier: "gamma", day_lean: "SHORT", day_lean_conviction: "medium",
      confluence: { mode: "WAIT", side: "LONG" },
    });
    expect(out.primary_tier).toBe("gamma");
    expect(out.veto_reason).toBeNull();
  });
});

describe("attachOptionManagement (Stage 4)", () => {
  const gp = { bull_trigger: 776, bull_target: 780, bear_trigger: 770, bear_target: 766 };

  it("attaches the exit doctrine block to a put day-trade", () => {
    const play = { _day_trade_flavor: "put", expiration: { dte: 1 } };
    const out = attachOptionManagement(play, { gamePlan: gp });
    expect(out.option_management).toBeTruthy();
    expect(out.option_management.take_profit_1).toEqual({ pct: 40, size: 0.5 });
    expect(out.option_management.hard_stop_pct).toBe(-50);
    expect(out.option_management.time_stop_et).toBe("16:15");
    // Put invalidation is the BULL trigger (reclaim)
    expect(out.option_management.invalidation).toEqual({ underlying_above: 776 });
  });

  it("attaches to a call with the BEAR trigger as invalidation", () => {
    const play = { _day_trade_flavor: "call", expiration: { dte: 0 } };
    const out = attachOptionManagement(play, { gamePlan: gp });
    expect(out.option_management.time_stop_et).toBe("12:00"); // 0 DTE cutoff
    expect(out.option_management.invalidation).toEqual({ underlying_below: 770 });
  });

  it("degrades gracefully with no game plan", () => {
    const play = { _day_trade_flavor: "call", expiration: { dte: 1 } };
    const out = attachOptionManagement(play, {});
    expect(out.option_management.invalidation).toEqual({ underlying_below: null });
  });

  it("attachManagementToTiers wraps every tier", () => {
    const tiers = {
      tiers: [
        { _tier: "gamma", _day_trade_flavor: "put", expiration: { dte: 1 } },
        { _tier: "safety", _day_trade_flavor: "put", expiration: { dte: 1 } },
      ],
      primary_tier: "gamma",
    };
    const out = attachManagementToTiers(tiers, { gamePlan: gp });
    expect(out.tiers).toHaveLength(2);
    expect(out.tiers[0].option_management).toBeTruthy();
    expect(out.tiers[1].option_management).toBeTruthy();
  });
});

describe("shouldIndexAutoMirror (Stage 5)", () => {
  it("blocks when the flag is off", () => {
    expect(shouldIndexAutoMirror({ ticker: "SPY", archetype: "day_trade_call", flagOn: false }).should_mirror).toBe(false);
  });
  it("blocks non-index tickers", () => {
    expect(shouldIndexAutoMirror({ ticker: "AAPL", archetype: "day_trade_call", flagOn: true }).should_mirror).toBe(false);
    expect(shouldIndexAutoMirror({ ticker: "DIA", archetype: "day_trade_call", flagOn: true }).should_mirror).toBe(false);
  });
  it("blocks non-directional archetypes", () => {
    expect(shouldIndexAutoMirror({ ticker: "SPY", archetype: "day_trade_straddle", flagOn: true }).should_mirror).toBe(false);
    expect(shouldIndexAutoMirror({ ticker: "SPY", archetype: "long_straddle", flagOn: true }).should_mirror).toBe(false);
  });
  it("blocks when the scorecard win rate is below 60%", () => {
    expect(shouldIndexAutoMirror({
      ticker: "SPY", archetype: "day_trade_put", tier: "gamma",
      scorecardTierWinRate: 45, flagOn: true,
    }).should_mirror).toBe(false);
  });
  it("passes SPY/QQQ/IWM long_call or long_put with ≥60% winrate and flag on", () => {
    for (const t of ["SPY", "QQQ", "IWM"]) {
      expect(shouldIndexAutoMirror({
        ticker: t, archetype: "day_trade_call", tier: "gamma",
        scorecardTierWinRate: 62, flagOn: true,
      }).should_mirror).toBe(true);
    }
  });
  it("passes when scorecard has no data yet (paper first, real edge later)", () => {
    expect(shouldIndexAutoMirror({
      ticker: "SPY", archetype: "day_trade_put", tier: "gamma",
      scorecardTierWinRate: null, flagOn: true,
    }).should_mirror).toBe(true);
  });
});

describe("buildIndexSwingPlay (Stage 6)", () => {
  const now = Date.UTC(2026, 7, 19, 14, 0, 0); // Wednesday

  it("builds a SPY LONG swing call at ATM ~7 DTE", () => {
    const out = buildIndexSwingPlay({ ticker: "SPY", price: 773, direction: "LONG", atrPct: 0.008, now });
    expect(out).toBeTruthy();
    expect(out.archetype).toBe("index_swing_call");
    expect(out.strikes.primary).toBe(773);
    expect(out.expiration.dte).toBeGreaterThanOrEqual(5);
    expect(out.expiration.dte).toBeLessThanOrEqual(14);
    // Stage 4 doctrine attaches automatically
    expect(out.option_management).toBeTruthy();
  });

  it("builds a QQQ SHORT swing put at ATM", () => {
    const out = buildIndexSwingPlay({ ticker: "QQQ", price: 730, direction: "SHORT", atrPct: 0.01, now });
    expect(out.archetype).toBe("index_swing_put");
    expect(out.strikes.primary).toBe(730);
  });

  it("rejects non-SPY/QQQ/IWM tickers", () => {
    expect(buildIndexSwingPlay({ ticker: "DIA", price: 534, direction: "LONG", now })).toBeNull();
    expect(buildIndexSwingPlay({ ticker: "AAPL", price: 190, direction: "LONG", now })).toBeNull();
  });

  it("rejects neutral direction", () => {
    expect(buildIndexSwingPlay({ ticker: "SPY", price: 773, direction: "NEUTRAL", now })).toBeNull();
  });

  it("pickIndexSwingExpiration returns a Friday in the 5-14 DTE window", () => {
    const exp = pickIndexSwingExpiration(now);
    expect(exp.dte).toBeGreaterThanOrEqual(5);
    expect(exp.dte).toBeLessThanOrEqual(14);
    // Fridays in 2026 land on specific dates
    expect(exp.iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("buildScorecardHeadline (Stage 7)", () => {
  it("builds a readable one-liner", () => {
    const row = {
      ticker: "SPY", tier: "gamma", conviction: "medium",
      n: 30, win_rate: 60, avg_max_gain_pct: 42,
    };
    const line = buildScorecardHeadline(row, { window: "9:45–11 ET" });
    expect(line).toBe("SPY gamma · 18-12 (60%) · medium+ · avg peak 42% · best window 9:45–11 ET");
  });

  it("handles missing conviction and window", () => {
    const row = { ticker: "QQQ", tier: "safety", n: 10, win_rate: 40 };
    const line = buildScorecardHeadline(row);
    expect(line).toBe("QQQ safety · 4-6 (40%)");
  });

  it("returns null on garbage", () => {
    expect(buildScorecardHeadline(null)).toBeNull();
    expect(buildScorecardHeadline({})).toBeNull();
  });
});
