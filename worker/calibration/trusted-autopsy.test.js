import { describe, it, expect } from "vitest";
import {
  scopedAutopsyId,
  bareTradeId,
  promotedScopeId,
  computeCalibrationDataQuality,
  buildCalibrationProvenance,
  evaluateApplyDataQuality,
  resolveExcursions,
  LIVE_SCOPE_KIND,
} from "./trusted-autopsy.js";

describe("scopedAutopsyId", () => {
  it("prefixes scope without double-prefix", () => {
    expect(scopedAutopsyId("live-trades", "ABC-1")).toBe("live-trades::ABC-1");
    expect(scopedAutopsyId("live-trades", "live-trades::ABC-1")).toBe("live-trades::ABC-1");
    expect(scopedAutopsyId("promoted:r1", "other::ABC-1")).toBe("promoted:r1::ABC-1");
  });

  it("bareTradeId strips scope", () => {
    expect(bareTradeId("live-trades::ABC-1")).toBe("ABC-1");
    expect(bareTradeId("ABC-1")).toBe("ABC-1");
  });

  it("promotedScopeId normalizes", () => {
    expect(promotedScopeId("run_xyz")).toBe("promoted:run_xyz");
    expect(promotedScopeId("promoted:run_xyz")).toBe("promoted:run_xyz");
  });
});

describe("data quality + apply gates", () => {
  it("marks SL/TP untrusted when atr excursions are zero", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      mfe_pct: 1.2,
      mae_pct: 0.8,
      mfe_atr: 0,
      mae_atr: 0,
      vix_at_entry: 18,
      regime_at_entry: "unknown",
      entry_ts: 1e12 + i,
    }));
    const dq = computeCalibrationDataQuality(rows);
    expect(dq.trade_count).toBe(100);
    expect(dq.mfe_pct_coverage_pct).toBe(100);
    expect(dq.mfe_atr_coverage_pct).toBe(0);
    expect(dq.sltp_recommendations_trusted).toBe(false);
  });

  it("trusts SL/TP when atr coverage is adequate", () => {
    const rows = Array.from({ length: 100 }, () => ({
      mfe_pct: 2,
      mae_pct: 1,
      mfe_atr: 1.1,
      mae_atr: 0.6,
      vix_at_entry: 20,
      regime_at_entry: "RISK_ON",
      excursion_source: "ledger",
    }));
    const dq = computeCalibrationDataQuality(rows);
    expect(dq.sltp_recommendations_trusted).toBe(true);
    expect(dq.regime_filters_trusted).toBe(true);
  });

  it("blocks apply when provenance is not live mutable", () => {
    const r = evaluateApplyDataQuality({
      calibration_provenance: {
        live_only: false,
        production_mutable: false,
        scope_kind: "promoted_run",
      },
      data_quality: { trade_count: 200, vix_coverage_pct: 100, sltp_recommendations_trusted: true },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("calibration_not_production_mutable");
  });

  it("blocks apply on untrusted SL/TP atr coverage", () => {
    const dq = computeCalibrationDataQuality(Array.from({ length: 100 }, () => ({
      mfe_pct: 1, mae_pct: 1, mfe_atr: 0, mae_atr: 0, vix_at_entry: 18, regime_at_entry: "x",
    })));
    const prov = buildCalibrationProvenance({
      scopeId: "live-trades",
      scopeKind: LIVE_SCOPE_KIND,
      liveOnly: true,
      source: "live_trades",
      dataQuality: dq,
    });
    const r = evaluateApplyDataQuality({
      calibration_provenance: prov,
      data_quality: dq,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("sltp_data_untrusted");
  });
});

describe("resolveExcursions", () => {
  it("prefers ledger MFE/MAE", () => {
    const e = resolveExcursions({ max_favorable_excursion: 3.2, max_adverse_excursion: 1.1 }, -0.5, 100, 99);
    expect(e.source).toBe("ledger");
    expect(e.mfePct).toBe(3.2);
    expect(e.maePct).toBe(1.1);
  });

  it("falls back to entry/exit approx", () => {
    const e = resolveExcursions({}, 2.0, 100, 102);
    expect(e.source).toBe("approx_entry_exit");
    expect(e.mfePct).toBeGreaterThan(0);
  });
});
