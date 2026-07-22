import { describe, it, expect } from "vitest";
import {
  normalizeOrderStatus,
  normalizeBrokerOrder,
  extractOrders,
  ocoSiblingClientOrderId,
  reconcileAccountFills,
} from "./bridge-fills.js";
import { buildOrderBody } from "./bridge-webull-api.js";

describe("normalizeOrderStatus", () => {
  it("canonicalizes broker status strings", () => {
    expect(normalizeOrderStatus("Filled")).toBe("filled");
    expect(normalizeOrderStatus("PARTIAL_FILLED")).toBe("partial");
    expect(normalizeOrderStatus("Cancelled")).toBe("cancelled");
    expect(normalizeOrderStatus("Submitted")).toBe("working");
    expect(normalizeOrderStatus("weird")).toBe("unknown");
  });
});

describe("normalizeBrokerOrder", () => {
  it("maps Webull order fields", () => {
    const o = normalizeBrokerOrder("webull", {
      client_order_id: "tt-entry-AMZN-1-WB1", order_id: "wb_9", status: "FILLED",
      filled_quantity: 17, avg_fill_price: 251.7, symbol: "AMZN", side: "BUY", order_type: "MARKET",
    });
    expect(o.status).toBe("filled");
    expect(o.filled_qty).toBe(17);
    expect(o.avg_price).toBe(251.7);
    expect(o.ticker).toBe("AMZN");
    expect(o.client_order_id).toBe("tt-entry-AMZN-1-WB1");
  });

  it("maps IBKR order fields (cOID/avgPrice)", () => {
    const o = normalizeBrokerOrder("ibkr", {
      cOID: "tt-p", orderId: "ib_1", status: "Filled", filledQuantity: 10, avgPrice: 100, ticker: "MSFT", side: "SELL",
    });
    expect(o.status).toBe("filled");
    expect(o.filled_qty).toBe(10);
    expect(o.broker_order_id).toBe("ib_1");
    expect(o.client_order_id).toBe("tt-p");
  });
});

describe("extractOrders + ocoSiblingClientOrderId", () => {
  it("pulls orders from varied response shapes", () => {
    expect(extractOrders({ orders: [{ a: 1 }] })).toHaveLength(1);
    expect(extractOrders({ response: { orders: [{ a: 1 }, { b: 2 }] } })).toHaveLength(2);
    expect(extractOrders({ response: [{ a: 1 }] })).toHaveLength(1);
    expect(extractOrders(null)).toEqual([]);
  });
  it("derives the OCO sibling by convention", () => {
    expect(ocoSiblingClientOrderId("tt-oco-AMZN-1-WB1-sl")).toBe("tt-oco-AMZN-1-WB1-tp");
    expect(ocoSiblingClientOrderId("tt-oco-AMZN-1-WB1-tp")).toBe("tt-oco-AMZN-1-WB1-sl");
    expect(ocoSiblingClientOrderId("tt-entry-AMZN-1")).toBe(null);
  });
});

// KV + BRIDGE_DB stubs.
function makeEnv() {
  const kv = new Map();
  const runs = [];
  return {
    BRIDGE_KV: {
      async get(k) { return kv.get(k) || null; },
      async put(k, v) { kv.set(k, v); },
    },
    BRIDGE_DB: {
      prepare(sql) {
        const s = { sql, _b: [] };
        s.bind = (...b) => { s._b = b; return s; };
        s.run = async () => { runs.push({ sql, binds: s._b }); return { meta: { last_row_id: runs.length } }; };
        s.all = async () => ({ results: [] });
        s.first = async () => null;
        return s;
      },
    },
    _runs: runs,
  };
}

describe("reconcileAccountFills", () => {
  const user = { user_id: "op@x.com#webull#margin", owner_email: "op@x.com", broker: "webull", webull_account_id: "WB1" };

  it("records a fill to the ledger and is idempotent on repeat", async () => {
    const env = makeEnv();
    const adapter = {
      listOrders: async () => ({ ok: true, response: { orders: [
        { client_order_id: "tt-entry-AMZN-1-WB1", order_id: "wb_1", status: "FILLED", filled_quantity: 17, avg_fill_price: 251.7, symbol: "AMZN", side: "BUY" },
      ] } }),
      cancelOrder: async () => ({ ok: true }),
    };
    const s1 = await reconcileAccountFills(env, user, adapter);
    expect(s1.scanned).toBe(1);
    expect(s1.recorded).toBe(1);
    const fillInserts = env._runs.filter((r) => /INSERT INTO broker_account_ledger/.test(r.sql));
    expect(fillInserts.length).toBe(1);
    // Second pass: seen-marker prevents a duplicate record.
    const s2 = await reconcileAccountFills(env, user, adapter);
    expect(s2.recorded).toBe(0);
  });

  it("cancels the OCO sibling when a protective child fills", async () => {
    const env = makeEnv();
    const cancelled = [];
    const adapter = {
      listOrders: async () => ({ ok: true, response: { orders: [
        { client_order_id: "tt-oco-AMZN-1-WB1-sl", order_id: "wb_sl", status: "FILLED", filled_quantity: 17, avg_fill_price: 240, symbol: "AMZN", side: "SELL" },
      ] } }),
      cancelOrder: async (_e, _u, id) => { cancelled.push(id); return { ok: true }; },
    };
    const s = await reconcileAccountFills(env, user, adapter);
    expect(s.oco_cancelled).toBe(1);
    expect(cancelled).toContain("tt-oco-AMZN-1-WB1-tp");
  });

  it("skips working/unfilled orders", async () => {
    const env = makeEnv();
    const adapter = {
      listOrders: async () => ({ ok: true, response: { orders: [
        { client_order_id: "x", status: "Submitted", filled_quantity: 0, symbol: "AMZN" },
      ] } }),
    };
    const s = await reconcileAccountFills(env, user, adapter);
    expect(s.recorded).toBe(0);
  });
});

