// worker-bridge/bridge-options-fill-lookup.test.js
//
// 2026-09-24 — the DIA 509P and QQQ 731P stops. Both SELLs reached the broker,
// both FILLED at 16:17, and hours later both mirrors still read exit_pending:
// every poll came back "still working" because the lookup behind it asked for
// 50 orders and gave up.
//
// Webull's order history is not returned newest-first — a 10-row page came
// back spanning six days with the oldest row first — so "the first 50" is not
// "the most recent 50". As the week's order count grows past the window,
// today's orders fall out of it, and the reduce that cannot be found is
// indistinguishable from one that is patiently working. $139.50 of a $500
// daily budget sat against two closed positions.
//
// These tests pin the two properties that were missing: the search keeps
// reading until it finds the order, and a search that comes up empty SAYS so.
import { describe, it, expect } from "vitest";
import { lookupOptionsOrderFill } from "./bridge-index.js";

const USER = { user_id: "op@x.com#webull#margin", broker: "webull", webull_account_id: "WB1" };
const WANT = "G4HIBPJ2CVTQ975PL6KG514CRA";

/** One Webull combo group, the shape extractOrders() flattens. */
const combo = (orderId, patch = {}) => ({
  client_order_id: `tt-opt-${orderId}`,
  combo_type: "NORMAL",
  combo_order_id: orderId,
  orders: [{
    order_id: orderId,
    client_order_id: `tt-opt-${orderId}`,
    symbol: "DIA",
    side: "SELL",
    status: "FILLED",
    total_quantity: "1",
    filled_quantity: "1",
    filled_price: "0.51",
    place_time: "1790266629593",
    create_time: "1790266629593",
    instrument_type: "OPTION",
    ...patch,
  }],
});

const filler = (n, startTime = 1790200000000) => Array.from(
  { length: n },
  (_, i) => combo(`PAD${i}`, { place_time: String(startTime + i), create_time: String(startTime + i) }),
);

function adapterOf(pages) {
  const calls = [];
  return {
    calls,
    listOrders: async (_env, _user, opts) => {
      calls.push({ limit: opts?.limit ?? null, last_create_time: opts?.last_create_time ?? null });
      return { ok: true, response: pages[calls.length - 1] ?? [] };
    },
  };
}

describe("lookupOptionsOrderFill", () => {
  it("reads the broker's maximum page, not a 50-row slice of it", async () => {
    const adapter = adapterOf([[combo(WANT)]]);
    const r = await lookupOptionsOrderFill({}, USER, WANT, { adapter });

    expect(adapter.calls[0].limit).toBe(100);
    expect(r).toMatchObject({ ok: true, searched: 1 });
    expect(r.fill).toMatchObject({ status: "filled", filled_qty: 1, order_id: WANT });
  });

  it("matches on the client order id as well as the broker's own", async () => {
    const adapter = adapterOf([[combo("WB9", { client_order_id: WANT })]]);
    const r = await lookupOptionsOrderFill({}, USER, WANT, { adapter });
    expect(r.fill).toMatchObject({ status: "filled" });
  });

  it("keeps reading past a full page until it finds the order", async () => {
    const adapter = adapterOf([filler(100), [combo(WANT)]]);
    const r = await lookupOptionsOrderFill({}, USER, WANT, { adapter });

    expect(adapter.calls).toHaveLength(2);
    expect(r.fill).toMatchObject({ order_id: WANT });
    expect(r.searched).toBe(101);
  });

  it("pages from the oldest row it has seen, so it walks backwards", async () => {
    const adapter = adapterOf([filler(100, 1790200000000), [combo(WANT)]]);
    await lookupOptionsOrderFill({}, USER, WANT, { adapter });
    expect(adapter.calls[1].last_create_time).toBe("1790200000000");
  });

  it("stops on a short page instead of re-reading it forever", async () => {
    const adapter = adapterOf([filler(3)]);
    const r = await lookupOptionsOrderFill({}, USER, WANT, { adapter });

    expect(adapter.calls).toHaveLength(1);
    expect(r).toMatchObject({ ok: true, fill: null, searched: 3 });
  });

  it("bounds how far back it will walk", async () => {
    // Every page full and the order never in it — the loop must end.
    const adapter = {
      calls: [],
      listOrders: async (_e, _u, opts) => {
        adapter.calls.push(opts);
        return { ok: true, response: filler(100, 1790200000000 - adapter.calls.length * 1000) };
      },
    };
    const r = await lookupOptionsOrderFill({}, USER, WANT, { adapter });
    expect(adapter.calls).toHaveLength(3);
    expect(r.fill).toBeNull();
  });

  it("reports a broker that could not be read apart from one that answered", async () => {
    const adapter = { listOrders: async () => ({ ok: false, error: "token_expired" }) };
    const r = await lookupOptionsOrderFill({}, USER, WANT, { adapter });
    expect(r).toMatchObject({ ok: false, error: "token_expired" });
    expect(r.fill).toBeUndefined();
  });

  it("refuses to guess when the broker cannot list orders at all", async () => {
    const r = await lookupOptionsOrderFill({}, USER, WANT, { adapter: {} });
    expect(r).toMatchObject({ ok: false, error: "no_list_orders" });
  });
});
