import { describe, it, expect } from "vitest";
import {
  parseOcc,
  formatContractLabel,
  parseWebullContractName,
  parseCsvObjects,
  fillsFromCsv,
  fillsFromOrders,
  pairFillsIntoTrips,
  mergeJournalOntoTrips,
  computeTripMetrics,
  webullHistoryDateQuery,
  defaultJournalDay,
  previousWeekday,
  nyDateKey,
  nyWallTimeToUtcMs,
  parseFilledTime,
  normalizeFill,
  extractOrderRows,
  accountsFromBridgeStatus,
  filterTrips,
  makeTripId,
  tripInDateRange,
} from "./desk-journal.js";

const ACCT = "shashant@gmail.com#webull#individual-margin";

function fill(partial) {
  return normalizeFill({
    status: "Filled",
    side: "BUY",
    symbol: "SPY260903C00766000",
    filled_quantity: 1,
    filled_price: 1.5,
    filled_time: "09/03/2026 09:31:00 EDT",
    order_id: partial.order_id || `o_${Math.random().toString(16).slice(2)}`,
    ...partial,
  }, ACCT);
}

describe("OCC + Webull name", () => {
  it("parses an OCC call", () => {
    const occ = parseOcc("SPY260903C00766000");
    expect(occ).toMatchObject({
      underlying: "SPY",
      expiration: "2026-09-03",
      right: "C",
      strike: 766,
    });
    expect(formatContractLabel("SPY260903C00766000")).toBe("SPY 766C 9/3");
  });

  it("builds OCC from a Webull name when the symbol is missing", () => {
    const parsed = parseWebullContractName("SPY 09/03/2026 766.00 Call");
    expect(parsed.occ).toBe("SPY260903C00766000");
    expect(parsed.label).toMatch(/SPY 766C/);
  });
});

describe("CSV parse", () => {
  const csv = `Name,Symbol,Side,Status,Filled,Total Qty,Price,Avg Price,Time-in-Force,Placed Time,Filled Time
"SPY 09/03/2026 766.00 Call",SPY260903C00766000,Buy,Filled,7,7,1.65,1.649,GTC,09/02/2026 15:50:00 EDT,09/02/2026 15:50:11 EDT
"SPY 09/03/2026 766.00 Call",SPY260903C00766000,Sell,Filled,7,7,2.88,2.88,DAY,09/03/2026 09:30:00 EDT,09/03/2026 09:30:51 EDT
"AAPL","AAPL",Buy,Cancelled,0,10,200,200,DAY,09/03/2026 10:00:00 EDT,09/03/2026 10:00:01 EDT
`;

  it("reads headered rows and skips cancels", () => {
    expect(parseCsvObjects(csv)).toHaveLength(3);
    const fills = fillsFromCsv(csv, ACCT);
    expect(fills).toHaveLength(2);
    expect(fills[0].side).toBe("BUY");
    expect(fills[0].qty).toBe(7);
    expect(fills[0].px).toBeCloseTo(1.649);
    expect(fills[0].instrument).toBe("OPTION");
    expect(nyDateKey(fills[0].filled_ts)).toBe("2026-09-02");
  });
});

describe("Webull order flatten + normalize", () => {
  it("flattens combo groups", () => {
    const rows = extractOrderRows({
      response: {
        data: [
          { combo_type: "NORMAL", orders: [{ order_id: "a", status: "FILLED" }, { order_id: "b", status: "FILLED" }] },
          { order_id: "c", status: "FILLED" },
        ],
      },
    });
    expect(rows.map((r) => r.order_id)).toEqual(["a", "b", "c"]);
  });

  it("accepts filled_price + update_time", () => {
    const f = normalizeFill({
      order_id: "wb1",
      symbol: "SPY260903C00766000",
      side: "SELL",
      status: "FILLED",
      filled_quantity: 2,
      filled_price: 3.46,
      update_time: "2026-09-03T13:34:19.000Z",
    }, ACCT);
    expect(f.px).toBe(3.46);
    expect(f.side).toBe("SELL");
    expect(f.fill_id).toContain("wb1");
  });
});

