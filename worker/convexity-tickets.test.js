import { describe, it, expect } from "vitest";
import {
  ticketIdFor,
  shouldOpenConvexityTicket,
  ticketFromCard,
  evaluateConvexityTicket,
  ticketPnlPct,
  lastSessionExitTs,
  openConvexityTicketsFromCards,
  markConvexityTickets,
} from "./convexity-tickets.js";

// Thu 2026-09-03 11:00 ET (15:00Z) -- inside the options entry window.
const RTH = new Date("2026-09-03T15:00:00Z").getTime();
// Thu 2026-09-03 19:00 ET -- broker follow-through, not RTH.
const AH = new Date("2026-09-03T23:00:00Z").getTime();

// The call the earnings desk made and nobody owned: DELL 475c into the
// Thu Aug 27 AMC print (expiration Fri Aug 28), priced off the live chain.
function dellCard(overrides = {}) {
  return {
    ticker: "DELL",
    play_class: "lotto",
    direction: "LONG",
    strike: 475,
    expiration: { iso: "2026-09-04", dte: 1 },
    premium_mid: 2.1,
    contracts: 1,
    chain_status: "live",
    premium_source: "live_chain",
    earnings_prep: true,
    h4_close_pending: false,
    confluence_score: 71,
    earnings_play: {
      report_date: "2026-09-03",
      report_session: "AMC",
      covers_print: true,
      alignment: { score: 82, verdict: "CONFLUENT" },
      crush: { recommendation: "CAN_HOLD_THROUGH", exit_by: { date: "2026-09-03" } },
    },
    shot_reason: "Earnings AMC today - implied move 9%",
    ...overrides,
  };
}

describe("ticketIdFor", () => {
  it("is deterministic per contract", () => {
    expect(ticketIdFor(dellCard())).toBe("cx:DELL:2026-09-04:475C");
    expect(ticketIdFor(dellCard({ direction: "SHORT", strike: 400 }))).toBe("cx:DELL:2026-09-04:400P");
  });
});

describe("shouldOpenConvexityTicket", () => {
  it("opens a CONFLUENT earnings-prep lotto priced off the live chain inside the window", () => {
    const d = shouldOpenConvexityTicket(dellCard(), { now: RTH });
    expect(d.open).toBe(true);
    expect(d.reason).toBe("earnings_confluent");
    expect(d.conviction).toBe(82);
  });
  it("never tickets an estimated premium", () => {
    const d = shouldOpenConvexityTicket(dellCard({ chain_status: "estimated", premium_source: "bs" }), { now: RTH });
    expect(d).toMatchObject({ open: false, reason: "premium_not_live" });
  });
  it("respects the options entry window", () => {
    expect(shouldOpenConvexityTicket(dellCard(), { now: AH }).open).toBe(false);
    expect(shouldOpenConvexityTicket(dellCard(), { now: AH }).reason).toMatch(/^window_/);
  });
  it("waits for the 4H close when the card says so", () => {
    expect(shouldOpenConvexityTicket(dellCard({ h4_close_pending: true }), { now: RTH }).reason).toBe("h4_close_pending");
  });
  it("earnings-prep needs a CONFLUENT four-pillar read", () => {
    const c = dellCard();
    c.earnings_play.alignment = { score: 48, verdict: "MIXED" };
    expect(shouldOpenConvexityTicket(c, { now: RTH }).reason).toBe("earnings_MIXED");
  });
  it("rejects a contract that expires before the print unless the run-up is the trade", () => {
    const c = dellCard();
    c.earnings_play.covers_print = false;
    expect(shouldOpenConvexityTicket(c, { now: RTH }).reason).toBe("expires_before_print");
    c.earnings_play.crush.recommendation = "RUN_UP_ONLY";
    expect(shouldOpenConvexityTicket(c, { now: RTH }).open).toBe(true);
  });
  it("non-earnings cards need root confluence at the floor", () => {
    const c = dellCard({ earnings_prep: false, earnings_play: null, confluence_score: 71 });
    expect(shouldOpenConvexityTicket(c, { now: RTH }).reason).toBe("confluence_71_below_75");
    expect(shouldOpenConvexityTicket({ ...c, confluence_score: 80 }, { now: RTH }).open).toBe(true);
  });
  it("enforces open, daily and duplicate caps", () => {
    expect(shouldOpenConvexityTicket(dellCard(), { now: RTH, openCount: 4 }).reason).toBe("max_open");
    expect(shouldOpenConvexityTicket(dellCard(), { now: RTH, todayCount: 2 }).reason).toBe("max_daily");
    const openIds = new Set(["cx:DELL:2026-09-04:475C"]);
    expect(shouldOpenConvexityTicket(dellCard(), { now: RTH, openIds }).reason).toBe("already_open");
  });
});

