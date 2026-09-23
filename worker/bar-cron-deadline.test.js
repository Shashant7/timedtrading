// worker/bar-cron-deadline.test.js
//
// 2026-09-23 — the monolith's `*/5` bar pass had always been over the wall at
// the top of the hour and nobody had multiplied out its own tier arithmetic:
//
//   10/15/30, full ~383-symbol universe   48 batches x 2.5s x 3 TFs  = 360s
//   5m, half slice, deliberate 8s pacing  24 batches x 8s            = 190s
//   60/240, half slice                    24 batches x 2.5s x 2      = 120s
//   D/W/M, full universe, top-of-hour     48 batches x 2.5s x 3 TFs  = 360s
//
// ~670s off-hour, which is exactly what production ran (677s, 694s, 702s,
// 707s, 714s), and ~1030s at the top of the hour against a hard 900s cron
// wall. `*/5 sched 17:00:54 ... exceededWallTime wall=900s`.
//
// Being killed there is worse than stopping, twice over: the tail tier's
// upserts are lost anyway, and the kill takes the ISOLATE with every other
// invocation resident in it — which is how a paced bar pass ends up showing
// as `exceededMemory` on an unrelated `*/1` tick.
//
// So the pass stops itself now. The tier order was already chosen for this
// (5m last, because the WS stream covers it), so a deadline drops the tier
// that was designed to be droppable.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tdFetchTimeSeries } from "./twelvedata.js";

const root = dirname(fileURLToPath(import.meta.url));
const providerSrc = readFileSync(join(root, "data-provider.js"), "utf8");
const indexSrc = readFileSync(join(root, "index.js"), "utf8");

const env = { TWELVEDATA_API_KEY: "test-key" };
const syms = (n) => Array.from({ length: n }, (_, i) => `T${String(i).padStart(3, "0")}`);
// Pacing cannot be switched off: `Number(opts.batchDelayMs) || 8000` reads a
// literal 0 as absent and falls back to the 8s default. Pass 1, not 0.
const FAST = 1;

