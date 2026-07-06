import { describe, it, expect } from "vitest";
import {
  classifyPhantomTrimEvent,
  buildPhantomTrimScrubPlan,
} from "../worker/phantom-trim-scrub.js";

describe("phantom-trim-scrub", () => {
  const sndkTrade = {
    trade_id: "SNDK-1",
    ticker: "SNDK",
    direction: "LONG",
    entry_price: 1346,
    shares: 7,
  };

  it("classifies SNDK phantom trim", () => {
    const cls = classifyPhantomTrimEvent({
      type: "TRIM",
      event_id: "ev1",
      price: 1447.31,
      qty_pct_delta: 0.5,
      pnl_realized: 14365.15,
      ts: 1000,
    }, sndkTrade);
    expect(cls.phantom).toBe(true);
    expect(cls.correctedRealized).toBeGreaterThan(340);
    expect(cls.correctedRealized).toBeLessThan(360);
  });

  it("builds scrub plan with ledger delete", () => {
    const plan = buildPhantomTrimScrubPlan({
      trades: [sndkTrade],
      trimEvents: [{
        event_id: "ev1",
        trade_id: "SNDK-1",
        type: "TRIM",
        ts: 1000,
        price: 1447.31,
        qty_pct_delta: 0.5,
        pnl_realized: 14365.15,
      }],
      ledgerRows: [{
        ledger_id: 99,
        position_id: "SNDK-1",
        ts: 1000,
        event_type: "TRIM",
        realized_pnl: 14365.15,
      }],
    });
    expect(plan.eventUpdates).toHaveLength(1);
    expect(plan.ledgerDeletes).toHaveLength(1);
    expect(plan.eventUpdates[0].correctedRealized).toBeLessThan(360);
  });
});
