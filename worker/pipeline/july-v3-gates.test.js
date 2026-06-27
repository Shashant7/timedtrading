import { describe, it, expect } from "vitest";
import {
  isIndexModelTicker,
  isStockPathBlockedOnIndex,
  evaluateIndexEtfModelEntry,
  getIndexTickerProfile,
  INDEX_TICKER_PROFILES,
} from "./index-etf-model.js";
import { checkSetupDemotion } from "./setup-demotion.js";
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
