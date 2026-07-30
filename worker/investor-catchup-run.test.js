import { describe, it, expect } from "vitest";
import {
  planInvestorCatchupOps,
  selectLatestSignalLots,
  ringSidesForLotAction,
} from "./investor-catchup-run.js";
import {
  rthElapsedMs,
  isCatchupSignalFresh,
  CATCHUP_SIGNAL_TTL_RTH_MS,
} from "./investor-catchup-gates.js";

/** Wed 2026-07-29 16:30 ET = after RTH close (20:30 UTC EDT). */
const baseLot = {
  id: "lot-CRDO-dca-1",
  position_id: "inv-CRDO-auto-1",
  ticker: "CRDO",
  action: "DCA_BUY",
  shares: 11.3,
  price: 177.04,
  ts: Date.UTC(2026, 6, 29, 20, 30, 0),
  reason: "dca_pullback",
};

/** Thu 2026-07-30 10:30 ET — ~1h RTH since open; prior overnight doesn't count. */
const NOW_RTH = Date.UTC(2026, 6, 30, 14, 30, 0);

describe("rthElapsedMs / isCatchupSignalFresh", () => {
  it("excludes overnight ETH from the TTL clock", () => {
    // Signal at Wed 15:00 ET (19:00 UTC), now Thu 10:00 ET (14:00 UTC).
    // RTH: Wed 15:00–16:00 = 1h + Thu 9:30–10:00 = 0.5h → 1.5h.
    const from = Date.UTC(2026, 6, 29, 19, 0, 0);
    const to = Date.UTC(2026, 6, 30, 14, 0, 0);
    const elapsed = rthElapsedMs(from, to);
    expect(elapsed).toBeGreaterThan(1.4 * 3600000);
    expect(elapsed).toBeLessThan(1.7 * 3600000);
  });

  it("expires after 4h of RTH even if wall clock is longer", () => {
    // Signal Mon 10:00 ET → by Mon 14:30 ET = 4.5h RTH → expired.
    const from = Date.UTC(2026, 6, 27, 14, 0, 0); // Mon 10:00 ET
    const to = Date.UTC(2026, 6, 27, 18, 30, 0);   // Mon 14:30 ET
    const fresh = isCatchupSignalFresh(from, to);
    expect(fresh.fresh).toBe(false);
    expect(fresh.reason).toBe("signal_expired_rth");
    expect(fresh.rth_elapsed_ms).toBeGreaterThan(CATCHUP_SIGNAL_TTL_RTH_MS);
  });

  it("force bypasses expiry", () => {
    const from = Date.UTC(2026, 6, 20, 14, 0, 0);
    const to = Date.UTC(2026, 6, 30, 14, 0, 0);
    expect(isCatchupSignalFresh(from, to, { force: true }).fresh).toBe(true);
  });
});

describe("selectLatestSignalLots — last signal wins", () => {
  it("keeps only the newest lot per position", () => {
    const older = { ...baseLot, id: "old", ts: baseLot.ts };
    const newer = {
      ...baseLot,
      id: "new",
      action: "SELL",
      reason: "PRE_FOMC_RISK_REDUCTION",
      ts: baseLot.ts + 86400000,
    };
    const { latest, superseded } = selectLatestSignalLots([older, newer]);
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBe("new");
    expect(superseded).toHaveLength(1);
    expect(superseded[0].skip_reason).toBe("superseded_by_newer_signal");
  });
});

