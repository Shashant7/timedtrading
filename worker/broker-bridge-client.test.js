import { describe, it, expect, afterEach, vi } from "vitest";
import {
  forwardOrderToBridge,
  readClientRing,
  isEquityMirrorVehicle,
  shouldForwardTraderMirrorAsEquity,
  recordBridgeMirrorSkip,
  parseBridgeOrderIds,
  resolveTraderEquityEthMirror,
} from "./broker-bridge-client.js";
import { readSilentFailures, SILENT_FAILURE_RING_KEY } from "./silent-failure-log.js";

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

describe("parseBridgeOrderIds", () => {
  it("reads Webull order_id / broker_order_id aliases, not just rh_order_id", () => {
    expect(parseBridgeOrderIds({ ok: true, order_id: "WB-9" }).rh_order_id).toBe("WB-9");
    expect(parseBridgeOrderIds({ ok: true, broker_order_id: "M-1" }).order_id).toBe("M-1");
    expect(parseBridgeOrderIds({ ok: true, response: { order_id: "NEST" } }).broker_order_id).toBe("NEST");
    expect(parseBridgeOrderIds({ ok: true, deduped: true }).deduped).toBe(true);
    expect(parseBridgeOrderIds({ ok: true, deduped: true }).order_id).toBeNull();
  });
});

describe("isEquityMirrorVehicle", () => {
  it("treats shares / equity_long / empty as equity mirrors", () => {
    expect(isEquityMirrorVehicle("shares")).toBe(true);
    expect(isEquityMirrorVehicle("equity_long")).toBe(true);
    expect(isEquityMirrorVehicle("")).toBe(true);
    expect(isEquityMirrorVehicle(null)).toBe(true);
  });
  it("rejects options / LETF model-play vehicles", () => {
    expect(isEquityMirrorVehicle("options")).toBe(false);
    expect(isEquityMirrorVehicle("letf")).toBe(false);
    expect(isEquityMirrorVehicle("long_call")).toBe(false);
  });
});

describe("shouldForwardTraderMirrorAsEquity", () => {
  it("forwards share books and skips options / LETF paper", () => {
    expect(shouldForwardTraderMirrorAsEquity({ vehicle: "shares" })).toBe(true);
    expect(shouldForwardTraderMirrorAsEquity({})).toBe(true);
    expect(shouldForwardTraderMirrorAsEquity({ executed_vehicle: "options", options_paper: {} })).toBe(false);
    expect(shouldForwardTraderMirrorAsEquity({ options_paper: { premium: 1.75 } })).toBe(false);
    expect(shouldForwardTraderMirrorAsEquity({ vehicle: "letf" })).toBe(false);
    expect(shouldForwardTraderMirrorAsEquity({ letf_paper: { ticker: "TQQQ" } })).toBe(false);
  });
});

