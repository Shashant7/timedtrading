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
