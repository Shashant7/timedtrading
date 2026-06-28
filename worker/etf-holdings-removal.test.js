// worker/etf-holdings-removal.test.js
// 2026-06-28 — FSD-removal exit signal. When Fundstrat drops a name from the
// GRNY/GRNJ/GRNI complex, the investor lane treats it as an exit signal
// ("know when to exit"). Pins the pure predicate + config plumbing.
import { describe, it, expect } from "vitest";
import { fsdRemovalSignal } from "./etf-holdings.js";
import { loadInvestorConfig, DEFAULT_INVESTOR_CONFIG } from "./investor.js";

const DAY = 86400000;
const NOW = Date.parse("2026-06-28T14:00:00Z");

describe("fsdRemovalSignal", () => {
  it("fires for a name removed within the window", () => {
    const map = { CDNS: NOW - 3 * DAY };
    const sig = fsdRemovalSignal("CDNS", map, NOW, 14);
    expect(sig).toBeTruthy();
    expect(sig.removed).toBe(true);
    expect(sig.days_ago).toBeCloseTo(3, 0);
  });

  it("is case-insensitive on ticker", () => {
    expect(fsdRemovalSignal("cdns", { CDNS: NOW - DAY }, NOW, 14)).toBeTruthy();
  });

  it("does NOT fire outside the window (stale removal)", () => {
    expect(fsdRemovalSignal("CDNS", { CDNS: NOW - 30 * DAY }, NOW, 14)).toBeNull();
  });

  it("returns null for names not in the removed map", () => {
    expect(fsdRemovalSignal("NVDA", { CDNS: NOW - DAY }, NOW, 14)).toBeNull();
    expect(fsdRemovalSignal("NVDA", {}, NOW, 14)).toBeNull();
    expect(fsdRemovalSignal("NVDA", null, NOW, 14)).toBeNull();
  });

  it("window=0 disables the time bound (any removal fires)", () => {
    expect(fsdRemovalSignal("CDNS", { CDNS: NOW - 200 * DAY }, NOW, 0)).toBeTruthy();
  });
});

describe("FSD-removal exit config", () => {
  it("ships sensible defaults", () => {
    expect(DEFAULT_INVESTOR_CONFIG.fsd_removal_exit_enabled).toBe(true);
    expect(DEFAULT_INVESTOR_CONFIG.fsd_removal_exit_pct).toBe(1.0);
    expect(DEFAULT_INVESTOR_CONFIG.fsd_removal_window_days).toBe(14);
  });

  it("applies bounds-checked overrides", () => {
    const c = loadInvestorConfig({
      deep_audit_investor_fsd_removal_exit_enabled: "false",
      deep_audit_investor_fsd_removal_exit_pct: "0.5",
      deep_audit_investor_fsd_removal_window_days: "30",
    });
    expect(c.fsd_removal_exit_enabled).toBe(false);
    expect(c.fsd_removal_exit_pct).toBeCloseTo(0.5);
    expect(c.fsd_removal_window_days).toBe(30);
  });

  it("rejects out-of-range pct (>1) and keeps default", () => {
    const c = loadInvestorConfig({ deep_audit_investor_fsd_removal_exit_pct: "2" });
    expect(c.fsd_removal_exit_pct).toBe(1.0);
  });
});
