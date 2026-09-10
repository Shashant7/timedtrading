import { describe, it, expect, vi, beforeEach } from "vitest";
import { maybeNotifyIndexTrendPaperEvent, finalizeIndexTrendPaperClose } from "./index-trend-alerts.js";
import { notifyDiscord } from "./alerts.js";

vi.mock("./alerts.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    notifyDiscord: vi.fn(async () => ({ ok: true })),
  };
});

function envWithStore(seed = {}) {
  const store = { ...seed };
  return {
    KV_TIMED: {
      get: async (k) => (store[k] == null ? null : store[k]),
      put: async (k, v) => { store[k] = v; },
      delete: async (k) => { delete store[k]; },
    },
    store,
  };
}

const RTH = Date.UTC(2026, 8, 10, 14, 30, 0); // 10:30 ET

describe("index-trend pending close", () => {
  beforeEach(() => {
    notifyDiscord.mockClear();
  });

  it("persists pending_close and does not Discord until finalize", async () => {
    const env = envWithStore();
    const book = {
      status: "open",
      direction: "LONG",
      entry_underlying_price: 640,
      entry_letf_price: 120,
      stop_underlying: 628,
      shares: 5,
      shares_remaining: 5,
      trims_fired: [],
      peak_underlying_r: 0,
    };
    const ev = await maybeNotifyIndexTrendPaperEvent(env, {
      signal_id: "it:SPY:SPYU:LONG:2026-W37",
      underlying: "SPY",
      letf_ticker: "SPYU",
      direction: "LONG",
      letf_price: 110,
      underlying_price: 627,
      management: { stop_underlying: 628 },
      now: RTH,
      loadedBook: { book, bookKey: "timed:idx-trend-book:it:SPY:SPYU:LONG:2026-W37" },
    });
    expect(ev.event).toBe("STOP");
    expect(ev.pending_close).toBe(true);
    expect(notifyDiscord).not.toHaveBeenCalled();
    const persisted = JSON.parse(env.store["timed:idx-trend-book:it:SPY:SPYU:LONG:2026-W37"]);
    expect(persisted.status).toBe("pending_close");
    expect(persisted.shares_remaining).toBe(5);

    const fin = await finalizeIndexTrendPaperClose(env, {
      signal_id: "it:SPY:SPYU:LONG:2026-W37",
      letf_ticker: "SPYU",
      event: "STOP",
      reason: "underlying_invalidation",
      book: persisted,
      letf_price: 110,
      underlying_price: 627,
      now: RTH,
    });
    expect(fin.book.status).toBe("closed");
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
  });
});
