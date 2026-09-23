// worker/candle-chain-feed-batch.js
//
// One sub-batch of the candle-chain DO feed: turn a sub-batch of Alpaca bars
// into candles and push each ticker to its shard.
//
// Extracted from `_feedCandleChainDO` so the two properties that matter here
// are testable, because neither is visible from the call site:
//
//   1. The pushes run CONCURRENTLY. They used to go one DO round trip at a
//      time, and 298 tickers at ~240ms each is most of the 132-312s a pass
//      measured on 2026-09-23. A pass that outruns its own 60-second cadence
//      overlaps itself, and since the 128 MB memory limit is per-ISOLATE
//      rather than per-invocation, three to five overlapping passes killed the
//      isolate and everything else resident in it.
//   2. One bad ticker costs only itself. This is the same reason the caller
//      fetches in independent sub-batches: a symbol Alpaca rejects, or a shard
//      that throws, must not take the rest of the sub-batch with it.

/**
 * Push one sub-batch of tickers to their candle-chain shards.
 *
 * @param {string[]} sub          Tickers in this sub-batch.
 * @param {object}   barsBySym    Raw Alpaca bars keyed by ticker.
 * @param {object}   deps
 * @param {Function} deps.toCandle  Raw Alpaca bar -> candle-ish object.
 * @param {Function} deps.stubFor   Ticker -> DO stub (or null when unbound).
 * @returns {Promise<{fed:number, empty:number, errors:number}>}
 */
export async function ingestChainSubBatch(sub, barsBySym, deps = {}) {
  const { toCandle, stubFor } = deps;
  const tickers = Array.isArray(sub) ? sub : [];
  let fed = 0;
  let empty = 0;
  let errors = 0;

  // `Promise.all` and not a serial loop — see (1) above. Width is the caller's
  // sub-batch size, and the tickers spread over the shard count, each shard
  // serializing its own writes the way a Durable Object always does.
  await Promise.all(tickers.map(async (ticker) => {
    try {
      const raw = (barsBySym && barsBySym[ticker]) || [];
      const bars = raw.map(toCandle)
        .filter((c) => c && Number.isFinite(c.ts) && Number.isFinite(c.o))
        .map((c) => ({ ts: c.ts, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v != null ? c.v : null }));
      // No bars is the normal state for a thin symbol in a 30-minute window,
      // so it is counted rather than treated as a failure.
      if (bars.length === 0) { empty++; return; }
      const stub = stubFor(ticker);
      if (!stub) return;
      await stub.fetch(new Request("https://do/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticker, tf: "5", bars }),
      }));
      fed++;
    } catch (_) { errors++; }
  }));

  return { fed, empty, errors };
}
