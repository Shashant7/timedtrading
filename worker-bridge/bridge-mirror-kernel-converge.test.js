// worker-bridge/bridge-mirror-kernel-converge.test.js
//
// Every account's order is recorded against its sleeve, and a stop is
// followed through at every broker until each account's holdings show it.
// Driven through the real signed routes, with real SQLite as BRIDGE_DB.

import { describe, it, expect, beforeEach } from "vitest";
import worker from "./bridge-index.js";
import { hmacSign } from "./bridge-crypto.js";
import { buildIndexDayTradeClosePlay } from "../worker/options-auto-mirror.js";
import { d1Sqlite } from "../worker/test-support/d1-sqlite.js";
import { loadSleeves, _resetKernelSchemaForTest } from "../worker/mirror-kernel.js";

const HMAC = "test-bridge-hmac-key";
const OPERATOR = "op@x.com";
const OP_ROTH = `${OPERATOR}#webull#roth-ira`;
const PARTNER = "partner@y.com";
const PARTNER_CASH = `${PARTNER}#webull#individual-cash`;
const SID = "dt:IWM:2026-09-24:2026-09-25:P:279";
const PID = `${SID}@1790257550000`;

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

const opRoth = {
  user_id: OP_ROTH, owner_email: OPERATOR, broker: "webull", status: "connected",
  webull_account_class: "ROTH_IRA", webull_account_id: "1111000011",
  broker_integration_enabled: true, options_enabled: true, mirror_participant: false,
  equity_usd: 100000, cash_usd: 100000, buying_power_usd: 100000,
};
const partnerCash = {
  user_id: PARTNER_CASH, owner_email: PARTNER, broker: "webull", status: "connected",
  webull_account_class: "INDIVIDUAL_CASH", webull_account_id: "2222000022",
  broker_integration_enabled: true, options_enabled: true, mirror_participant: true,
  equity_usd: 50000, cash_usd: 50000, buying_power_usd: 50000,
};

function makeEnv(rows = [opRoth, partnerCash]) {
  const seed = {};
  for (const r of rows) seed[`bridge:user:${r.user_id}`] = JSON.stringify(r);
  return {
    BRIDGE_INTERNAL_HMAC_KEY: HMAC,
    BROKER_BRIDGE_MOCK: "true",
    WEBULL_DEFAULT_ACCOUNT_CLASS: "ROTH_IRA",
    MODEL_BOOK_BASE_USD: "100000",
    BRIDGE_KV: kvMock(seed),
    BRIDGE_DB: d1Sqlite(),
  };
}

