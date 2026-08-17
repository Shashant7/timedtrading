// worker/investor-autopsy-gates.test.js
// Pins the investor stop-forensics gate pack to the live cases that motivated
// it. Every gate is default OFF, so the first assertion in each block is that
// an unarmed config changes nothing.

import { describe, it, expect } from "vitest";
import {
  weeklySupertrendBull,
  deferForSessionClose,
  shallowBreachScoreHold,
} from "./investor-autopsy-gates.js";

const ON = (k, extra = {}) => ({ [k]: "true", ...extra });

describe("weeklySupertrendBull (D2 — atr.xs is flip-only and sign-mirrored)", () => {
  const OFF = { deep_audit_investor_weekly_st_dir_fix: "false" };

  it("ships ON: an unset config gets the corrected reading, not the legacy one", () => {
    // Pine convention: -1 = bull.
    expect(weeklySupertrendBull({ tfW: { stDir: -1 }, daCfg: null })).toBe(true);
    expect(weeklySupertrendBull({ tfW: { stDir: 1 }, daCfg: null })).toBe(false);
    expect(weeklySupertrendBull({ tfW: { stDir: -1 }, daCfg: {} })).toBe(true);
  });

  it("the kill switch restores the legacy atr.xs === 1 reading", () => {
    expect(weeklySupertrendBull({ tfW: { atr: { xs: 1 } }, daCfg: OFF })).toBe(true);
    expect(weeklySupertrendBull({ tfW: { atr: { xs: -1 } }, daCfg: OFF })).toBe(false);
    // Legacy on the live shape: no flip bar, so no xs, so always false.
    expect(weeklySupertrendBull({ tfW: { stDir: -1, atr: { s: "up", lo: "0.5" } }, daCfg: OFF })).toBe(false);
  });

  it("corrects the inversion: xs === 1 was read as bullish but means stDir >= 0", () => {
    // Producer: atr.xs = stDir < 0 ? -1 : 1. A bearish weekly (stDir=+1)
    // therefore emits xs=+1, which the legacy consumer scored as bullish.
    const bearishWeeklyOnAFlipBar = { stDir: 1, atr: { xs: 1 } };
    expect(weeklySupertrendBull({ tfW: bearishWeeklyOnAFlipBar, daCfg: OFF })).toBe(true);
    expect(weeklySupertrendBull({ tfW: bearishWeeklyOnAFlipBar, daCfg: null })).toBe(false);
  });

  it("recovers the reading on a non-flip bar, where legacy always scored 0", () => {
    // This is the shape on ~every live pass: no stFlip, so no atr.xs at all.
    // Verified 2026-08-17: undefined on all 17 open positions.
    const tfW = { stDir: -1, atr: { s: "up", lo: "1.0", hi: "1.5" } };
    expect(weeklySupertrendBull({ tfW, daCfg: OFF })).toBe(false);
    expect(weeklySupertrendBull({ tfW, daCfg: null })).toBe(true);
  });

  it("falls back to the weekly bundle when tf_tech has no usable stDir", () => {
    expect(weeklySupertrendBull({ tfW: { stDir: 0 }, wb: { supertrend_dir: -1 }, daCfg: null })).toBe(true);
    expect(weeklySupertrendBull({ tfW: null, wb: { supertrend_dir: 1 }, daCfg: null })).toBe(false);
  });

  it("returns false rather than throwing when everything is missing", () => {
    expect(weeklySupertrendBull({ daCfg: null })).toBe(false);
    expect(weeklySupertrendBull({ tfW: {}, wb: {} })).toBe(false);
    expect(weeklySupertrendBull({})).toBe(false);
  });

  it("matches the live book: 15 of 17 open positions read bullish once fixed", () => {
    // W.stDir / weekly_bundle.supertrend_dir pulled from timed:latest:<T>
    // on 2026-08-17. atr.xs was undefined on every one of them.
    const book = {
      PANW: -1, PLTR: -1, CF: -1, TSM: -1, DE: -1, GE: -1, CAT: -1, PWR: -1,
      FN: 1, KO: -1, NVDA: -1, TJX: -1, WTS: -1, IONQ: 1, BNY: -1, ANET: -1, IWM: -1,
    };
    const legacy = [];
    const fixed = [];
    for (const [t, stDir] of Object.entries(book)) {
      const tfW = { stDir, atr: { s: "up", lo: "0.5" } }; // no xs — not a flip bar
      if (weeklySupertrendBull({ tfW, daCfg: OFF })) legacy.push(t);
      if (weeklySupertrendBull({ tfW, daCfg: null })) fixed.push(t);
    }
    expect(legacy).toEqual([]);
    expect(fixed).toHaveLength(15);
    expect(fixed).not.toContain("FN");
    expect(fixed).not.toContain("IONQ");
  });
});

