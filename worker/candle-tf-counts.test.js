import { describe, it, expect } from "vitest";
import {
  CANDLE_TF_COUNTS_KEY,
  CANDLE_TF_COUNTS_SQL,
  rowsToTickerTfCounts,
  loadCandleTfCounts,
  bustCandleTfCountsCache,
} from "./candle-tf-counts.js";

function makeEnv({ rows = [], kvSeed = null } = {}) {
  let prepares = 0;
  const kv = new Map();
  if (kvSeed) kv.set(CANDLE_TF_COUNTS_KEY, JSON.stringify(kvSeed));
  return {
    prepares: () => prepares,
    env: {
      DB: {
        prepare(sql) {
          expect(sql).toBe(CANDLE_TF_COUNTS_SQL);
          prepares += 1;
          return {
            async all() { return { results: rows }; },
          };
        },
      },
      KV_TIMED: {
        async get(k, type) {
          if (!kv.has(k)) return null;
          return type === "json" ? JSON.parse(kv.get(k)) : kv.get(k);
        },
        async put(k, v) { kv.set(k, v); },
        async delete(k) { kv.delete(k); },
      },
    },
    kv,
  };
}

describe("loadCandleTfCounts", () => {
  it("scans D1 once and serves the next call from KV", async () => {
    const { env, prepares } = makeEnv({
      rows: [
        { ticker: "twlo", tf: "D", cnt: 250 },
        { ticker: "TWLO", tf: "60", cnt: 300 },
      ],
    });
    const first = await loadCandleTfCounts(env, { now: 1_000_000 });
    expect(first.source).toBe("d1");
    expect(first.byTicker.TWLO.D).toBe(250);
    expect(first.byTicker.TWLO["60"]).toBe(300);
    expect(prepares()).toBe(1);

    const second = await loadCandleTfCounts(env, { now: 1_000_000 + 10_000 });
    expect(second.source).toBe("kv");
    expect(second.byTicker.TWLO.D).toBe(250);
    expect(prepares()).toBe(1);
  });

  it("rescans after TTL and after an explicit bust", async () => {
    const { env, prepares } = makeEnv({
      rows: [{ ticker: "SPY", tf: "D", cnt: 400 }],
    });
    await loadCandleTfCounts(env, { now: 1_000_000 });
    const stale = await loadCandleTfCounts(env, { now: 1_000_000 + 3600_000 + 1 });
    expect(stale.source).toBe("d1");
    expect(prepares()).toBe(2);

    await bustCandleTfCountsCache(env);
    const forced = await loadCandleTfCounts(env, { now: 1_000_000 + 3600_000 + 5 });
    expect(forced.source).toBe("d1");
    expect(prepares()).toBe(3);
  });
});

describe("rowsToTickerTfCounts", () => {
  it("uppercases tickers and ignores blanks", () => {
    expect(rowsToTickerTfCounts([
      { ticker: "iwm", tf: "D", cnt: "12" },
      { ticker: "", tf: "D", cnt: 9 },
    ])).toEqual({ IWM: { D: 12 } });
  });
});