describe("recordBridgeMirrorSkip", () => {
  it("writes skipped status to the client ring + silent-failure breadcrumb", async () => {
    const env = { KV_TIMED: makeKv(), ADMIN_EMAIL: "op@x.com" };
    await recordBridgeMirrorSkip(env, {
      ticker: "DIA",
      side: "buy",
      reason: "vehicle_options_not_mirrored_as_equity",
      trade_id: "t1",
      qty: 10,
    });
    const ring = await readClientRing(env);
    expect(ring[0].status).toBe("skipped");
    expect(ring[0].skip_reason).toContain("options");
    const fails = await readSilentFailures(env, { stage: "bridge_mirror.skip" });
    expect(fails.length).toBeGreaterThan(0);
    expect(fails[0].ticker).toBe("DIA");
  });
});

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

  it("persists Webull order_id onto the ring (not only rh_order_id)", async () => {
    const env = {
      BROKER_BRIDGE_HMAC_KEY: "secret",
      BROKER_BRIDGE_URL: "https://tt-broker-bridge.example.workers.dev",
      KV_TIMED: makeKv(),
      BROKER_BRIDGE: {
        fetch: async () => new Response(JSON.stringify({ ok: true, order_id: "WB-77" }), { status: 200 }),
      },
    };
    await forwardOrderToBridge(env, ORDER);
    const ring = await readClientRing(env);
    expect(ring[0].order_id).toBe("WB-77");
    expect(ring[0].rh_order_id).toBe("WB-77");
    expect(ring[0].broker_order_id).toBe("WB-77");
    expect(ring[0].deduped).toBe(false);
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

  it("surfaces a non-ok upstream status and records a silent-failure breadcrumb", async () => {
    const env = {
      BROKER_BRIDGE_HMAC_KEY: "secret",
      KV_TIMED: makeKv(),
      BROKER_BRIDGE: {
        fetch: async () => new Response(JSON.stringify({ ok: false, reject_reason: "kill_switch" }), { status: 200 }),
      },
    };
    const r = await forwardOrderToBridge(env, ORDER);
    expect(r.ok).toBe(false);
    const ring = await readClientRing(env);
    expect(ring[0].status).toBe("error");
    expect(ring[0].reject_reason).toBe("kill_switch");
    const fails = await readSilentFailures(env, { stage: "bridge_mirror.reject" });
    expect(fails.some((f) => String(f.error || "").includes("kill_switch"))).toBe(true);
    expect(env.KV_TIMED).toBeTruthy();
    expect(SILENT_FAILURE_RING_KEY).toBeTruthy();
  });

  it("records fetch_error to the silent-failure ring", async () => {
    const env = {
      BROKER_BRIDGE_HMAC_KEY: "secret",
      KV_TIMED: makeKv(),
      BROKER_BRIDGE: {
        fetch: async () => { throw new Error("aborted"); },
      },
    };
    const r = await forwardOrderToBridge(env, ORDER);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("aborted");
    const fails = await readSilentFailures(env, { stage: "bridge_mirror.fetch_error" });
    expect(fails.length).toBeGreaterThan(0);
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

describe("resolveTraderEquityEthMirror", () => {
  it("coerces LIMIT+ALL+GTC in the 5pm ET earnings window", () => {
    const r = resolveTraderEquityEthMirror(
      { ticker: "TSLA", side: "exit", entry: 348.95, mode: "trader" },
      new Date("2026-08-24T17:00:00-04:00"),
    );
    expect(r.skip).toBe(false);
    expect(r.fields.order_kind).toBe("limit");
    expect(r.fields.support_trading_session).toBe("ALL");
    expect(r.fields.tif).toBe("GTC");
    expect(r.fields.limit_price).toBeLessThan(348.95);
  });

  it("skips at 8:01 PM ET — broker cannot follow through", () => {
    const r = resolveTraderEquityEthMirror(
      { ticker: "TSLA", side: "exit", entry: 348.95, mode: "trader" },
      new Date("2026-08-24T20:01:00-04:00"),
    );
    expect(r.skip).toBe(true);
    expect(r.reason).toBe("equity_ah_too_late_for_broker");
  });

  it("does not gate crypto at 8pm", () => {
    const r = resolveTraderEquityEthMirror(
      { ticker: "BTCUSD", side: "exit", entry: 70000, mode: "trader" },
      new Date("2026-08-24T20:01:00-04:00"),
    );
    expect(r.skip).toBe(false);
    expect(r.fields).toEqual({});
  });
});

describe("forwardOrderToBridge — 8pm ST equity skip", () => {
  afterEach(() => vi.useRealTimers());

  it("does not POST a trader share exit after the 7pm follow-through cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T20:01:00-04:00"));
    let posted = false;
    const env = {
      BROKER_BRIDGE_HMAC_KEY: "secret",
      BROKER_BRIDGE_URL: "https://tt-broker-bridge.example.workers.dev",
      KV_TIMED: makeKv(),
      BROKER_BRIDGE: { fetch: async () => { posted = true; return new Response("{}", { status: 200 }); } },
    };
    const r = await forwardOrderToBridge(env, {
      ...ORDER, ticker: "DPZ", side: "trim", mode: "trader", vehicle: "equity_long", entry: 349.01,
    });
    expect(r.skip).toBe("equity_ah_too_late_for_broker");
    expect(posted).toBe(false);
    const ring = await readClientRing(env);
    expect(ring[0].status).toBe("skipped");
  });
});
