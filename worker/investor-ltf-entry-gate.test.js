// Investor LTF stabilization gate — July 2026 LT autopsy (NBIS/AMD/IESC/MU).
import { describe, it, expect } from "vitest";
import {
  DEFAULT_INVESTOR_CONFIG,
  loadInvestorConfig,
  investorLtfEntryStabilizationBlock,
} from "./investor.js";

function td(overrides = {}) {
  return {
    price: 100,
    tf_tech: {
      "10": {
        stDir: -1,
        stBull: true,
        stSlopeUp: true,
        stSlope: 1,
        ripster: { c5_12: { bull: true, above: true, crossUp: true, fastSlope: 0.2 } },
      },
      "30": { stDir: -1, stBull: true },
      "1H": { stDir: -1, stBull: true, ripster: { c5_12: { bull: true } } },
      "4H": { stDir: -1, stSlopeUp: true },
      D: { stDir: -1 },
      W: { stDir: -1 },
    },
    fvg_D: { inBearGap: false, activeBear: 0 },
    ...overrides,
  };
}

describe("investorLtfEntryStabilizationBlock", () => {
  it("allows a stabilized long (10m ST bull + 5-12 curl)", () => {
    expect(investorLtfEntryStabilizationBlock(td())).toBeNull();
  });

  it("blocks when 10m+30m ST both bearish (NBIS/AMD-style breakdown)", () => {
    const block = investorLtfEntryStabilizationBlock(td({
      tf_tech: {
        "10": {
          stDir: 1, stBear: true, stSlopeDn: true, stSlope: -2,
          ripster: { c5_12: { bear: true, below: true, crossDn: true } },
        },
        "30": { stDir: 1, stBear: true },
        "1H": { stDir: 1, stBear: true },
      },
    }));
    expect(block?.reason).toBe("ltf_st_both_bearish");
  });

  it("blocks 10m ST bearish + sloping even if 30m is flat/bull", () => {
    const block = investorLtfEntryStabilizationBlock(td({
      tf_tech: {
        "10": {
          stDir: 1, stBear: true, stSlopeDn: true, stSlope: -1.5,
          ripster: { c5_12: { bull: true, crossUp: true } },
        },
        "30": { stDir: -1 },
      },
    }));
    expect(block?.reason).toBe("ltf_st_bearish_sloping");
  });

  it("blocks when 5-12 cloud is bear and has not curled (MU/NBIS)", () => {
    const block = investorLtfEntryStabilizationBlock(td({
      tf_tech: {
        "10": {
          stDir: -1, stBull: true, stSlope: 0,
          ripster: { c5_12: { bear: true, below: true, crossUp: false, crossDn: false } },
        },
        "30": { stDir: -1 },
      },
    }));
    expect(block?.reason).toBe("ltf_5_12_cloud_not_curled");
  });

  it("allows bearish cloud if a fresh 5-12 crossUp is printing", () => {
    expect(investorLtfEntryStabilizationBlock(td({
      tf_tech: {
        "10": {
          stDir: -1, stBull: true, stSlopeUp: true,
          ripster: { c5_12: { bear: true, crossUp: true, below: true } },
        },
        "30": { stDir: -1 },
      },
    }))).toBeNull();
  });

  it("blocks opposing daily FVG without LTF reclaim (NBIS hourly/daily FVG theme)", () => {
    const block = investorLtfEntryStabilizationBlock(td({
      fvg_D: { inBearGap: true, activeBear: 1 },
      tf_tech: {
        "10": {
          stDir: 1, stBear: true, stSlope: 0,
          ripster: { c5_12: { bear: true, below: true } },
        },
        "30": { stDir: -1 },
      },
    }));
    // 10m bear+slope may fire first; either veto is acceptable.
    expect(["ltf_st_bearish_sloping", "ltf_st_both_bearish", "opposing_daily_fvg", "ltf_5_12_cloud_not_curled"])
      .toContain(block?.reason);
  });

  it("blocks opposing daily FVG when 10m has not reclaimed", () => {
    const block = investorLtfEntryStabilizationBlock(td({
      fvg_D: { inBearGap: true, activeBear: 2 },
      tf_tech: {
        "10": {
          stDir: 0,
          ripster: { c5_12: { inCloud: true, bull: false, bear: false, crossUp: false } },
        },
        "30": { stDir: -1 },
      },
    }));
    expect(block?.reason).toBe("opposing_daily_fvg");
  });

  it("can be disabled via config / deep_audit override", () => {
    const bearish = td({
      tf_tech: {
        "10": { stDir: 1, stBear: true, stSlopeDn: true, ripster: { c5_12: { bear: true } } },
        "30": { stDir: 1, stBear: true },
      },
    });
    expect(investorLtfEntryStabilizationBlock(bearish, {
      ...DEFAULT_INVESTOR_CONFIG,
      investor_ltf_entry_gate_enabled: false,
    })).toBeNull();
    const cfg = loadInvestorConfig({ deep_audit_investor_ltf_entry_gate_enabled: false });
    expect(investorLtfEntryStabilizationBlock(bearish, cfg)).toBeNull();
  });
});
