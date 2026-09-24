// worker-bridge/bridge-webull-options-client-id.test.js
//
// 2026-09-24 — the IWM 278P stop-out that never reached the broker.
//
// Webull rejects a REUSED client_order_id with "Please do not place an order
// repeatedly". The id was built as `tt-opt-<trade>-<uuid>`.slice(0, 32), and a
// day-trade signal id (`dt:IWM:2026-09-24:2026-09-25:P:278`) is long enough on
// its own to push the uuid past character 32 — so every close for a ticker on
// a given day collapsed onto the SAME id, `tt-opt-dt:IWM:2026-09-24:2026-09`.
//
// Webull's order list for that day shows the consequence exactly once per
// ticker: IWM 279P sold at 15:10:17Z on that id, and the IWM 278P stop that
// fired at 16:17 was then refused on all 20 retries over 18 minutes until the
// contract was flattened by hand at 0.37 against the model's 0.44 stop. DIA
// and QQQ each got their one close for the same reason.
//
// The invariant these tests hold: two closes that differ only in strike must
// never produce the same client_order_id, and the id must stay inside
// Webull's 10-40 character window.

import { describe, it, expect } from "vitest";
import {
  OPTION_CLIENT_ORDER_ID_MAX,
  optionOrderClientId,
  buildWebullOptionOrderPayload,
  playToWebullOptionOrder,
} from "./bridge-webull-options.js";

const SIGNALS = [
  "dt:IWM:2026-09-24:2026-09-25:P:278",
  "dt:IWM:2026-09-24:2026-09-25:P:279",
  "dt:IWM:2026-09-24:2026-09-25:P:280",
];

describe("optionOrderClientId", () => {
  it("keeps same-day, same-ticker closes distinct — the IWM 278P regression", () => {
    // One fixed uuid so the only thing that can separate these ids is the
    // trade id itself. Under the old trailing slice all three were
    // `tt-opt-dt:IWM:2026-09-24:2026-09`.
    const ids = SIGNALS.map((s) => optionOrderClientId(s, { uuid: "aaaaaaaa" }));
    expect(new Set(ids).size).toBe(3);
  });

  it("never reuses an id across submissions of the SAME signal", () => {
    // The reconciler retries a rejected reduce once a minute; each retry is a
    // new order and needs a new id or Webull calls it a repeat.
    const ids = new Set(
      Array.from({ length: 200 }, () => optionOrderClientId(SIGNALS[0])),
    );
    expect(ids.size).toBe(200);
  });

  it("stays inside Webull's 10-40 character window", () => {
    for (const trade of [...SIGNALS, "na", null, "", "x", "dt:" + "Z".repeat(200)]) {
      const id = optionOrderClientId(trade);
      expect(id.length).toBeGreaterThanOrEqual(10);
      expect(id.length).toBeLessThanOrEqual(OPTION_CLIENT_ORDER_ID_MAX);
    }
  });

  it("emits only characters Webull accepts", () => {
    expect(optionOrderClientId(SIGNALS[0])).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("spends the budget on the suffix first, so the uuid always survives", () => {
    const id = optionOrderClientId("dt:IWM:2026-09-24:2026-09-25:P:278", { uuid: "deadbeef" });
    expect(id.endsWith("-deadbeef")).toBe(true);
  });

  it("keeps the ticker and the strike readable in the broker's order list", () => {
    const id = optionOrderClientId(SIGNALS[0], { uuid: "aaaaaaaa" });
    expect(id).toContain("IWM");
    expect(id).toContain("278");
  });

  it("does not pad a short trade id — it only truncates a long one", () => {
    expect(optionOrderClientId("inv-KO-1", { uuid: "aaaaaaaa" })).toBe("tt-opt-inv-KO-1-aaaaaaaa");
  });

  it("falls back to a usable id when the trade id is missing entirely", () => {
    expect(optionOrderClientId(null, { uuid: "aaaaaaaa" })).toBe("tt-opt-na-aaaaaaaa");
  });
});

describe("buildWebullOptionOrderPayload — client_order_id", () => {
  const user = { webull_account_id: "LJJ84GKUVIVG998B8DO3069DKA" };
  const closeOrder = (strike) => ({
    symbol: "IWM",
    action: "SELL",
    qty: 1,
    strike,
    expiration: "2026-09-25",
    option_type: "PUT",
    limit_price: 0.44,
    trade_id: `dt:IWM:2026-09-24:2026-09-25:P:${strike}`,
  });

  it("gives two same-day IWM closes different ids", () => {
    const a = buildWebullOptionOrderPayload(user, closeOrder(278)).new_orders[0].client_order_id;
    const b = buildWebullOptionOrderPayload(user, closeOrder(279)).new_orders[0].client_order_id;
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(OPTION_CLIENT_ORDER_ID_MAX);
  });

  it("gives the same close a new id on every retry", () => {
    const a = buildWebullOptionOrderPayload(user, closeOrder(278)).new_orders[0].client_order_id;
    const b = buildWebullOptionOrderPayload(user, closeOrder(278)).new_orders[0].client_order_id;
    expect(a).not.toBe(b);
  });

  it("previews stay unique too", () => {
    const a = buildWebullOptionOrderPayload(user, closeOrder(278), { preview: true });
    const b = buildWebullOptionOrderPayload(user, closeOrder(278), { preview: true });
    expect(a.new_orders[0].client_order_id).not.toBe(b.new_orders[0].client_order_id);
    expect(a.new_orders[0].client_order_id.length).toBeLessThanOrEqual(OPTION_CLIENT_ORDER_ID_MAX);
  });

  it("carries the whole close through translation with a distinct id", () => {
    // End to end from the shape the mirror actually sends
    // (buildIndexDayTradeClosePlay output) rather than a hand-made order.
    const closePlay = (strike) => ({
      ticker: "IWM",
      trade_id: `dt:IWM:2026-09-24:2026-09-25:P:${strike}`,
      legs: [{
        action: "SELL", optionType: "PUT", strike,
        expiration: "2026-09-25", qty: 1, premium_mid: 0.44,
      }],
      premium: { mid: 0.44 },
      contracts: 1,
    });
    const ids = [278, 279, 280].map((k) => {
      const order = playToWebullOptionOrder(closePlay(k), "IWM");
      return buildWebullOptionOrderPayload(user, order).new_orders[0].client_order_id;
    });
    expect(new Set(ids).size).toBe(3);
  });
});
