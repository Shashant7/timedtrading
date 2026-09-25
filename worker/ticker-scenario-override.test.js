// worker/ticker-scenario-override.test.js
//
// The day-trade clock hands `buildTickerScenario` a minute-fresh score as
// `latestOverride`, so the lean is built from the same tape as the live spot
// without that score ever being written over the shared `timed:latest`.

import { describe, it, expect } from "vitest";
import { buildTickerScenario } from "./ticker-scenario.js";
import { d1Sqlite } from "./test-support/d1-sqlite.js";

async function envWithDailies() {
  const DB = d1Sqlite();
  await DB.prepare("CREATE TABLE ticker_candles (ticker TEXT, tf TEXT, ts INTEGER, o REAL, h REAL, l REAL, c REAL)").run();
  const day = 86400000;
  for (let i = 0; i < 30; i++) {
    const c = 700 + i;
    await DB.prepare("INSERT INTO ticker_candles VALUES ('QQQ', 'D', ?1, ?2, ?3, ?4, ?5)")
      .bind(Date.UTC(2026, 7, 1) + i * day, c - 1, c + 2, c - 3, c).run();
  }
  const reads = [];
  const KV_TIMED = {
    async get(k) { reads.push(k); return null; },
    async put() {},
  };
  return { DB, KV_TIMED, reads };
}

describe("buildTickerScenario latestOverride", () => {
  it("builds from the override instead of the shared snapshot", async () => {
    const env = await envWithDailies();
    const fresh = { ticker: "QQQ", price: 729, prev_close: 728, state: "HTF_BULL_LTF_BULL", htf_score: 30, ltf_score: 18 };
    const out = await buildTickerScenario(env, "QQQ", { priceOverride: 729.4, latestOverride: fresh });
    expect(out).toBeTruthy();
    expect(out.error).not.toBe("insufficient_data");
    expect(env.reads.some((k) => k === "timed:latest:QQQ")).toBe(false);
  });

  it("still reads the shared snapshot when no override is given", async () => {
    const env = await envWithDailies();
    const out = await buildTickerScenario(env, "QQQ", { priceOverride: 729.4 });
    expect(env.reads.some((k) => k === "timed:latest:QQQ")).toBe(true);
    // The shared snapshot is empty here, so without an override there is nothing to build from.
    expect(out.error).toBe("insufficient_data");
  });
});
