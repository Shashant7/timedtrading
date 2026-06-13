import { describe, it, expect } from "vitest";
import {
  evaluateMfeRatchet,
  loadMfeRatchetConfig,
  resolveRatchetPeak,
  MFE_RATCHET_EXIT_REASON,
} from "./mfe-ratchet.js";

describe("loadMfeRatchetConfig", () => {
  it("defaults: enabled, 2% activation, 0.40 lock", () => {
    expect(loadMfeRatchetConfig({})).toEqual({ enabled: true, activationPct: 2.0, lockFrac: 0.40 });
    expect(loadMfeRatchetConfig(null).enabled).toBe(true);
  });

  it("respects explicit disable in every config spelling", () => {
    expect(loadMfeRatchetConfig({ deep_audit_mfe_ratchet_enabled: "false" }).enabled).toBe(false);
    expect(loadMfeRatchetConfig({ deep_audit_mfe_ratchet_enabled: false }).enabled).toBe(false);
    expect(loadMfeRatchetConfig({ deep_audit_mfe_ratchet_enabled: 0 }).enabled).toBe(false);
    expect(loadMfeRatchetConfig({ deep_audit_mfe_ratchet_enabled: "true" }).enabled).toBe(true);
  });

  it("rejects nonsense knob values and falls back to defaults", () => {
    const cfg = loadMfeRatchetConfig({
      deep_audit_mfe_ratchet_activation_pct: "-5",
      deep_audit_mfe_ratchet_lock_frac: "1.7",
    });
    expect(cfg.activationPct).toBe(2.0);
    expect(cfg.lockFrac).toBe(0.40);
  });
});

describe("resolveRatchetPeak", () => {
  it("reads every historical MFE field spelling and takes the max", () => {
    const pos = {
      maxFavorableExcursion: 3.2,
      max_favorable_excursion: 5.1,
      __tradeRef: { mfePct: 4.4 },
    };
    expect(resolveRatchetPeak(pos, 1.0)).toBe(5.1);
  });

  it("self-maintains a high-water mark when upstream MFE plumbing is absent", () => {
    const pos = {};
    expect(resolveRatchetPeak(pos, 2.6)).toBe(2.6);
    expect(pos.__ratchet_peak_pnl_pct).toBe(2.6);
    // price retraces — peak persists
    expect(resolveRatchetPeak(pos, 0.4)).toBe(2.6);
    // new high — peak ratchets up
    expect(resolveRatchetPeak(pos, 7.0)).toBe(7.0);
  });
});

describe("evaluateMfeRatchet", () => {
  const daCfg = {}; // defaults: activation 2.0, lock 0.40

  it("does not arm below the activation threshold", () => {
    const r = evaluateMfeRatchet({ pnlPct: 1.5, position: { maxFavorableExcursion: 1.5 }, daCfg });
    expect(r.armed).toBe(false);
    expect(r.fire).toBe(false);
  });

  it("armed but holding while pnl stays above the floor (winner breathing near peak)", () => {
    // peak 6.45 (the HARD_LOSS_CAP cohort average) — floor 2.58
    const r = evaluateMfeRatchet({ pnlPct: 5.9, position: { maxFavorableExcursion: 6.45 }, daCfg });
    expect(r.armed).toBe(true);
    expect(r.floorPct).toBeCloseTo(2.58, 4);
    expect(r.fire).toBe(false);
  });

  it("fires when the giveback crosses the floor (the HIMX pattern)", () => {
    // HIMX: peaked +26.85%, was allowed to fall to -5.84%. Floor = 10.74.
    const pos = { maxFavorableExcursion: 26.85 };
    const atFloor = evaluateMfeRatchet({ pnlPct: 10.74, position: pos, daCfg });
    expect(atFloor.fire).toBe(false); // at floor exactly: hold
    const below = evaluateMfeRatchet({ pnlPct: 10.0, position: pos, daCfg });
    expect(below.fire).toBe(true);
    expect(below.floorPct).toBeCloseTo(10.74, 2);
  });

  it("fires even after pnl has gone negative (gap-through backstop)", () => {
    const r = evaluateMfeRatchet({ pnlPct: -1.2, position: { maxFavorableExcursion: 2.4 }, daCfg });
    expect(r.fire).toBe(true);
  });

  it("never fires when disabled", () => {
    const r = evaluateMfeRatchet({
      pnlPct: 0.1,
      position: { maxFavorableExcursion: 20 },
      daCfg: { deep_audit_mfe_ratchet_enabled: "false" },
    });
    expect(r.armed).toBe(false);
    expect(r.fire).toBe(false);
  });

  it("honors custom activation and lock knobs", () => {
    const r = evaluateMfeRatchet({
      pnlPct: 2.4,
      position: { maxFavorableExcursion: 5.0 },
      daCfg: {
        deep_audit_mfe_ratchet_activation_pct: 3.0,
        deep_audit_mfe_ratchet_lock_frac: 0.5,
      },
    });
    expect(r.armed).toBe(true);
    expect(r.floorPct).toBeCloseTo(2.5, 4);
    expect(r.fire).toBe(true);
  });

  it("works for SHORT positions via direction-adjusted pnl (caller contract)", () => {
    // pnlPct is already direction-adjusted by both call sites, so SHORT
    // math is identical: peak favorable 4%, floor 1.6, current 1.0 -> fire.
    const r = evaluateMfeRatchet({ pnlPct: 1.0, position: { maxFavorableExcursion: 4.0 }, daCfg });
    expect(r.fire).toBe(true);
  });

  it("exports the canonical exit reason", () => {
    expect(MFE_RATCHET_EXIT_REASON).toBe("mfe_ratchet_giveback");
  });

  it("current open book (2026-06-12) does not fire on deploy", () => {
    // GS peak 3.885 pnl 2.72 | MU peak 29.777 pnl 17.19 | SNDK peak 39.785 pnl 23.65
    for (const [peak, pnl] of [[3.885, 2.72], [29.777, 17.19], [39.785, 23.65]]) {
      const r = evaluateMfeRatchet({ pnlPct: pnl, position: { maxFavorableExcursion: peak }, daCfg });
      expect(r.armed).toBe(true);
      expect(r.fire).toBe(false);
    }
  });
});
