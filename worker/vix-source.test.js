import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  VIX_VX1_FRESH_MS,
  isVx1Fresh,
  applyVixToPrices,
  loadHistoricalVixSeries,
  resolveHistoricalVixAtTs,
  resolveVixLevel,
  syncVixLatestStub,
} from "./vix-source.js";

describe("vix-source", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats VX1! as fresh within 10 minutes", () => {
    const now = Date.now();
    expect(isVx1Fresh({ price: 18.5, ts: now - 5 * 60 * 1000 }, now)).toBe(true);
    expect(isVx1Fresh({ price: 18.5, ts: now - 11 * 60 * 1000 }, now)).toBe(false);
  });

  it("prefers fresh VX1! over Yahoo", async () => {
    const now = Date.now();
    const env = { KV_TIMED: {} };
    const prices = {
      "VX1!": { p: 19.2, pc: 18.8, t: now - 60 * 1000 },
    };
    const resolved = await resolveVixLevel(env, { prices, nowMs: now });
    expect(resolved.ok).toBe(true);
    expect(resolved.source).toBe("VX1!");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back to Yahoo when VX1! is stale", async () => {
    const now = Date.now();
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        chart: {
          result: [{
            meta: {
              regularMarketPrice: 21.45,
              chartPreviousClose: 20.1,
            },
          }],
        },
      }),
    });
    const env = { KV_TIMED: { get: vi.fn(), put: vi.fn() } };
    const prices = {
      "VX1!": { p: 19.2, pc: 18.8, t: now - VIX_VX1_FRESH_MS - 1000 },
    };
    const resolved = await resolveVixLevel(env, { prices, nowMs: now });
    expect(resolved.ok).toBe(true);
    expect(resolved.source).toBe("yahoo_vix");
    expect(resolved.price).toBe(21.45);
  });

  it("writes canonical VIX row into prices map", () => {
    const prices = {};
    applyVixToPrices(prices, {
      ok: true,
      price: 22.5,
      prev_close: 21.0,
      ts: 1_700_000_000_000,
      source: "yahoo_vix",
    });
    expect(prices.VIX.p).toBe(22.5);
    expect(prices.VIX.pc).toBe(21);
    expect(prices.VIX._macro_source).toBe("yahoo_vix");
  });

  it("syncs timed:latest:VIX from resolved level", async () => {
    const puts = [];
    const KV = {};
    const putJson = async (_kv, key, val) => { puts.push({ key, val }); };
    const getJson = async () => null;
    const result = await syncVixLatestStub(KV, {
      ok: true,
      price: 17.8,
      prev_close: 17.2,
      ts: 1_700_000_000_000,
      source: "VX1!",
      _via: "prices",
    }, getJson, putJson);
    expect(result.synced).toBe(true);
    expect(puts[0].key).toBe("timed:latest:VIX");
    expect(puts[0].val.price).toBe(17.8);
    expect(puts[0].val._macro_source).toBe("VX1!");
  });

  it("uses recorded entry VIX before Market Pulse history", () => {
    const entryTs = Date.parse("2026-07-10T16:00:00Z");
    const result = resolveHistoricalVixAtTs(entryTs, {
      snapshots: [{ ts: entryTs, level: 21.5, source: "market_pulse_snapshot" }],
      candles: [{ ts: entryTs, level: 22.1, source: "vx1_daily" }],
    }, 19.8);
    expect(result).toEqual({ level: 19.8, source: "entry_lineage" });
  });

  it("uses the Market Pulse snapshot before VX1! history", () => {
    const entryTs = Date.parse("2026-07-10T16:00:00Z");
    const result = resolveHistoricalVixAtTs(entryTs, {
      snapshots: [{ ts: entryTs - 4 * 60 * 60 * 1000, level: 20.4, source: "market_pulse_snapshot" }],
      candles: [{ ts: entryTs, level: 22.1, source: "vx1_daily" }],
    });
    expect(result).toEqual({ level: 20.4, source: "market_pulse_snapshot" });
  });

  it("loads canonical snapshot and VX1! history without VIXY", async () => {
    const db = {
      prepare(sql) {
        return {
          all: async () => sql.includes("daily_market_snapshots")
            ? { results: [{ date: "2026-07-10", vix_close: 20.4 }] }
            : { results: [{ ticker: "VX1!", ts: Date.parse("2026-07-09T20:00:00Z"), c: 21.2 }] },
        };
      },
    };
    const series = await loadHistoricalVixSeries(db);
    expect(series.snapshots[0].level).toBe(20.4);
    expect(series.candles[0]).toMatchObject({ level: 21.2, source: "vx1_daily" });
  });
});
