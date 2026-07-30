import { describe, it, expect } from "vitest";
import {
  evaluateMirrorRebuildGate,
  rebuildSliceShares,
  REBUILD_MIN_VS_ENTRY_PCT,
  REBUILD_MAX_VS_ENTRY_PCT,
} from "./investor-catchup-gates.js";
import { planMirrorRebuildOps } from "./investor-mirror-rebuild.js";

describe("evaluateMirrorRebuildGate", () => {
  const base = {
    avgEntry: 200,
    livePrice: 190, // -5%
    stage: "accumulate",
    score: 70,
  };

  it("allows near/under entry in accumulate with healthy score", () => {
    const r = evaluateMirrorRebuildGate(base);
    expect(r.allow).toBe(true);
    expect(r.vs_entry_pct).toBeCloseTo(-5, 5);
  });

  it("blocks chase above max vs entry (+2%)", () => {
    const r = evaluateMirrorRebuildGate({ ...base, livePrice: 210 }); // +5%
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("chase_above_entry");
  });

  it("blocks deep underwater below min vs entry (−8%)", () => {
    const r = evaluateMirrorRebuildGate({ ...base, livePrice: 180 }); // -10%
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("deep_underwater");
  });

  it("allows at the +2% ceiling", () => {
    const r = evaluateMirrorRebuildGate({ ...base, livePrice: 204 }); // +2%
    expect(r.allow).toBe(true);
  });

  it("allows at the −8% floor", () => {
    const r = evaluateMirrorRebuildGate({ ...base, livePrice: 184 }); // -8%
    expect(r.allow).toBe(true);
    expect(REBUILD_MIN_VS_ENTRY_PCT).toBe(-8);
    expect(REBUILD_MAX_VS_ENTRY_PCT).toBe(2);
  });

  it("blocks reduce stage", () => {
    const r = evaluateMirrorRebuildGate({ ...base, stage: "reduce" });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("stage_blocks_add");
  });

  it("blocks watch (not rebuildable — needs accumulate/core_hold)", () => {
    const r = evaluateMirrorRebuildGate({ ...base, stage: "watch" });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("stage_not_rebuildable");
  });

  it("blocks low score", () => {
    const r = evaluateMirrorRebuildGate({ ...base, score: 40 });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("score_low");
  });

  it("allows null score when stage is accumulate/core_hold", () => {
    const r = evaluateMirrorRebuildGate({ ...base, score: null, stage: "core_hold" });
    expect(r.allow).toBe(true);
  });

  it("blocks exhausted zone", () => {
    const r = evaluateMirrorRebuildGate({
      ...base,
      accumZone: { zoneType: "exhaustion", exhaustionWarnings: ["stretch"] },
    });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("zone_exhausted");
  });

  it("blocks when broker already holds above dust", () => {
    const r = evaluateMirrorRebuildGate({ ...base, brokerQty: 1.5 });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("already_mirrored");
  });
});

describe("rebuildSliceShares", () => {
  it("sizes one DCA slice from dca_amount / live", () => {
    expect(rebuildSliceShares({ dcaAmountUsd: 2000, livePrice: 200 })).toBe(10);
  });

  it("caps at maxSliceUsd", () => {
    expect(rebuildSliceShares({
      dcaAmountUsd: 5000,
      livePrice: 100,
      maxSliceUsd: 1000,
    })).toBe(10);
  });
});

describe("planMirrorRebuildOps", () => {
  const positions = [
    {
      id: "inv-TWLO-auto-1",
      ticker: "TWLO",
      status: "OPEN",
      avg_entry: 200,
      dca_amount: 2000,
      investor_stage: "accumulate",
    },
    {
      id: "inv-KO-auto-1",
      ticker: "KO",
      status: "OPEN",
      avg_entry: 80,
      dca_amount: 2000,
      investor_stage: "accumulate",
    },
    {
      id: "inv-META-auto-1",
      ticker: "META",
      status: "OPEN",
      avg_entry: 600,
      dca_amount: 2000,
      investor_stage: "accumulate",
    },
  ];

  it("plans under-entry accumulate; skips chase and deep underwater", () => {
    const out = planMirrorRebuildOps({
      positions,
      livePrices: { TWLO: 190, KO: 88, META: 520 }, // -5%, +10%, -13.3%
      scores: {
        TWLO: { stage: "accumulate", score: 70 },
        KO: { stage: "accumulate", score: 70 },
        META: { stage: "accumulate", score: 70 },
      },
      brokerQtyByTicker: {},
    });
    expect(out.planned.map((p) => p.ticker)).toEqual(["TWLO"]);
    expect(out.planned[0].shares).toBeCloseTo(2000 / 190, 5);
    const reasons = Object.fromEntries(out.skipped.map((s) => [s.ticker, s.skip_reason]));
    expect(reasons.KO).toBe("chase_above_entry");
    expect(reasons.META).toBe("deep_underwater");
  });

  it("skips tickers already held at broker", () => {
    const out = planMirrorRebuildOps({
      positions: [positions[0]],
      livePrices: { TWLO: 190 },
      scores: { TWLO: { stage: "accumulate", score: 70 } },
      brokerQtyByTicker: { TWLO: 2.5 },
    });
    expect(out.planned).toHaveLength(0);
    expect(out.skipped[0].skip_reason).toBe("already_mirrored");
  });

  it("sorts planned by deepest discount first", () => {
    const out = planMirrorRebuildOps({
      positions: [
        { id: "a", ticker: "AAA", status: "OPEN", avg_entry: 100, dca_amount: 1000 },
        { id: "b", ticker: "BBB", status: "OPEN", avg_entry: 100, dca_amount: 1000 },
      ],
      livePrices: { AAA: 98, BBB: 93 }, // -2% vs -7%
      scores: {
        AAA: { stage: "accumulate", score: 60 },
        BBB: { stage: "accumulate", score: 60 },
      },
    });
    expect(out.planned.map((p) => p.ticker)).toEqual(["BBB", "AAA"]);
  });
});
