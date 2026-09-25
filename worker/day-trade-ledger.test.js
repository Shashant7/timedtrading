// worker/day-trade-ledger.test.js
import { describe, it, expect } from "vitest";
import {
  DAY_TRADE_START_CASH,
  DAY_TRADE_LEDGER_MODE,
  filterDayTradeClosedTrades,
  buildDayTradeEquityPoints,
  summarizeDayTradeEquity,
  dayTradeCloseLedgerRow,
  syncDayTradeLedgerFromClosedTrades,
} from "./day-trade-ledger.js";

const t0 = Date.parse("2026-09-23T14:00:00Z");
const t1 = Date.parse("2026-09-23T18:00:00Z");
const t2 = Date.parse("2026-09-24T15:00:00Z");

function round(sid, exitTs, pnl, lane = "index_day_trade") {
  return {
    id: `${sid}:EXIT:${exitTs}`,
    signal_id: sid,
    trade_id: sid,
    ticker: "SPY",
    exit_ts: exitTs,
    entry_ts: exitTs - 3600_000,
    realized_pnl: pnl,
    pnl,
    status: pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "FLAT",
    close_event: "EXIT",
    _lane: lane,
    _paper_lane: lane,
    contracts: 2,
    exit_price: 1.5,
  };
}

describe("day-trade-ledger", () => {
  it("exports the Day Trader sleeve start cash and ledger mode", () => {
    expect(DAY_TRADE_START_CASH).toBe(25_000);
    expect(DAY_TRADE_LEDGER_MODE).toBe("day_trade");
  });

  it("filters Index Day Trade rounds and ignores Index Swings", () => {
    const rows = [
      round("dt:a", t1, 100),
      round("ix:b", t1, 50, "index_swing"),
    ];
    expect(filterDayTradeClosedTrades(rows)).toHaveLength(1);
    expect(filterDayTradeClosedTrades(rows)[0].signal_id).toBe("dt:a");
  });

  it("builds a cumulative equity curve from closed rounds", () => {
    const points = buildDayTradeEquityPoints([
      round("dt:1", t1, 200),
      round("dt:2", t2, -50),
    ]);
    expect(points.length).toBeGreaterThanOrEqual(2);
    const last = points[points.length - 1];
    expect(last.equity).toBe(DAY_TRADE_START_CASH + 150);
    expect(points[0].dayPnl + points[1].dayPnl).toBe(150);
  });

  it("overlays open MTM on the tip", () => {
    const points = buildDayTradeEquityPoints(
      [round("dt:1", t1, 100)],
      { openUnrealized: 40, openPositions: 1 },
    );
    const tip = points[points.length - 1];
    expect(tip.live_mark).toBe(true);
    expect(tip.equity).toBe(DAY_TRADE_START_CASH + 140);
    expect(tip.openPositions).toBe(1);
  });

  it("summarizes closed W/L and return vs sleeve", () => {
    const trades = [round("dt:1", t1, 200), round("dt:2", t2, -50)];
    const points = buildDayTradeEquityPoints(trades);
    const sm = summarizeDayTradeEquity(points, { closedTrades: trades });
    expect(sm.startCash).toBe(25_000);
    expect(sm.cumRealized).toBe(150);
    expect(sm.closedStats).toEqual({ closed: 2, wins: 1, losses: 1 });
    expect(sm.totalReturnPct).toBeCloseTo((150 / 25000) * 100, 2);
  });

  it("shapes a ledger row for a closed round", () => {
    const row = dayTradeCloseLedgerRow({
      trade: round("dt:SPY:x", t1, 88.5),
      balanceAfter: DAY_TRADE_START_CASH + 88.5,
    });
    expect(row.mode).toBe("day_trade");
    expect(row.cash_delta).toBe(88.5);
    expect(row.realized_pnl).toBe(88.5);
    expect(row.position_id).toBe(`dt:SPY:x:${t1}`);
    expect(row.balance).toBe(DAY_TRADE_START_CASH + 88.5);
  });

  it("syncs closed rounds into the ledger idempotently", async () => {
    const inserted = [];
    const existing = new Set();
    const insertFn = async (row) => {
      inserted.push(row);
      existing.add(row.position_id);
      return { ok: true };
    };
    const trades = [round("dt:1", t1, 100), round("dt:2", t2, -25)];
    const first = await syncDayTradeLedgerFromClosedTrades({}, trades, {
      insertFn,
      listExistingIdsFn: async () => [...existing],
    });
    expect(first.inserted).toBe(2);
    expect(inserted).toHaveLength(2);
    expect(inserted[1].balance).toBe(DAY_TRADE_START_CASH + 75);

    const second = await syncDayTradeLedgerFromClosedTrades({}, trades, {
      insertFn,
      listExistingIdsFn: async () => [...existing],
    });
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(2);
    expect(inserted).toHaveLength(2);
  });

  it("ignores non-day-trade lanes during sync", async () => {
    const inserted = [];
    await syncDayTradeLedgerFromClosedTrades({}, [
      round("ix:1", t1, 99, "index_swing"),
    ], {
      insertFn: async (row) => { inserted.push(row); return { ok: true }; },
      listExistingIdsFn: async () => [],
    });
    expect(inserted).toHaveLength(0);
  });
});
