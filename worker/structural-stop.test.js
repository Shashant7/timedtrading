// worker/structural-stop.test.js

import { describe, it, expect } from "vitest";
import {
  loadStructuralStopConfig,
  structuralStopLevel,
  applyStructuralStop,
  clampRespectingStructure,
  dailyAtrOf,
  STRUCTURAL_STOP_DA_KEYS,
} from "./structural-stop.js";
import { REPLAY_DA_KEYS } from "./replay-runtime-setup.js";
import { computeTfBundle, assembleTickerData } from "./indicators.js";

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

describe("dailyAtrOf", () => {
  it("reads atrPct (tf_tech.D.atr is the band object, not a number)", () => {
    const td = { tf_tech: { D: { atr: { band: "mid" }, atrPct: 2.5 } } };
    expect(dailyAtrOf(td, 80)).toBeCloseTo(2, 9);
    expect(dailyAtrOf({ tf_tech: { D: { atr: { band: "mid" } } } }, 80)).toBe(0);
  });

  it("feeds a level from a real assembled tickerData shape", () => {
    const td = { tf_tech: { D: { atrPct: 2.5 } }, daily_structure: DS };
    expect(structuralStopLevel({ direction: "LONG", entryPx: 100, dailyStructure: td.daily_structure, dailyAtr: dailyAtrOf(td, 100), daCfg: ON }))
      .toBeCloseTo(97 - 0.25, 9);
  });
});

describe("assembled tickerData carries both inputs", () => {
  it("daily_structure.ath52w swings and tf_tech.D.atrPct", () => {
    const bars = [];
    for (let i = 0; i < 260; i++) {
      const c = 100 + Math.sin(i / 5) * 3;
      bars.push({ ts: Date.UTC(2025, 0, 1) + i * 86400000, o: c, h: c + 1, l: c - 1, c, v: 1e6 });
    }
    const b = computeTfBundle(bars);
    const td = assembleTickerData("TEST", { M: b, W: b, D: b, "240": b, "60": b, "30": b, "15": b, "10": b });
    expect(td.daily_structure.ath52w.swing_low_5).toBeGreaterThan(0);
    expect(dailyAtrOf(td, 100)).toBeGreaterThan(0);
    const lvl = structuralStopLevel({ direction: "LONG", entryPx: td.daily_structure.ath52w.swing_high_5 + 1,
      dailyStructure: td.daily_structure, dailyAtr: dailyAtrOf(td, 100), daCfg: ON });
    expect(lvl).toBeGreaterThan(0);
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
