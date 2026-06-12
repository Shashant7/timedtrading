// worker/discovery/gameplan.test.js
//
// Coverage for the Discovery Gameplan synthesizer — the bridge that
// turns move-discovery + diagnosis + coverage gaps + play usage into
// the artifact the AI officers consume. Pure-function tests plus an
// end-to-end orchestrator test with stub KV/D1.

import { describe, it, expect } from "vitest";
import {
  classifyConstraintMix,
  computePlaybookUsage,
  buildMissArchetypes,
  buildGameplanNarrative,
  buildDiscoveryGameplan,
  KNOWN_PLAYS,
} from "./gameplan.js";

describe("classifyConstraintMix", () => {
  it("maps diagnosis buckets + coverage reasons into the unified mix", () => {
    const r = classifyConstraintMix({
      diagnosisBreakdown: {
        low_rank: 10, low_htf: 5, low_completion: 2,   // → CONVICTION 17
        wrong_state: 4,                                 // → WRONG_SIDE 4
        no_signals: 8,                                  // → NO_PLAY 8
        should_have_entered: 6,                         // → GATE_VETO 6
        no_trail_data: 30,                              // → DATA_GAP 30
      },
      coverageReasonMix: {
        setup_not_detected: 12,                         // → NO_PLAY +12
        gate_blocked: 7, cohort_fail: 3,                // → GATE_VETO +10
        low_rank: 5,                                    // → CONVICTION +5
        not_scored: 2,                                  // → DATA_GAP +2
      },
      missedOutOfUniverse: 40,
    });
    expect(r.mix.NO_PLAY_FOR_MOVE).toBe(20);
    expect(r.mix.GENERIC_GATE_VETO).toBe(16);
    expect(r.mix.CONVICTION_TOO_LOW).toBe(22);
    expect(r.mix.WRONG_SIDE_BIAS).toBe(4);
    expect(r.mix.DATA_GAP).toBe(32);
    expect(r.mix.UNIVERSE_GAP).toBe(40);
    expect(r.binding_constraint).toBe("UNIVERSE_GAP");
    expect(r.total_classified).toBe(134);
    expect(r.binding_constraint_pct).toBeCloseTo(29.9, 1);
  });

  it("survives entirely-missing inputs", () => {
    const r = classifyConstraintMix({});
    expect(r.total_classified).toBe(0);
    expect(r.binding_constraint).toBe(null);
  });
});

describe("summarizeCTOCoverage", () => {
  it("counts insufficient candle failures", async () => {
    const { summarizeCTOCoverage } = await import("./gameplan.js");
    const r = summarizeCTOCoverage({
      results: [
        { ok: true, low_sample: true },
        { ok: false, error_kind: "insufficient_candles" },
        { ok: false, error_kind: "insufficient_candles" },
        { ok: true },
      ],
    });
    expect(r.insufficient_candles).toBe(2);
    expect(r.tickers_ok).toBe(2);
    expect(r.low_sample).toBe(1);
  });
});

describe("computePlaybookUsage", () => {
  it("detects a one-play offense with idle plays", () => {
    const r = computePlaybookUsage([
      { entry_path: "tt_reclaim", trades: 40, wins: 22 },
      { entry_path: "tt_momentum", trades: 6, wins: 3 },
      { entry_path: "tt_pullback", trades: 4, wins: 2 },
    ]);
    expect(r.plays_run).toBe(3);
    expect(r.total_trades).toBe(50);
    expect(r.concentration_pct).toBe(80);
    expect(r.one_play_offense).toBe(true);
    expect(r.plays_idle).toContain("tt_gap_reversal_short");
    expect(r.plays_idle.length).toBe(KNOWN_PLAYS.length - 3);
    expect(r.by_path[0]).toEqual({ path: "tt_reclaim", trades: 40, wins: 22, win_rate: 55 });
  });

  it("is not a one-play offense when usage is spread", () => {
    const rows = KNOWN_PLAYS.map((p) => ({ entry_path: p, trades: 5, wins: 3 }));
    const r = computePlaybookUsage(rows);
    expect(r.one_play_offense).toBe(false);
    expect(r.plays_idle).toEqual([]);
  });

  it("doesn't flag one-play offense below the sample floor", () => {
    const r = computePlaybookUsage([{ entry_path: "tt_reclaim", trades: 5, wins: 4 }]);
    expect(r.one_play_offense).toBe(false);
  });
});