describe("FIFO round-trips", () => {
  it("pairs a simple long into one closed trip with option multiplier", () => {
    const fills = [
      fill({ order_id: "b1", side: "BUY", filled_quantity: 7, filled_price: 1.649, filled_time: "09/02/2026 15:50:11 EDT" }),
      fill({ order_id: "s1", side: "SELL", filled_quantity: 6, filled_price: 2.80, filled_time: "09/03/2026 09:30:20 EDT" }),
      fill({ order_id: "s2", side: "SELL", filled_quantity: 1, filled_price: 3.46, filled_time: "09/03/2026 09:34:19 EDT" }),
    ];
    const trips = pairFillsIntoTrips(fills, ACCT);
    expect(trips).toHaveLength(1);
    expect(trips[0].status).toBe("closed");
    expect(trips[0].qty).toBe(7);
    expect(trips[0].overnight).toBe(1);
    expect(trips[0].pnl).toBeCloseTo((2.8942857 - 1.649) * 7 * 100, 0);
    expect(trips[0].dte_in).toBe(1);
  });

  it("starts a new trip after going flat (overnight vs chase)", () => {
    const fills = [
      fill({ order_id: "1", side: "BUY", filled_quantity: 7, filled_price: 1.65, filled_time: "09/02/2026 15:50:00 EDT" }),
      fill({ order_id: "2", side: "SELL", filled_quantity: 7, filled_price: 2.88, filled_time: "09/03/2026 09:34:00 EDT" }),
      fill({ order_id: "3", side: "BUY", filled_quantity: 2, filled_price: 3.59, filled_time: "09/03/2026 09:40:00 EDT" }),
      fill({ order_id: "4", side: "SELL", filled_quantity: 2, filled_price: 3.36, filled_time: "09/03/2026 09:55:00 EDT" }),
    ];
    const trips = pairFillsIntoTrips(fills, ACCT);
    expect(trips).toHaveLength(2);
    const overnight = trips.find((t) => t.qty === 7);
    const chase = trips.find((t) => t.qty === 2);
    expect(overnight.pnl).toBeCloseTo((2.88 - 1.65) * 7 * 100);
    expect(chase.pnl).toBeCloseTo((3.36 - 3.59) * 2 * 100);
    expect(overnight.overnight).toBe(1);
    expect(chase.overnight).toBe(0);
  });

  it("keeps scale-in / scale-out as one trip until flat", () => {
    const fills = [
      fill({ order_id: "a", side: "BUY", filled_quantity: 5, filled_price: 1.0, filled_time: "09/03/2026 10:00:00 EDT" }),
      fill({ order_id: "b", side: "SELL", filled_quantity: 3, filled_price: 1.2, filled_time: "09/03/2026 10:05:00 EDT" }),
      fill({ order_id: "c", side: "BUY", filled_quantity: 4, filled_price: 1.1, filled_time: "09/03/2026 10:10:00 EDT" }),
      fill({ order_id: "d", side: "SELL", filled_quantity: 6, filled_price: 1.3, filled_time: "09/03/2026 10:20:00 EDT" }),
    ];
    const trips = pairFillsIntoTrips(fills, ACCT);
    expect(trips).toHaveLength(1);
    expect(trips[0].opened_qty).toBe(9);
    expect(trips[0].closed_qty).toBe(9);
  });

  it("splits a fill that crosses through flat", () => {
    const fills = [
      fill({ order_id: "l1", side: "BUY", filled_quantity: 2, filled_price: 1.0, filled_time: "09/03/2026 10:00:00 EDT" }),
      fill({ order_id: "x1", side: "SELL", filled_quantity: 5, filled_price: 1.2, filled_time: "09/03/2026 10:10:00 EDT" }),
    ];
    const trips = pairFillsIntoTrips(fills, ACCT);
    expect(trips).toHaveLength(2);
    const closed = trips.find((t) => t.status === "closed");
    const opened = trips.find((t) => t.status === "open");
    expect(closed.qty).toBe(2);
    expect(opened.qty).toBe(3);
    expect(opened.start_side).toBe("SELL");
  });

  it("leaves a leftover as an open trip", () => {
    const fills = [
      fill({ order_id: "x", side: "BUY", filled_quantity: 4, filled_price: 1.1, filled_time: "09/04/2026 15:50:00 EDT" }),
    ];
    const trips = pairFillsIntoTrips(fills, ACCT);
    expect(trips[0].status).toBe("open");
    expect(trips[0].qty).toBe(4);
    expect(trips[0].exit_px).toBeNull();
  });
});

