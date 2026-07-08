import { describe, it, expect } from "vitest";
import { isPastHardLossCap } from "./event-risk-hlc-guard.js";

describe("isPastHardLossCap", () => {
  const minHold = 15 * 60 * 1000;

  it("flags WAL-style -4.22% past 4% cap after min hold", () => {
    expect(isPastHardLossCap({
      pnlPct: -4.22,
      pnlDollar: -181,
      capPct: 4,
      capDollar: 250,
      entryAgeMs: 24 * 60 * 60 * 1000,
      minHoldMs: minHold,
    })).toBe(true);
  });

  it("does not flag before min hold", () => {
    expect(isPastHardLossCap({
      pnlPct: -5,
      pnlDollar: -300,
      entryAgeMs: 5 * 60 * 1000,
      minHoldMs: minHold,
    })).toBe(false);
  });

  it("does not flag shallow loss under cap", () => {
    expect(isPastHardLossCap({
      pnlPct: -2.5,
      pnlDollar: -100,
      entryAgeMs: 60 * 60 * 1000,
      minHoldMs: minHold,
    })).toBe(false);
  });

  it("flags dollar cap even when pct is mild", () => {
    expect(isPastHardLossCap({
      pnlPct: -2,
      pnlDollar: -260,
      capPct: 4,
      capDollar: 250,
      entryAgeMs: 60 * 60 * 1000,
      minHoldMs: minHold,
    })).toBe(true);
  });
});
