import { describe, it, expect, vi, beforeEach } from "vitest";

const forwardMock = vi.fn();
const itMirrorMock = vi.fn();

vi.mock("./broker-bridge-client.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    forwardOrderToBridge: (...args) => forwardMock(...args),
    readClientRing: async (env) => {
      const raw = await env?.KV_TIMED?.get?.("bridge:client:recent");
      try { return raw ? JSON.parse(raw) : []; } catch { return []; }
    },
  };
});

vi.mock("./index-trend-auto-mirror.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    maybeAutoMirrorIndexTrendEvent: (...args) => itMirrorMock(...args),
  };
});

import {
  planTraderEquityEntryCatchup,
  planIndexTrendEntryCatchup,
  tradeHasRealBuyPlace,
  recentRingError,
  runTraderEntryCatchup,
} from "./trader-entry-catchup.js";

const TJX = {
  trade_id: "TJX-1788443010856-y683gd3xi",
  ticker: "TJX",
  direction: "LONG",
  shares: 10.07,
  entry_price: 131.60,
  status: "OPEN",
};
const ULTA = {
  trade_id: "ULTA-1788443010856-abc",
  ticker: "ULTA",
  direction: "LONG",
  shares: 1.77,
  entry_price: 560.61,
  status: "OPEN",
};
const NKE = {
  trade_id: "NKE-1788443010856-short",
  ticker: "NKE",
  direction: "SHORT",
  shares: 29.67,
  entry_price: 38.28,
  status: "OPEN",
};
const UDOW_BOOK = {
  signal_id: "it:DIA:UDOW:LONG:2026-W36",
  underlying: "DIA",
  letf_ticker: "UDOW",
  shares: 27,
  entry: 71.96,
  book: { shares: 27, status: "open", entry_letf_price: 71.96, signal_id: "it:DIA:UDOW:LONG:2026-W36" },
  needs_catchup: true,
};

const RTH = new Date("2026-09-03T10:05:00-04:00");

describe("planTraderEquityEntryCatchup", () => {
  it("plans TJX when the ring is a false-ok 200 with no order id", () => {
    const ring = [{
      trade_id: TJX.trade_id,
      ticker: "TJX",
      side: "buy",
      status: "ok",
      http_status: 200,
      order_id: null,
      reject_reason: null,
      ts: Date.parse("2026-09-03T13:43:40Z"),
    }];
    expect(tradeHasRealBuyPlace(ring, TJX.trade_id)).toBe(false);
    const out = planTraderEquityEntryCatchup({
      trades: [TJX, ULTA, NKE],
      ring,
      livePrices: { TJX: 131.80, ULTA: 561, NKE: 38.2 },
      nowMs: RTH.getTime(),
    });
    expect(out.planned.map((p) => p.ticker).sort()).toEqual(["TJX", "ULTA"]);
    expect(out.skipped.find((s) => s.ticker === "NKE")?.skip).toBe("equity_short_blocked_on_ira");
  });

  it("skips a buy that has a real order id", () => {
    const out = planTraderEquityEntryCatchup({
      trades: [TJX],
      ring: [{
        trade_id: TJX.trade_id,
        side: "buy",
        status: "ok",
        order_id: "WB-1",
        http_status: 200,
      }],
      livePrices: { TJX: 131.80 },
      nowMs: RTH.getTime(),
    });
    expect(out.planned).toHaveLength(0);
    expect(out.skipped[0].skip).toBe("already_mirrored");
  });

  it("does not chase a 6% drift", () => {
    const out = planTraderEquityEntryCatchup({
      trades: [TJX],
      ring: [],
      livePrices: { TJX: 131.60 * 1.06 },
      nowMs: RTH.getTime(),
    });
    expect(out.planned).toHaveLength(0);
    expect(out.skipped[0].skip).toBe("price_drift");
  });

  it("cools down after a recent ring error", () => {
    const nowMs = RTH.getTime();
    const ring = [{
      trade_id: TJX.trade_id,
      side: "buy",
      status: "error",
      reject_reason: "insufficient_cash_for_one_unit_92_lt_131.60",
      ts: nowMs - 2 * 60 * 1000,
    }];
    expect(recentRingError(ring, TJX.trade_id, nowMs)).toBe(true);
    const out = planTraderEquityEntryCatchup({
      trades: [TJX],
      ring,
      livePrices: { TJX: 131.80 },
      nowMs,
    });
    expect(out.skipped[0].skip).toBe("recent_reject_cooldown");
  });
});

