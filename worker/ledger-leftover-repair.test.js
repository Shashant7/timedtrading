import { describe, it, expect } from "vitest";
import {
  planInvestorLedgerLeftovers,
  planOrphanTwinBuys,
  planSameTsOversellDrops,
  planClosedDustFlattens,
} from "./ledger-leftover-repair.js";

describe("planOrphanTwinBuys", () => {
  it("drops the repair_backfill whose lot was deleted beside a kept twin", () => {
    const lots = [{
      id: "lot-PLTR-dca-1784838650044",
      position_id: "inv-PLTR",
      ticker: "PLTR",
      action: "DCA_BUY",
      shares: 16.2061,
      value: 2000,
      ts: 1784838650044,
    }];
    const ledgerRows = [
      {
        ledger_id: 1,
        position_id: "inv-PLTR",
        ticker: "PLTR",
        event_type: "DCA_BUY",
        qty: 16.2061,
        cash_delta: -2000,
        ts: 1784838650044,
        note: "repair_backfill_from_lot_lot-PLTR-dca-1784838650044",
      },
      {
        ledger_id: 80175,
        position_id: "inv-PLTR",
        ticker: "PLTR",
        event_type: "ENTRY",
        qty: 16.2061,
        cash_delta: -2000,
        ts: 1784838650330,
        note: "repair_backfill_from_lot_lot-PLTR-dca-1784838650330",
      },
    ];
    const orphans = planOrphanTwinBuys(lots, ledgerRows);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].ledger_id).toBe(80175);
    expect(orphans[0].missing_lot_id).toBe("lot-PLTR-dca-1784838650330");
  });

  it("keeps a backfill when the lot is still present", () => {
    const lots = [{
      id: "lot-A",
      position_id: "inv-A",
      action: "DCA_BUY",
      shares: 10,
      value: 2000,
      ts: 1,
    }];
    const ledgerRows = [{
      ledger_id: 9,
      position_id: "inv-A",
      event_type: "DCA_BUY",
      qty: 10,
      cash_delta: -2000,
      ts: 1,
      note: "repair_backfill_from_lot_lot-A",
    }];
    expect(planOrphanTwinBuys(lots, ledgerRows)).toEqual([]);
  });
});

describe("planSameTsOversellDrops", () => {
  it("keeps the invalidation close and drops the same-ts event-risk trim", () => {
    const lots = [
      { id: "b1", position_id: "inv-DE", ticker: "DE", action: "BUY", shares: 11.7603, value: 6999.97, ts: 1, price: 595.22 },
      { id: "s1", position_id: "inv-DE", ticker: "DE", action: "SELL", shares: 0.588, value: 367, ts: 2, price: 624.15, reason: "PRE_FOMC_RISK_REDUCTION" },
      {
        id: "lot-DE-eventrisk-1787182546339",
        position_id: "inv-DE",
        ticker: "DE",
        action: "SELL",
        shares: 1.2289,
        value: 713.54,
        ts: 1787182546339,
        price: 580.63,
        reason: "PRE_EARNINGS_RISK_REDUCTION",
      },
      {
        id: "lot-DE-invalidation-1787182546339",
        position_id: "inv-DE",
        ticker: "DE",
        action: "SELL",
        shares: 11.1723,
        value: 6486.97,
        ts: 1787182546339,
        price: 580.63,
        reason: "PRIMARY_INVALIDATION_BREACH",
      },
    ];
    const ledgerRows = [
      {
        ledger_id: 80398,
        position_id: "inv-DE",
        ticker: "DE",
        event_type: "EXIT",
        qty: 11.1723,
        cash_delta: 713.54,
        realized_pnl: -163,
        ts: 1787182546339,
      },
      {
        ledger_id: 80402,
        position_id: "inv-DE",
        ticker: "DE",
        event_type: "TRIM",
        qty: 1.2289,
        cash_delta: 6486.97,
        realized_pnl: -17.93,
        ts: 1787182546339,
      },
    ];
    const { drops, resyncs } = planSameTsOversellDrops(lots, ledgerRows);
    expect(drops.map((d) => d.lot_id)).toEqual(["lot-DE-eventrisk-1787182546339"]);
    expect(drops[0].ledger_id).toBe(80402);
    expect(resyncs).toHaveLength(1);
    expect(resyncs[0].ledger_id).toBe(80398);
    expect(resyncs[0].cash_delta).toBe(6486.97);
  });
});

describe("planClosedDustFlattens", () => {
  it("extends an incomplete invalidation EXIT to absorb leftover dust", () => {
    const lots = [
      { id: "b1", position_id: "inv-TWLO-1", ticker: "TWLO", action: "BUY", shares: 10.8485, value: 2000, ts: 1, price: 184.36 },
      {
        id: "lot-TWLO-invalidation",
        position_id: "inv-TWLO-1",
        ticker: "TWLO",
        action: "SELL",
        shares: 9.9304,
        value: 1806.94,
        ts: 2,
        price: 181.96,
        reason: "PRIMARY_INVALIDATION_BREACH",
      },
    ];
    const ledgerRows = [{
      ledger_id: 50,
      position_id: "inv-TWLO-1",
      ticker: "TWLO",
      event_type: "EXIT",
      qty: 9.9304,
      cash_delta: 1806.94,
      realized_pnl: -100,
      ts: 2,
    }];
    const positions = [{ id: "inv-TWLO-1", ticker: "TWLO", status: "CLOSED", total_shares: 0, cost_basis: 1913.63 }];
    const { flattens } = planClosedDustFlattens(lots, ledgerRows, positions);
    expect(flattens).toHaveLength(1);
    expect(flattens[0].leftover_shares).toBeCloseTo(0.9181, 3);
    expect(flattens[0].shares).toBeCloseTo(10.8485, 3);
    expect(flattens[0].value).toBeCloseTo(181.96 * 10.8485, 1);
    expect(flattens[0].ledger_id).toBe(50);
  });
});

describe("planInvestorLedgerLeftovers", () => {
  it("counts the three leftover classes together", () => {
    const plan = planInvestorLedgerLeftovers({
      lots: [
        { id: "lot-keep", position_id: "p1", ticker: "PLTR", action: "DCA_BUY", shares: 16.2, value: 2000, ts: 10 },
      ],
      ledgerRows: [
        { ledger_id: 1, position_id: "p1", ticker: "PLTR", event_type: "DCA_BUY", qty: 16.2, cash_delta: -2000, ts: 10, note: "repair_backfill_from_lot_lot-keep" },
        { ledger_id: 2, position_id: "p1", ticker: "PLTR", event_type: "ENTRY", qty: 16.2, cash_delta: -2000, ts: 10 + 286, note: "repair_backfill_from_lot_lot-gone" },
      ],
      positions: [],
    });
    expect(plan.orphans).toHaveLength(1);
    expect(plan.action_count).toBeGreaterThanOrEqual(1);
  });
});