describe("ticketFromCard", () => {
  it("stamps the pre-print exit only when the crush block asked for it", () => {
    const hold = ticketFromCard(dellCard(), { id: "x", reason: "earnings_confluent", conviction: 82 }, RTH);
    expect(hold.exit_by_ts).toBeNull();
    expect(hold.crush_recommendation).toBe("CAN_HOLD_THROUGH");
    const c = dellCard();
    c.earnings_play.crush.recommendation = "EXIT_BEFORE_PRINT";
    const exit = ticketFromCard(c, { id: "x", reason: "earnings_confluent" }, RTH);
    expect(exit.exit_by_date).toBe("2026-09-03");
    expect(exit.exit_by_ts).toBe(lastSessionExitTs("2026-09-03"));
    expect(exit.max_loss_usd).toBe(210);
  });
});

describe("lastSessionExitTs", () => {
  it("is 15:45 ET on the date, DST aware", () => {
    expect(new Date(lastSessionExitTs("2026-09-03")).toISOString()).toBe("2026-09-03T19:45:00.000Z");
    expect(new Date(lastSessionExitTs("2026-12-15")).toISOString()).toBe("2026-12-15T20:45:00.000Z");
  });
});

describe("evaluateConvexityTicket", () => {
  const base = { entry_premium: 2.0, peak_premium: 2.0, expiry_ts: RTH + 86400000 * 2, exit_by_ts: null };
  it("holds without a mark, and on a normal mark", () => {
    expect(evaluateConvexityTicket(base, null, RTH).action).toBe("hold");
    expect(evaluateConvexityTicket(base, 2.4, RTH)).toMatchObject({ action: "hold", peak: 2.4 });
  });
  it("stops when the premium halves", () => {
    expect(evaluateConvexityTicket(base, 1.0, RTH)).toMatchObject({ action: "close", reason: "premium_stop" });
    expect(evaluateConvexityTicket(base, 1.05, RTH).action).toBe("hold");
  });
  it("takes 3x", () => {
    expect(evaluateConvexityTicket(base, 6.0, RTH)).toMatchObject({ action: "close", reason: "take_3x" });
  });
  it("trails the peak after 2x: keep 60% of the gain", () => {
    const t = { ...base, peak_premium: 5.0 }; // +3.00 gain, floor = 2 + 1.8 = 3.8
    expect(evaluateConvexityTicket(t, 4.0, RTH).action).toBe("hold");
    expect(evaluateConvexityTicket(t, 3.7, RTH)).toMatchObject({ action: "close", reason: "peak_giveback" });
  });
  it("exits before the print when stamped, and at expiry regardless of mark", () => {
    const t = { ...base, exit_by_ts: RTH - 1 };
    expect(evaluateConvexityTicket(t, 2.5, RTH)).toMatchObject({ action: "close", reason: "pre_print_exit" });
    const e = { ...base, expiry_ts: RTH - 1 };
    expect(evaluateConvexityTicket(e, null, RTH)).toMatchObject({ action: "close", reason: "expiry" });
  });
});

