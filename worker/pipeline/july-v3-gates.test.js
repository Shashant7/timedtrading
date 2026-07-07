import { describe, it, expect } from "vitest";
import {
  isIndexModelTicker,
  isStockPathBlockedOnIndex,
  shouldBlockStockPathOnIndexTicker,
  evaluateIndexEtfModelEntry,
  getIndexTickerProfile,
  INDEX_TICKER_PROFILES,
} from "./index-etf-model.js";
import { checkSetupDemotion, demotionProposalConfigKey } from "./setup-demotion.js";
import { shouldRejectAthBreakoutOpeningNoise } from "./tt-core-entry.js";
import { checkEarningsClusterEntryBlock } from "./earnings-cluster-gate.js";
import { getEtfProfile, isEtfRideRunnerMode } from "../etf-profile.js";

describe("index-etf-model v4", () => {
  const daCfg = { deep_audit_index_model_enabled: "true" };

  it("SPY profile is slower/tighter than IWM", () => {
    const spy = getIndexTickerProfile("SPY", daCfg);
    const iwm = getIndexTickerProfile("IWM", daCfg);
    expect(spy.rvol_min).toBeLessThan(iwm.rvol_min);
    expect(spy.pct_above_e48[1]).toBeLessThan(iwm.pct_above_e48[1]);
    expect(spy.min_rank).toBeLessThanOrEqual(iwm.min_rank);
  });

  it("qualifies SPY slow grind in BULL state", () => {
    let qualified = null;
    evaluateIndexEtfModelEntry(
      {
        ticker: "SPY",
        state: "HTF_BULL_LTF_BULL",
        daily: {
          bull_stack: true,
          above_e200: true,
          pct_above_e48: 1.2,
          e21_slope_5d_pct: 0.4,
        },
        rvol: { best: 0.5 },
        raw: {},
      },
      {
        qualifyEntry: (path) => { qualified = path; return { ok: true }; },
        rejectEntry: () => ({ ok: false }),
        daCfg,
        rankScore: 90,
        side: "LONG",
        c10_8: { inCloud: true },
        tf: { m30: { ripster: { c8_9: { inCloud: true } } } },
        baseSizing: {},
      },
    );
    expect(qualified).toBe("tt_index_etf_swing");
  });

  it("rejects stock ATH path on index via block list", () => {
    expect(isStockPathBlockedOnIndex("tt_ath_breakout")).toBe(true);
    expect(isStockPathBlockedOnIndex("tt_index_etf_swing")).toBe(false);
  });

  it("blocks stock paths on SPY even when index model is disabled", () => {
    const daCfg = { deep_audit_index_model_enabled: "false", deep_audit_index_model_tickers: "SPY,QQQ,IWM" };
    expect(isIndexModelTicker("SPY", daCfg)).toBe(false);
    expect(shouldBlockStockPathOnIndexTicker("SPY", "tt_ath_breakout", daCfg)).toBe(true);
    expect(shouldBlockStockPathOnIndexTicker("NVDA", "tt_ath_breakout", daCfg)).toBe(false);
  });
});

describe("setup-demotion index-only", () => {
  it("does not block singles support demotion", () => {
    const daCfg = {
      deep_audit_setup_demotion_enforce_paths: "tt_n_test_support",
      deep_audit_setup_demotion_index_only: "true",
      "deep_audit_setup_demotion_TT Support Bounce_long": "blocked",
    };
    expect(checkSetupDemotion("tt_n_test_support", "LONG", daCfg, "NVDA").blocked).toBe(false);
    expect(checkSetupDemotion("tt_n_test_support", "LONG", daCfg, "IWM").blocked).toBe(true);
  });

  it("demotionProposalConfigKey canonicalizes display, path, and mangled names", () => {
    const canonical = "deep_audit_setup_demotion_TT ATH Breakout_long";
    expect(demotionProposalConfigKey("TT ATH Breakout", "LONG")).toBe(canonical);
    expect(demotionProposalConfigKey("tt_ath_breakout", "LONG")).toBe(canonical);
    // Edge-scorecard mangled form observed in production model_config.
    expect(demotionProposalConfigKey("TT Tt Ath Breakout", "LONG")).toBe(canonical);
  });
});