describe("buildMissArchetypes", () => {
  it("groups repeated should-have-entered misses by direction × state", () => {
    const she = [
      { ticker: "AAA", direction: "UP", move_pct: 12, start_date: "2026-06-01", dominant_state: "HTF_BULL_LTF_BULL" },
      { ticker: "BBB", direction: "UP", move_pct: 9, start_date: "2026-06-03", dominant_state: "HTF_BULL_LTF_BULL" },
      { ticker: "CCC", direction: "DOWN", move_pct: -8, start_date: "2026-06-02", dominant_state: "HTF_BEAR_LTF_BEAR" },
    ];
    const r = buildMissArchetypes({ shouldHaveEntered: she, topMissed: [] });
    // Only the LONG group repeats (count >= 2).
    expect(r.length).toBe(1);
    expect(r[0].count).toBe(2);
    expect(r[0].kind).toBe("gate_or_trigger_gap");
    expect(r[0].direction).toBe("LONG");
    expect(r[0].examples).toContain("AAA 12% (2026-06-01)");
  });

  it("groups large missed moves by magnitude band", () => {
    const top = [
      { ticker: "AAA", direction: "UP", move_pct: 20, start_date: "2026-06-01" },
      { ticker: "BBB", direction: "UP", move_pct: 18, start_date: "2026-06-02" },
      { ticker: "CCC", direction: "UP", move_pct: 9, start_date: "2026-06-03" },
      { ticker: "DDD", direction: "UP", move_pct: 3, start_date: "2026-06-04" }, // < 8% ignored
    ];
    const r = buildMissArchetypes({ shouldHaveEntered: [], topMissed: top });
    expect(r.length).toBe(1); // only mega band repeats
    expect(r[0].magnitude).toBe("mega(≥15%)");
    expect(r[0].count).toBe(2);
  });
});

describe("buildGameplanNarrative", () => {
  it("composes the officer-facing paragraph", () => {
    const n = buildGameplanNarrative({
      capture: { capture_rate: 5.4, total_moves: 632, window_days: 60, missed_in_universe: 568, missed_out_of_universe: 27 },
      constraint: { binding_constraint: "GENERIC_GATE_VETO", binding_constraint_pct: 44, total_classified: 150 },
      usage: { one_play_offense: true, concentration_pct: 80, total_trades: 50, plays_idle: ["tt_ath_breakout", "tt_mean_revert"], plays_known: 12, by_path: [{ path: "tt_reclaim" }] },
      archetypes: [{ archetype: "LONG moves from HTF_BULL_LTF_BULL — scores/signals were valid but no entry fired", count: 9 }],
    });
    expect(n).toContain("Capture 5.4% of 632");
    expect(n).toContain("generic gates vetoed otherwise-valid setups");
    expect(n).toContain("One-play offense: tt_reclaim accounts for 80%");
    expect(n).toContain("×9");
    expect(n.length).toBeLessThanOrEqual(700);
  });
});

describe("buildDiscoveryGameplan (orchestrator)", () => {
  function makeKv(seed = {}) {
    const store = new Map(Object.entries(seed));
    return {
      store,
      async get(k) { return store.has(k) ? store.get(k) : null; },
      async put(k, v) { store.set(k, v); },
    };
  }
  function makeDb(pathRows) {
    return {
      prepare() {
        return {
          bind() {
            return { all: async () => ({ results: pathRows }) };
          },
        };
      },
    };
  }

  const sampleReport = {
    since_days: 60,
    summary: {
      total_moves: 632, capture_rate: 5.4, missed: 595,
      missed_in_universe: 568, missed_out_of_universe: 27, churned: 3,
      total_missed_upside_from_churn: 35.7,
    },
    diagnosis: {
      breakdown: { low_rank: 20, no_signals: 30, should_have_entered: 10, no_trail_data: 40 },
      should_have_entered: [
        { ticker: "AAA", direction: "UP", move_pct: 12, start_date: "2026-06-01", dominant_state: "HTF_BULL_LTF_BULL" },
        { ticker: "BBB", direction: "UP", move_pct: 10, start_date: "2026-06-02", dominant_state: "HTF_BULL_LTF_BULL" },
      ],
    },
    missed_signals: { top_missed: [] },
    recommendations: [
      { id: "widen_trailing_stop", type: "knob_change", title: "Widen", knob_path: "deep_audit_trail_atr_mult", current_value: 2, suggested_value: 2.5, confidence: "medium" },
      { id: "info_summary", type: "info", title: "Window summary" },
    ],
  };

  it("synthesizes and persists the gameplan to both KV keys", async () => {
    const kv = makeKv({ "timed:move-discovery": JSON.stringify(sampleReport) });
    const db = makeDb([{ entry_path: "tt_reclaim", trades: 40, wins: 22 }]);
    const res = await buildDiscoveryGameplan({ KV_TIMED: kv, DB: db });

    expect(res.ok).toBe(true);
    const gp = res.gameplan;
    expect(gp.capture.total_moves).toBe(632);
    expect(gp.constraint_mix.NO_PLAY_FOR_MOVE).toBe(30);
    expect(gp.constraint_mix.UNIVERSE_GAP).toBe(27);
    expect(gp.playbook_usage.one_play_offense).toBe(true);
    expect(gp.miss_archetypes.length).toBeGreaterThan(0);
    // Knob rec carried through, info rec dropped, structural insight added.
    expect(gp.actions.some((a) => a.kind === "knob_change" && a.id === "widen_trailing_stop")).toBe(true);
    expect(gp.actions.some((a) => a.id === "one_play_offense")).toBe(true);
    expect(gp.narrative.length).toBeGreaterThan(50);

    // Persisted standalone + merged into the report.
    expect(kv.store.has("timed:discovery:gameplan")).toBe(true);
    const merged = JSON.parse(kv.store.get("timed:move-discovery"));
    expect(merged.gameplan.binding_constraint).toBe(gp.binding_constraint);
  });

  it("fails soft when no move-discovery report exists", async () => {
    const res = await buildDiscoveryGameplan({ KV_TIMED: makeKv(), DB: makeDb([]) });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no_move_discovery_report");
  });
});
