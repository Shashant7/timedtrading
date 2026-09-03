import { describe, it, expect, vi } from "vitest";
import { maybeAutoMirrorIndexTrendEvent, indexTrendNeedsEntryCatchUp, indexTrendCatchUpPlaced, INDEX_TREND_MIRROR_LOG_KEY } from "./index-trend-auto-mirror.js";
import { forwardOrderToBridge } from "./broker-bridge-client.js";

vi.mock("./broker-bridge-client.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    forwardOrderToBridge: vi.fn(async () => ({ ok: true, order_id: "ord-1" })),
  };
});

const RTH_TS = Date.UTC(2026, 7, 31, 13, 45, 0); // 9:45 AM ET
const AFTER_TS = Date.UTC(2026, 7, 31, 21, 30, 0); // 5:30 PM ET

function envWithStore(seed = {}) {
  const store = { ...seed };
  return {
    ADMIN_EMAIL: "op@test.com",
    KV_TIMED: {
      get: async (k) => (store[k] == null ? null : store[k]),
      put: async (k, v) => { store[k] = v; },
    },
    store,
  };
}

const ENABLED_PREFS = JSON.stringify({
  enabled: true,
  daily_cap: 3,
  vehicles: { index_trend_letf: { enabled: true, daily_cap: 2, max_per_order_usd: 2000 } },
});

describe("index-trend-auto-mirror", () => {
  it("skips when auto-mirror disabled and still writes the decision log", async () => {
    const env = envWithStore({
      "timed:options:auto-mirror:op@test.com": JSON.stringify({ enabled: false }),
    });
    const r = await maybeAutoMirrorIndexTrendEvent(env, {
      event: "BUY",
      signal_id: "it:SPY:SPYU:LONG:2026-W35",
      underlying: "SPY",
      letf_ticker: "SPYU",
      letf_price: 120,
      management: { stop_underlying: 628 },
      now: RTH_TS,
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("disabled");
    const log = JSON.parse(env.store[INDEX_TREND_MIRROR_LOG_KEY]);
    expect(log[0].decision).toBe("skipped");
    expect(log[0].reason).toBe("disabled");
    expect(log[0].side).toBe("buy");
  });

  it("forwards a catch-up BUY after the cash session for an already-open book", async () => {
    const env = envWithStore({
      "timed:options:auto-mirror:op@test.com": ENABLED_PREFS,
    });
    expect(await indexTrendNeedsEntryCatchUp(env, "it:IWM:TNA:LONG:2026-W36")).toBe(true);
    const r = await maybeAutoMirrorIndexTrendEvent(env, {
      event: "BUY",
      catch_up: true,
      signal_id: "it:IWM:TNA:LONG:2026-W36",
      underlying: "IWM",
      letf_ticker: "TNA",
      letf_price: 68.15,
      book: { shares: 29, status: "open" },
      now: AFTER_TS,
    });
    expect(r.skipped).toBe(false);
    expect(r.qty).toBe(29);
    expect(forwardOrderToBridge).toHaveBeenCalled();
    expect(await indexTrendNeedsEntryCatchUp(env, "it:IWM:TNA:LONG:2026-W36")).toBe(false);
  });

  it("treats a forwarded catch-up as placed only with a real order id", () => {
    expect(indexTrendCatchUpPlaced({ skipped: false, fired: { ok: true, order_id: "ord-1" } })).toBe(true);
    expect(indexTrendCatchUpPlaced({ skipped: false, fired: { ok: true } })).toBe(false);
    expect(indexTrendCatchUpPlaced({ skipped: true, reason: "no_mirrored_entry" })).toBe(false);
    expect(indexTrendCatchUpPlaced({ skipped: false, fired: { ok: false, skip: "no_bridge_url" } })).toBe(false);
  });

  it("does not stamp entry_fired on a cash reject (UDOW 2026-09-03)", async () => {
    forwardOrderToBridge.mockResolvedValueOnce({
      ok: false,
      response: { reject_reason: "insufficient_cash_for_one_unit_92_lt_71.96" },
    });
    const env = envWithStore({
      "timed:options:auto-mirror:op@test.com": ENABLED_PREFS,
    });
    const signalId = "it:DIA:UDOW:LONG:2026-W36";
    const r = await maybeAutoMirrorIndexTrendEvent(env, {
      event: "BUY",
      catch_up: true,
      signal_id: signalId,
      underlying: "DIA",
      letf_ticker: "UDOW",
      letf_price: 71.96,
      book: { shares: 27, status: "open" },
      now: RTH_TS,
    });
    expect(r.skipped).toBe(false);
    expect(r.fired?.ok).toBe(false);
    expect(await indexTrendNeedsEntryCatchUp(env, signalId, RTH_TS)).toBe(false);
    expect(await indexTrendNeedsEntryCatchUp(env, signalId, RTH_TS + 16 * 60 * 1000)).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect(env.store[`timed:options:auto-mirror:count:op@test.com:${today}`]).toBe("0");
    expect(env.store[`timed:options:auto-mirror:count:op@test.com:index_trend_letf:${today}`]).toBe("0");
  });

  it("stamps a fan-out order id so later UDOW/TQQQ trims stay eligible", async () => {
    forwardOrderToBridge.mockResolvedValueOnce({
      ok: true,
      response: {
        ok: true,
        fanout: true,
        results: [
          { http_status: 200, result: { ok: true, order_id: "WB-OWNER" } },
          { http_status: 200, result: { ok: true, order_id: "WB-PARTNER" } },
        ],
      },
    });
    const env = envWithStore({
      "timed:options:auto-mirror:op@test.com": ENABLED_PREFS,
    });
    const signalId = "it:QQQ:TQQQ:LONG:2026-W36";
    const r = await maybeAutoMirrorIndexTrendEvent(env, {
      event: "BUY",
      signal_id: signalId,
      underlying: "QQQ",
      letf_ticker: "TQQQ",
      letf_price: 55,
      book: { shares: 20, status: "open" },
      now: RTH_TS,
    });
    expect(r.skipped).toBe(false);
    const mirror = JSON.parse(env.store[`timed:idx-trend-mirror:${signalId}`]);
    expect(mirror.entry_fired).toBe(true);
    expect(mirror.entry_order_id).toBe("WB-OWNER");
    expect(mirror.entry_order_ids).toEqual(["WB-OWNER", "WB-PARTNER"]);
  });

  it("still blocks a fresh BUY outside RTH", async () => {
    const env = envWithStore({
      "timed:options:auto-mirror:op@test.com": ENABLED_PREFS,
    });
    const r = await maybeAutoMirrorIndexTrendEvent(env, {
      event: "BUY",
      signal_id: "it:IWM:TNA:LONG:2026-W36",
      underlying: "IWM",
      letf_ticker: "TNA",
      letf_price: 68.15,
      book: { shares: 29 },
      now: AFTER_TS,
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("outside_rth_buy_window");
  });
});
