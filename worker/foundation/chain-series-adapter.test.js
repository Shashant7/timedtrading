// worker/foundation/chain-series-adapter.test.js
import { describe, it, expect } from "vitest";
import {
  windowForTf, makeChainGetCandlesFromBases, getSeriesFromBases,
  makeHybridGetCandles, HYBRID_CHAIN_TFS, resolveScoreGetCandles,
} from "./chain-series-adapter.js";
import { evaluateScore } from "./score-contract.js";
import { expectedIntradayBuckets, sessionBoundsUtc, tradingDaysInRange } from "./trading-calendar.js";

// Build a contiguous multi-day 5m base over [startDate, endDate].
function base5mRange(startDate, endDate) {
  const out = [];
  let i = 0;
  for (const day of tradingDaysInRange(startDate, endDate)) {
    for (const ts of expectedIntradayBuckets(day, 5)) {
      out.push({ ts, o: 100 + i * 0.01, h: 100.5 + i * 0.01, l: 99.5 + i * 0.01, c: 100.2 + i * 0.01, v: 10 });
      i++;
    }
  }
  return out;
}
function dailyRange(startDate, endDate) {
  const out = [];
  let d = 0;
  for (const day of tradingDaysInRange(startDate, endDate)) {
    const ts = sessionBoundsUtc(day).openMs;
    out.push({ ts, o: 50 + d, h: 51 + d, l: 49 + d, c: 50.5 + d, v: 100 });
    d++;
  }
  return out;
}

describe("chain-series-adapter: windowForTf", () => {
  const asOf = Date.UTC(2026, 5, 12, 20, 0);
  it("intraday windows scale with bars-per-day; D/W/M scale by period", () => {
    expect(windowForTf("10", 300, asOf).startMs).toBeLessThan(asOf);
    // 300x 10m bars ≈ 7.7 RTH days → window spans at least ~2 weeks of calendar
    expect(asOf - windowForTf("10", 300, asOf).startMs).toBeGreaterThan(10 * 24 * 3600e3);
    // a monthly window for 60 months reaches back years
    expect(asOf - windowForTf("M", 60, asOf).startMs).toBeGreaterThan(2000 * 24 * 3600e3);
  });
});

describe("chain-series-adapter: getCandles backed by the chain", () => {
  const base5m = base5mRange("2026-05-01", "2026-06-12");
  const baseDaily = dailyRange("2026-01-02", "2026-06-12");
  const asOf = sessionBoundsUtc("2026-06-12").closeMs;
  const getCandles = makeChainGetCandlesFromBases({ base5m, baseDaily }, { asOf, source: "as_of" });

  it("serves intraday TFs derived from the 5m base (contract: {ok,candles})", async () => {
    const r = await getCandles({}, "AAPL", "30", 200);
    expect(r.ok).toBe(true);
    expect(r.tf).toBe("30");
    expect(r.candles.length).toBeGreaterThan(50);     // enough for computeTfBundle
    expect(r.candles.length).toBeLessThanOrEqual(200); // respects limit
    // ascending + valid OHLC
    expect(r.candles[0].ts).toBeLessThan(r.candles[r.candles.length - 1].ts);
    expect(Number.isFinite(r.candles[0].c)).toBe(true);
  });

  it("serves D/W/M derived from the daily base", async () => {
    const d = await getCandles({}, "AAPL", "D", 300);
    expect(d.ok).toBe(true);
    expect(d.candles.length).toBeGreaterThan(100);
    const w = await getCandles({}, "AAPL", "W", 60);
    expect(w.ok).toBe(true);
    expect(w.candles.length).toBeGreaterThan(10);
  });

  it("carries the chain's complete flag + coverage for the score gate", async () => {
    const r = await getCandles({}, "AAPL", "10", 300);
    expect(typeof r.complete).toBe("boolean");
    expect(r.coverage).toBeTruthy();
  });
});

describe("chain-series-adapter: hybrid router (LTF→chain, rest→legacy)", () => {
  const calls = [];
  const chainGC = async (env, t, tf) => { calls.push(["chain", tf]); return { ok: true, tf, source: "chain", candles: [] }; };
  const legacyGC = async (env, t, tf) => { calls.push(["legacy", tf]); return { ok: true, tf, source: "legacy", candles: [] }; };
  const hybrid = makeHybridGetCandles(chainGC, legacyGC);

  it("routes 10/15/30/60 to the chain", async () => {
    for (const tf of HYBRID_CHAIN_TFS) {
      const r = await hybrid({}, "AAPL", tf, 300);
      expect(r.source).toBe("chain");
    }
  });
  it("routes 240/D/W/M to legacy (deep stores)", async () => {
    for (const tf of ["240", "D", "W", "M"]) {
      const r = await hybrid({}, "AAPL", tf, 300);
      expect(r.source).toBe("legacy");
    }
  });
  it("honors a custom chainTfs set", async () => {
    const h2 = makeHybridGetCandles(chainGC, legacyGC, { chainTfs: ["10"] });
    expect((await h2({}, "X", "10")).source).toBe("chain");
    expect((await h2({}, "X", "60")).source).toBe("legacy");
  });
});