describe("Webull buildOrderBody — Connect API schema (new_orders array)", () => {
  const user = { webull_account_id: "WB1" };
  // Regression test for ETN 2026-07-22: every Webull order was silently
  // rejected with `INVALID_PARAMETER: Orders can not be empty` because the
  // body spread order fields at the top level instead of wrapping them in
  // a `new_orders` array with per-order instrument_type + market. Spec:
  // https://developer.webull.hk/apis/docs/trade-api/stock.md
  it("wraps the order in new_orders[] with account_id at the top", () => {
    const b = buildOrderBody(user, { ticker: "AMZN", side: "buy", qty: 10 });
    expect(b.account_id).toBe("WB1");
    expect(Array.isArray(b.new_orders)).toBe(true);
    expect(b.new_orders.length).toBe(1);
  });
  it("stamps instrument_type=EQUITY and market=US on each order (Webull mandatory)", () => {
    const b = buildOrderBody(user, { ticker: "AMZN", side: "buy", qty: 10 });
    expect(b.new_orders[0].instrument_type).toBe("EQUITY");
    expect(b.new_orders[0].market).toBe("US");
  });
  it("defaults to MARKET", () => {
    const b = buildOrderBody(user, { ticker: "AMZN", side: "buy", qty: 10 });
    expect(b.new_orders[0].order_type).toBe("MARKET");
    expect(b.new_orders[0].limit_price).toBeUndefined();
  });
  it("builds a LIMIT with limit_price", () => {
    const b = buildOrderBody(user, { ticker: "AMZN", side: "buy", qty: 10, order_type: "limit", limit_price: 250 });
    expect(b.new_orders[0].order_type).toBe("LIMIT");
    expect(b.new_orders[0].limit_price).toBe("250");
  });
  it("maps generic 'stop' → STOP_LOSS (Webull's spec name)", () => {
    const b = buildOrderBody(user, { ticker: "AMZN", side: "sell", qty: 10, order_type: "stop", stop_price: 240 });
    expect(b.new_orders[0].order_type).toBe("STOP_LOSS");
    expect(b.new_orders[0].stop_price).toBe("240");
  });
  it("maps generic 'stop_limit' → STOP_LOSS_LIMIT (Webull's spec name)", () => {
    const b = buildOrderBody(user, { ticker: "AMZN", side: "sell", qty: 10, order_type: "stop_limit", stop_price: 240, limit_price: 235 });
    expect(b.new_orders[0].order_type).toBe("STOP_LOSS_LIMIT");
    expect(b.new_orders[0].stop_price).toBe("240");
    expect(b.new_orders[0].limit_price).toBe("235");
  });
  it("honors a passed client_order_id (fan-out idempotency)", () => {
    const b = buildOrderBody(user, { ticker: "AMZN", side: "buy", qty: 10, client_order_id: "tt-oco-AMZN-1-WB1-sl" });
    expect(b.new_orders[0].client_order_id).toBe("tt-oco-AMZN-1-WB1-sl");
  });
  it("preview flag generates a unique client_order_id (not conflict with real order id)", () => {
    const b = buildOrderBody(user, { ticker: "AMZN", side: "buy", qty: 10 }, { preview: true });
    expect(b.new_orders[0].client_order_id).toMatch(/^tt-preview-/);
  });
  it("degrades a STOP with no price to MARKET so no $0 order is ever placed", () => {
    const b = buildOrderBody(user, { ticker: "AMZN", side: "sell", qty: 10, order_type: "stop", stop_price: 0 });
    expect(b.new_orders[0].order_type).toBe("MARKET");
  });
  it("carries entrust_type QTY + time_in_force DAY + core session", () => {
    const b = buildOrderBody(user, { ticker: "AMZN", side: "buy", qty: 10 });
    expect(b.new_orders[0].entrust_type).toBe("QTY");
    expect(b.new_orders[0].time_in_force).toBe("DAY");
    expect(b.new_orders[0].support_trading_session).toBe("CORE");
    expect(b.new_orders[0].combo_type).toBe("NORMAL");
  });
});