async function signedPost(env, path, body) {
  const raw = JSON.stringify(body);
  const res = await worker.fetch(
    new Request(`https://bridge.example.workers.dev${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-signature": await hmacSign({ BRIDGE_INTERNAL_HMAC_KEY: HMAC }, raw),
      },
      body: raw,
    }),
    env,
    { waitUntil: () => {} },
  );
  return { status: res.status, body: await res.json() };
}

function buyPayload(over = {}) {
  return {
    user_id: OPERATOR,
    trade_id: SID,
    position_id: PID,
    leg_seq: 0,
    ticker: "IWM",
    source: "auto_mirror_index_dt",
    play: {
      archetype: "long_put", contracts: 2, premium: { mid: 0.64 },
      expiration: "2026-09-25", strikes: { primary: 279 }, max_loss_usd: 128,
      legs: [{ action: "BUY", optionType: "PUT", strike: 279, expiration: "2026-09-25", qty: 2, premium_mid: 0.64 }],
    },
    ...over,
  };
}

function closePlay(qty = 1) {
  return buildIndexDayTradeClosePlay({
    archetype: "long_put", ticker: "IWM", _day_trade_flavor: "put",
    strikes: { primary: 279 }, expiration: { iso: "2026-09-25" },
    legs: [{ action: "BUY", optionType: "PUT", strike: 279, expiration: "2026-09-25", qty }],
  }, { ticker: "IWM", strike: 279, expiration: { iso: "2026-09-25" }, flavor: "put", qty, limitPrice: 0.4, event: "STOP", signalId: SID });
}

function converge(env, over = {}) {
  return signedPost(env, "/bridge/options/converge", {
    position_id: PID, trade_id: SID, leg_seq: 2,
    model: { opened_qty: 2, remaining_qty: 0 },
    close_play: closePlay(),
    ...over,
  });
}

beforeEach(() => _resetKernelSchemaForTest());

describe("every account's entry is a sleeve on the record", () => {
  it("records the operator and the partner against the same position", async () => {
    const env = makeEnv();
    const r = await signedPost(env, "/bridge/options/order", buyPayload());
    expect(r.body.ok).toBe(true);
    const sleeves = await loadSleeves(env.BRIDGE_DB, PID);
    expect(sleeves).toHaveLength(2);
    const op = sleeves.find((s) => s.is_owner);
    const partner = sleeves.find((s) => !s.is_owner);
    expect(op).toMatchObject({ account_id: "1111000011", opened_qty: 2, remaining_qty: 2, status: "open" });
    expect(partner).toMatchObject({ account_id: "2222000022", opened_qty: 2, remaining_qty: 2, status: "open" });
  });

  it("sends each order under the id it recorded", async () => {
    const env = makeEnv();
    const r = await signedPost(env, "/bridge/options/order", buyPayload());
    const rows = (await env.BRIDGE_DB.prepare("SELECT client_order_id, status FROM mirror_order_attempt").all()).results;
    expect(rows).toHaveLength(2);
    expect(rows.every((a) => /^tt[0-9a-f]{28}$/.test(a.client_order_id))).toBe(true);
    expect(rows.map((a) => a.client_order_id)).toContain(r.body.translated_order.client_order_id);
  });

  it("keeps an account the fan-out sized out, with the reason", async () => {
    const tiny = { ...partnerCash, options_prefs: { daily_loss_limit_usd: 20 } };
    const env = makeEnv([opRoth, tiny]);
    await signedPost(env, "/bridge/options/order", buyPayload());
    const partner = (await loadSleeves(env.BRIDGE_DB, PID)).find((s) => !s.is_owner);
    expect(partner).toMatchObject({ opened_qty: 0, status: "diverged", divergence_reason: "max_loss_cap" });
  });

  it("records nothing for an order that names no position", async () => {
    const env = makeEnv();
    await signedPost(env, "/bridge/options/order", buyPayload({ position_id: undefined }));
    await expect(env.BRIDGE_DB.prepare("SELECT COUNT(*) AS n FROM mirror_order_attempt").first("n"))
      .rejects.toThrow(); // table never created: the kernel was never touched
  });
});

describe("converge — the stop is followed through at every broker", () => {
  it("sells what each account still holds and reports every account", async () => {
    const env = makeEnv();
    await signedPost(env, "/bridge/options/order", buyPayload());
    const r = await converge(env);
    expect(r.body.ok).toBe(true);
    expect(r.body.accounts).toBe(2);
    expect(r.body.results.every((x) => x.action === "sell" && x.sold.ok)).toBe(true);
    expect(r.body.all_verified).toBe(false);

    const sleeves = await loadSleeves(env.BRIDGE_DB, PID);
    expect(sleeves.every((s) => s.remaining_qty === 0)).toBe(true);
  });

  it("verifies once every account's holdings show flat", async () => {
    const env = makeEnv();
    await signedPost(env, "/bridge/options/order", buyPayload());
    await converge(env);
    const r = await converge(env, { mock_held: { "1111000011": 0, "2222000022": 0 } });
    expect(r.body.all_verified).toBe(true);
    const sleeves = await loadSleeves(env.BRIDGE_DB, PID);
    expect(sleeves.every((s) => s.status === "closed" && s.verified_seq === 2)).toBe(true);
  });

  it("trims each account to the mirror image, not the operator's quantity", async () => {
    const env = makeEnv();
    await signedPost(env, "/bridge/options/order", buyPayload());
    const r = await converge(env, { leg_seq: 1, model: { opened_qty: 2, remaining_qty: 1 } });
    expect(r.body.results.map((x) => [x.target, x.sold?.qty])).toEqual([[1, 1], [1, 1]]);
  });

  it("stands down for an account whose holder already sold", async () => {
    const env = makeEnv();
    await signedPost(env, "/bridge/options/order", buyPayload());
    const r = await converge(env, { mock_held: { "1111000011": 2, "2222000022": 0 } });
    const partner = r.body.results.find((x) => !x.is_owner);
    expect(partner).toMatchObject({ external_qty: 2, action: "verified", divergence: "external_reduction" });
    const op = r.body.results.find((x) => x.is_owner);
    expect(op.action).toBe("sell");
  });

  it("skips an account declined at entry without reading its broker", async () => {
    const tiny = { ...partnerCash, options_prefs: { daily_loss_limit_usd: 20 } };
    const env = makeEnv([opRoth, tiny]);
    await signedPost(env, "/bridge/options/order", buyPayload());
    const r = await converge(env);
    const partner = r.body.results.find((x) => !x.is_owner);
    expect(partner).toMatchObject({ action: "never_opened", divergence: "max_loss_cap" });
  });

  it("dry-runs without placing", async () => {
    const env = makeEnv();
    await signedPost(env, "/bridge/options/order", buyPayload());
    const r = await converge(env, { dry_run: true });
    expect(r.body.results.every((x) => x.action === "sell" && !x.sold)).toBe(true);
    const sleeves = await loadSleeves(env.BRIDGE_DB, PID);
    expect(sleeves.every((s) => s.remaining_qty === 2)).toBe(true);
  });

  it("refuses without a signature or the fields it needs", async () => {
    const env = makeEnv();
    const bad = await signedPost(env, "/bridge/options/converge", { position_id: PID });
    expect(bad.status).toBe(400);
    const unsigned = await worker.fetch(new Request("https://bridge.example.workers.dev/bridge/options/converge", {
      method: "POST", body: "{}",
    }), env, { waitUntil: () => {} });
    expect(unsigned.status).toBeGreaterThanOrEqual(400);
  });

  it("does not charge the owner's converge sell to the partner ledger", async () => {
    const env = makeEnv();
    await signedPost(env, "/bridge/options/order", buyPayload());
    await converge(env);
    const riskKeys = [...env.BRIDGE_KV.store.keys()].filter((k) => k.includes(":risk:"));
    expect(riskKeys.some((k) => k.includes(OP_ROTH))).toBe(false);
  });
});