describe("chain-series-adapter: reversible cutover resolver (default OFF)", () => {
  const legacyGC = async (env, t, tf) => ({ ok: true, tf, source: "legacy", candles: [] });
  const chainGC = async (env, t, tf) => ({ ok: true, tf, source: "chain", candles: [] });
  const opts = { legacyGetCandles: legacyGC, chainGetCandles: chainGC };

  it("defaults to LEGACY when the flag is unset (zero behavior change)", async () => {
    const gc = resolveScoreGetCandles({}, opts);
    expect((await gc({}, "X", "10")).source).toBe("legacy");
    expect((await gc({}, "X", "240")).source).toBe("legacy");
  });
  it("hybrid_chain → chain LTF, legacy 240/D/W/M", async () => {
    const gc = resolveScoreGetCandles({ SCORE_CANDLE_SOURCE: "hybrid_chain" }, opts);
    expect((await gc({}, "X", "10")).source).toBe("chain");
    expect((await gc({}, "X", "60")).source).toBe("chain");
    expect((await gc({}, "X", "240")).source).toBe("legacy");
    expect((await gc({}, "X", "D")).source).toBe("legacy");
  });
  it("full_chain → chain everywhere", async () => {
    const gc = resolveScoreGetCandles({ SCORE_CANDLE_SOURCE: "full_chain" }, opts);
    expect((await gc({}, "X", "240")).source).toBe("chain");
  });
  it("unknown flag value fails safe to legacy", async () => {
    const gc = resolveScoreGetCandles({ SCORE_CANDLE_SOURCE: "bogus" }, opts);
    expect((await gc({}, "X", "10")).source).toBe("legacy");
  });
  it("missing chain source ⇒ legacy regardless of flag", async () => {
    const gc = resolveScoreGetCandles({ SCORE_CANDLE_SOURCE: "hybrid_chain" }, { legacyGetCandles: legacyGC });
    expect((await gc({}, "X", "10")).source).toBe("legacy");
  });
});

describe("chain-series-adapter: UNSCORABLE on an incomplete chain window (end-to-end)", () => {
  // The whole point of Phase 2: an incomplete candle window must yield
  // UNSCORABLE, never a silent number. Here we punch a gap in the 5m base, ask
  // the chain for a tight window, and feed its `complete=false` into the score
  // gate as a CRITICAL input — the score refuses.
  const startDate = "2026-06-08", endDate = "2026-06-12";
  const full = base5mRange(startDate, endDate);
  const gappy = full.filter((b, i) => i % 7 !== 0); // drop ~1/7 of the 5m bars
  const baseDaily = dailyRange("2026-01-02", "2026-06-12");
  const asOf = sessionBoundsUtc("2026-06-12").closeMs;

  function baseViewFromChain(getSeries) {
    // The chain's single freshness point is the 5m BASE; gate on its completeness
    // over a window we expect to be fully covered, so incompleteness = a real gap.
    const startMs = sessionBoundsUtc(startDate).openMs;
    const endMs = asOf;
    return getSeries("AAPL", "5", { startMs, endMs, asOf, source: "as_of" });
  }

  it("complete chain → SCORABLE", async () => {
    const view = await baseViewFromChain(getSeriesFromBases({ base5m: full, baseDaily }));
    const res = evaluateScore({
      version: "ltf@test",
      formula: () => ({ value: 42 }),
      inputs: {},
      inputs_meta: { base_5m: { available: view.complete } },
      critical: ["base_5m"],
    });
    expect(view.complete).toBe(true);
    expect(res.status).toBe("SCORABLE");
    expect(res.value).toBe(42);
  });

  it("gappy chain → UNSCORABLE (no silent number)", async () => {
    const view = await baseViewFromChain(getSeriesFromBases({ base5m: gappy, baseDaily }));
    const res = evaluateScore({
      version: "ltf@test",
      formula: () => ({ value: 42 }),
      inputs: {},
      inputs_meta: { base_5m: { available: view.complete } },
      critical: ["base_5m"],
    });
    expect(view.complete).toBe(false);
    expect(res.status).toBe("UNSCORABLE");
    expect(res.value).toBeNull();
    expect(res.missing_critical).toContain("base_5m");
  });
});
