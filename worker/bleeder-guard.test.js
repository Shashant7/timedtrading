import { describe, it, expect } from "vitest";
import {
  isBleederReason,
  shouldShieldBleederExit,
} from "./bleeder-guard.js";

const healthy = { htfIntact: true, isReversal: false, structuralSupport: true, isPullback: true };
const broken = { htfIntact: false, isReversal: true, structuralSupport: false, isPullback: false };

describe("isBleederReason", () => {
  it("matches the empirically-bleeding soft exits", () => {
    expect(isBleederReason("doctrine_force_exit")).toBe(true);
    expect(isBleederReason("phase_i_mfe_fast_cut_2h")).toBe(true);
    expect(isBleederReason("phase_i_mfe_fast_cut_zero_mfe")).toBe(true);
    expect(isBleederReason("atr_day_adverse_382_cut")).toBe(true);
    expect(isBleederReason("tape_capitulation_force_exit")).toBe(true);
  });
  it("does not match the winners or hard exits", () => {
    expect(isBleederReason("TP_FULL")).toBe(false);
    expect(isBleederReason("ST_FLIP_4H_CLOSE")).toBe(false);
    expect(isBleederReason("sl_breached")).toBe(false);
    expect(isBleederReason("max_loss")).toBe(false);
  });
});

describe("shouldShieldBleederExit", () => {
  const base = { exitReason: "doctrine_force_exit", isHardExit: false, trendHealth: healthy, pnlPct: -1.0, flagEnabled: true };

  it("shields a soft bleeder when structure is intact and flag on", () => {
    expect(shouldShieldBleederExit(base).shield).toBe(true);
  });

  it("NEVER shields a hard exit (capital protection always fires)", () => {
    expect(shouldShieldBleederExit({ ...base, isHardExit: true }).shield).toBe(false);
    expect(shouldShieldBleederExit({ ...base, exitReason: "sl_breached", isHardExit: true }).shield).toBe(false);
  });

  it("does not shield when the flag is off (default)", () => {
    expect(shouldShieldBleederExit({ ...base, flagEnabled: false }).shield).toBe(false);
  });

  it("does not shield a non-bleeder exit (lets winners exit)", () => {
    expect(shouldShieldBleederExit({ ...base, exitReason: "TP_FULL" }).shield).toBe(false);
  });

  it("does not shield when structure is broken/reversing", () => {
    expect(shouldShieldBleederExit({ ...base, trendHealth: broken }).shield).toBe(false);
  });

  it("does not shield a trade bleeding past the PnL floor", () => {
    expect(shouldShieldBleederExit({ ...base, pnlPct: -6 }).shield).toBe(false);
  });
});
