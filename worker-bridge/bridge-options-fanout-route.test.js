// worker-bridge/bridge-options-fanout-route.test.js
//
// 2026-09-24 — `POST /bridge/options/order` fans out to partner accounts.
//
// The equity webhook has copied model trades to mirror participants since
// multi-tenant launched. The options webhook placed on ONE resolved account
// and returned, so a partner with mirroring on, options enabled, and a
// funded cash account received every LETF share and not one index day
// trade. Nothing reported a miss because nothing was ever asked to place.
//
// Two contracts are load-bearing here and both are asserted below:
//   1. The operator's result stays at the TOP LEVEL of the response. The
//      main worker's day-trade ledger reads `fill` / `broker_response` /
//      `ok` from there, so a partner must not be able to move it.
//   2. A partner failure is isolated. One broker erroring cannot stop
//      another partner's order or the operator's.
import { describe, it, expect } from "vitest";
import worker from "./bridge-index.js";
import { hmacSign } from "./bridge-crypto.js";
import { buildIndexDayTradeClosePlay } from "../worker/options-auto-mirror.js";

const HMAC = "test-bridge-hmac-key";
const OPERATOR = "op@x.com";
const OP_ROTH = `${OPERATOR}#webull#roth-ira`;
const PARTNER = "partner@y.com";
const PARTNER_CASH = `${PARTNER}#webull#individual-cash`;
const PARTNER_FUTURES = `${PARTNER}#webull#futures`;
const PARTNER2 = "partner2@z.com";

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
  user_id: OP_ROTH,
  owner_email: OPERATOR,
  broker: "webull",
  status: "connected",
  webull_account_class: "ROTH_IRA",
  webull_account_id: "1111000011",
  broker_integration_enabled: true,
  options_enabled: true,
  mirror_participant: false,
  equity_usd: 100000,
  cash_usd: 100000,
  buying_power_usd: 100000,
};

const partnerCash = {
  user_id: PARTNER_CASH,
  owner_email: PARTNER,
  broker: "webull",
  status: "connected",
  webull_account_class: "INDIVIDUAL_CASH",
  webull_account_id: "2222000022",
  broker_integration_enabled: true,
  options_enabled: true,
  mirror_participant: true,
  equity_usd: 50000,
  cash_usd: 50000,
  buying_power_usd: 50000,
};

// Same owner, futures sub-account: mirrors stock, must never see options.
const partnerFutures = {
  user_id: PARTNER_FUTURES,
  owner_email: PARTNER,
  broker: "webull",
  status: "connected",
  webull_account_class: "FUTURES",
  webull_account_id: "3333000033",
  broker_integration_enabled: true,
  options_enabled: false,
  mirror_participant: true,
  equity_usd: 20000,
};

function makeEnv(rows = [opRoth], { mock = "true" } = {}) {
  const seed = {};
  for (const r of rows) seed[`bridge:user:${r.user_id}`] = JSON.stringify(r);
  return {
    BRIDGE_INTERNAL_HMAC_KEY: HMAC,
    BROKER_BRIDGE_MOCK: mock,
    WEBULL_DEFAULT_ACCOUNT_CLASS: "ROTH_IRA",
    MODEL_BOOK_BASE_USD: "100000",
    BRIDGE_KV: kvMock(seed),
  };
}

// Exactly the play the index day-trade lane sends (worker/options-auto-mirror.js):
// premium is an object, and the leg carries its own qty.
function buyPayload(over = {}) {
  return {
    user_id: OPERATOR,
    trade_id: "dt:IWM:2026-09-24:2026-09-25:P:279",
    ticker: "IWM",
    source: "auto_mirror_index_dt",
    play: {
      archetype: "long_put",
      contracts: 2,
      premium: { mid: 0.64 },
      expiration: "2026-09-25",
      strikes: { primary: 279 },
      max_loss_usd: 128,
      legs: [{
        action: "BUY", optionType: "PUT", strike: 279,
        expiration: "2026-09-25", qty: 2, premium_mid: 0.64,
      }],
    },
    ...over,
  };
}

