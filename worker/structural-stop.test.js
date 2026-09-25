// worker/structural-stop.test.js

import { describe, it, expect } from "vitest";
import {
  loadStructuralStopConfig,
  structuralStopLevel,
  applyStructuralStop,
  clampRespectingStructure,
  STRUCTURAL_STOP_DA_KEYS,
} from "./structural-stop.js";
import { REPLAY_DA_KEYS } from "./replay-runtime-setup.js";
import { computeTfBundle } from "./indicators.js";

const ON = { deep_audit_stop_beyond_swing_enabled: "true" };
// Entry 100, daily ATR 2, prior 5-day low 97, 10-day low 95.
const DS = { ath52w: { swing_low_5: 97, swing_high_5: 104, swing_low_10: 95, swing_high_10: 106 } };
const ctx = (over = {}) => ({ direction: "LONG", entryPx: 100, dailyStructure: DS, dailyAtr: 2, daCfg: ON, ...over });

describe("config", () => {
  it("is off by default and every knob reaches the replay runtime", () => {
    expect(loadStructuralStopConfig({}).enabled).toBe(false);
    for (const k of STRUCTURAL_STOP_DA_KEYS) expect(REPLAY_DA_KEYS).toContain(k);
  });
});

describe("structuralStopLevel", () => {
  it("sits a buffer beyond the 5-day swing", () => {
    expect(structuralStopLevel(ctx())).toBeCloseTo(97 - 0.2, 9);
    expect(structuralStopLevel(ctx({ direction: "SHORT" }))).toBeCloseTo(104 + 0.2, 9);
  });

  it("uses the 10-day swing when asked", () => {
    expect(structuralStopLevel(ctx({ daCfg: { ...ON, deep_audit_stop_beyond_swing_days: "10" } }))).toBeCloseTo(94.8, 9);
  });

  it("never sits further than the ATR cap from entry", () => {
    expect(structuralStopLevel(ctx({ dailyStructure: { ath52w: { swing_low_5: 90 } } }))).toBe(94);
  });

  it("is null without the inputs, or when the swing is on the wrong side", () => {
    expect(structuralStopLevel(ctx({ dailyAtr: 0 }))).toBeNull();
    expect(structuralStopLevel(ctx({ dailyStructure: {} }))).toBeNull();
    expect(structuralStopLevel(ctx({ dailyStructure: { ath52w: { swing_low_5: 101 } } }))).toBeNull();
  });
});

describe("applyStructuralStop", () => {
  it("widens a stop that sits inside the swing", () => {
    expect(applyStructuralStop(98.5, ctx())).toEqual({ sl: 96.8, moved: true, level: 96.8 });
  });

  it("never tightens a stop already beyond it", () => {
    expect(applyStructuralStop(96, ctx()).moved).toBe(false);
    expect(applyStructuralStop(96, ctx()).sl).toBe(96);
  });

  it("does nothing when off", () => {
    expect(applyStructuralStop(98.5, ctx({ daCfg: {} }))).toEqual({ sl: 98.5, moved: false, level: null });
  });
});

describe("clampRespectingStructure", () => {
  it("lets the ETF clamp tighten, but not back inside the swing", () => {
    // ETF 0.7% clamp = 99.30 would put the stop inside a 96.80 structural level.
    expect(clampRespectingStructure(99.3, ctx())).toBeCloseTo(96.8, 9);
    expect(clampRespectingStructure(99.3, ctx({ daCfg: {} }))).toBe(99.3);
    expect(clampRespectingStructure(100.7, ctx({ direction: "SHORT" }))).toBeCloseTo(104.2, 9);
  });
});

describe("computeTfBundle swing levels", () => {
  it("come from the bars BEFORE the current one", () => {
    const bars = [];
    for (let i = 0; i < 60; i++) bars.push({ ts: i * 86400000, o: 100, h: 101, l: 99, c: 100, v: 1000 });
    bars[54].l = 90;                                  // inside the 5 prior bars (54..58)
    bars[59] = { ...bars[59], l: 80, h: 120 };        // current bar: excluded
    const b = computeTfBundle(bars);
    expect(b.ath52w.swing_low_5).toBe(90);
    expect(b.ath52w.swing_high_5).toBe(101);
    expect(b.ath52w.swing_low_10).toBe(90);
  });
});
