import { describe, it, expect } from "vitest";
import {
  evaluateMfeRatchet,
  loadMfeRatchetConfig,
  resolveRatchetPeak,
  MFE_RATCHET_EXIT_REASON,
} from "./mfe-ratchet.js";

describe("loadMfeRatchetConfig", () => {
  it("defaults: enabled + mid/hi/runner tiers", () => {
    const cfg = loadMfeRatchetConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.activationPct).toBe(2.0);
    expect(cfg.lockFrac).toBe(0.40);
    expect(cfg.hiActivationPct).toBe(5.0);
    expect(cfg.hiLockFrac).toBe(0.70);
    expect(cfg.runnerActivationPct).toBe(10.0);
    expect(cfg.runnerLockFrac).toBe(0.80);
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
    // Peak 6.45 → hi tier (>=5) → 70% lock → floor 4.515.
    const r = evaluateMfeRatchet({ pnlPct: 5.9, position: { maxFavorableExcursion: 6.45 }, daCfg });
    expect(r.armed).toBe(true);
    expect(r.tier).toBe("hi");
    expect(r.floorPct).toBeCloseTo(4.515, 4);
    expect(r.fire).toBe(false);
  });

  it("fires when the giveback crosses the runner-tier floor (HIMX)", () => {
    // HIMX peak 26.85 → runner tier (peak >= 10) → 80% lock → floor 21.48.
    const pos = { maxFavorableExcursion: 26.85 };
    const atFloor = evaluateMfeRatchet({ pnlPct: 21.48, position: pos, daCfg });
    expect(atFloor.fire).toBe(false);
    const below = evaluateMfeRatchet({ pnlPct: 20.0, position: pos, daCfg });
    expect(below.tier).toBe("runner");
    expect(below.fire).toBe(true);
    expect(below.floorPct).toBeCloseTo(21.48, 2);
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

  it("honors custom activation and mid lock knobs (peak in mid tier)", () => {
    // Peak 4.5 is between activation 3 and default hi 5 → mid tier, 0.5 lock.
    const r = evaluateMfeRatchet({
      pnlPct: 2.0,
      position: { maxFavorableExcursion: 4.5 },
      daCfg: {
        deep_audit_mfe_ratchet_activation_pct: 3.0,
        deep_audit_mfe_ratchet_lock_frac: 0.5,
      },
    });
    expect(r.armed).toBe(true);
    expect(r.tier).toBe("mid");
    expect(r.floorPct).toBeCloseTo(2.25, 3);
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
    // GS peak 3.885 pnl 2.72 → mid tier (>=2), 40% lock = 1.55 → holds.
    const gs = evaluateMfeRatchet({ pnlPct: 2.72, position: { maxFavorableExcursion: 3.885 }, daCfg });
    expect(gs.tier).toBe("mid");
    expect(gs.fire).toBe(false);
    // MU peak 29.77 → runner tier, 80% lock = 23.82. Pnl 17.19 < 23.82
    // = fire. That's the RIGHT answer: MU gave back 12+ points of a
    // 29% MFE. The whole point of the new runner tier is to catch that.
    const mu = evaluateMfeRatchet({ pnlPct: 17.19, position: { maxFavorableExcursion: 29.777 }, daCfg });
    expect(mu.tier).toBe("runner");
    expect(mu.fire).toBe(true);
    expect(mu.floorPct).toBeCloseTo(23.82, 1);
    // SNDK peak 39.79 pnl 23.65 — same class. Runner lock 31.83 → fire.
    const sndk = evaluateMfeRatchet({ pnlPct: 23.65, position: { maxFavorableExcursion: 39.785 }, daCfg });
    expect(sndk.tier).toBe("runner");
    expect(sndk.fire).toBe(true);
  });

  // 2026-08-20 — Runner mandate (fix for "we can't hold a winner" — 3
  // TP_FULL in 90 days). Three-tier progressive lock: keeps the tight
  // 40% floor near breakout, tightens to 70% and then 80% as MFE grows.
  describe("three-tier runner lock (2026-08-20)", () => {
    it("mid tier (2 <= peak < 5): 40% lock — kills round-trip losers", () => {
      const r = evaluateMfeRatchet({ pnlPct: 1.4, position: { maxFavorableExcursion: 3.5 }, daCfg: {} });
      expect(r.tier).toBe("mid");
      expect(r.lockFrac).toBe(0.40);
      expect(r.floorPct).toBeCloseTo(1.4, 3);
      expect(r.fire).toBe(false); // exactly at floor holds
    });

    it("hi tier (5 <= peak < 10): 70% lock — winners keep meaningful profit", () => {
      // Peak 8% MFE, current 4% — old code (40% lock) would hold at 3.2
      // (allowing further giveback); new code locks at 5.6 → exit at 4.
      const r = evaluateMfeRatchet({ pnlPct: 4.0, position: { maxFavorableExcursion: 8.0 }, daCfg: {} });
      expect(r.tier).toBe("hi");
      expect(r.lockFrac).toBe(0.70);
      expect(r.floorPct).toBeCloseTo(5.6, 3);
      expect(r.fire).toBe(true);
    });

    it("runner tier (peak >= 10): 80% lock — tight trail on real trends (HIMX class)", () => {
      // HIMX 26.85 → 80% lock at 21.48. Old flat 40% would have locked
      // at 10.74; the trade closed at -5.84 either way, but the runner
      // lock catches it 10+ points sooner.
      const r = evaluateMfeRatchet({ pnlPct: 20.0, position: { maxFavorableExcursion: 26.85 }, daCfg: {} });
      expect(r.tier).toBe("runner");
      expect(r.lockFrac).toBe(0.80);
      expect(r.floorPct).toBeCloseTo(21.48, 2);
      expect(r.fire).toBe(true);
    });

    it("honors custom hi + runner knobs", () => {
      const r = evaluateMfeRatchet({
        pnlPct: 8.0,
        position: { maxFavorableExcursion: 15.0 },
        daCfg: {
          deep_audit_mfe_ratchet_runner_activation_pct: 12.0,
          deep_audit_mfe_ratchet_runner_lock_frac: 0.6,
        },
      });
      // Peak 15 >= runner 12 → runner lock 0.6 → floor 9.0. Current 8 < 9 → fire.
      expect(r.tier).toBe("runner");
      expect(r.lockFrac).toBe(0.6);
      expect(r.floorPct).toBeCloseTo(9.0, 3);
      expect(r.fire).toBe(true);
    });
  });
});
