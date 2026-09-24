// worker-bridge/bridge-options-cancel.test.js
//
// 2026-09-23 — `POST /bridge/options/order/cancel`.
//
// The day-trade mirror could place an option order and poll it, but it had no
// way to pull one. That gap cost a whole day of index day trades: two limit
// buys placed at the open never filled, held the entire 2/day `long_put`
// budget, and stayed live at the broker for hours after the model had exited
// the thesis on paper. Cancelling is the missing half of "place".
//
// The route is signature-gated like every other mirror route, and its
// ok/cancelled contract is load-bearing: the caller releases a daily-cap slot
// on `cancelled: true` and must NOT on anything else.
import { describe, it, expect } from "vitest";
import worker from "./bridge-index.js";
import { hmacSign } from "./bridge-crypto.js";

const HMAC = "test-bridge-hmac-key";
const USER = "op@x.com";

function kvMock(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
    list: async ({ prefix = "" } = {}) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

function makeEnv({ user = null, mock = "true" } = {}) {
  const seed = {};
  if (user) seed[`bridge:user:${USER}`] = JSON.stringify({ user_id: USER, ...user });
  return {
    BRIDGE_INTERNAL_HMAC_KEY: HMAC,
    BROKER_BRIDGE_MOCK: mock,
    BRIDGE_KV: kvMock(seed),
  };
}

async function post(env, body, { sign = true } = {}) {
  const raw = JSON.stringify(body);
  const headers = { "Content-Type": "application/json" };
  if (sign) headers["x-bridge-signature"] = await hmacSign({ BRIDGE_INTERNAL_HMAC_KEY: HMAC }, raw);
  const res = await worker.fetch(
    new Request("https://bridge.example.workers.dev/bridge/options/order/cancel", {
      method: "POST", headers, body: raw,
    }),
    env,
    { waitUntil: () => {} },
  );
  return { status: res.status, body: await res.json() };
}

describe("POST /bridge/options/order/cancel", () => {
  it("rejects an unsigned request", async () => {
    const r = await post(makeEnv(), { order_id: "OID", user_id: USER }, { sign: false });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("missing_signature");
  });

  it("rejects a request signed with the wrong key", async () => {
    const raw = JSON.stringify({ order_id: "OID", user_id: USER });
    const badSig = await hmacSign({ BRIDGE_INTERNAL_HMAC_KEY: "other-key" }, raw);
    const res = await worker.fetch(
      new Request("https://bridge.example.workers.dev/bridge/options/order/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-bridge-signature": badSig },
        body: raw,
      }),
      makeEnv(),
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_signature");
  });

  it("refuses a cancel with no order id", async () => {
    const r = await post(makeEnv({ user: { broker: "webull" } }), { user_id: USER });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("missing_required_fields");
  });

  it("refuses a cancel with no user", async () => {
    const r = await post(makeEnv(), { order_id: "OID" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("missing_required_fields");
  });

  it("404s an unknown user rather than guessing an account", async () => {
    const r = await post(makeEnv(), { user_id: USER, order_id: "OID" });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("user_not_found");
  });

  it("acknowledges in mock mode without touching a broker", async () => {
    const r = await post(makeEnv({ user: { broker: "webull" }, mock: "true" }), { user_id: USER, order_id: "OID" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mock: true, cancelled: true, order_id: "OID" });
  });

  it("honours a per-user mock flag even when the bridge is live", async () => {
    const r = await post(
      makeEnv({ user: { broker: "webull", mock_mode: true }, mock: "false" }),
      { user_id: USER, order_id: "OID" },
    );
    expect(r.status).toBe(200);
    expect(r.body.cancelled).toBe(true);
  });

  it("echoes the order id back so the caller can match the response", async () => {
    const r = await post(
      makeEnv({ user: { broker: "webull" } }),
      { user_id: USER, order_id: "I3I87Q92ISRM5FPJMMU0LMR38A" },
    );
    expect(r.body.order_id).toBe("I3I87Q92ISRM5FPJMMU0LMR38A");
  });
});