describe("deferForSessionClose (D3 — intraday confirms liquidate a long-horizon lane)", () => {
  it("is a no-op when the flag is off", () => {
    for (const confirm of ["sustained_hold_below", "prior_daily_close", "session_close_mark"]) {
      expect(deferForSessionClose({ confirm, marketOpen: true, daCfg: null })).toBe(false);
    }
  });

  it("defers the two intraday confirms during RTH when armed", () => {
    const cfg = ON("deep_audit_investor_require_session_close");
    expect(deferForSessionClose({ confirm: "sustained_hold_below", marketOpen: true, daCfg: cfg })).toBe(true);
    expect(deferForSessionClose({ confirm: "prior_daily_close", marketOpen: true, daCfg: cfg })).toBe(true);
  });

  it("never defers session_close_mark — that IS the published discipline", () => {
    const cfg = ON("deep_audit_investor_require_session_close");
    expect(deferForSessionClose({ confirm: "session_close_mark", marketOpen: true, daCfg: cfg })).toBe(false);
    expect(deferForSessionClose({ confirm: "session_close_mark", marketOpen: false, daCfg: cfg })).toBe(false);
  });

  it("never defers outside RTH, where the mark is the session close", () => {
    const cfg = ON("deep_audit_investor_require_session_close");
    expect(deferForSessionClose({ confirm: "sustained_hold_below", marketOpen: false, daCfg: cfg })).toBe(false);
    expect(deferForSessionClose({ confirm: "prior_daily_close", marketOpen: false, daCfg: cfg })).toBe(false);
  });

  it("leaves the legacy tick path alone", () => {
    const cfg = ON("deep_audit_investor_require_session_close");
    expect(deferForSessionClose({ confirm: "legacy_tick", marketOpen: true, daCfg: cfg })).toBe(false);
  });
});

