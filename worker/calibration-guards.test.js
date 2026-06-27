import { describe, it, expect } from "vitest";
import {
  applyPullbackLiquidityCap,
  evaluateEntryCalibrationGuards,
  parseTickerAllowlist,
  shouldBlockAthBreakoutFastFail,
  shouldBlockRangeReversalAdversePhase,
  shouldBlockRepeatChurn,
} from "./calibration-guards.js";

describe("shouldBlockRangeReversalAdversePhase", () => {
  it("blocks range reversal when adverse phase div at entry", () => {
    const r = shouldBlockRangeReversalAdversePhase({
      entryPath: "tt_range_reversal_long",
      entrySignals: { has_adverse_phase_div: true, adverse_phase_strongest_tf: "15m" },
    });
    expect(r.block).toBe(true);
    expect(r.reason).toBe("range_reversal_adverse_phase_div");
  });

  it("allows gap reversal with adverse phase", () => {
    const r = shouldBlockRangeReversalAdversePhase({
      entryPath: "tt_gap_reversal_long",
      entrySignals: { has_adverse_phase_div: true },
    });
    expect(r.block).toBe(false);
  });
});

describe("shouldBlockAthBreakoutFastFail", () => {
  it("blocks ATH entry before min confirm minutes", () => {
    const now = 1_000_000;
    const r = shouldBlockAthBreakoutFastFail({
      entryPath: "tt_ath_breakout",
      now,
      triggerTs: now - 2 * 60 * 1000,
      confirmCount: 5,
    });
    expect(r.block).toBe(true);
    expect(r.reason).toBe("ath_breakout_min_confirm_minutes");
  });
});

describe("shouldBlockRepeatChurn", () => {
  it("blocks third same-day SL re-entry on allowlisted ticker", () => {
    const r = shouldBlockRepeatChurn({
      ticker: "CRDO",
      direction: "LONG",
      now: Date.UTC(2026, 5, 26, 18, 0, 0),
      dayKey: "2026-06-26",
      dayKeyForTs: () => "2026-06-26",
      daCfg: {
        deep_audit_repeat_churn_guard_enabled: "true",
        deep_audit_repeat_churn_guard_include_tickers: '["CRDO","MOD"]',
        deep_audit_repeat_churn_max_same_day_sl: 2,
      },
      recentClosedTrades: [
        { ticker: "CRDO", direction: "LONG", exit_ts: 1, exit_reason: "sl_breached", status: "LOSS" },
        { ticker: "CRDO", direction: "LONG", exit_ts: 2, exit_reason: "sl_breached", status: "LOSS" },
      ],
    });
    expect(r.block).toBe(true);
    expect(r.reason).toBe("repeat_churn_same_day_sl");
  });

  it("ignores non-allowlisted ticker unless global", () => {
    const r = shouldBlockRepeatChurn({
      ticker: "AAPL",
      daCfg: {
        deep_audit_repeat_churn_guard_include_tickers: '["CRDO"]',
      },
      recentClosedTrades: [
        { ticker: "AAPL", exit_ts: 1, exit_reason: "sl_breached", status: "LOSS" },
        { ticker: "AAPL", exit_ts: 2, exit_reason: "sl_breached", status: "LOSS" },
      ],
    });
    expect(r.block).toBe(false);
  });
});

describe("applyPullbackLiquidityCap", () => {
  it("caps notional on low avg volume pullback", () => {
    const r = applyPullbackLiquidityCap({
      notional: 8000,
      entryPath: "tt_pullback",
      avgDailyVolume: 100_000,
      price: 50,
    });
    expect(r.capped).toBe(true);
    expect(r.notional).toBeLessThan(8000);
  });
});

describe("evaluateEntryCalibrationGuards", () => {
  it("returns first blocking guard", () => {
    const r = evaluateEntryCalibrationGuards({
      entryPath: "tt_range_reversal_long",
      entrySignals: { has_adverse_phase_div: true },
    });
    expect(r.block).toBe(true);
  });
});

describe("parseTickerAllowlist", () => {
  it("parses JSON allowlist", () => {
    expect(parseTickerAllowlist('["CRDO","MOD"]')).toEqual(["CRDO", "MOD"]);
  });
});
