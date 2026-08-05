// Investor LTF stabilization gate — July 2026 LT autopsy (NBIS/AMD/IESC/MU).
import { describe, it, expect } from "vitest";
import {
  DEFAULT_INVESTOR_CONFIG,
  loadInvestorConfig,
  investorLtfEntryStabilizationBlock,
  resolveInvestorLtfEma233Snapshot,
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
        ema: { ema233: 95, momentum: 0.2, structure: 0.3 },
        ripster: { c5_12: { bull: true, above: true, crossUp: true, fastSlope: 0.2 } },
      },
      "30": {
        stDir: -1, stBull: true, stSlope: 0,
        ema: { ema233: 96, momentum: 0.1, structure: 0.2 },
      },
      "1H": {
        stDir: -1, stBull: true,
        ema: { ema233: 97, momentum: 0.1, structure: 0.1 },
        ripster: { c5_12: { bull: true } },
      },
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

  it("allows bearish-but-flat 10m AND 30m ST (normal into reversals)", () => {
    expect(investorLtfEntryStabilizationBlock(td({
      tf_tech: {
        "10": {
          stDir: 1, stBear: true, stSlope: 0,
          ripster: { c5_12: { bull: true, crossUp: true } },
        },
        "30": { stDir: 1, stBear: true, stSlope: 0 },
        "1H": { stDir: 1, stBear: true },
      },
    }))).toBeNull();
  });

  it("blocks only when 10m ST is actively sloping down", () => {
    const block = investorLtfEntryStabilizationBlock(td({
      tf_tech: {
        "10": {
          stDir: 1, stBear: true, stSlopeDn: true, stSlope: -1.5,
          ripster: { c5_12: { bull: true, crossUp: true } },
        },
        // Bearish-flat 30m must NOT be enough to veto by itself.
        "30": { stDir: 1, stBear: true, stSlope: 0 },
      },
    }));
    expect(block?.reason).toBe("ltf_st_sloping_down");
  });

  it("blocks when 5-12 cloud is bear and has not curled (MU/NBIS)", () => {
    const block = investorLtfEntryStabilizationBlock(td({
      tf_tech: {
        "10": {
          stDir: 1, stBear: true, stSlope: 0,
          ripster: { c5_12: { bear: true, below: true, crossUp: false, crossDn: false } },
        },
        "30": { stDir: 1, stBear: true, stSlope: 0 },
      },
    }));
    expect(block?.reason).toBe("ltf_5_12_cloud_not_curled");
  });

  it("allows bearish cloud if a fresh 5-12 crossUp is printing", () => {
    expect(investorLtfEntryStabilizationBlock(td({
      tf_tech: {
        "10": {
          stDir: 1, stBear: true, stSlope: 0,
          ripster: { c5_12: { bear: true, crossUp: true, below: true } },
        },
        "30": { stDir: 1, stBear: true, stSlope: 0 },
      },
    }))).toBeNull();
  });

  it("blocks opposing daily FVG without 5-12 curl (ST direction irrelevant)", () => {
    const block = investorLtfEntryStabilizationBlock(td({
      fvg_D: { inBearGap: true, activeBear: 2 },
      tf_tech: {
        "10": {
          stDir: 1, stBear: true, stSlope: 0,
          ripster: { c5_12: { inCloud: true, bull: false, bear: false, crossUp: false } },
        },
        "30": { stDir: 1, stBear: true, stSlope: 0 },
      },
    }));
    expect(block?.reason).toBe("opposing_daily_fvg");
  });

  it("allows opposing daily FVG once 5-12 has curled, even if ST still bearish-flat", () => {
    expect(investorLtfEntryStabilizationBlock(td({
      fvg_D: { inBearGap: true, activeBear: 1 },
      tf_tech: {
        "10": {
          stDir: 1, stBear: true, stSlope: 0,
          ripster: { c5_12: { bull: true, crossUp: true } },
        },
        "30": { stDir: 1, stBear: true, stSlope: 0 },
      },
    }))).toBeNull();
  });

  it("can be disabled via config / deep_audit override", () => {
    const sloping = td({
      tf_tech: {
        "10": { stDir: 1, stBear: true, stSlopeDn: true, ripster: { c5_12: { bear: true } } },
        "30": { stDir: 1, stBear: true },
      },
    });
    expect(investorLtfEntryStabilizationBlock(sloping, {
      ...DEFAULT_INVESTOR_CONFIG,
      investor_ltf_entry_gate_enabled: false,
    })).toBeNull();
    const cfg = loadInvestorConfig({ deep_audit_investor_ltf_entry_gate_enabled: false });
    expect(investorLtfEntryStabilizationBlock(sloping, cfg)).toBeNull();
  });

  it("blocks when LTFs are near/below EMA-233 with no reclaim (IESC/AMD)", () => {
    const block = investorLtfEntryStabilizationBlock(td({
      price: 90,
      tf_tech: {
        "10": {
          stDir: 1, stBear: true, stSlope: 0,
          ema: { ema233: 100, momentum: -0.2, structure: -0.3 },
          ripster: { c5_12: { bull: true, crossUp: true } },
        },
        "30": {
          stDir: 1, stBear: true, stSlope: 0,
          ema: { ema233: 101, momentum: -0.1, structure: -0.2 },
        },
        "1H": {
          stDir: 1, stBear: true, stSlope: 0,
          ema: { ema233: 102, momentum: -0.1, structure: -0.1 },
        },
      },
    }));
    expect(block?.reason).toBe("ltf_below_233_ema");
  });

  it("allows gaining reclaim / break-through of LTF EMA-233", () => {
    expect(investorLtfEntryStabilizationBlock(td({
      price: 105,
      tf_tech: {
        "10": {
          stDir: -1, stSlopeUp: true, stSlope: 1,
          ema: { ema233: 100, momentum: 0.4, structure: 0.3 },
          ripster: { c5_12: { bull: true, crossUp: true } },
        },
        "30": {
          stDir: 1, stBear: true, stSlope: 0,
          ema: { ema233: 101, momentum: 0.2, structure: 0.1 },
        },
        "1H": {
          stDir: 1, stBear: true, stSlope: 0,
          ema: { ema233: 99, momentum: 0.1, structure: 0.05 },
        },
      },
    }))).toBeNull();
  });

  it("skips 233 gate when fewer than 2 LTFs have ema233 (pre-warm)", () => {
    expect(investorLtfEntryStabilizationBlock(td({
      price: 90,
      tf_tech: {
        "10": {
          stDir: -1, stSlope: 0,
          ema: { ema21: 88 },
          ripster: { c5_12: { bull: true, crossUp: true } },
        },
        "30": { stDir: 1, stSlope: 0, ema: {} },
        "1H": { stDir: 1, stSlope: 0 },
      },
    }))).toBeNull();
  });

  it("resolveInvestorLtfEma233Snapshot reports near/below vs reclaiming", () => {
    const snap = resolveInvestorLtfEma233Snapshot(td({
      price: 90,
      tf_tech: {
        "10": { ema: { ema233: 100, momentum: -0.2 } },
        "30": { ema: { ema233: 101, momentum: -0.1 } },
        "60": { ema: { ema233: 102, momentum: -0.1 } },
      },
    }));
    expect(snap.nearOrBelowCount).toBe(3);
    expect(snap.reclaimingCount).toBe(0);
  });
});
