// worker/candle-chain-feed-batch.test.js
//
// 2026-09-23 — `timed-trading-ingest` (the monolith) failed its RTH crons with
// `exceededMemory` all morning. Reading the raw outcome counts said 18 kills in
// two hours across two crons, which is the wrong shape entirely. Grouping the
// kills by their END instant instead says six:
//
//   isolate teardown at 16:05:05 killed 6 resident invocation(s):
//       */5  sched 15:55:54  wall=552s
//       */1  sched 15:59:54  wall=312s
//       */5  sched 16:00:54  wall=242s
//       */1  sched 16:01:54  wall=192s
//       */1  sched 16:02:54  wall=132s
//       */1  sched 16:03:54  wall=72s
//   isolate teardown at 16:52:10 killed 5 resident invocation(s): ...
//
// The 128 MB limit is per-ISOLATE, so a teardown kills every invocation
// resident in it at the same instant. Most of those 18 were collateral — a
// `*/1` tick with 116ms of CPU allocated essentially nothing.
//
// What was actually over budget: the candle-chain DO feed. Since tt-feed took
// the price feed off the monolith, it is the whole cost of the `*/1` lane, and
// it ran 132-312s against a 60-second cadence with no overlap guard, so three
// to five passes were always resident, each with its own parse of the 2 MB
// universe index. Its own log proves the duplication — two passes 30 seconds
// apart both reporting the same full sweep:
//
//   16:56:02.530  */1  [CHAIN-DO-FEED] {"fed":298,"empty":30,"universe":328}
//   16:56:32.439  */1  [CHAIN-DO-FEED] {"fed":298,"empty":30,"universe":328}
//
// Two fixes, both covered here: the pushes run concurrently so a pass fits
// inside its cadence, and a per-isolate lease collapses whatever still
// overlaps.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ingestChainSubBatch } from "./candle-chain-feed-batch.js";

const root = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(root, "index.js"), "utf8");

const toCandle = (b) => b;
const bar = (ts) => ({ ts, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 });

/**
 * A fake shard that records how many pushes are in flight at once, so
 * concurrency is asserted rather than assumed.
 */
function makeShards({ failOn = new Set(), delayMs = 0 } = {}) {
  const state = { inFlight: 0, maxInFlight: 0, seen: [], bodies: [] };
  const stubFor = (ticker) => ({
    fetch: async (req) => {
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        if (failOn.has(ticker)) throw new Error(`shard refused ${ticker}`);
        state.seen.push(ticker);
        state.bodies.push(JSON.parse(await req.text()));
        return new Response("{}");
      } finally {
        state.inFlight--;
      }
    },
  });
  return { state, stubFor };
}

