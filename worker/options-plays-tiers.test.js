import { describe, it, expect } from "vitest";
import {
  buildDayTradeTiers,
  pickBreathingExpiration,
  pickItmStrike,
  pickDayTradeExpiration,
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
