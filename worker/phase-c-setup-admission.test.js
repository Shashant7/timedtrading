/**
 * Setup admission matrix — Speculative ATH / N-test gates (DE+WM 2026-07-30).
 */
import { describe, it, expect } from "vitest";
import { admitSetup } from "./phase-c-setup-admission.js";

describe("admitSetup — Speculative ATH breakout", () => {
  it("always blocks Speculative ATH (closes Confirmed-kill / Speculative-allow hole)", () => {
    const r = admitSetup({
      setup: "tt_ath_breakout",
      grade: "Speculative",
      direction: "LONG",
      regime: "STRONG_BULL",
      rr: 3.0,
      conviction: 90,
    });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/blocked_always/);
    expect(r.matched_key).toBe("tt_ath_breakout:LONG:Speculative");
  });

  it("blocks the WM autopsy shape (COUNTER_TREND_BEAR + thin RR)", () => {
    const r = admitSetup({
      setup: "tt_ath_breakout",
      grade: "Speculative",
      direction: "LONG",
      regime: "COUNTER_TREND_BEAR",
      rr: 1.39,
    });
    expect(r.allow).toBe(false);
  });

  it("still blocks Confirmed ATH", () => {
    const r = admitSetup({
      setup: "tt_ath_breakout",
      grade: "Confirmed",
      direction: "LONG",
      regime: "STRONG_BULL",
      rr: 3.0,
    });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/blocked_always/);
  });
});

describe("admitSetup — Speculative N-test support", () => {
  it("blocks LATE_BULL (DE autopsy regime)", () => {
    const r = admitSetup({
      setup: "tt_n_test_support",
      grade: "Speculative",
      direction: "LONG",
      regime: "LATE_BULL",
      rr: 2.52,
    });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/regime_not_allowed/);
  });

  it("blocks COUNTER_TREND_BEAR", () => {
    const r = admitSetup({
      setup: "tt_n_test_support",
      grade: "Speculative",
      direction: "LONG",
      regime: "COUNTER_TREND_BEAR",
      rr: 3.0,
    });
    expect(r.allow).toBe(false);
  });

  it("blocks thin R:R even in EARLY_BULL", () => {
    const r = admitSetup({
      setup: "tt_n_test_support",
      grade: "Speculative",
      direction: "LONG",
      regime: "EARLY_BULL",
      rr: 1.8,
    });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/rr_too_low/);
  });

  it("allows EARLY_BULL with rr>=2.5", () => {
    const r = admitSetup({
      setup: "tt_n_test_support",
      grade: "Speculative",
      direction: "LONG",
      regime: "EARLY_BULL",
      rr: 2.5,
    });
    expect(r.allow).toBe(true);
    expect(r.reason).toMatch(/setup_admission_passed/);
  });

  it("allows STRONG_BULL / NEUTRAL with rr>=2.5", () => {
    for (const regime of ["STRONG_BULL", "NEUTRAL"]) {
      const r = admitSetup({
        setup: "tt_n_test_support",
        grade: "Speculative",
        direction: "LONG",
        regime,
        rr: 2.6,
      });
      expect(r.allow).toBe(true);
    }
  });
});
