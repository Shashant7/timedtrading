import { describe, expect, it, vi } from "vitest";
import {
  CANDIDATE_RANK_VERSION, candidateBaseScore, computeCandidateScore,
  stampTechnicalRank, stampCandidatePositions, processRankedCandidates,
} from "./candidate-rank.js";

function candidate(ticker, raw, extra = {}) {
  const payload = { ticker, htf_score: 20, kanban_stage: "enter", ...extra };
  payload.rank = stampTechnicalRank(payload, raw, "v1");
  return { ticker, payload };
}

describe("canonical candidate score", () => {
  it("preserves zero and does not invent an average score for absent/invalid rank", () => {
    for (const rank of [0, "0", null, undefined, "", " ", false, NaN, Infinity]) {
      expect(computeCandidateScore({ rank, htf_score: 20, _fair_value: { tilt: 5, tilt_enabled: true } })).toBe(0);
    }
    expect(computeCandidateScore({ rank: "72" })).toBe(72);
  });

  it("counts technical evidence once even when all legacy dynamic bonuses are present", () => {
    const payload = candidate("STRONG", 81.25, {
      ltf_score: 10, state: "HTF_BULL_LTF_BULL", rr: 5, completion: 0.1, phase_pct: 0.1,
      data_completeness: { score: 100 }, tf_summary: { score: 10, squeeze_on: true },
      trigger_summary: { score: 9 }, flags: { sq30_release: true, phase_zone_change: true },
    }).payload;
    expect(computeCandidateScore(payload)).toBe(81.25);
    expect(payload.rank).toBe(81);
    expect(payload._ranking.overlay_delta).toBe(0);
  });

  it("separates saturated technical scores without changing their admission scale", () => {
    const a = candidate("AAA", 101.125), z = candidate("ZZZ", 125.875);
    const order = stampCandidatePositions({ AAA: a.payload, ZZZ: z.payload }, computeCandidateScore);
    expect(order.map(r => r.ticker)).toEqual(["ZZZ", "AAA"]);
    expect(a.payload.rank).toBe(100);
    expect(z.payload.rank).toBe(100);
    expect(z.payload.rank_score).toBe(125.88);
    expect(z.payload._technical_rank.raw_score).toBe(125.875);
  });

  it("ignores a raw score whose gate or ranking version belongs to an older snapshot", () => {
    const p = candidate("OLD", 140).payload;
    p.rank = 25;
    expect(candidateBaseScore(p)).toBe(25);
    p._technical_rank.gate_score = 25;
    p._technical_rank.version = "old";
    expect(candidateBaseScore(p)).toBe(25);
  });

  it("enforces quarantine after positive overlays and restores fresh/replay scores", () => {
    const p = candidate("STALE", 140, {
      _freshness: { enforced: true, grade: "STALE" },
      _fair_value: { tilt: 5, tilt_enabled: true },
      harmonic_cycle: { rank_tilt: 4, tilt_enabled: true },
    }).payload;
    expect(p.rank).toBe(10);
    expect(computeCandidateScore(p)).toBe(10);
    expect(p._rank_freshness_capped).toBe(true);
    p._freshness = { enforced: true, grade: "FRESH" };
    p.rank = stampTechnicalRank(p, 140, "v1");
    expect(computeCandidateScore(p)).toBe(149);
    expect(p._rank_freshness_capped).toBeUndefined();
    p._freshness = { enforced: false, grade: "STALE" };
    expect(computeCandidateScore(p)).toBe(149);
  });

  it("keeps direction-aware overlays, their gates, and shadow traces", () => {
    const options = { themeMap: { enabled: true, by_ticker: { XYZ: { tilt: 6, theme: "test" } } } };
    const long = candidate("XYZ", 70).payload;
    const short = candidate("XYZ", 70, { htf_score: -20 }).payload;
    expect(computeCandidateScore(long, options)).toBe(76);
    expect(computeCandidateScore(short, options)).toBe(64);
    expect(short._theme_tilt).toBe(-6);
    options.themeMap.enabled = false;
    expect(computeCandidateScore(short, options)).toBe(70);
    expect(short._theme_tilt_shadow).toBe(-6);
    expect(short._theme_tilt).toBeUndefined();
    expect(short._ranking.overlay_delta).toBe(0);
  });

  it("signs overlays to an armed Cloud Pivot play instead of HTF_BEAR", () => {
    const options = { themeMap: { enabled: true, by_ticker: { BE: { tilt: 6, theme: "ai_infra_energy" } } } };
    const play = candidate("BE", 70, {
      htf_score: -20,
      _cloud_pivot_detect: { fires: true, direction: "LONG" },
      _fair_value: { tilt: 1, tilt_enabled: true },
    }).payload;
    expect(computeCandidateScore(play, options)).toBe(77);
    expect(play._theme_tilt).toBe(6);
    expect(play._fv_tilt).toBe(1);
    const noPlay = candidate("BE", 70, { htf_score: -20 }).payload;
    expect(computeCandidateScore(noPlay, options)).toBe(64);
  });

  it("malformed overlays cannot erase a valid base score", () => {
    const p = candidate("XYZ", 77).payload;
    expect(computeCandidateScore(p, {
      themeMap: { enabled: true, by_ticker: { XYZ: {} } },
      officerMap: {}, lookupOfficerTilt: () => ({ tilt: NaN }),
      macroMap: { enabled: true }, lookupMacroRiskTilt: () => { throw new Error("unavailable"); },
    })).toBe(77);
  });

  it("attributes each overlay once and reconciles the final score through caps and rounding", () => {
    const p = candidate("XYZ", 91.125, {
      _fair_value: { tilt: 3, tilt_enabled: true },
      harmonic_cycle: { rank_tilt: 2, tilt_enabled: false },
    }).payload;
    const options = { themeMap: { enabled: true, by_ticker: { XYZ: { tilt: 4 } } },
      officerMap: {}, lookupOfficerTilt: () => ({ tilt: 1, cto: 2, cro: -1 }) };
    const final = computeCandidateScore(p, options);
    const parts = p._ranking.parts;
    expect(parts.find(p => p.label === "harmonic")).toMatchObject({ delta: 0, shadow_delta: 2, status: "shadow" });
    expect(parts.find(p => p.label === "officer").delta).toBe(1);
    expect(parts.reduce((s, p) => s + p.delta, 0)).toBeCloseTo(final, 10);
    p._freshness = { enforced: true, grade: "STALE" };
    expect(computeCandidateScore(p, options)).toBe(10);
    expect(p._ranking.parts.find(p => p.label === "score_cap").delta).toBe(-8);
    expect(p._ranking.parts.reduce((s, p) => s + p.delta, 0)).toBeCloseTo(10, 10);
  });
});