describe("the chain sub-batch pushes concurrently", () => {
  it("has more than one push in flight at a time", async () => {
    const sub = Array.from({ length: 25 }, (_, i) => `T${String(i).padStart(3, "0")}`);
    const barsBySym = {};
    for (const t of sub) barsBySym[t] = [bar(1), bar(2)];
    const { state, stubFor } = makeShards({ delayMs: 5 });

    const r = await ingestChainSubBatch(sub, barsBySym, { toCandle, stubFor });

    expect(r).toEqual({ fed: 25, empty: 0, errors: 0 });
    // Serial would be exactly 1. This is the regression that matters: the
    // whole point is that 298 tickers stop costing 298 sequential round trips.
    expect(state.maxInFlight).toBe(25);
  });

  it("still feeds every ticker in the sub-batch", async () => {
    const sub = ["AAPL", "MSFT", "NVDA"];
    const barsBySym = { AAPL: [bar(1)], MSFT: [bar(1)], NVDA: [bar(1)] };
    const { state, stubFor } = makeShards();

    const r = await ingestChainSubBatch(sub, barsBySym, { toCandle, stubFor });

    expect(r.fed).toBe(3);
    expect(state.seen.slice().sort()).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  it("sends each ticker its own bars, tagged tf=5", async () => {
    const sub = ["AAPL", "MSFT"];
    const barsBySym = { AAPL: [bar(11), bar(12)], MSFT: [bar(21)] };
    const { state, stubFor } = makeShards();

    await ingestChainSubBatch(sub, barsBySym, { toCandle, stubFor });

    const byTicker = Object.fromEntries(state.bodies.map((b) => [b.ticker, b]));
    expect(byTicker.AAPL.tf).toBe("5");
    expect(byTicker.AAPL.bars.map((b) => b.ts)).toEqual([11, 12]);
    expect(byTicker.MSFT.bars.map((b) => b.ts)).toEqual([21]);
  });
});

describe("one bad ticker costs only itself", () => {
  it("feeds the rest of the sub-batch when a shard throws", async () => {
    const sub = ["AAPL", "BROKEN", "NVDA"];
    const barsBySym = { AAPL: [bar(1)], BROKEN: [bar(1)], NVDA: [bar(1)] };
    const { state, stubFor } = makeShards({ failOn: new Set(["BROKEN"]) });

    const r = await ingestChainSubBatch(sub, barsBySym, { toCandle, stubFor });

    expect(r).toEqual({ fed: 2, empty: 0, errors: 1 });
    expect(state.seen.slice().sort()).toEqual(["AAPL", "NVDA"]);
  });

  it("counts a ticker with no bars as empty, not as an error", async () => {
    const sub = ["AAPL", "THIN"];
    const barsBySym = { AAPL: [bar(1)], THIN: [] };
    const { stubFor } = makeShards();

    const r = await ingestChainSubBatch(sub, barsBySym, { toCandle, stubFor });

    expect(r).toEqual({ fed: 1, empty: 1, errors: 0 });
  });

  it("drops unusable bars and reports the ticker empty rather than feeding junk", async () => {
    const sub = ["JUNK"];
    const barsBySym = { JUNK: [{ ts: null, o: 1 }, { ts: 5, o: undefined }] };
    const { state, stubFor } = makeShards();

    const r = await ingestChainSubBatch(sub, barsBySym, { toCandle, stubFor });

    expect(r).toEqual({ fed: 0, empty: 1, errors: 0 });
    expect(state.seen).toEqual([]);
  });

  it("skips a ticker whose shard binding is absent without counting an error", async () => {
    const sub = ["AAPL", "UNBOUND"];
    const barsBySym = { AAPL: [bar(1)], UNBOUND: [bar(1)] };
    const { state } = makeShards();
    const r = await ingestChainSubBatch(sub, barsBySym, {
      toCandle,
      stubFor: (t) => (t === "UNBOUND" ? null : makeShards().stubFor(t)),
    });

    expect(r).toEqual({ fed: 1, empty: 0, errors: 0 });
    expect(state.seen).toEqual([]);
  });

  it("handles an absent or empty sub-batch", async () => {
    const { stubFor } = makeShards();
    expect(await ingestChainSubBatch([], {}, { toCandle, stubFor }))
      .toEqual({ fed: 0, empty: 0, errors: 0 });
    expect(await ingestChainSubBatch(undefined, undefined, { toCandle, stubFor }))
      .toEqual({ fed: 0, empty: 0, errors: 0 });
  });
});

describe("the */1 chain feed holds a per-isolate lease", () => {
  // Source-asserted, like the rest of the isolate-kill fixes: the runtime
  // tears the isolate down outright, so no harness can stage the failure.
  it("uses the same lease shape as the bar cron", () => {
    expect(src).toContain("let _chainFeedSince = 0;");
    expect(src).toContain("const CHAIN_FEED_LEASE_MS = 4 * 60 * 1000;");
    expect(src).toContain("const _cfAge = _chainFeedSince ? Date.now() - _chainFeedSince : 0;");
    expect(src).toContain("if (_chainFeedSince && _cfAge < CHAIN_FEED_LEASE_MS) {");
  });

  it("claims before dispatching and releases in a finally", () => {
    const claim = src.indexOf("_chainFeedSince = Date.now();");
    const dispatch = src.indexOf("const r = await _feedCandleChainDO(env, [..._set]);");
    const release = src.indexOf("_chainFeedSince = 0;", claim);
    expect(claim).toBeGreaterThan(0);
    expect(dispatch).toBeGreaterThan(claim);
    expect(release).toBeGreaterThan(dispatch);
    // The release has to be unconditional — a pass that throws must not wedge
    // the lane until the lease expires.
    expect(src.slice(dispatch, release + 40)).toContain("} finally {");
  });

  it("logs the skip and the expiry so a wedged lane is visible", () => {
    expect(src).toContain("[CHAIN-DO-FEED] skipped: the previous pass has been running");
    expect(src).toContain("[CHAIN-DO-FEED] lease expired after");
  });

  it("times the pass, so the cadence it has to fit inside is measurable", () => {
    expect(src).toContain("const _cfStart = Date.now();");
    expect(src).toContain("in ${Date.now() - _cfStart}ms`");
  });

  it("leaves the lease long enough for a healthy pass and short enough to self-heal", () => {
    const m = src.match(/const CHAIN_FEED_LEASE_MS = (\d+) \* 60 \* 1000;/);
    expect(m).toBeTruthy();
    const minutes = Number(m[1]);
    // Longer than the worst observed pass (312s) so a healthy one never trips
    // it; short enough that a holder which dies without releasing costs a few
    // ticks rather than the rest of the session.
    expect(minutes).toBeGreaterThanOrEqual(4);
    expect(minutes).toBeLessThanOrEqual(10);
  });

  it("delegates the sub-batch push instead of looping serially", () => {
    expect(src).toContain('import { ingestChainSubBatch } from "./candle-chain-feed-batch.js";');
    expect(src).toContain("const _sb = await ingestChainSubBatch(sub, barsBySym, {");
    // The serial loop this replaced.
    expect(src).not.toContain("for (const ticker of sub) {");
  });
});
