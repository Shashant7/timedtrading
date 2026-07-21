import { describe, it, expect } from "vitest";
import * as Ibkr from "./bridge-ibkr.js";

// Mock mode is on by default (BROKER_BRIDGE_MOCK !== "false"); callIbkr returns
// canned responses and never hits the network. We assert the request SHAPE by
// reading the echoed mock responses (parent + bracket legs).
const env = {}; // BROKER_BRIDGE_MOCK unset → mock mode
const user = { broker: "ibkr", ibkr_account_id: "U-TEST" };

describe("IBKR adapter — order-type sending", () => {
  it("places a plain market order (default)", async () => {
    const res = await Ibkr.placeOrder(env, user, { ticker: "AMZN", side: "buy", qty: 10 });
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.response)).toBe(true);
    expect(res.response[0].order_type).toBe("MKT");
  });

  it("places a limit order when order_type=limit + limit_price", async () => {
    const res = await Ibkr.placeOrder(env, user, {
      ticker: "AMZN", side: "buy", qty: 10, order_type: "limit", limit_price: 250.5,
    });
    expect(res.response[0].order_type).toBe("LMT");
  });

  it("degrades a limit with no price to market (no $0 limit)", async () => {
    const res = await Ibkr.placeOrder(env, user, {
      ticker: "AMZN", side: "buy", qty: 10, order_type: "limit", limit_price: 0,
    });
    expect(res.response[0].order_type).toBe("MKT");
  });

  it("placeBracketOrder sends parent + STP + LMT legs", async () => {
    const res = await Ibkr.placeBracketOrder(env, user, {
      ticker: "AMZN", side: "buy", qty: 10, trade_id: "AMZN-1", sl: 240, tp: 270,
    });
    expect(res.ok).toBe(true);
    expect(res.response).toHaveLength(3);
    const types = res.response.map((o) => o.order_type).sort();
    expect(types).toEqual(["LMT", "MKT", "STP"]);
    // The two protective legs reference the parent.
    const children = res.response.filter((o) => o.parent_id);
    expect(children).toHaveLength(2);
  });

  it("placeBracketOrder with no SL/TP falls back to a single order", async () => {
    const res = await Ibkr.placeBracketOrder(env, user, {
      ticker: "AMZN", side: "buy", qty: 10, trade_id: "AMZN-2",
    });
    expect(res.response).toHaveLength(1);
  });
});