async function post(env, body) {
  const raw = JSON.stringify(body);
  const res = await worker.fetch(
    new Request("https://bridge.example.workers.dev/bridge/options/order", {
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

describe("POST /bridge/options/order — partner fan-out", () => {
  it("places for the operator and copies the trade to the partner", async () => {
    const r = await post(makeEnv([opRoth, partnerCash]), buyPayload());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.fanout.accounts).toBe(1);
    const [mirror] = r.body.fanout.results;
    expect(mirror.user_id).toBe(PARTNER_CASH);
    expect(mirror.ok).toBe(true);
  });

  // This is the regression that started it: no partner rows at all used to
  // be the ONLY behaviour, so it has to stay byte-compatible.
  it("returns exactly the old shape when there is no partner", async () => {
    const r = await post(makeEnv([opRoth]), buyPayload());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.fanout).toBeUndefined();
    expect(r.body.ticker).toBe("IWM");
    expect(r.body.fill).toBeTruthy();
  });

  // The main worker's day-trade ledger reads these fields off the top
  // level. A partner must never be able to move them.
  it("keeps the operator's fill at the top level, not inside fanout", async () => {
    const solo = await post(makeEnv([opRoth]), buyPayload());
    const withPartner = await post(makeEnv([opRoth, partnerCash]), buyPayload());
    expect(withPartner.body.ok).toBe(solo.body.ok);
    expect(withPartner.body.ticker).toBe(solo.body.ticker);
    expect(withPartner.body.translated_order.qty).toBe(solo.body.translated_order.qty);
    expect(withPartner.body.fill.filled_qty).toBe(solo.body.fill.filled_qty);
  });

  it("never sends options to the partner's futures sub-account", async () => {
    const r = await post(makeEnv([opRoth, partnerCash, partnerFutures]), buyPayload());
    const ids = r.body.fanout.results.map((x) => x.user_id);
    expect(ids).toEqual([PARTNER_CASH]);
  });

  it("skips a partner who mirrors stock but never enabled options", async () => {
    const stockOnly = { ...partnerCash, options_enabled: false, options_prefs: undefined };
    const r = await post(makeEnv([opRoth, stockOnly]), buyPayload());
    expect(r.body.fanout).toBeUndefined();
  });

  it("skips a partner who paused mirroring", async () => {
    const paused = { ...partnerCash, mirror_participant: false };
    const r = await post(makeEnv([opRoth, paused]), buyPayload());
    expect(r.body.fanout).toBeUndefined();
  });

  it("sizes the partner down on its equity instead of copying model size", async () => {
    // $50k against a $100k book: half of 2 contracts.
    const r = await post(makeEnv([opRoth, partnerCash]), buyPayload());
    const [mirror] = r.body.fanout.results;
    expect(r.body.translated_order.qty).toBe(2);
    expect(mirror.contracts).toBe(1);
  });

  it("gives the partner its own order, not a second copy of the operator's", async () => {
    const r = await post(makeEnv([opRoth, partnerCash]), buyPayload());
    const [mirror] = r.body.fanout.results;
    expect(mirror.result.translated_order).toBeTruthy();
    expect(mirror.result.translated_order.qty).toBe(1);
  });

  it("reports why an account sat out rather than dropping it silently", async () => {
    const noEquity = { ...partnerCash, equity_usd: 0, portfolio: null };
    const r = await post(makeEnv([opRoth, noEquity]), buyPayload());
    const [mirror] = r.body.fanout.results;
    expect(mirror.ok).toBe(false);
    expect(mirror.skipped).toBe(true);
    expect(mirror.reason).toBe("account_equity_unknown");
  });

  it("still places for the operator when every partner sits out", async () => {
    const noEquity = { ...partnerCash, equity_usd: 0, portfolio: null };
    const r = await post(makeEnv([opRoth, noEquity]), buyPayload());
    expect(r.body.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  // One partner's broker having a bad day must not cost the operator or
  // any other partner their fill on a lane measured in seconds.
  it("isolates one partner's failure from the other accounts", async () => {
    const broken = {
      ...partnerCash,
      user_id: `${PARTNER2}#webull#individual-cash`,
      owner_email: PARTNER2,
      webull_account_id: "4444000044",
      equity_usd: 0, // sits out at sizing, inside its own branch
      portfolio: null,
    };
    const r = await post(makeEnv([opRoth, partnerCash, broken]), buyPayload());
    expect(r.body.ok).toBe(true);
    const byId = Object.fromEntries(r.body.fanout.results.map((x) => [x.user_id, x]));
    expect(byId[PARTNER_CASH].ok).toBe(true);
    expect(byId[`${PARTNER2}#webull#individual-cash`].ok).toBe(false);
  });

  it("copies the trade to every partner, not just the first", async () => {
    const second = {
      ...partnerCash,
      user_id: `${PARTNER2}#webull#individual-cash`,
      owner_email: PARTNER2,
      webull_account_id: "5555000055",
      equity_usd: 100000,
    };
    const r = await post(makeEnv([opRoth, partnerCash, second]), buyPayload());
    expect(r.body.fanout.accounts).toBe(2);
    expect(r.body.fanout.results.every((x) => x.ok)).toBe(true);
    // Each account claims the order under its own id; one shared key would
    // let the first target dedupe the rest into placing nothing.
    const sizes = Object.fromEntries(r.body.fanout.results.map((x) => [x.user_id, x.contracts]));
    expect(sizes[PARTNER_CASH]).toBe(1);
    expect(sizes[`${PARTNER2}#webull#individual-cash`]).toBe(2);
  });

  // Built by the REAL main-worker builder, not a hand-made fixture: if
  // that builder changes shape, a partner's exit would get sized like an
  // entry and could be scaled down below what they hold.
  it("fans a day-trade exit out, and does not resize it like an entry", async () => {
    // Source seed exactly as reconcileIndexDtMirrorPositions builds it.
    const seed = {
      archetype: "day_trade_put", ticker: "IWM", _day_trade_flavor: "put",
      strikes: { primary: 279 }, expiration: { iso: "2026-09-25" },
      premium: { mid: 0.63 },
      legs: [{ action: "BUY", optionType: "PUT", strike: 279, expiration: "2026-09-25", qty: 2 }],
    };
    const closePlay = buildIndexDayTradeClosePlay(
      seed,
      {
        ticker: "IWM", strike: 279, expiration: { iso: "2026-09-25" },
        flavor: "put", qty: 2, limitPrice: 0.63, event: "STOP",
        signalId: "dt:IWM:2026-09-24:2026-09-25:P:279",
      },
    );
    const r = await post(makeEnv([opRoth, partnerCash]), buyPayload({ play: closePlay }));
    expect(r.body.fanout.accounts).toBe(1);
    const [mirror] = r.body.fanout.results;
    expect(mirror.user_id).toBe(PARTNER_CASH);
    // Entry sizing would have cut this to 1 on the equity ratio. A reduce
    // goes out at the model's qty and is clamped to held at the guard.
    expect(mirror.contracts).toBe(2);
    expect(mirror.sizing).toBeUndefined();
  });

  it("honours the global kill switch before any account is touched", async () => {
    const env = makeEnv([opRoth, partnerCash]);
    env.BRIDGE_KILL_SWITCH = "true";
    const r = await post(env, buyPayload());
    expect(r.body).toMatchObject({ ok: false, rejected: true, reason: "global_kill_switch" });
    expect(r.body.fanout).toBeUndefined();
  });

  it("still requires a signature", async () => {
    const raw = JSON.stringify(buyPayload());
    const res = await worker.fetch(
      new Request("https://bridge.example.workers.dev/bridge/options/order", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: raw,
      }),
      makeEnv([opRoth, partnerCash]),
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(401);
  });
});
