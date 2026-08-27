import { describe, it, expect } from "vitest";
import { extraActionFromLedger, modelRowFromDayTradeAction, modelRowFromIndexTrendAction } from "./broker-day-actions-join.js";

describe("extraActionFromLedger", () => {
  it("surfaces reject reason on unmatched options SELL extras", () => {
    const row = extraActionFromLedger({
      ts: 100,
      ticker: "QQQ",
      side: "sell",
      qty: 1,
      price: 1.75,
      status: "rejected",
      reject_reason: "no_held_contracts",
    }, "Roth IRA");
    expect(row.mode).toBe("mirror");
    expect(row.event).toBe("SELL");
    expect(row.mirror).toBe("rejected");
    expect(row.mirror_reason).toBe("no_held_contracts");
    expect(row.rejects[0].reject_reason).toBe("no_held_contracts");
    expect(row.rejects[0].account).toBe("Roth IRA");
    expect(row.fills).toEqual([]);
  });

  it("marks filled extras as mirrored with a fill row", () => {
    const row = extraActionFromLedger({
      ts: 100, ticker: "QQQ", side: "buy", qty: 1, price: 1.3, status: "ok",
    }, "Roth IRA");
    expect(row.mirror).toBe("mirrored");
    expect(row.fills[0].qty).toBe(1);
    expect(row.rejects).toEqual([]);
  });
});

describe("modelRowFromDayTradeAction", () => {
  it("maps paper BUY/EXIT onto account_ledger-shaped rows keyed by signal_id", () => {
    const buy = modelRowFromDayTradeAction({
      ts: 10, event: "BUY", ticker: "QQQ", signal_id: "dt:QQQ:x", contracts: 1, premium: 1.3,
    });
    expect(buy.event_type).toBe("ENTRY");
    expect(buy.position_id).toBe("dt:QQQ:x");
    expect(buy.price).toBe(1.3);
    // Options day-trades carry an instrument marker so the timeline labels
    // the qty as contracts, not shares.
    expect(buy.instrument).toBe("option");
    const sell = modelRowFromDayTradeAction({
      ts: 20, event: "STOP", ticker: "QQQ", signal_id: "dt:QQQ:x", contracts: 1, premium: 1.75,
    });
    expect(sell.event_type).toBe("EXIT");
    expect(sell.position_id).toBe("dt:QQQ:x");
    expect(sell.instrument).toBe("option");
  });
});

describe("modelRowFromIndexTrendAction", () => {
  it("maps paper BUY/TRIM onto account_ledger-shaped rows keyed by signal_id", () => {
    const buy = modelRowFromIndexTrendAction({
      ts: 10,
      event: "BUY",
      underlying: "SPY",
      letf_ticker: "SPYU",
      signal_id: "it:SPY:SPYU:LONG:2026-W35",
      shares: 76,
      letf_price: 34.5,
    });
    expect(buy.event_type).toBe("ENTRY");
    expect(buy.position_id).toBe("it:SPY:SPYU:LONG:2026-W35");
    expect(buy.ticker).toBe("SPYU");
    expect(buy.instrument).toBe("letf");
    const trim = modelRowFromIndexTrendAction({
      ts: 20,
      event: "TRIM",
      underlying: "SPY",
      letf_ticker: "SPYU",
      signal_id: "it:SPY:SPYU:LONG:2026-W35",
      shares: 57,
      letf_price: 35.45,
    });
    expect(trim.event_type).toBe("TRIM");
    expect(trim.qty).toBe(57);
  });
});
