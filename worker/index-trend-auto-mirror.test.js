import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  maybeAutoMirrorIndexTrendEvent,
  indexTrendNeedsEntryCatchUp,
  indexTrendNeedsExitCatchUp,
  indexTrendMirrorNeedsExitCatchUp,
  indexTrendCatchUpPlaced,
  indexTrendCloseReadyToFinalize,
  healStrandedIndexTrendCloses,
  INDEX_TREND_MIRROR_LOG_KEY,
} from "./index-trend-auto-mirror.js";
import { forwardOrderToBridge } from "./broker-bridge-client.js";
import { indexTrendActionShares } from "./index-trend-alerts.js";

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
  beforeEach(() => {
    forwardOrderToBridge.mockClear();
    forwardOrderToBridge.mockResolvedValue({ ok: true, order_id: "ord-1" });
  });

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

  it("revives a premature TQQQ runner STOP instead of heal-selling", async () => {
    const signalId = "it:QQQ:TQQQ:LONG:2026-W36";
    const env = envWithStore({
      "timed:options:auto-mirror:op@test.com": ENABLED_PREFS,
      [`timed:idx-trend-mirror:${signalId}`]: JSON.stringify({
        entry_fired: true,
        trim_fired: true,
        shares: 28,
        shares_remaining: 21,
        letf_ticker: "TQQQ",
        underlying: "QQQ",
      }),
      [`timed:idx-trend-book:${signalId}`]: JSON.stringify({
        status: "closed",
        reason: "underlying_invalidation",
        direction: "LONG",
        entry_underlying_price: 711.8,
        entry_letf_price: 70.32,
        stop_underlying: 710.26,
        shares: 28,
        shares_remaining: 0,
        trims_fired: [1, 2],
        peak_underlying_r: 5.88,
        needs_wait: true,
        letf_ticker: "TQQQ",
        underlying: "QQQ",
      }),
      "timed:idx-trend-actions": JSON.stringify([
        {
          ts: RTH_TS,
          event: "STOP",
          underlying: "QQQ",
          letf_ticker: "TQQQ",
          signal_id: signalId,
          shares: 21,
          letf_price: 69.08,
          reason: "underlying_invalidation",
        },
      ]),
    });
    const out = await healStrandedIndexTrendCloses(env, { now: RTH_TS });
    expect(out.revived).toBe(1);
    expect(out.attempted).toBe(0);
    expect(forwardOrderToBridge).not.toHaveBeenCalled();
    const book = JSON.parse(env.store[`timed:idx-trend-book:${signalId}`]);
    expect(book.status).toBe("trimmed");
    expect(book.shares_remaining).toBe(21);
    expect(book.stop_underlying).toBeLessThan(710.26);
    expect(await indexTrendNeedsExitCatchUp(env, signalId, RTH_TS)).toBe(true);
    forwardOrderToBridge.mockClear();
    const again = await healStrandedIndexTrendCloses(env, { now: RTH_TS + 60_000 });
    expect(again.revived).toBe(0);
    expect(again.attempted).toBe(0);
    expect(forwardOrderToBridge).not.toHaveBeenCalled();
  });

  it("heals a real first-stop leftover (no runner) to the broker", async () => {
    const signalId = "it:IWM:TNA:LONG:2026-W36";
    const env = envWithStore({
      "timed:options:auto-mirror:op@test.com": ENABLED_PREFS,
      [`timed:idx-trend-mirror:${signalId}`]: JSON.stringify({
        entry_fired: true,
        shares: 10,
        shares_remaining: 10,
        letf_ticker: "TNA",
        underlying: "IWM",
      }),
      [`timed:idx-trend-book:${signalId}`]: JSON.stringify({
        status: "closed",
        reason: "underlying_invalidation",
        direction: "LONG",
        entry_underlying_price: 240,
        stop_underlying: 236,
        shares: 10,
        shares_remaining: 0,
        trims_fired: [],
        peak_underlying_r: 0.2,
        needs_wait: true,
      }),
      "timed:idx-trend-actions": JSON.stringify([
        {
          ts: RTH_TS,
          event: "STOP",
          underlying: "IWM",
          letf_ticker: "TNA",
          signal_id: signalId,
          shares: 10,
          reason: "underlying_invalidation",
        },
      ]),
    });
    expect(indexTrendMirrorNeedsExitCatchUp({
      entry_fired: true,
      shares_remaining: 10,
    })).toBe(true);
    expect(indexTrendCloseReadyToFinalize({ skipped: false, fired: { ok: true, order_id: "ord-1" } })).toBe(true);
    expect(indexTrendCloseReadyToFinalize({ skipped: true, reason: "disabled" })).toBe(false);
    const out = await healStrandedIndexTrendCloses(env, { now: RTH_TS });
    expect(out.revived).toBe(0);
    expect(out.attempted).toBe(1);
    expect(out.filled).toBe(1);
    expect(forwardOrderToBridge).toHaveBeenCalledWith(env, expect.objectContaining({
      ticker: "TNA",
      side: "exit",
      qty: 10,
      trade_id: signalId,
    }));
  });

  it("does not immediately re-heal a rejected close (cooldown)", async () => {
    forwardOrderToBridge.mockResolvedValueOnce({
      ok: false,
      skip: "equity_ah_too_late_for_broker",
    });
    const signalId = "it:DIA:UDOW:LONG:2026-W36";
    const env = envWithStore({
      "timed:options:auto-mirror:op@test.com": ENABLED_PREFS,
      [`timed:idx-trend-mirror:${signalId}`]: JSON.stringify({
        entry_fired: true,
        shares: 27,
        shares_remaining: 20,
        letf_ticker: "UDOW",
        underlying: "DIA",
      }),
      "timed:idx-trend-actions": JSON.stringify([
        { ts: AFTER_TS, event: "EXIT", signal_id: signalId, letf_ticker: "UDOW", underlying: "DIA", shares: 0 },
      ]),
    });
    const first = await healStrandedIndexTrendCloses(env, { now: AFTER_TS });
    expect(first.attempted).toBe(1);
    expect(first.filled).toBe(0);
    expect(await indexTrendNeedsExitCatchUp(env, signalId, AFTER_TS + 60_000)).toBe(false);
    expect(await indexTrendNeedsExitCatchUp(env, signalId, AFTER_TS + 16 * 60 * 1000)).toBe(true);
  });

  it("records flatten qty on STOP, not post-close remaining 0", () => {
    expect(indexTrendActionShares(
      { event: "STOP", close_qty: 16 },
      { nextBook: { shares: 28, shares_remaining: 0 }, priorBook: { shares: 28, shares_remaining: 16 } },
    )).toBe(16);
    expect(indexTrendActionShares(
      { event: "TRIM", trim_sell_qty: 7 },
      { nextBook: { shares_remaining: 21 } },
    )).toBe(7);
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
