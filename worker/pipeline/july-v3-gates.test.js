import { describe, it, expect } from "vitest";
import {
  isIndexModelTicker,
  isStockPathBlockedOnIndex,
  evaluateIndexEtfModelEntry,
} from "./index-etf-model.js";
import { checkSetupDemotion, setupDemotionConfigKey } from "./setup-demotion.js";
import {
  buildEarningsClusterWindowsFromEvents,
  checkEarningsClusterEntryBlock,
} from "./earnings-cluster-gate.js";

describe("index-etf-model", () => {
  const daCfg = { deep_audit_index_model_enabled: "true" };

  it("recognizes index tickers", () => {
    expect(isIndexModelTicker("SPY", daCfg)).toBe(true);
    expect(isIndexModelTicker("NVDA", daCfg)).toBe(false);
  });

  it("blocks stock paths on index", () => {
    expect(isStockPathBlockedOnIndex("tt_pullback")).toBe(true);
    expect(isStockPathBlockedOnIndex("tt_index_etf_swing")).toBe(false);
  });

  it("qualifies strict long index swing", () => {
    let qualified = null;
    const qualifyEntry = (path, conf, reason, sizing, meta) => {
      qualified = { path, conf, reason, meta };
      return { ok: true, path };
    };
    const rejectEntry = () => ({ ok: false });
    const ctx = {
      state: "HTF_BULL_LTF_PULLBACK",
      daily: {
        bull_stack: true,
        above_e200: true,
        pct_above_e48: 2.5,
        e21_slope_5d_pct: 1.0,
      },
      rvol: { best: 1.2 },
      raw: {},
    };
    evaluateIndexEtfModelEntry(ctx, {
      qualifyEntry,
      rejectEntry,
      daCfg,
      rankScore: 96,
      side: "LONG",
      c10_8: { above: true, inCloud: false },
      tf: { m30: { ripster: { c8_9: { above: true } } } },
      baseSizing: {},
    });
    expect(qualified?.path).toBe("tt_index_etf_swing");
  });

  it("rejects index long in BULL state when pullback-only", () => {
    let reason = null;
    evaluateIndexEtfModelEntry(
      {
        state: "HTF_BULL_LTF_BULL",
        daily: {
          bull_stack: true,
          above_e200: true,
          pct_above_e48: 2.5,
          e21_slope_5d_pct: 1.0,
        },
        rvol: { best: 1.2 },
        raw: {},
      },
      {
        qualifyEntry: () => ({ ok: true }),
        rejectEntry: (r) => { reason = r; return { ok: false }; },
        daCfg,
        rankScore: 96,
        side: "LONG",
        c10_8: { above: true },
        tf: { m30: { ripster: { c8_9: { above: true } } } },
        baseSizing: {},
      },
    );
    expect(reason).toBe("index_model_structure_long");
  });
});

describe("setup-demotion", () => {
  it("builds demotion config key", () => {
    expect(setupDemotionConfigKey("tt_n_test_support", "LONG"))
      .toBe("deep_audit_setup_demotion_TT Support Bounce_long");
  });

  it("blocks support when demotion key set", () => {
    const daCfg = {
      deep_audit_setup_demotion_enforce_paths: "tt_n_test_support",
      "deep_audit_setup_demotion_TT Support Bounce_long": "blocked",
    };
    expect(checkSetupDemotion("tt_n_test_support", "LONG", daCfg).blocked).toBe(true);
    expect(checkSetupDemotion("tt_ath_breakout", "LONG", daCfg).blocked).toBe(false);
  });
});

describe("earnings-cluster-gate", () => {
  it("builds cluster windows", () => {
    const events = [
      { event_type: "earnings", ticker: "CDNS", date: "2025-07-28" },
      { event_type: "earnings", ticker: "META", date: "2025-07-30" },
      { event_type: "earnings", ticker: "MSFT", date: "2025-07-30" },
      { event_type: "earnings", ticker: "SWK", date: "2025-07-29" },
    ];
    const windows = buildEarningsClusterWindowsFromEvents(events, { minTickers: 4 });
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0].tickers).toContain("CDNS");
  });

  it("blocks low-rank entry in cluster window", () => {
    const block = checkEarningsClusterEntryBlock({
      dateKey: "2025-07-29",
      ticker: "SWK",
      rank: 95,
      daCfg: { deep_audit_earnings_cluster_gate_enabled: "true" },
      clusterWindows: [{
        anchor: "2025-07-28",
        window_dates: ["2025-07-28", "2025-07-29", "2025-07-30"],
        tickers: ["CDNS", "META", "MSFT", "SWK"],
      }],
    });
    expect(block.blocked).toBe(true);
  });

  it("allows high-rank bypass", () => {
    const block = checkEarningsClusterEntryBlock({
      dateKey: "2025-07-29",
      ticker: "SWK",
      rank: 100,
      daCfg: { deep_audit_earnings_cluster_gate_enabled: "true" },
      clusterWindows: [{
        anchor: "2025-07-28",
        window_dates: ["2025-07-28", "2025-07-29", "2025-07-30"],
        tickers: ["CDNS", "META", "MSFT", "SWK"],
      }],
    });
    expect(block.blocked).toBe(false);
  });
});
