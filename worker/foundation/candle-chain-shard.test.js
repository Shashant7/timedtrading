// worker/foundation/candle-chain-shard.test.js
import { describe, it, expect } from "vitest";
import { CandleChainShardCore, shardForTicker } from "./candle-chain-shard.js";
import { expectedIntradayBuckets, sessionBoundsUtc } from "./trading-calendar.js";

function memStorage() {
  const m = new Map();
  return {
    _m: m,
    async get(k) { return m.get(k); },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list(prefix) { const r = new Map(); for (const [k, v] of m) if (k.startsWith(prefix)) r.set(k, v); return r; },
  };
}
function session5m(dateStr) {
  return expectedIntradayBuckets(dateStr, 5).map((ts, i) => ({ ts, o: 100 + i, h: 100 + i + 0.5, l: 100 + i - 0.5, c: 100 + i + 0.2, v: 10 }));
}

describe("shard assignment", () => {
  it("is deterministic and within range", () => {
    expect(shardForTicker("AAPL", 16)).toBe(shardForTicker("aapl", 16));
    for (const t of ["AAPL", "MU", "GS", "TSLA", "XLE"]) {
      const s = shardForTicker(t, 16);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(16);
    }
  });
  it("spreads a universe across shards (not all in one)", () => {
    const universe = ["AA","AAPL","CLS","FSLR","GS","MU","NFLX","SNDK","TSLA","XLE","DE","TT","OKE","PWR","NXT","BG"];
    const used = new Set(universe.map((t) => shardForTicker(t, 8)));
    expect(used.size).toBeGreaterThan(1);
  });
});

describe("shard core: ingest + derive", () => {
  const DAY = "2026-06-12";
  const { openMs, closeMs } = sessionBoundsUtc(DAY);

  it("ingests 5m chunked by session and derives a complete 30m view", async () => {
    const core = new CandleChainShardCore(memStorage());
    await core.ingest("AAPL", "5", session5m(DAY));
    // stored as one session chunk
    expect((await core.storage.list("b5:AAPL:")).size).toBe(1);

    const v = await core.getSeries("AAPL", "30", { startMs: openMs, endMs: closeMs, asOf: closeMs });
    expect(v.tf).toBe("30");
    expect(v.bars.length).toBe(13);
    expect(v.complete).toBe(true);
  });

  it("ingest is idempotent (re-ingest same bars → same base length)", async () => {
    const core = new CandleChainShardCore(memStorage());
    await core.ingest("MU", "5", session5m(DAY));
    await core.ingest("MU", "5", session5m(DAY));
    const base = await core.loadBase5("MU", openMs, closeMs);
    expect(base.length).toBe(78);
  });

  it("integrity flags a missing 5m bucket as a heal range", async () => {
    const core = new CandleChainShardCore(memStorage());
    const bars = session5m(DAY).filter((b, i) => i !== 20);
    await core.ingest("GS", "5", bars);
    const integ = await core.integrity("GS", { startMs: openMs, endMs: closeMs });
    expect(integ.complete).toBe(false);
    expect(integ.healRanges.length).toBe(1);
  });

  it("derives D/W/M from the stored daily base", async () => {
    const core = new CandleChainShardCore(memStorage());
    const daily = Array.from({ length: 40 }, (_, d) => ({ ts: Date.UTC(2026, 2, 16, 13, 30) + d * 7 * 86400000, o: d, h: d + 1, l: d - 1, c: d, v: 1 }));
    await core.ingest("TSLA", "D", daily);
    const vd = await core.getSeries("TSLA", "D", { startMs: daily[0].ts, endMs: daily[daily.length - 1].ts + 1, asOf: Date.now() });
    expect(vd.bars.length).toBe(40);
  });

  it("listTickers returns held tickers", async () => {
    const core = new CandleChainShardCore(memStorage());
    await core.ingest("AAPL", "5", session5m(DAY));
    await core.ingest("MU", "5", session5m(DAY));
    expect(await core.listTickers()).toEqual(["AAPL", "MU"]);
  });
});

describe("shard core: bounded retention", () => {
  it("drops session chunks older than the hot window", async () => {
    const core = new CandleChainShardCore(memStorage(), { retentionTradingDays: 5 });
    await core.ingest("AAPL", "5", session5m("2026-01-05")); // old
    await core.ingest("AAPL", "5", session5m("2026-06-12")); // recent
    expect((await core.storage.list("b5:AAPL:")).size).toBe(2);
    const res = await core.retentionSweep("AAPL", sessionBoundsUtc("2026-06-12").closeMs);
    expect(res.dropped.length).toBe(1);
    expect(res.dropped[0]).toContain("2026-01-05");
    expect((await core.storage.list("b5:AAPL:")).size).toBe(1);
  });
});