describe("ticketPnlPct", () => {
  it("is percent of premium", () => {
    expect(ticketPnlPct({ entry_premium: 2 }, 5)).toBe(150);
    expect(ticketPnlPct({ entry_premium: 2 }, 0)).toBe(-100);
    expect(ticketPnlPct({ entry_premium: 2 }, null)).toBeNull();
  });
});

// Minimal D1 fake: one table, exact-enough SQL for this module.
function fakeDb() {
  const rows = new Map();
  const stmt = (sql) => {
    const s = { _b: [] };
    s.bind = (...a) => { s._b = a; return s; };
    s.run = async () => {
      if (/CREATE/i.test(sql)) return { meta: {} };
      if (/INSERT OR IGNORE/i.test(sql)) {
        const b = s._b;
        if (!rows.has(b[0])) {
          rows.set(b[0], {
            id: b[0], ticker: b[1], play_class: b[2], direction: b[3], side: b[4], strike: b[5], expiration: b[6],
            entry_premium: b[7], contracts: b[9], max_loss_usd: b[10], conviction: b[11], open_reason: b[12],
            exit_by_ts: b[18], expiry_ts: b[19], status: "open", mark_premium: b[20], peak_premium: b[21],
            opened_ts: b[22], updated_ts: b[23],
          });
        }
        return { meta: { changes: 1 } };
      }
      if (/SET status = 'closed'/i.test(sql)) {
        const b = s._b; const r = rows.get(b[b.length - 1]);
        if (r && r.status === "open") Object.assign(r, { status: "closed", exit_premium: b[0], exit_reason: b[1], pnl_pct: b[2], mfe_pct: b[3] });
        return { meta: {} };
      }
      if (/SET mark_premium/i.test(sql)) {
        const b = s._b; const r = rows.get(b[b.length - 1]);
        if (r) Object.assign(r, { mark_premium: b[0], peak_premium: b[1], mfe_pct: b[2] });
        return { meta: {} };
      }
      return { meta: {} };
    };
    s.all = async () => {
      if (/status = 'open'/i.test(sql)) return { results: [...rows.values()].filter((r) => r.status === "open") };
      if (/SELECT opened_ts/i.test(sql)) return { results: [...rows.values()].filter((r) => r.opened_ts >= s._b[0]) };
      return { results: [...rows.values()] };
    };
    return s;
  };
  return { prepare: stmt, _rows: rows };
}

describe("openConvexityTicketsFromCards + markConvexityTickets (D1 fake)", () => {
  it("opens the best card once, then closes it off a live chain mark", async () => {
    const env = { DB: fakeDb() };
    const notes = [];
    const notify = async (e) => notes.push(e.title);
    const cards = [dellCard(), dellCard({ chain_status: "estimated", premium_source: "bs", ticker: "CRDO" })];
    const r1 = await openConvexityTicketsFromCards(env, cards, { now: RTH, notify });
    expect(r1.opened.map((t) => t.id)).toEqual(["cx:DELL:2026-09-04:475C"]);
    expect(r1.skipped).toEqual([{ ticker: "CRDO", reason: "premium_not_live" }]);
    // Same card on the next scan is a no-op.
    const r2 = await openConvexityTicketsFromCards(env, [dellCard()], { now: RTH + 60000, notify });
    expect(r2.opened).toHaveLength(0);
    expect(notes[0]).toContain("ticket DELL 475C 2026-09-04 (model fill)");

    // Live chain says the 475c is now $7.20 -> 3x take.
    const fetchChain = async () => ({
      ok: true,
      underlying_price: 480,
      calls: [{ strike: 475, bid: 7.0, ask: 7.4, expiration: "2026-09-04" }],
      puts: [],
    });
    const m = await markConvexityTickets(env, { fetchChain, now: RTH + 3600000, notify });
    expect(m.closed).toBe(1);
    expect(m.results[0]).toMatchObject({ reason: "take_3x", exit: 7.2 });
    expect(m.results[0].pnl_pct).toBeCloseTo(242.9, 0);
    expect(notes[1]).toContain("closed DELL 475C");
  });
});