describe("planIndexTrendEntryCatchup", () => {
  it("plans UDOW when the mirror KV never stamped entry_fired", () => {
    const out = planIndexTrendEntryCatchup({
      books: [UDOW_BOOK],
      ring: [],
      livePrices: { UDOW: 72.10 },
      nowMs: RTH.getTime(),
    });
    expect(out.planned).toHaveLength(1);
    expect(out.planned[0].ticker).toBe("UDOW");
    expect(out.planned[0].kind).toBe("index_trend_letf");
  });

  it("skips when needs_catchup is false", () => {
    const out = planIndexTrendEntryCatchup({
      books: [{ ...UDOW_BOOK, needs_catchup: false }],
      ring: [],
      livePrices: { UDOW: 72.10 },
      nowMs: RTH.getTime(),
    });
    expect(out.planned).toHaveLength(0);
    expect(out.skipped[0].skip).toBe("already_mirrored");
  });
});

describe("runTraderEntryCatchup", () => {
  beforeEach(() => {
    forwardMock.mockReset();
    itMirrorMock.mockReset();
    forwardMock.mockResolvedValue({ ok: true, response: { ok: true, order_id: "WB-9" } });
    itMirrorMock.mockResolvedValue({ skipped: false, fired: { ok: true, order_id: "WB-IT" } });
  });

  it("hours lookback drops stale August leftovers", async () => {
    const stale = {
      trade_id: "UNP-old",
      ticker: "UNP",
      direction: "LONG",
      shares: 22,
      entry_price: 294.94,
      entry_ts: Date.parse("2026-08-14T18:04:07Z"),
      status: "OPEN",
    };
    const out = await runTraderEntryCatchup({}, {
      dry_run: true,
      hours: 24,
      now: RTH,
      trades: [TJX, stale],
      index_trend_books: [UDOW_BOOK],
      ring: [],
      livePrices: { TJX: 131.80, UDOW: 72.10, UNP: 288 },
    });
    expect(out.results.map((r) => r.ticker).sort()).toEqual(["TJX", "UDOW"]);
    expect(out.results.some((r) => r.ticker === "UNP")).toBe(false);
  });

  it("dry_run lists TJX + UDOW and does not forward", async () => {
    const out = await runTraderEntryCatchup({}, {
      dry_run: true,
      now: RTH,
      trades: [TJX, NKE],
      index_trend_books: [UDOW_BOOK],
      ring: [{
        trade_id: TJX.trade_id,
        side: "buy",
        status: "ok",
        http_status: 200,
      }],
      livePrices: { TJX: 131.80, UDOW: 72.10, NKE: 38.2 },
    });
    expect(out.dry_run).toBe(true);
    expect(out.results.map((r) => r.ticker).sort()).toEqual(["TJX", "UDOW"]);
    expect(forwardMock).not.toHaveBeenCalled();
    expect(itMirrorMock).not.toHaveBeenCalled();
  });

  it("forwards equity + index-trend during RTH", async () => {
    const out = await runTraderEntryCatchup({ ADMIN_EMAIL: "op@x.com" }, {
      dry_run: false,
      now: RTH,
      trades: [TJX],
      index_trend_books: [UDOW_BOOK],
      ring: [],
      livePrices: { TJX: 131.80, UDOW: 72.10 },
    });
    expect(out.forwarded).toBe(2);
    expect(forwardMock).toHaveBeenCalledTimes(1);
    expect(forwardMock.mock.calls[0][1].ticker).toBe("TJX");
    expect(forwardMock.mock.calls[0][1].client_order_id).toMatch(/^ttcu/);
    expect(itMirrorMock).toHaveBeenCalledTimes(1);
    expect(itMirrorMock.mock.calls[0][1].catch_up).toBe(true);
    expect(itMirrorMock.mock.calls[0][1].letf_ticker).toBe("UDOW");
  });

  it("skips outside RTH unless force", async () => {
    const out = await runTraderEntryCatchup({}, {
      dry_run: false,
      now: new Date("2026-09-03T18:10:00-04:00"),
      trades: [TJX],
      index_trend_books: [],
      ring: [],
      livePrices: { TJX: 131.80 },
    });
    expect(out.skipped).toBe("not_rth");
    expect(forwardMock).not.toHaveBeenCalled();
  });
});
