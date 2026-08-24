import { describe, it, expect } from "vitest";
import { extraActionFromLedger, modelRowFromDayTradeAction } from "./broker-day-actions-join.js";

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
    const sell = modelRowFromDayTradeAction({
      ts: 20, event: "STOP", ticker: "QQQ", signal_id: "dt:QQQ:x", contracts: 1, premium: 1.75,
    });
    expect(sell.event_type).toBe("EXIT");
    expect(sell.position_id).toBe("dt:QQQ:x");
  });
});
