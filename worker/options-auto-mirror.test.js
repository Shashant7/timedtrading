import { describe, it, expect, afterEach } from "vitest";
import { fireAutoMirror, maybeAutoMirrorIndexDayTrade } from "./options-auto-mirror.js";

const PAYLOAD = { ticker: "NEU", side: "buy", contracts: 1, occ_symbol: "NEU260821C00790000", limit_price: 24.2 };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("fireAutoMirror — transport (CF 1042 / 404 fix)", () => {
  it("prefers the BROKER_BRIDGE service binding and POSTs /bridge/options/order with an HMAC signature", async () => {
    let captured = null;
    const env = {
      BROKER_BRIDGE_HMAC_KEY: "secret",
      BROKER_BRIDGE_URL: "https://tt-broker-bridge.example.workers.dev",
      BROKER_BRIDGE: {
        fetch: async (req) => {
          captured = { url: req.url, method: req.method, sig: req.headers.get("x-bridge-signature") };
          return new Response(JSON.stringify({ ok: true, order_id: "OPT1" }), { status: 200 });
        },
      },
    };
    const r = await fireAutoMirror(env, "op@x.com", PAYLOAD);
    expect(r.ok).toBe(true);
    expect(r.transport).toBe("service-binding");
    expect(captured.url.endsWith("/bridge/options/order")).toBe(true);
    expect(captured.method).toBe("POST");
    expect(typeof captured.sig).toBe("string");
    expect(captured.sig.length).toBeGreaterThan(0);
  });

  it("falls back to HTTP fetch when no service binding is present", async () => {
    let httpUrl = null;
    globalThis.fetch = async (url) => { httpUrl = String(url); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
    const env = { BROKER_BRIDGE_HMAC_KEY: "secret", BROKER_BRIDGE_URL: "https://tt-broker-bridge.example.workers.dev" };
    const r = await fireAutoMirror(env, "op@x.com", PAYLOAD);
    expect(r.transport).toBe("http");
    expect(httpUrl.endsWith("/bridge/options/order")).toBe(true);
  });

  it("returns a clean error when the HMAC key is missing (no silent throw)", async () => {
    const r = await fireAutoMirror({ BROKER_BRIDGE_URL: "https://x.example.workers.dev" }, "op@x.com", PAYLOAD);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("missing_hmac_key");
  });
});

describe("maybeAutoMirrorIndexDayTrade", () => {
  it("skips when the index mirror flag is off", async () => {
    const r = await maybeAutoMirrorIndexDayTrade(
      { ADMIN_EMAIL: "op@x.com", KV_TIMED: { get: async () => null, put: async () => {} } },
      {
        ticker: "QQQ",
        play: { archetype: "day_trade_call", premium: { mid: 1.25 }, contracts: 1, max_loss_usd: 125 },
        indicesFlagOn: false,
      },
    );
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("flag_off");
  });
});