/** One TD time_series response covering whatever symbols were asked for. */
function stubTd() {
  return vi.fn(async (url) => {
    const asked = new URL(url).searchParams.get("symbol").split(",");
    const body = {};
    for (const s of asked) body[s] = { values: [{ datetime: "2026-09-23 12:00:00", open: "1", high: "2", low: "0.5", close: "1.5", volume: "10" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("a paced bar fetch stops at the caller's deadline", () => {
  it("fetches everything when the deadline is comfortable", async () => {
    vi.stubGlobal("fetch", stubTd());
    const r = await tdFetchTimeSeries(env, syms(24), "5min", "2026-09-23T10:00:00Z", null, 5000, {
      batchDelayMs: FAST,
      deadlineMs: Date.now() + 60_000,
    });
    expect(r.stoppedAtDeadline).toBe(false);
    expect(r.batchesDone).toBe(3); // 24 symbols at BATCH=8
    expect(r.batchesTotal).toBe(3);
    expect(Object.keys(r.bars)).toHaveLength(24);
    vi.unstubAllGlobals();
  });

  it("stops between batches once the deadline has passed, keeping what it fetched", async () => {
    vi.stubGlobal("fetch", stubTd());
    // 10ms of pacing per batch and a 25ms budget: the first batch or two land,
    // the rest do not.
    const r = await tdFetchTimeSeries(env, syms(80), "5min", "2026-09-23T10:00:00Z", null, 5000, {
      batchDelayMs: 10,
      deadlineMs: Date.now() + 25,
    });
    expect(r.stoppedAtDeadline).toBe(true);
    expect(r.batchesTotal).toBe(10);
    expect(r.batchesDone).toBeGreaterThan(0);
    expect(r.batchesDone).toBeLessThan(10);
    // The bars already paid for come back rather than being thrown away.
    expect(Object.keys(r.bars).length).toBe(r.batchesDone * 8);
    vi.unstubAllGlobals();
  });

  it("stops before the first batch when the deadline is already gone", async () => {
    const td = stubTd();
    vi.stubGlobal("fetch", td);
    const r = await tdFetchTimeSeries(env, syms(80), "5min", "2026-09-23T10:00:00Z", null, 5000, {
      batchDelayMs: FAST,
      deadlineMs: Date.now() - 1,
    });
    expect(r.stoppedAtDeadline).toBe(true);
    expect(r.batchesDone).toBe(0);
    expect(td).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("is unbounded when no deadline is given, so every other caller is unchanged", async () => {
    vi.stubGlobal("fetch", stubTd());
    const r = await tdFetchTimeSeries(env, syms(40), "5min", "2026-09-23T10:00:00Z", null, 5000, {
      batchDelayMs: FAST,
    });
    expect(r.stoppedAtDeadline).toBe(false);
    expect(r.batchesDone).toBe(5);
    expect(Object.keys(r.bars)).toHaveLength(40);
    vi.unstubAllGlobals();
  });
});

describe("the deadline does not turn into an unbounded per-symbol heal", () => {
  it("skips the Alpaca fallback on a short fetch", () => {
    // The fallback reads "no bars for this symbol" as "TwelveData dropped it"
    // and retries ONE AT A TIME. After a deadlined stop most of the universe
    // has no bars, so running it would replace a bounded stop with a longer
    // unbounded loop past the same deadline.
    const fn = providerSrc.slice(
      providerSrc.indexOf("export async function fetchAllBars("),
      providerSrc.indexOf("// _withAlpacaBarsFallback"),
    );
    expect(fn).toContain("if (tdResult?.stoppedAtDeadline) return tdResult;");
    const guard = fn.indexOf("stoppedAtDeadline");
    const call = fn.indexOf("_withAlpacaBarsFallback(env, tdResult");
    expect(guard).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(guard);
  });

  it("propagates the stop out of the chunked path instead of re-entering it", () => {
    const fn = providerSrc.slice(
      providerSrc.indexOf("async function _tdFetchBarsChunked("),
      providerSrc.indexOf("async function _tdFetchBars("),
    );
    expect(fn).toContain("if (raw.stoppedAtDeadline) { stoppedAtDeadline = true; break; }");
    expect(fn).toContain("return { bars: allBars, stoppedAtDeadline };");
  });

  it("keeps the flag through the 10m aggregation path", () => {
    expect(providerSrc).toContain("return { bars, stoppedAtDeadline: raw.stoppedAtDeadline };");
  });
});

describe("cronFetchLatest budgets the whole pass", () => {
  it("takes a deadline and does not start a tier there is no time for", () => {
    expect(providerSrc).toContain("export async function cronFetchLatest(env, allTickers, opts = {}) {");
    expect(providerSrc).toContain("const _deadlineMs = Number(opts.deadlineMs) || 0;");
    expect(providerSrc).toContain("if (_timeLeft() <= 0) { _skippedTfs.push(tf); continue; }");
  });

  it("still upserts the bars a short tier did fetch", () => {
    const fn = providerSrc.slice(providerSrc.indexOf("const runTfBatch = async ("));
    const stop = fn.indexOf("result.stoppedAtDeadline");
    const upsert = fn.indexOf("_batchUpsertBars(db, result.bars, tf)");
    expect(stop).toBeGreaterThan(0);
    // The upsert comes AFTER the stop is noted, not instead of it.
    expect(upsert).toBeGreaterThan(stop);
  });

  it("reports what it cut off rather than returning a silent partial", () => {
    expect(providerSrc).toContain("[TD CRON] stopped at the tick deadline");
    expect(providerSrc).toContain("stoppedAtDeadline: Boolean(_stoppedTf) || _skippedTfs.length > 0,");
    expect(providerSrc).toContain("skippedTfs: _skippedTfs,");
  });

  it("does not record a deadlined pass as a healthy aggregated pass", () => {
    // Otherwise the top-of-hour freshness check reads green while D/W/M went
    // unfetched — the exact class of "every check healthy, data stale" this
    // codebase keeps rediscovering.
    expect(indexSrc).toContain('if (_isTopOfHour && !result.stoppedAtDeadline) recordCronSuccess(env, "bar_cron_aggregated")');
  });

  it("budgets against the invocation's wall, not the pass's own start", () => {
    // `ctx.waitUntil` in a cron handler keeps the invocation alive rather than
    // deferring anything, so the pass and the wall run out together.
    expect(indexSrc).toContain("deadlineMs: _now.getTime() + TICK_WALL_MS - TICK_SAFETY_MS,");
  });

  it("leaves the tier order that makes a cutoff safe", () => {
    // 5m last, because the WS stream covers it. If this order ever flips, a
    // deadline stops dropping the droppable tier.
    const agg = providerSrc.indexOf("await runTfBatch(aggregatedTfs,");
    const uncovered = providerSrc.indexOf("await runTfBatch(streamUncoveredIntradayTfs,");
    const critical = providerSrc.indexOf("await runTfBatch(criticalIntradayTfs,");
    const redundant = providerSrc.indexOf("await runTfBatch(streamRedundantTfs,");
    expect(agg).toBeGreaterThan(0);
    expect(uncovered).toBeGreaterThan(agg);
    expect(critical).toBeGreaterThan(uncovered);
    expect(redundant).toBeGreaterThan(critical);
  });
});