describe("shallowBreachScoreHold (D4 — median historical breach was 1.29%)", () => {
  const cfg = ON("deep_audit_investor_shallow_breach_score_hold");

  it("is a no-op when the flag is off", () => {
    const r = shallowBreachScoreHold({ price: 99, breach: { price: 100 }, score: 82, daCfg: null });
    expect(r.hold).toBe(false);
  });

  it("holds SANM — a 0.01% penetration at score 73", () => {
    const floor = 100;
    const r = shallowBreachScoreHold({ price: floor * (1 - 0.0001), breach: { price: floor, label: "Weekly ATR support" }, score: 73, daCfg: cfg });
    expect(r.hold).toBe(true);
    expect(r.breachPct).toBeLessThan(0.05);
  });

  it("holds IESC (0.11% at score 80.8) and CRDO (0.31% at score 82)", () => {
    const iesc = shallowBreachScoreHold({ price: 100 * (1 - 0.0011), breach: { price: 100 }, score: 80.8, daCfg: cfg });
    const crdo = shallowBreachScoreHold({ price: 100 * (1 - 0.0031), breach: { price: 100 }, score: 82, daCfg: cfg });
    expect(iesc.hold).toBe(true);
    expect(crdo.hold).toBe(true);
  });

  it("holds ANET Jul-16 — the -0.62% breach that then ran +26% in 20 sessions", () => {
    const r = shallowBreachScoreHold({ price: 166.81, breach: { price: 167.85 }, score: 71, daCfg: cfg });
    expect(r.hold).toBe(true);
    expect(r.breachPct).toBeCloseTo(0.62, 1);
  });

  it("still fires on NBIS — a 6.93% break is not noise", () => {
    const r = shallowBreachScoreHold({ price: 100 * (1 - 0.0693), breach: { price: 100 }, score: 70, daCfg: cfg });
    expect(r.hold).toBe(false);
    expect(r.breachPct).toBeCloseTo(6.93, 1);
  });

  it("still fires on a shallow breach once the score has actually deteriorated", () => {
    const r = shallowBreachScoreHold({ price: 99.5, breach: { price: 100 }, score: 43, daCfg: cfg });
    expect(r.hold).toBe(false);
    expect(r.score).toBe(43);
  });

  it("respects the configured thresholds", () => {
    const tight = ON("deep_audit_investor_shallow_breach_score_hold", { deep_audit_investor_shallow_breach_pct: 0.5 });
    expect(shallowBreachScoreHold({ price: 99, breach: { price: 100 }, score: 80, daCfg: tight }).hold).toBe(false);
    const strict = ON("deep_audit_investor_shallow_breach_score_hold", { deep_audit_investor_breach_hold_score_min: 85 });
    expect(shallowBreachScoreHold({ price: 99, breach: { price: 100 }, score: 80, daCfg: strict }).hold).toBe(false);
  });

  it("never holds when price is at or above the floor (no breach to defer)", () => {
    expect(shallowBreachScoreHold({ price: 100, breach: { price: 100 }, score: 90, daCfg: cfg }).hold).toBe(false);
    expect(shallowBreachScoreHold({ price: 101, breach: { price: 100 }, score: 90, daCfg: cfg }).hold).toBe(false);
  });

  it("does not hold on missing inputs — a null score must not read as 0 or as strong", () => {
    expect(shallowBreachScoreHold({ price: 99, breach: { price: 100 }, score: null, daCfg: cfg }).hold).toBe(false);
    expect(shallowBreachScoreHold({ price: 99, breach: null, score: 90, daCfg: cfg }).hold).toBe(false);
    expect(shallowBreachScoreHold({ price: null, breach: { price: 100 }, score: 90, daCfg: cfg }).hold).toBe(false);
    expect(shallowBreachScoreHold({ price: 99, breach: { price: 0 }, score: 90, daCfg: cfg }).hold).toBe(false);
  });
});

describe("live open book — what the gates would do on 2026-08-17", () => {
  // Cushion between the live mark and the ratcheted floor, pulled from
  // timed:investor:scores + timed:prices. Four positions sit inside 3%.
  const book = [
    { t: "PANW", price: 384.27, floor: 376.17, score: 79 },
    { t: "PLTR", price: 174.04, floor: 170.32, score: 73 },
    { t: "CF", price: 118.30, floor: 115.49, score: 57 },
    { t: "TSM", price: 426.35, floor: 414.14, score: 47 },
    { t: "DE", price: 608.85, floor: 590.70, score: 68 },
    { t: "CAT", price: 856.57, floor: 824.71, score: 43 },
  ];
  const cfg = ON("deep_audit_investor_shallow_breach_score_hold");

  it("holds the high-conviction names on a 1% dip through the floor, releases the rest", () => {
    const held = [];
    for (const p of book) {
      // Simulate price dipping 1% below the floor — well inside the 1.29%
      // median breach that liquidated 44 positions.
      const r = shallowBreachScoreHold({ price: p.floor * 0.99, breach: { price: p.floor }, score: p.score, daCfg: cfg });
      if (r.hold) held.push(p.t);
    }
    expect(held).toEqual(["PANW", "PLTR", "DE"]);
  });

  it("releases every name once the dip deepens past the 2% band", () => {
    for (const p of book) {
      const r = shallowBreachScoreHold({ price: p.floor * 0.97, breach: { price: p.floor }, score: p.score, daCfg: cfg });
      expect(r.hold).toBe(false);
    }
  });
});