describe("ath-breakout opening-noise gate (XLI churn fix)", () => {
  it("rejects during the opening-noise window (XLI entered 9:31/9:33 ET)", () => {
    expect(shouldRejectAthBreakoutOpeningNoise({}, { hour: 9, minute: 31 })).toBe(true);
    expect(shouldRejectAthBreakoutOpeningNoise({}, { hour: 9, minute: 33 })).toBe(true);
    expect(shouldRejectAthBreakoutOpeningNoise({}, { hour: 9, minute: 44 })).toBe(true);
  });

  it("allows once the tape settles", () => {
    expect(shouldRejectAthBreakoutOpeningNoise({}, { hour: 9, minute: 45 })).toBe(false);
    expect(shouldRejectAthBreakoutOpeningNoise({}, { hour: 10, minute: 5 })).toBe(false);
    expect(shouldRejectAthBreakoutOpeningNoise({}, { hour: 14, minute: 0 })).toBe(false);
  });

  it("respects the config kill switch and custom end minute", () => {
    expect(shouldRejectAthBreakoutOpeningNoise(
      { deep_audit_ath_breakout_opening_noise_enabled: "false" },
      { hour: 9, minute: 31 },
    )).toBe(false);
    expect(shouldRejectAthBreakoutOpeningNoise(
      { deep_audit_ripster_opening_noise_end_minute: 35 },
      { hour: 9, minute: 36 },
    )).toBe(false);
  });
});

describe("etf-profile per-index", () => {
  it("SPY ride runner activates at 0.6% MFE", () => {
    const r = isEtfRideRunnerMode("SPY", 0.65, 0.3);
    expect(r.active).toBe(true);
  });

  it("SPY has tighter TP than generic ETF default", () => {
    const spy = getEtfProfile("SPY");
    expect(spy.tp_ladder.trim_pct_target).toBe(0.005);
  });
});

describe("earnings-cluster high-rank member block", () => {
  const clusters = [{
    anchor: "2025-07-28",
    window_dates: ["2025-07-28", "2025-07-29", "2025-07-30"],
    tickers: ["CDNS", "META", "MSFT", "SWK"],
  }];
  const daCfg = {
    deep_audit_earnings_cluster_gate_enabled: "true",
    deep_audit_earnings_cluster_rank_bypass: "93",
    deep_audit_earnings_cluster_block_high_rank_members: "true",
    deep_audit_earnings_cluster_high_rank_floor: "100",
    deep_audit_earnings_cluster_high_rank_day_pad: "3",
  };

  it("blocks rank-100 SWK on Jul 25 (wide pad) but not CDNS rank 94 on Jul 28", () => {
    expect(checkEarningsClusterEntryBlock({
      dateKey: "2025-07-25",
      ticker: "SWK",
      rank: 100,
      daCfg,
      clusterWindows: clusters,
    }).blocked).toBe(true);
    expect(checkEarningsClusterEntryBlock({
      dateKey: "2025-07-28",
      ticker: "CDNS",
      rank: 94,
      daCfg,
      clusterWindows: clusters,
    }).blocked).toBe(false);
  });
});

describe("index model reentry cooldown", () => {
  it("rejects second SPY entry within 48h", () => {
    let reason = null;
    evaluateIndexEtfModelEntry(
      {
        ticker: "SPY",
        state: "HTF_BULL_LTF_BULL",
        daily: {
          bull_stack: true,
          above_e200: true,
          pct_above_e48: 1.2,
          e21_slope_5d_pct: 0.4,
        },
        rvol: { best: 0.5 },
        raw: {},
        nowTs: Date.parse("2025-07-10T14:00:00Z"),
        recentTrades: [{
          ticker: "SPY",
          direction: "LONG",
          exit_ts: Date.parse("2025-07-09T14:00:00Z"),
        }],
      },
      {
        qualifyEntry: () => ({ ok: true }),
        rejectEntry: (r) => { reason = r; return { ok: false }; },
        daCfg: { deep_audit_index_model_enabled: "true", deep_audit_index_model_reentry_cooldown_hours: "48" },
        rankScore: 90,
        side: "LONG",
        c10_8: { inCloud: true },
        tf: { m30: { ripster: { c8_9: { inCloud: true } } } },
        baseSizing: {},
      },
    );
    expect(reason).toBe("index_model_reentry_cooldown");
  });
});
