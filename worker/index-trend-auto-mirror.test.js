import { describe, it, expect, vi } from "vitest";
import { maybeAutoMirrorIndexTrendEvent } from "./index-trend-auto-mirror.js";

vi.mock("./broker-bridge-client.js", () => ({
  forwardOrderToBridge: vi.fn(async () => ({ ok: true, order_id: "ord-1" })),
}));

describe("index-trend-auto-mirror", () => {
  it("skips when auto-mirror disabled", async () => {
    const env = {
      ADMIN_EMAIL: "op@test.com",
      KV_TIMED: {
        get: async () => JSON.stringify({ enabled: false }),
        put: async () => {},
      },
    };
    const r = await maybeAutoMirrorIndexTrendEvent(env, {
      event: "BUY",
      signal_id: "it:SPY:SPYU:LONG:2026-W35",
      underlying: "SPY",
      letf_ticker: "SPYU",
      letf_price: 120,
      management: { stop_underlying: 628 },
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("disabled");
  });
});