describe("planInvestorCatchupOps", () => {
  it("plans a DCA when thesis/price intact and not yet mirrored", () => {
    const out = planInvestorCatchupOps({
      lots: [baseLot],
      ring: [],
      scores: { CRDO: { stage: "accumulate", score: 70 } },
      livePrices: { CRDO: 178 },
      nowMs: NOW_RTH,
    });
    expect(out.planned).toHaveLength(1);
    expect(out.planned[0].kind).toBe("dca");
    expect(out.planned[0].ticker).toBe("CRDO");
  });

  it("skips when bridge already has a successful order id", () => {
    const out = planInvestorCatchupOps({
      lots: [baseLot],
      ring: [{
        trade_id: "inv-CRDO-auto-1",
        side: "buy",
        status: "ok",
        broker_order_id: "wb-123",
      }],
      scores: { CRDO: { stage: "accumulate", score: 70 } },
      livePrices: { CRDO: 178 },
      nowMs: NOW_RTH,
    });
    expect(out.planned).toHaveLength(0);
  });

  it("does not treat dedupe_skip (ok, null order id) as mirrored", () => {
    const out = planInvestorCatchupOps({
      lots: [baseLot],
      ring: [{
        trade_id: "inv-CRDO-auto-1",
        side: "buy",
        status: "ok",
        broker_order_id: null,
      }],
      scores: { CRDO: { stage: "accumulate", score: 70 } },
      livePrices: { CRDO: 178 },
      nowMs: NOW_RTH,
    });
    expect(out.planned).toHaveLength(1);
  });

  it("gates buys that chased above max drift", () => {
    const out = planInvestorCatchupOps({
      lots: [baseLot],
      ring: [],
      scores: { CRDO: { stage: "accumulate", score: 70 } },
      livePrices: { CRDO: 200 },
      maxBuyDriftPct: 5,
      nowMs: NOW_RTH,
    });
    expect(out.planned).toHaveLength(0);
    expect(out.skipped_gates[0].skip_reason).toBe("price_drift_above");
  });

  it("always plans sells even when stage is reduce (while fresh)", () => {
    const sell = {
      ...baseLot,
      id: "lot-CRDO-sell-1",
      action: "SELL",
      reason: "PRE_EARNINGS_RISK_REDUCTION",
      shares: 2,
      ts: Date.UTC(2026, 6, 30, 14, 0, 0), // Thu 10:00 ET
    };
    const out = planInvestorCatchupOps({
      lots: [sell],
      ring: [],
      scores: { CRDO: { stage: "reduce", score: 20 } },
      livePrices: { CRDO: 190 },
      nowMs: NOW_RTH,
    });
    expect(out.planned).toHaveLength(1);
    expect(out.planned[0].kind).toBe("trim");
  });

  it("skipBuys defers DCA/add until RTH (Webull fractional)", () => {
    const out = planInvestorCatchupOps({
      lots: [baseLot],
      ring: [],
      scores: { CRDO: { stage: "accumulate", score: 70 } },
      livePrices: { CRDO: 178 },
      skipBuys: true,
      nowMs: NOW_RTH,
    });
    expect(out.planned).toHaveLength(0);
    expect(out.skipped_gates[0].skip_reason).toBe("rth_closed_buy");
  });

  it("last signal wins — twin lots keep the newer id", () => {
    const twin = {
      ...baseLot,
      id: "lot-CRDO-dca-2",
      ts: baseLot.ts + 300,
    };
    const out = planInvestorCatchupOps({
      lots: [baseLot, twin],
      ring: [],
      scores: { CRDO: { stage: "accumulate", score: 70 } },
      livePrices: { CRDO: 178 },
      nowMs: NOW_RTH,
    });
    expect(out.planned).toHaveLength(1);
    expect(out.planned[0].lot_id).toBe(twin.id);
    expect(out.skipped_gates.some((s) => s.skip_reason === "superseded_by_newer_signal")).toBe(true);
  });

  it("treats ring side=trim as mirrored for a SELL lot", () => {
    const sell = {
      ...baseLot,
      id: "lot-CRS-sell-1",
      position_id: "inv-CRS-auto-1780326044329",
      ticker: "CRS",
      action: "SELL",
      reason: "PRE_FOMC_RISK_REDUCTION",
      shares: 0.5925,
      ts: Date.UTC(2026, 6, 30, 14, 0, 0),
    };
    const out = planInvestorCatchupOps({
      lots: [sell],
      ring: [{
        trade_id: "inv-CRS-auto-1780326044329",
        side: "trim",
        status: "ok",
        rh_order_id: "wb-trim-1",
      }],
      scores: { CRS: { stage: "reduce", score: 40 } },
      livePrices: { CRS: 500 },
      nowMs: NOW_RTH,
    });
    expect(out.planned).toHaveLength(0);
    expect(ringSidesForLotAction("SELL")).toContain("trim");
  });

  it("last signal wins — newer PRE_FOMC sell supersedes older unmatched DCA", () => {
    const dca = {
      ...baseLot,
      id: "lot-CRS-dca",
      position_id: "inv-CRS-auto-1",
      ticker: "CRS",
      action: "DCA_BUY",
      shares: 3.44554,
      price: 500,
      reason: "dca_pullback",
      ts: Date.UTC(2026, 6, 30, 13, 30, 0), // Thu 9:30 ET
    };
    const sell = {
      ...baseLot,
      id: "lot-CRS-sell",
      position_id: "inv-CRS-auto-1",
      ticker: "CRS",
      action: "SELL",
      shares: 0.5925,
      price: 538,
      reason: "PRE_FOMC_RISK_REDUCTION",
      ts: Date.UTC(2026, 6, 30, 14, 0, 0), // Thu 10:00 ET — later
    };
    const out = planInvestorCatchupOps({
      lots: [dca, sell],
      ring: [],
      scores: { CRS: { stage: "accumulate", score: 70 } },
      livePrices: { CRS: 501 },
      nowMs: NOW_RTH,
    });
    expect(out.planned.map((p) => p.kind)).toEqual(["trim"]);
    expect(out.planned[0].lot_id).toBe(sell.id);
    expect(out.skipped_gates.some((s) => s.skip_reason === "superseded_by_newer_signal")).toBe(true);
  });

  it("expires a signal after 4h of RTH (ETH excluded from clock)", () => {
    // Mon 10:00 ET signal, now Mon 15:00 ET → 5h RTH → expired.
    const lot = {
      ...baseLot,
      id: "lot-old",
      ts: Date.UTC(2026, 6, 27, 14, 0, 0),
    };
    const out = planInvestorCatchupOps({
      lots: [lot],
      ring: [],
      scores: { CRDO: { stage: "accumulate", score: 70 } },
      livePrices: { CRDO: 178 },
      nowMs: Date.UTC(2026, 6, 27, 19, 0, 0), // Mon 15:00 ET
    });
    expect(out.planned).toHaveLength(0);
    expect(out.skipped_gates[0].skip_reason).toBe("signal_expired_rth");
  });
});
