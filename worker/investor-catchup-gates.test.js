import { describe, it, expect } from "vitest";
import {
  evaluateCatchupThesisGate,
  findDuplicateDcaLotPairs,
  resolveCatchupLivePrice,
  CATCHUP_BUY_BLOCK_STAGES,
} from "./investor-catchup-gates.js";

describe("evaluateCatchupThesisGate — buys", () => {
  const baseBuy = {
    kind: "dca",
    lotPrice: 177.04,
    livePrice: 178.0,
    stage: "accumulate",
    score: 72,
  };

  it("allows a DCA when stage/score/price are intact", () => {
    const g = evaluateCatchupThesisGate(baseBuy);
    expect(g.allow).toBe(true);
    expect(g.reason).toBeNull();
    expect(g.drift_pct).toBeCloseTo(((178 - 177.04) / 177.04) * 100, 2);
  });

  it("blocks when stage is reduce/exited", () => {
    for (const stage of CATCHUP_BUY_BLOCK_STAGES) {
      const g = evaluateCatchupThesisGate({ ...baseBuy, stage });
      expect(g.allow, stage).toBe(false);
      expect(g.reason).toBe("stage_blocks_add");
    }
  });

  it("blocks when score is below the DCA floor", () => {
    const g = evaluateCatchupThesisGate({ ...baseBuy, score: 22 });
    expect(g.allow).toBe(false);
    expect(g.reason).toBe("score_low");
  });

  it("blocks when live price chased more than maxBuyDriftPct above the lot", () => {
    // 177.04 → 190 is ~7.3% above — default max is 5%
    const g = evaluateCatchupThesisGate({ ...baseBuy, livePrice: 190 });
    expect(g.allow).toBe(false);
    expect(g.reason).toBe("price_drift_above");
    expect(g.drift_pct).toBeGreaterThan(5);
  });

  it("allows a modest drift under the cap (thesis still intact)", () => {
    const g = evaluateCatchupThesisGate({
      ...baseBuy,
      livePrice: 177.04 * 1.04, // +4%
      maxBuyDriftPct: 5,
    });
    expect(g.allow).toBe(true);
  });

  it("blocks when live price is missing (do not chase blind)", () => {
    const g = evaluateCatchupThesisGate({ ...baseBuy, livePrice: null });
    expect(g.allow).toBe(false);
    expect(g.reason).toBe("no_live_price");
  });

  it("blocks exhausted zones outside accumulate", () => {
    const g = evaluateCatchupThesisGate({
      ...baseBuy,
      stage: "core_hold",
      accumZone: { zoneType: "exhausted_rally", exhaustionWarnings: ["vol_spike"] },
    });
    expect(g.allow).toBe(false);
    expect(g.reason).toBe("zone_exhausted");
  });

  // 2026-08-12 — Fresh-lot fidelity (NVDA 8/11 DCA): the model executed the
  // buy minutes ago; the mirror follows the book. Thesis gates skipped,
  // price gates kept.
  it("trustModelExecution bypasses stage/score/zone thesis gates", () => {
    const g = evaluateCatchupThesisGate({
      ...baseBuy,
      stage: "core_hold",
      score: 22,
      accumZone: { zoneType: "exhausted_rally", exhaustionWarnings: ["vol_spike"] },
      trustModelExecution: true,
    });
    expect(g.allow).toBe(true);
  });

  it("trustModelExecution keeps the price-drift gate (no runaway chase)", () => {
    const g = evaluateCatchupThesisGate({
      ...baseBuy,
      livePrice: 190, // ~7.3% above lot, default cap 5%
      trustModelExecution: true,
    });
    expect(g.allow).toBe(false);
    expect(g.reason).toBe("price_drift_above");
  });

  it("trustModelExecution keeps the no-live-price gate", () => {
    const g = evaluateCatchupThesisGate({
      ...baseBuy,
      livePrice: null,
      trustModelExecution: true,
    });
    expect(g.allow).toBe(false);
    expect(g.reason).toBe("no_live_price");
  });

  it("force=true bypasses every gate", () => {
    const g = evaluateCatchupThesisGate({
      ...baseBuy,
      stage: "reduce",
      score: 5,
      livePrice: 250,
      force: true,
    });
    expect(g.allow).toBe(true);
    expect(g.detail?.forced).toBe(true);
  });
});

describe("evaluateCatchupThesisGate — sells", () => {
  it("always allows trim/exit even when price drifted and stage is core_hold", () => {
    for (const kind of ["trim", "exit", "sell"]) {
      const g = evaluateCatchupThesisGate({
        kind,
        lotPrice: 180,
        livePrice: 120, // -33%
        stage: "core_hold",
        score: 80,
      });
      expect(g.allow, kind).toBe(true);
    }
  });
});

describe("resolveCatchupLivePrice", () => {
  it("prefers timed:prices.p over latest", () => {
    expect(resolveCatchupLivePrice({ p: 10 }, { _live_price: 99 })).toBe(10);
  });
  it("falls back to latest._live_price", () => {
    expect(resolveCatchupLivePrice({}, { _live_price: 42.5 })).toBe(42.5);
  });
  it("returns null when nothing usable", () => {
    expect(resolveCatchupLivePrice({}, {})).toBeNull();
  });
});

describe("findDuplicateDcaLotPairs", () => {
  it("pairs the 2026-07-29 CRDO dual-worker race (~295ms gap)", () => {
    const lots = [
      {
        id: "lot-CRDO-dca-1785357048105",
        position_id: "inv-CRDO-auto-1",
        ticker: "CRDO",
        shares: 11.2969,
        price: 177.04,
        reason: "dca_pullback",
        ts: 1785357048105,
      },
      {
        id: "lot-CRDO-dca-1785357048400",
        position_id: "inv-CRDO-auto-1",
        ticker: "CRDO",
        shares: 11.2969,
        price: 177.04,
        reason: "dca_pullback",
        ts: 1785357048400,
      },
    ];
    const pairs = findDuplicateDcaLotPairs(lots);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].keep_id).toBe("lot-CRDO-dca-1785357048105");
    expect(pairs[0].delete_id).toBe("lot-CRDO-dca-1785357048400");
    expect(pairs[0].gap_ms).toBe(295);
    expect(pairs[0].value).toBeCloseTo(2000, 0);
  });

  it("does not pair legitimate consecutive DCAs days apart", () => {
    const lots = [
      {
        id: "a", position_id: "p", ticker: "CRDO",
        shares: 9.38, price: 213.27, reason: "dca_pullback", ts: 1,
      },
      {
        id: "b", position_id: "p", ticker: "CRDO",
        shares: 11.3, price: 177.04, reason: "dca_pullback", ts: 1 + 5 * 86400000,
      },
    ];
    expect(findDuplicateDcaLotPairs(lots)).toEqual([]);
  });

  it("does not pair different share sizes even if close in time", () => {
    const lots = [
      {
        id: "a", position_id: "p", ticker: "X",
        shares: 10, price: 100, reason: "dca_pullback", ts: 1000,
      },
      {
        id: "b", position_id: "p", ticker: "X",
        shares: 5, price: 100, reason: "dca_pullback", ts: 1200,
      },
    ];
    expect(findDuplicateDcaLotPairs(lots)).toEqual([]);
  });
});
