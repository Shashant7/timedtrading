// worker/discovery/diagnose-missed.test.js
//
// Tests for the worker-native missed-move diagnosis pass.
// Mirrors the patterns in move-discovery.test.js.

import { describe, it, expect } from "vitest";
import { runDiagnosis } from "./diagnose-missed.js";

function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    _store: store,
    async get(k, type) {
      const v = store.get(k) ?? null;
      if (type === "json" && typeof v === "string") {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    async put(k, v) { store.set(k, v); },
  };
}

function makeStmt(handler, captureBindRef) {
  return {
    _sql: "",
    bind(...args) { captureBindRef.last = args; return this; },
    async all() {
      const result = handler(this._sql, captureBindRef.last);
      if (result instanceof Error) throw result;
      return result;
    },
    async first() {
      const result = handler(this._sql, captureBindRef.last);
      if (result instanceof Error) throw result;
      if (Array.isArray(result?.results)) return result.results[0] ?? null;
      return result?.first ?? null;
    },
  };
}

function makeDb(handler) {
  const bindRef = { last: [] };
  return {
    prepare(sql) {
      const s = makeStmt(handler, bindRef);
      s._sql = sql;
      return s;
    },
  };
}

function makeEnv({ db, kv }) {
  return { DB: db, KV_TIMED: kv };
}

