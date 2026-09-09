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
    options.themeMap.enabled = false;
    expect(computeCandidateScore(short, options)).toBe(70);
    expect(short._theme_tilt_shadow).toBe(-6);
    expect(short._theme_tilt).toBeUndefined();
    expect(short._ranking.overlay_delta).toBe(0);
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

  it("gives the remaining capacity slot to the highest-ranked eligible candidate, after management", async () => {
    const candidates = [candidate("LOW", 55), candidate("HIGH", 110), candidate("MANAGE", 1, { kanban_stage: "exit" }), candidate("BLOCKED", 120)];
    const attempted = [], opened = [];
    let capacity = 0, inFlight = 0;
    const count = await processRankedCandidates(candidates, {
      scoreCandidate: computeCandidateScore,
      processCandidate: async ({ ticker, payload }) => {
        expect(inFlight++).toBe(0);
        await Promise.resolve();
        attempted.push(ticker);
        if (ticker === "MANAGE") capacity++;
        else if (ticker !== "BLOCKED" && capacity > 0) { opened.push(ticker); capacity--; }
        expect(payload.rank).toBeLessThanOrEqual(100);
        inFlight--;
      },
    });
    expect(count).toBe(4);
    expect(attempted).toEqual(["MANAGE", "BLOCKED", "HIGH", "LOW"]);
    expect(opened).toEqual(["HIGH"]);
    expect(candidates[1].payload.__candidate_order).toEqual({ version: CANDIDATE_RANK_VERSION, score: 110, position: 2, total: 3 });
    expect(candidates[2].payload.__candidate_order).toBeUndefined();
  });

  it("one failed candidate does not suppress later candidates", async () => {
    const onError = vi.fn(), attempted = [];
    const n = await processRankedCandidates([candidate("A", 95), candidate("B", 80)], {
      scoreCandidate: computeCandidateScore, onError,
      processCandidate: async ({ ticker }) => { attempted.push(ticker); if (ticker === "A") throw new Error("entry failed"); },
    });
    expect(n).toBe(1);
    expect(attempted).toEqual(["A", "B"]);
    expect(onError).toHaveBeenCalledOnce();
  });
});
