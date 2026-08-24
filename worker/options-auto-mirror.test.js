import { describe, it, expect, afterEach } from "vitest";
import { fireAutoMirror, maybeAutoMirrorIndexDayTradeEvent, buildIndexDayTradeClosePlay, computeIndexDayTradeCloseQty } from "./options-auto-mirror.js";
import { trimSellQty } from "./option-day-trade-plan.js";

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
    const r = await maybeAutoMirrorIndexDayTradeEvent(
      { ADMIN_EMAIL: "op@x.com", KV_TIMED: { get: async () => null, put: async () => {} } },
      {
        event: "BUY",
        ticker: "QQQ",
        play: { archetype: "day_trade_call", premium: { mid: 1.25 }, contracts: 1, max_loss_usd: 125 },
        indicesFlagOn: false,
      },
    );
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("flag_off");
  });

  it("skips PROTECT — no broker action", async () => {
    const r = await maybeAutoMirrorIndexDayTradeEvent(
      { ADMIN_EMAIL: "op@x.com", KV_TIMED: { get: async () => null, put: async () => {} } },
      {
        event: "PROTECT",
        ticker: "QQQ",
        play: { archetype: "day_trade_call", premium: { mid: 1.9 }, contracts: 1, max_loss_usd: 125 },
        indicesFlagOn: true,
      },
    );
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("protect_no_broker_action");
  });

  it("skips close when no mirrored entry exists", async () => {
    const prefs = JSON.stringify({
      enabled: true,
      vehicles: { long_call: { enabled: true, daily_cap: 5, max_per_order_usd: 300, max_loss_per_order_usd: 75 } },
    });
    const r = await maybeAutoMirrorIndexDayTradeEvent(
      {
        ADMIN_EMAIL: "op@x.com",
        KV_TIMED: {
          get: async (k) => (k === "timed:options:auto-mirror:op@x.com" ? prefs : null),
          put: async () => {},
        },
      },
      {
        event: "EXIT",
        ticker: "QQQ",
        signal_id: "dt:QQQ:2026-08-24:2026-08-25:C:710",
        premium: 1.85,
        book: { contracts: 1, contracts_remaining: 1 },
        play: {
          archetype: "day_trade_call",
          _day_trade_flavor: "call",
          strikes: { primary: 710 },
          expiration: { iso: "2026-08-25" },
          legs: [{ action: "BUY", optionType: "CALL", strike: 710, expiration: "2026-08-25", qty: 1 }],
          premium: { mid: 1.85 },
          max_loss_usd: 185,
        },
        indicesFlagOn: true,
      },
    );
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("no_mirrored_entry");
  });
});

function kvMock(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
  };
}

function bridgeEnv(kv, captured) {
  return {
    ADMIN_EMAIL: "op@x.com",
    KV_TIMED: kv,
    BROKER_BRIDGE_HMAC_KEY: "secret",
    BROKER_BRIDGE_URL: "https://tt-broker-bridge.example.workers.dev",
    BROKER_BRIDGE: {
      fetch: async (req) => {
        captured.push(await req.clone().json());
        return new Response(JSON.stringify({ ok: true, order_id: "OPT1" }), { status: 200 });
      },
    },
  };
}

const SID = "dt:QQQ:2026-08-24:2026-08-25:C:710";
const PREFS = JSON.stringify({
  enabled: true,
  daily_cap: 2,
  vehicles: { long_call: { enabled: true, daily_cap: 2, max_per_order_usd: 300, max_loss_per_order_usd: 0 } },
});
const CALL_PLAY = {
  archetype: "day_trade_call",
  _day_trade_flavor: "call",
  strikes: { primary: 710 },
  expiration: { iso: "2026-08-25", dte: 1 },
  legs: [{ action: "BUY", optionType: "CALL", strike: 710, expiration: "2026-08-25", qty: 1 }],
  premium: { mid: 1.25 },
  contracts: 1,
  max_loss_usd: 125,
};

