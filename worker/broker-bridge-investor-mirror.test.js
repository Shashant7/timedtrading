import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./silent-failure-log.js", () => ({
  recordSilentFailure: vi.fn(async () => {}),
}));

describe("forwardInvestorMirror", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("records skip when HMAC is missing instead of silent no-op", async () => {
    const ringPuts = [];
    const env = {
      BROKER_INVESTOR_MIRROR_ENABLED: "true",
      BROKER_BRIDGE_URL: "https://tt-broker-bridge.example",
      // HMAC intentionally missing
      ADMIN_EMAIL: "op@example.com",
      KV_TIMED: {
        get: async () => "[]",
        put: async (k, v) => { ringPuts.push({ k, v }); },
      },
    };
    const { forwardInvestorMirror } = await import("./broker-bridge-client.js");
    const result = await forwardInvestorMirror(env, {
      kind: "dca",
      ticker: "KO",
      shares: 10,
      price: 80,
      position_id: "inv-KO-auto-1",
      source: "test",
    });
    expect(result.ok).toBe(false);
    expect(result.skip).toBe("no_hmac_or_url");
    expect(ringPuts.length).toBeGreaterThan(0);
    const ring = JSON.parse(ringPuts[0].v);
    expect(ring[0].trade_id).toBe("inv-inv-KO-auto-1");
    expect(ring[0].skip_reason).toBe("no_hmac_or_url");
  });

  it("records skip when investor mirror is disabled", async () => {
    const env = {
      BROKER_INVESTOR_MIRROR_ENABLED: "false",
      BROKER_BRIDGE_URL: "https://tt-broker-bridge.example",
      BROKER_BRIDGE_HMAC_KEY: "secret",
      KV_TIMED: {
        get: async () => "[]",
        put: async () => {},
      },
    };
    const { forwardInvestorMirror } = await import("./broker-bridge-client.js");
    const result = await forwardInvestorMirror(env, {
      kind: "dca", ticker: "META", shares: 1, price: 600, position_id: "inv-META-1",
    });
    expect(result.skip).toBe("investor_mirror_disabled");
  });
});