describe("journal preserve + metrics", () => {
  it("copies notes onto a rebuilt trip with the same fingerprint", () => {
    const fills = [
      fill({ order_id: "b1", side: "BUY", filled_quantity: 2, filled_price: 1, filled_time: "09/03/2026 10:00:00 EDT" }),
      fill({ order_id: "s1", side: "SELL", filled_quantity: 2, filled_price: 2, filled_time: "09/03/2026 11:00:00 EDT" }),
    ];
    const trips = pairFillsIntoTrips(fills, ACCT);
    const existing = [{
      trip_id: "old_id",
      account_id: ACCT,
      symbol: trips[0].symbol,
      entry_ts: trips[0].entry_ts,
      qty: trips[0].qty,
      journal_text: "Held for the open. Repeat.",
      journal_grade: "A",
      journal_tags: '["overnight"]',
      journal_updated_at: 1,
    }];
    const merged = mergeJournalOntoTrips(trips, existing);
    expect(merged[0].journal_text).toMatch(/Held for the open/);
    expect(merged[0].journal_grade).toBe("A");
  });

  it("rolls win rate, overnight vs intra, and journal counts", () => {
    const trips = [
      { status: "closed", pnl: 100, overnight: 1, hold_s: 600, exit_ts: nyWallTimeToUtcMs("2026-09-03", 10, 0, 0), journal_text: "ok", journal_grade: "A" },
      { status: "closed", pnl: -40, overnight: 0, hold_s: 120, exit_ts: nyWallTimeToUtcMs("2026-09-03", 14, 0, 0) },
      { status: "open", pnl: null, overnight: 0, hold_s: null },
    ];
    const m = computeTripMetrics(trips);
    expect(m.n_closed).toBe(2);
    expect(m.n_wins).toBe(1);
    expect(m.win_rate).toBe(0.5);
    expect(m.pnl).toBe(60);
    expect(m.overnight_pnl).toBe(100);
    expect(m.after_13_pnl).toBe(-40);
    expect(m.journaled).toBe(1);
    expect(m.unjournaled).toBe(2);
  });
});

describe("date helpers", () => {
  it("widens a same-day Webull window", () => {
    expect(webullHistoryDateQuery("2026-09-04", "2026-09-04")).toEqual({
      start_date: "2026-09-03",
      end_date: "2026-09-04",
    });
  });

  it("defaults the journal day to Friday on a Saturday", () => {
    const sat = Date.parse("2026-09-05T18:00:00Z");
    expect(defaultJournalDay(sat)).toBe("2026-09-04");
    expect(previousWeekday("2026-09-05")).toBe("2026-09-04");
  });

  it("parses NY wall-clock filled times", () => {
    const ts = parseFilledTime("09/03/2026 09:30:05 EDT");
    expect(nyDateKey(ts)).toBe("2026-09-03");
    expect(new Date(ts).toISOString()).toBe("2026-09-03T13:30:05.000Z");
  });

  it("filters trips by exit date", () => {
    const t = { exit_ts: nyWallTimeToUtcMs("2026-09-03", 10, 0, 0), entry_ts: nyWallTimeToUtcMs("2026-09-02", 15, 50, 0) };
    expect(tripInDateRange(t, "2026-09-03", "2026-09-03")).toBe(true);
    expect(tripInDateRange(t, "2026-09-04", "2026-09-04")).toBe(false);
  });
});

describe("accounts + filters", () => {
  it("lists connected Webull sleeves and imported leftovers", () => {
    const accounts = accountsFromBridgeStatus({
      users: [
        { user_id: ACCT, broker: "webull", status: "connected", webull_account_label: "Individual Margin", webull_account_id: "MMJE" },
        { user_id: "x#ibkr#main", broker: "ibkr", status: "connected" },
        { user_id: "y#webull#ira", broker: "webull", status: "disconnected" },
      ],
    }, ["csv-import-book"]);
    expect(accounts.map((a) => a.account_id)).toEqual([ACCT, "csv-import-book"]);
    expect(accounts[0].syncable).toBe(true);
    expect(accounts[0].label).toMatch(/Margin/i);
  });

  it("filters unjournaled losers", () => {
    const trips = [
      { pnl: -10, journal_text: "", status: "closed", exit_ts: nyWallTimeToUtcMs("2026-09-03", 11, 0, 0) },
      { pnl: 20, journal_text: "good", journal_grade: "A", status: "closed", exit_ts: nyWallTimeToUtcMs("2026-09-03", 11, 0, 0) },
    ];
    const out = filterTrips(trips, { from: "2026-09-03", to: "2026-09-03", unjournaled: true, side: "losers" });
    expect(out).toHaveLength(1);
    expect(out[0].pnl).toBe(-10);
  });

  it("keeps trip ids stable for the same first fill", () => {
    const a = makeTripId(ACCT, "SPY260903C00766000", 1000, "wb_1");
    const b = makeTripId(ACCT, "SPY260903C00766000", 1000, "wb_1");
    expect(a).toBe(b);
    expect(a).toMatch(/^djt_/);
  });
});

describe("orders → fills", () => {
  it("reads a mixed Webull payload", () => {
    const fills = fillsFromOrders({
      ok: true,
      response: {
        data: [
          { order_id: "1", symbol: "SPY260903C00766000", side: "BUY", status: "FILLED", filled_quantity: 1, filled_price: 1.5, filled_time: 1756905000000 },
          { order_id: "2", symbol: "AAPL", side: "BUY", status: "SUBMITTED", filled_quantity: 0, filled_price: 0 },
        ],
      },
    }, ACCT);
    expect(fills).toHaveLength(1);
    expect(fills[0].symbol).toBe("SPY260903C00766000");
  });
});