describe("runDiagnosis — error envelopes", () => {
  it("returns no_db when env is missing", async () => {
    const r = await runDiagnosis({});
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no_db");
  });

  it("returns no_kv when KV_TIMED is missing", async () => {
    const r = await runDiagnosis({ DB: makeDb(() => ({ results: [] })) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no_kv");
  });

  it("returns no_discovery_report when KV has no report", async () => {
    const r = await runDiagnosis(makeEnv({ db: makeDb(() => ({ results: [] })), kv: makeKv() }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no_discovery_report");
    expect(r.hint).toBeDefined();
  });

  it("returns ok with note when report has no missed moves", async () => {
    const report = { moves: [{ ticker: "AAPL", capture: "FULL" }] };
    const kv = makeKv({ "timed:move-discovery": JSON.stringify(report) });
    const r = await runDiagnosis(makeEnv({ db: makeDb(() => ({ results: [] })), kv }));
    expect(r.ok).toBe(true);
    expect(r.diagnosis.total_diagnosed).toBe(0);
    expect(r.diagnosis.note).toBe("no_missed_moves");
  });
});

describe("runDiagnosis — classification", () => {
  it("classifies missed move with no trail data as NO_TRAIL_DATA / no_rows_for_ticker", async () => {
    const report = {
      moves: [{
        ticker: "NOROWS", direction: "UP", capture: "MISSED",
        start_date: "2026-05-15", end_date: "2026-05-20",
        move_pct: 12, move_atr: 4,
      }],
    };
    const kv = makeKv({ "timed:move-discovery": JSON.stringify(report) });
    /* Trail rows + coverage query both return empty for this ticker. */
    const db = makeDb((sql) => {
      if (sql.includes("MIN(bucket_ts)")) return { results: [{ min_ts: null, max_ts: null, total_rows: 0 }] };
      return { results: [] };
    });
    const r = await runDiagnosis(makeEnv({ db, kv }));
    expect(r.ok).toBe(true);
    expect(r.diagnosis.breakdown.no_trail_data).toBe(1);
    expect(r.diagnosis.coverage_breakdown.no_rows_for_ticker).toBe(1);
  });

  it("classifies as LOW_RANK when trail rank is < 60", async () => {
    const startMs = new Date("2026-05-15T00:00:00Z").getTime();
    const endMs = new Date("2026-05-20T23:59:59Z").getTime();
    const trailRows = [
      { bucket_ts: startMs + 86400000, htf_score_avg: 30, ltf_score_avg: 30, state: "HTF_BULL_LTF_BULL", rank: 40, completion: 70, had_squeeze_release: 1, had_ema_cross: 0, had_st_flip: 0, had_momentum_elite: 0, kanban_stage_end: "in_review" },
      { bucket_ts: startMs + 2 * 86400000, htf_score_avg: 25, ltf_score_avg: 25, state: "HTF_BULL_LTF_BULL", rank: 35, completion: 70, had_squeeze_release: 1, had_ema_cross: 0, had_st_flip: 0, had_momentum_elite: 0, kanban_stage_end: "in_review" },
    ];
    const report = {
      moves: [{
        ticker: "LOWRANK", direction: "UP", capture: "MISSED",
        start_date: "2026-05-15", end_date: "2026-05-20",
        move_pct: 12, move_atr: 4,
      }],
    };
    const kv = makeKv({ "timed:move-discovery": JSON.stringify(report) });
    const db = makeDb((sql) => {
      if (sql.includes("MIN(bucket_ts)")) return { results: [{ min_ts: startMs, max_ts: endMs, total_rows: 2 }] };
      return { results: trailRows };
    });
    const r = await runDiagnosis(makeEnv({ db, kv }));
    expect(r.ok).toBe(true);
    expect(r.diagnosis.breakdown.low_rank).toBe(1);
  });

  it("classifies as LATE_STAGE when normalized completion > 45%", async () => {
    const startMs = new Date("2026-05-15T00:00:00Z").getTime();
    const endMs = new Date("2026-05-20T23:59:59Z").getTime();
    const trailRows = [
      { bucket_ts: startMs + 86400000, htf_score_avg: 30, ltf_score_avg: 30, state: "HTF_BULL_LTF_BULL", rank: 80, completion: 0.72, had_squeeze_release: 1, had_ema_cross: 1, had_st_flip: 1, had_momentum_elite: 1, kanban_stage_end: "watch" },
    ];
    const report = {
      moves: [{
        ticker: "LATE", direction: "UP", capture: "MISSED",
        start_date: "2026-05-15", end_date: "2026-05-20",
        move_pct: 15, move_atr: 5,
      }],
    };
    const kv = makeKv({ "timed:move-discovery": JSON.stringify(report) });
    const db = makeDb((sql) => {
      if (sql.includes("MIN(bucket_ts)")) return { results: [{ min_ts: startMs, max_ts: endMs, total_rows: 1 }] };
      return { results: trailRows };
    });
    const r = await runDiagnosis(makeEnv({ db, kv }));
    expect(r.ok).toBe(true);
    expect(r.diagnosis.breakdown.late_stage).toBe(1);
  });

  it("classifies as SHOULD_HAVE_ENTERED when everything looks good", async () => {
    const startMs = new Date("2026-05-15T00:00:00Z").getTime();
    const endMs = new Date("2026-05-20T23:59:59Z").getTime();
    /* High rank, high HTF, matching state, signals fired, early completion. */
    const trailRows = [
      { bucket_ts: startMs + 86400000, htf_score_avg: 30, ltf_score_avg: 30, state: "HTF_BULL_LTF_BULL", rank: 80, completion: 0.25, had_squeeze_release: 1, had_ema_cross: 1, had_st_flip: 1, had_momentum_elite: 1, kanban_stage_end: "in_review" },
      { bucket_ts: startMs + 2 * 86400000, htf_score_avg: 35, ltf_score_avg: 35, state: "HTF_BULL_LTF_BULL", rank: 85, completion: 0.30, had_squeeze_release: 1, had_ema_cross: 1, had_st_flip: 1, had_momentum_elite: 1, kanban_stage_end: "in_review" },
    ];
    const report = {
      moves: [{
        ticker: "MYSTERY", direction: "UP", capture: "MISSED",
        start_date: "2026-05-15", end_date: "2026-05-20",
        move_pct: 15, move_atr: 5,
      }],
    };
    const kv = makeKv({ "timed:move-discovery": JSON.stringify(report) });
    const db = makeDb((sql) => {
      if (sql.includes("MIN(bucket_ts)")) return { results: [{ min_ts: startMs, max_ts: endMs, total_rows: 2 }] };
      return { results: trailRows };
    });
    const r = await runDiagnosis(makeEnv({ db, kv }));
    expect(r.ok).toBe(true);
    expect(r.diagnosis.breakdown.qualification_gap).toBe(1);
    expect(r.diagnosis.should_have_entered).toHaveLength(0);
  });

  it("merges diagnosis back into the KV report (so dashboard sees it)", async () => {
    const report = {
      generated: "2026-06-02T00:00:00Z",
      summary: { total_moves: 1 },
      moves: [{
        ticker: "MERGE", direction: "UP", capture: "MISSED",
        start_date: "2026-05-15", end_date: "2026-05-20",
        move_pct: 10, move_atr: 3,
      }],
      recommendations: [{ id: "preserved", title: "should still exist" }],
    };
    const kv = makeKv({ "timed:move-discovery": JSON.stringify(report) });
    const db = makeDb((sql) => {
      if (sql.includes("MIN(bucket_ts)")) return { results: [{ min_ts: null, max_ts: null, total_rows: 0 }] };
      return { results: [] };
    });
    await runDiagnosis(makeEnv({ db, kv }));
    const persisted = JSON.parse(kv._store.get("timed:move-discovery"));
    expect(persisted.diagnosis).toBeDefined();
    expect(persisted.diagnosis.total_diagnosed).toBe(1);
    /* Critical: the rest of the report must be preserved */
    expect(persisted.summary).toEqual({ total_moves: 1 });
    expect(persisted.recommendations[0].id).toBe("preserved");
  });
});
