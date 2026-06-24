import { describe, it, expect } from "vitest";
import {
  investorActionClass,
  activityDedupeKey,
  activityDedupeKeys,
} from "./activity-dedupe.js";

// Minimal mirror of the merge dedupe so we can assert collapsing behavior
// without importing the whole worker.
function dedupe(events) {
  const seen = new Set();
  const out = [];
  for (const ev of events) {
    const keys = activityDedupeKeys(ev);
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    out.push(ev);
  }
  return out;
}

describe("investorActionClass", () => {
  it("maps sells/trims/closes/exits to 'sell'", () => {
    expect(investorActionClass({ action: "MODEL · REDUCE" })).toBe("sell");
    expect(investorActionClass({ investor_alert_type: "position_trim" })).toBe("sell");
    expect(investorActionClass({ investor_alert_type: "position_close" })).toBe("sell");
    expect(investorActionClass({ action: "SELL" })).toBe("sell");
  });
  it("maps buys/adds/queue/open to 'buy'", () => {
    expect(investorActionClass({ action: "MODEL · QUEUE" })).toBe("buy");
    expect(investorActionClass({ investor_alert_type: "position_add" })).toBe("buy");
    expect(investorActionClass({ action: "BUY" })).toBe("buy");
  });
});

describe("activityDedupeKeys", () => {
  it("collapses a D1 lot row and a KV signal append for the same CRDO reduce", () => {
    const ts = 1782324194637;
    const d1Lot = {
      ts,
      type: "INVESTOR_SIGNAL",
      ticker: "CRDO",
      action: "MODEL · REDUCE",
      investor_alert_type: "position_close",
      engine: "investor",
      lot_id: "lot-CRDO-invalidation-1782324194637",
    };
    const kvSignal = {
      ts: ts - 14000, // ~14s earlier (compute vs rebalance), same 10-min bucket
      type: "INVESTOR_SIGNAL",
      ticker: "CRDO",
      action: "MODEL · REDUCE",
      investor_alert_type: "thesis_invalidation",
      mode: "investor",
    };
    const result = dedupe([d1Lot, kvSignal]);
    expect(result).toHaveLength(1);
  });

  it("collapses RIOT lot + signal the same way", () => {
    const ts = 1782324194637;
    const rows = [
      { ts, ticker: "RIOT", type: "INVESTOR_SIGNAL", action: "MODEL · REDUCE", engine: "investor", lot_id: "lot-RIOT-1" },
      { ts: ts + 3000, ticker: "RIOT", type: "INVESTOR_SIGNAL", action: "MODEL · REDUCE", mode: "investor" },
    ];
    expect(dedupe(rows)).toHaveLength(1);
  });

  it("keeps genuinely different tickers and action classes separate", () => {
    const ts = 1782324194637;
    const rows = [
      { ts, ticker: "CRDO", type: "INVESTOR_SIGNAL", action: "MODEL · REDUCE", engine: "investor", lot_id: "a" },
      { ts, ticker: "RIOT", type: "INVESTOR_SIGNAL", action: "MODEL · REDUCE", engine: "investor", lot_id: "b" },
      { ts, ticker: "CRDO", type: "INVESTOR_SIGNAL", action: "MODEL · BOUGHT", engine: "investor", lot_id: "c" },
    ];
    expect(dedupe(rows)).toHaveLength(3);
  });

  it("does not over-collapse trader events (no investor semantic key)", () => {
    const ts = 1782324194637;
    const rows = [
      { ts, ticker: "NVDA", type: "TRIM", action: "TRIM", mode: "trader", lot_id: "x" },
      { ts: ts + 1000, ticker: "NVDA", type: "EXIT", action: "EXIT", mode: "trader", lot_id: "y" },
    ];
    expect(dedupe(rows)).toHaveLength(2);
  });
});

describe("activityDedupeKey (primary key, backward compat)", () => {
  it("prefers lot_id when present", () => {
    expect(activityDedupeKey({ lot_id: "abc" })).toBe("lot:abc");
  });
});