describe("one candidate order", () => {
  it("recomputes cached scores and produces stable positions regardless of source insertion order", () => {
    const a = candidate("AAA", 90).payload, b = candidate("BBB", 90).payload;
    const z = candidate("ZZZ", 120, { _freshness: { enforced: true, grade: "STALE" } }).payload;
    const zero = candidate("ZERO", 0).payload;
    a.dynamicScore = 1; b.dynamicScore = null; z.dynamicScore = 900;
    const first = { ZZZ: z, BBB: b, AAA: a, ZERO: zero };
    const second = { ZERO: structuredClone(zero), AAA: structuredClone(a), BBB: structuredClone(b), ZZZ: structuredClone(z) };
    for (const data of [first, second]) {
      expect(stampCandidatePositions(data, computeCandidateScore).map(r => r.ticker)).toEqual(["AAA", "BBB", "ZERO", "ZZZ"]);
      expect(data.AAA.position).toBe(1);
      expect(data.BBB.rank_position).toBe(2);
      expect(data.AAA.rank_total).toBe(4);
      expect(data.BBB.dynamicScore).toBe(90);
    }
  });

  // A loader that hands out a FRESH payload every call, the way a KV read
  // does. Anything the pass retains from the scan is therefore invisible to
  // processing, which is the property under test.
  function loaderFor(spec) {
    const calls = [];
    const load = async (ticker, phase) => {
      calls.push(`${ticker}:${phase}`);
      const def = spec[ticker];
      if (!def) return null;
      const p = candidate(ticker, def.raw, def.extra || {}).payload;
      p.__load_phase = phase;
      return p;
    };
    return { tickers: Object.keys(spec), load, calls };
  }

  it("gives the remaining capacity slot to the highest-ranked eligible candidate, after management", async () => {
    const { tickers, load } = loaderFor({
      LOW: { raw: 55 }, HIGH: { raw: 110 },
      MANAGE: { raw: 1, extra: { kanban_stage: "exit" } }, BLOCKED: { raw: 120 },
    });
    const attempted = [], opened = [];
    const orderSeen = {};
    let capacity = 0, inFlight = 0;
    const stats = await processRankedCandidates(tickers, {
      loadPayload: load,
      scoreCandidate: computeCandidateScore,
      processCandidate: async ({ ticker, payload }) => {
        expect(inFlight++).toBe(0);
        await Promise.resolve();
        attempted.push(ticker);
        orderSeen[ticker] = payload.__candidate_order;
        if (ticker === "MANAGE") capacity++;
        else if (ticker !== "BLOCKED" && capacity > 0) { opened.push(ticker); capacity--; }
        expect(payload.rank).toBeLessThanOrEqual(100);
        inFlight--;
      },
    });
    expect(stats).toEqual({ processed: 4, management: 1, entries: 3 });
    expect(attempted).toEqual(["MANAGE", "BLOCKED", "HIGH", "LOW"]);
    expect(opened).toEqual(["HIGH"]);
    expect(orderSeen.HIGH).toEqual({ version: CANDIDATE_RANK_VERSION, score: 110, position: 2, total: 3 });
    expect(orderSeen.MANAGE).toBeUndefined();
  });

  // The `*/5` tick died here. The live shortlist is 268 tickers and a
  // `timed:latest` payload is ~165 KB of JSON, so a pass that holds the
  // batch in order to rank it is past the 128 MB isolate on its own.
  it("ranks the whole batch without ever carrying it", async () => {
    const { tickers, load, calls } = loaderFor({
      LOW: { raw: 55 }, HIGH: { raw: 110 }, MANAGE: { raw: 1, extra: { kanban_stage: "exit" } },
    });
    const processedPhases = [];
    await processRankedCandidates(tickers, {
      loadPayload: load,
      scoreCandidate: computeCandidateScore,
      processCandidate: async ({ ticker, payload }) => processedPhases.push([ticker, payload.__load_phase]),
    });
    // Every ticker is read exactly once on the scan, management is handled
    // there and never re-read, and every entry payload that reaches
    // processing was read for it — the scan's copy is gone.
    expect(calls).toEqual(["LOW:scan", "HIGH:scan", "MANAGE:scan", "HIGH:entry", "LOW:entry"]);
    expect(processedPhases).toEqual([["MANAGE", "scan"], ["HIGH", "entry"], ["LOW", "entry"]]);
  });

  it("does not read a management candidate twice", async () => {
    // ~85% of the live batch is `hold`. A blanket second read cost the
    // engine tick three minutes it did not have.
    const { tickers, load, calls } = loaderFor({
      H1: { raw: 40, extra: { kanban_stage: "hold" } },
      H2: { raw: 40, extra: { kanban_stage: "defend" } },
      E1: { raw: 90 },
    });
    await processRankedCandidates(tickers, {
      loadPayload: load, scoreCandidate: computeCandidateScore, processCandidate: async () => {},
    });
    expect(calls.filter((c) => c.startsWith("H1"))).toEqual(["H1:scan"]);
    expect(calls.filter((c) => c.startsWith("H2"))).toEqual(["H2:scan"]);
    expect(calls.filter((c) => c.startsWith("E1"))).toEqual(["E1:scan", "E1:entry"]);
  });

  it("re-stamps the ranking on the copy it processes, keeping the score that set the order", async () => {
    const { tickers, load } = loaderFor({ A: { raw: 95 }, B: { raw: 80 } });
    const seen = [];
    await processRankedCandidates(tickers, {
      loadPayload: load,
      scoreCandidate: computeCandidateScore,
      processCandidate: async ({ ticker, payload }) => seen.push([ticker, payload._ranking?.final_score, payload.__candidate_order?.score]),
    });
    expect(seen).toEqual([["A", 95, 95], ["B", 80, 80]]);
  });

  it("drops a ticker the loader rejects, and tells the loader which pass it is on", async () => {
    const phases = [];
    const attempted = [];
    const { processed } = await processRankedCandidates(["A", "GONE", "B"], {
      loadPayload: async (ticker, phase) => {
        phases.push(`${ticker}:${phase}`);
        if (ticker === "GONE") return null;
        return candidate(ticker, 90).payload;
      },
      scoreCandidate: computeCandidateScore,
      processCandidate: async ({ ticker }) => { attempted.push(ticker); },
    });
    expect(processed).toBe(2);
    expect(attempted).toEqual(["A", "B"]);
    // GONE is rejected on the scan and never re-read, so a caller counting
    // rejections counts it once.
    expect(phases.filter((p) => p.startsWith("GONE"))).toEqual(["GONE:scan"]);
  });

  it("one failed candidate does not suppress later candidates", async () => {
    const { tickers, load } = loaderFor({ A: { raw: 95 }, B: { raw: 80 } });
    const onError = vi.fn(), attempted = [];
    const { processed } = await processRankedCandidates(tickers, {
      loadPayload: load,
      scoreCandidate: computeCandidateScore, onError,
      processCandidate: async ({ ticker }) => { attempted.push(ticker); if (ticker === "A") throw new Error("entry failed"); },
    });
    expect(processed).toBe(1);
    expect(attempted).toEqual(["A", "B"]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("a read that throws loses one ticker, not the pass", async () => {
    const onError = vi.fn(), attempted = [];
    const { processed } = await processRankedCandidates(["A", "BOOM", "B"], {
      loadPayload: async (ticker) => {
        if (ticker === "BOOM") throw new Error("KV read failed");
        return candidate(ticker, 90).payload;
      },
      scoreCandidate: computeCandidateScore, onError,
      processCandidate: async ({ ticker }) => { attempted.push(ticker); },
    });
    expect(processed).toBe(2);
    expect(attempted).toEqual(["A", "B"]);
    expect(onError).toHaveBeenCalledOnce();
  });
});
