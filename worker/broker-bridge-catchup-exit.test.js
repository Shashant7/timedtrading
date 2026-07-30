import { describe, it, expect, vi, beforeEach } from "vitest";

const forwardMock = vi.fn();
vi.mock("./broker-bridge-client.js", () => ({
  forwardOrderToBridge: (...args) => forwardMock(...args),
}));

import { catchupTraderExit } from "./broker-bridge-catchup-exit.js";

describe("catchupTraderExit", () => {
  beforeEach(() => {
    forwardMock.mockReset();
    forwardMock.mockResolvedValue({ ok: true, http_status: 200 });
  });

  it("dry-run plans exit from manifest remaining qty", async () => {
    const env = {
      BROKER_BRIDGE: {
        fetch: async () => new Response(JSON.stringify({
          ok: true,
          rows: [{
            trade_id: "DE-1785351897700-5d1dzat80",
            ticker: "DE",
            user_id: "shashant@gmail.com",
            broker_remaining_qty: 0.85444,
            broker_filled_qty: 0.85444,
            broker_account_id: "LJJ84GKUVIVG998B8DO3069DKA",
            mode: "trader",
            model_status: "OPEN",
            sync_state: "in_sync",
          }],
        }), { status: 200 }),
      },
      ADMIN_EMAIL: "shashant@gmail.com",
    };
    const out = await catchupTraderExit(env, {
      trade_id: "DE-1785351897700-5d1dzat80",
      dry_run: true,
      retry_nonce: "test1",
    });
    expect(out.ok).toBe(true);
    expect(out.dry_run).toBe(true);
    expect(out.planned.qty).toBe(0.85444);
    expect(out.planned.side).toBe("exit");
    expect(out.planned.client_order_id).toContain("retry-test1");
    expect(forwardMock).not.toHaveBeenCalled();
  });

  it("live forward uses retry client_order_id", async () => {
    const env = {
      BROKER_BRIDGE: {
        fetch: async () => new Response(JSON.stringify({
          ok: true,
          rows: [{
            trade_id: "DE-1",
            ticker: "DE",
            user_id: "a@b.com",
            broker_remaining_qty: 0.5,
            broker_filled_qty: 0.5,
            mode: "trader",
          }],
        }), { status: 200 }),
      },
    };
    const out = await catchupTraderExit(env, {
      trade_id: "DE-1",
      dry_run: false,
      retry_nonce: "abc",
    });
    expect(out.ok).toBe(true);
    expect(forwardMock).toHaveBeenCalledTimes(1);
    const order = forwardMock.mock.calls[0][1];
    expect(order.client_order_id).toBe("tt-exit-DE-1-retry-abc");
    expect(order.qty).toBe(0.5);
  });
});
