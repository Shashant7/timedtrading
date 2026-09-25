// worker/conviction-management.test.js

import { describe, it, expect } from "vitest";
import {
  loadConvictionMgmtConfig,
  resolveTradeGrade,
  holdsToStructure,
  trailConfigFor,
  staleRunnerHoursFor,
  CONVICTION_DA_KEYS,
} from "./conviction-management.js";
import { REPLAY_DA_KEYS } from "./replay-runtime-setup.js";
import { evaluateMfeRatchet } from "./pipeline/mfe-ratchet.js";
import { evaluateExit } from "./pipeline/tt-core-exit.js";

const ON = { deep_audit_conviction_mgmt_enabled: "true" };

// P, 2026-09-21: Prime TT Cloud Pivot, rank 100, entry 112.46, stop 101.06.
const P = { direction: "LONG", entryPrice: 112.46, sl: 101.06, setup_grade: "Prime", status: "OPEN" };

describe("config", () => {
  it("is off unless enabled", () => {
    expect(loadConvictionMgmtConfig({}).enabled).toBe(false);
    expect(holdsToStructure(P, {})).toBe(false);
  });

  it("holds Prime by default and takes a comma list", () => {
    expect(loadConvictionMgmtConfig(ON).grades).toEqual(["prime"]);
    expect(loadConvictionMgmtConfig({ ...ON, deep_audit_conviction_mgmt_grades: "Prime, Confirmed" }).grades)
      .toEqual(["prime", "confirmed"]);
  });

  it("every knob reaches the replay runtime", () => {
    for (const k of CONVICTION_DA_KEYS) expect(REPLAY_DA_KEYS).toContain(k);
  });
});

describe("resolveTradeGrade", () => {
  it("reads the grade wherever the context carried it", () => {
    expect(resolveTradeGrade({ setup_grade: "Prime" })).toBe("Prime");
    expect(resolveTradeGrade({ setupGrade: "Confirmed" })).toBe("Confirmed");
    expect(resolveTradeGrade({ __tradeRef: { setupGrade: "Prime" } })).toBe("Prime");
    expect(resolveTradeGrade({})).toBeNull();
  });
});

describe("holdsToStructure", () => {
  it("holds a Prime long with a stop below entry", () => {
    expect(holdsToStructure(P, ON)).toBe(true);
  });

  it("does not hold other grades", () => {
    expect(holdsToStructure({ ...P, setup_grade: "Speculative" }, ON)).toBe(false);
    expect(holdsToStructure({ ...P, setup_grade: "Confirmed" }, ON)).toBe(false);
  });

  it("does not hold without a structural stop to hold to", () => {
    expect(holdsToStructure({ ...P, sl: null }, ON)).toBe(false);
    expect(holdsToStructure({ ...P, sl: 0 }, ON)).toBe(false);
  });

  it("does not hold a stop on the wrong side of entry", () => {
    expect(holdsToStructure({ ...P, sl: 115 }, ON)).toBe(false);
    expect(holdsToStructure({ ...P, direction: "SHORT", sl: 101.06 }, ON)).toBe(false);
    expect(holdsToStructure({ ...P, direction: "SHORT", sl: 120 }, ON)).toBe(true);
  });

  it("uses the caller's direction and entry when given", () => {
    expect(holdsToStructure({ setup_grade: "Prime", sl: 101 }, ON, { direction: "LONG", entryPrice: 112 })).toBe(true);
  });
});

describe("trailConfigFor", () => {
  it("leaves a non-held trade's config untouched (same object)", () => {
    const cfg = { ...ON, deep_audit_mfe_ratchet_lock_frac: 0.4 };
    expect(trailConfigFor({ ...P, setup_grade: "Speculative" }, cfg)).toBe(cfg);
    expect(trailConfigFor(P, {})).toEqual({});
  });

  it("widens both give-back trails for a held trade", () => {
    const out = trailConfigFor(P, ON);
    expect(out.deep_audit_mfe_ratchet_lock_frac).toBe(0.25);
    expect(out.deep_audit_mfe_ratchet_hi_lock_frac).toBe(0.55);
    expect(out.deep_audit_mfe_ratchet_runner_lock_frac).toBe(0.7);
    expect(out.deep_audit_mfe_trail_ratio_low).toBe(0.25);
    expect(out.deep_audit_mfe_trail_ratio_mid).toBe(0.45);
    expect(out.deep_audit_mfe_trail_ratio_high).toBe(0.6);
  });

  it("gives a held trade more room in the real MFE ratchet", () => {
    // Peak +3%, now +1.0%: the live 40% lock (+1.2%) fires; 25% (+0.75%) does not.
    const pos = { ...P, maxFavorableExcursion: 3.0 };
    const live = evaluateMfeRatchet({ pnlPct: 1.0, position: pos, daCfg: {} });
    const held = evaluateMfeRatchet({ pnlPct: 1.0, position: pos, daCfg: trailConfigFor(pos, ON) });
    expect(live.fire).toBe(true);
    expect(held.fire).toBe(false);
  });
});

describe("staleRunnerHoursFor", () => {
  it("doubles the stale-runner clock for a held trade only", () => {
    expect(staleRunnerHoursFor(P, ON, 120)).toBe(240);
    expect(staleRunnerHoursFor({ ...P, setup_grade: "Confirmed" }, ON, 120)).toBe(120);
    expect(staleRunnerHoursFor(P, {}, 120)).toBe(120);
  });
});

describe("pipeline exit (tt-core-exit) agrees", () => {
  // Price at 108.90 = -3.17%: through the -3% floor, well above the 101.06 stop.
  const ctx = (deepAudit) => ({
    raw: { ema_regime_daily: 1 },
    tf: {},
    price: 108.9,
    asOfTs: Date.UTC(2026, 8, 22, 16, 0),
    config: { deepAudit },
  });
  const pos = { ...P, entry_ts: Date.UTC(2026, 8, 21, 17, 3) };

  it("cuts at the flat floor when conviction management is off", () => {
    const r = evaluateExit(ctx({}), pos);
    expect(r?.reason).toMatch(/max_loss/);
  });

  it("holds a Prime trade to its structure when on", () => {
    const r = evaluateExit(ctx(ON), pos);
    expect(String(r?.reason || "")).not.toMatch(/max_loss/);
  });

  it("still stops out at the structural stop", () => {
    const r = evaluateExit({ ...ctx(ON), price: 100.5 }, pos);
    expect(r?.reason).toBe("sl_breached");
  });
});
