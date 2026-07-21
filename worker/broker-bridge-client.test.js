import { describe, it, expect, afterEach } from "vitest";
import { forwardOrderToBridge, readClientRing } from "./broker-bridge-client.js";

// In-memory KV stub (the client ring writes to env.KV_TIMED).
function makeKv() {
  const map = new Map();
  return {
    async get(k) { return map.get(k) ?? null; },
    async put(k, v) { map.set(k, v); },
  };
}

const ORDER = {
  user_id: "op@x.com",
  ticker: "NEU",
  side: "buy",
  qty: 4.7576,
  trade_id: "NEU-1784641638639",
  client_order_id: "tt-entry-NEU-1784641638639",
  entry: 780.9,
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("forwardOrderToBridge — transport (CF 1042 / 404 fix)", () => {
  it("prefers the BROKER_BRIDGE service binding, POSTs /bridge/order with an HMAC signature", async () => {
    let captured = null;
    const env = {
      BROKER_BRIDGE_HMAC_KEY: "secret",
      BROKER_BRIDGE_URL: "https://tt-broker-bridge.example.workers.dev",
      KV_TIMED: makeKv(),
      BROKER_BRIDGE: {
        fetch: async (req) => {
          captured = { url: req.url, method: req.method, sig: req.headers.get("x-bridge-signature") };
          return new Response(JSON.stringify({ ok: true, rh_order_id: "RH123" }), { status: 200 });
        },
      },
    };
    const r = await forwardOrderToBridge(env, ORDER);
    expect(r.ok).toBe(true);
    expect(r.transport).toBe("service-binding");
    expect(captured.url.endsWith("/bridge/order")).toBe(true);
    expect(captured.method).toBe("POST");
    expect(typeof captured.sig).toBe("string");
    expect(captured.sig.length).toBeGreaterThan(0);
  });

  it("records the dispatch to the KV client ring with the transport tag", async () => {
    const env = {
      BROKER_BRIDGE_HMAC_KEY: "secret",
      BROKER_BRIDGE_URL: "https://tt-broker-bridge.example.workers.dev",
      KV_TIMED: makeKv(),
      BROKER_BRIDGE: { fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) },
    };
    await forwardOrderToBridge(env, ORDER);
    const ring = await readClientRing(env);
    expect(ring.length).toBe(1);
    expect(ring[0].ticker).toBe("NEU");
    expect(ring[0].side).toBe("buy");
    expect(ring[0].status).toBe("ok");
    expect(ring[0].transport).toBe("service-binding");
  });

  it("falls back to HTTP fetch when no service binding is present", async () => {
    let httpUrl = null;
    globalThis.fetch = async (url) => { httpUrl = String(url); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
    const env = {
      BROKER_BRIDGE_HMAC_KEY: "secret",
      BROKER_BRIDGE_URL: "https://tt-broker-bridge.example.workers.dev",
      KV_TIMED: makeKv(),
    };
    const r = await forwardOrderToBridge(env, ORDER);
    expect(r.transport).toBe("http");
    expect(httpUrl.endsWith("/bridge/order")).toBe(true);
  });

  it("surfaces a non-ok upstream status instead of silently dropping", async () => {
    const env = {
      BROKER_BRIDGE_HMAC_KEY: "secret",
      KV_TIMED: makeKv(),
      BROKER_BRIDGE: { fetch: async () => new Response("not found", { status: 404 }) },
    };
    const r = await forwardOrderToBridge(env, ORDER);
    expect(r.ok).toBe(false);
    expect(r.http_status).toBe(404);
    const ring = await readClientRing(env);
    expect(ring[0].status).toBe("error");
    expect(ring[0].http_status).toBe(404);
  });

  it("skips cleanly when neither a service binding nor a URL is configured", async () => {
    const r = await forwardOrderToBridge({ BROKER_BRIDGE_HMAC_KEY: "s", KV_TIMED: makeKv() }, ORDER);
    expect(r.skip).toBe("no_bridge_url");
  });

  it("skips cleanly when the HMAC key is missing", async () => {
    const r = await forwardOrderToBridge({ BROKER_BRIDGE: { fetch: async () => new Response("{}") }, KV_TIMED: makeKv() }, ORDER);
    expect(r.skip).toBe("no_hmac_key");
  });
});