describe("Stage 5b mirror safety invariants", () => {
  const today = new Date().toISOString().slice(0, 10);

  it("EXIT close fires even when daily caps are exhausted (closes never cap-gated)", async () => {
    const captured = [];
    const kv = kvMock({
      "timed:options:auto-mirror:op@x.com": PREFS,
      [`timed:options:auto-mirror:count:op@x.com:${today}`]: "2",
      [`timed:options:auto-mirror:count:op@x.com:long_call:${today}`]: "2",
      [`timed:opt-dt-mirror:${SID}`]: JSON.stringify({ entry_fired: true, contracts: 1, contracts_remaining: 1 }),
    });
    const r = await maybeAutoMirrorIndexDayTradeEvent(bridgeEnv(kv, captured), {
      event: "EXIT",
      ticker: "QQQ",
      signal_id: SID,
      premium: 1.85,
      book: { contracts: 1, contracts_remaining: 1 },
      play: CALL_PLAY,
      indicesFlagOn: true,
    });
    expect(r.skipped).toBe(false);
    expect(r.fired.ok).toBe(true);
    expect(r.close_qty).toBe(1);
    expect(captured[0].play.legs[0].action).toBe("SELL");
  });

  it("close qty is capped at the mirrored remainder, not the paper book qty", async () => {
    const captured = [];
    const kv = kvMock({
      "timed:options:auto-mirror:op@x.com": PREFS,
      [`timed:opt-dt-mirror:${SID}`]: JSON.stringify({ entry_fired: true, contracts: 1, contracts_remaining: 1 }),
    });
    const r = await maybeAutoMirrorIndexDayTradeEvent(bridgeEnv(kv, captured), {
      event: "EXIT",
      ticker: "QQQ",
      signal_id: SID,
      premium: 2.1,
      book: { contracts: 3, contracts_remaining: 3 },
      play: CALL_PLAY,
      indicesFlagOn: true,
    });
    expect(r.skipped).toBe(false);
    expect(r.close_qty).toBe(1);
    expect(captured[0].play.legs[0].qty).toBe(1);
  });

  it("skips a broker TRIM when the mirror only holds one contract", async () => {
    const kv = kvMock({
      "timed:options:auto-mirror:op@x.com": PREFS,
      [`timed:opt-dt-mirror:${SID}`]: JSON.stringify({ entry_fired: true, contracts: 1, contracts_remaining: 1 }),
    });
    const r = await maybeAutoMirrorIndexDayTradeEvent(bridgeEnv(kv, []), {
      event: "TRIM",
      ticker: "QQQ",
      signal_id: SID,
      premium: 1.9,
      book: { contracts: 2, contracts_remaining: 2, trim_sell_qty: 1 },
      play: CALL_PLAY,
      indicesFlagOn: true,
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("mirror_single_lot_no_trim");
  });

  it("dedupes BUY when an entry was already mirrored for the signal id", async () => {
    const kv = kvMock({
      "timed:options:auto-mirror:op@x.com": PREFS,
      [`timed:opt-dt-mirror:${SID}`]: JSON.stringify({ entry_fired: true, contracts: 1, contracts_remaining: 1 }),
    });
    const r = await maybeAutoMirrorIndexDayTradeEvent(bridgeEnv(kv, []), {
      event: "BUY",
      ticker: "QQQ",
      signal_id: SID,
      play: CALL_PLAY,
      indicesFlagOn: true,
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("entry_already_mirrored");
  });

  it("does not consume the daily counter when the BUY is skipped on notional", async () => {
    const kv = kvMock({ "timed:options:auto-mirror:op@x.com": PREFS });
    const bigPlay = { ...CALL_PLAY, premium: { mid: 9.99 }, max_loss_usd: 999 };
    const r = await maybeAutoMirrorIndexDayTradeEvent(bridgeEnv(kv, []), {
      event: "BUY",
      ticker: "QQQ",
      signal_id: SID,
      play: bigPlay,
      indicesFlagOn: true,
    });
    expect(r.skipped).toBe(true);
    expect(String(r.reason)).toContain("notional_");
    expect(kv.store.has(`timed:options:auto-mirror:count:op@x.com:${today}`)).toBe(false);
    expect(kv.store.has(`timed:options:auto-mirror:count:op@x.com:long_call:${today}`)).toBe(false);
  });

  it("EXIT after a mirrored TRIM sells only the mirrored remainder", async () => {
    const captured = [];
    const kv = kvMock({
      "timed:options:auto-mirror:op@x.com": PREFS,
      [`timed:opt-dt-mirror:${SID}`]: JSON.stringify({
        entry_fired: true, trim_fired: true, contracts: 2, trim_qty: 1, contracts_remaining: 1,
      }),
    });
    const r = await maybeAutoMirrorIndexDayTradeEvent(bridgeEnv(kv, captured), {
      event: "STOP",
      ticker: "QQQ",
      signal_id: SID,
      premium: 1.25,
      book: { contracts: 2, contracts_remaining: 1 },
      play: CALL_PLAY,
      indicesFlagOn: true,
    });
    expect(r.skipped).toBe(false);
    expect(r.close_qty).toBe(1);
    const saved = JSON.parse(kv.store.get(`timed:opt-dt-mirror:${SID}`));
    expect(saved.exit_fired).toBe(true);
    expect(saved.contracts_remaining).toBe(0);
  });
});

describe("buildIndexDayTradeClosePlay", () => {
  const basePlay = {
    archetype: "day_trade_call",
    _day_trade_flavor: "call",
    strikes: { primary: 710 },
    expiration: { iso: "2026-08-25", dte: 1 },
    legs: [{ action: "BUY", optionType: "CALL", strike: 710, expiration: "2026-08-25", qty: 1 }],
  };

  it("builds a SELL single-leg close", () => {
    const close = buildIndexDayTradeClosePlay(basePlay, {
      ticker: "QQQ",
      qty: 1,
      limitPrice: 1.85,
      event: "EXIT",
      signalId: "dt:QQQ:2026-08-24:2026-08-25:C:710",
    });
    expect(close.legs[0].action).toBe("SELL");
    expect(close.legs[0].qty).toBe(1);
    expect(close.premium.mid).toBe(1.85);
    expect(close._day_trade_close).toBe(true);
  });

  it("trim qty uses trim_sell_qty on the book", () => {
    expect(trimSellQty(2)).toBe(1);
    expect(computeIndexDayTradeCloseQty("TRIM", { contracts: 2, trim_sell_qty: 1 })).toBe(1);
    expect(computeIndexDayTradeCloseQty("EXIT", { contracts: 2, contracts_remaining: 1 })).toBe(1);
  });
});
