// worker/lib/regime-markov-compute.test.js
//
// Regression coverage for the 2026-06-10 production incident: PR #311
// changed the matrix-compute SELECT to read `max_completion` from
// trail_5m_facts, but that name only exists as a SELECT alias inside the
// aggregation WRITER (trail-facts-light.js). The real column is
// `completion`, so every matrix compute since 2026-05-27 failed with
// `D1_ERROR: no such column: max_completion` and the Markov matrix
// stopped rebuilding (bootstrap, nightly refresh, admin recompute).
//
// The stub D1 below validates every SELECT against the REAL
// trail_5m_facts schema (mirrored from production pragma_table_info on
// 2026-06-10) and throws the same SQLite error a phantom column would
// produce in production. If anyone reintroduces a non-existent column in
// the read path, this suite fails the same way prod did.

import { describe, it, expect } from "vitest";
import { computeAndPersistRegimeMatrix } from "./regime-markov-compute.js";

// Production schema of trail_5m_facts (pragma_table_info, 2026-06-10).
const TRAIL_5M_FACTS_COLUMNS = new Set([
  "ticker", "bucket_ts",
  "price_open", "price_high", "price_low", "price_close",
  "htf_score_avg", "htf_score_min", "htf_score_max",
  "ltf_score_avg", "ltf_score_min", "ltf_score_max",
  "state", "rank", "completion", "phase_pct",
  "had_squeeze_release", "had_ema_cross", "had_st_flip",
  "had_momentum_elite", "had_flip_watch",
  "kanban_stage_start", "kanban_stage_end", "kanban_changed",
  "trade_entered", "trade_exited",
  "sample_count", "created_at",
  "ema_regime_D", "had_ema_cross_5_48", "had_ema_cross_13_21",
  "pdz_zone", "pdz_pct",
  "fvg_bull_count", "fvg_bear_count", "liq_bs_count", "liq_ss_count",
]);

const SQL_KEYWORDS = new Set(["count", "min", "max", "avg", "sum", "distinct", "as"]);

/**
 * Validate the SELECT list of a trail_5m_facts query against the real
 * schema, mimicking SQLite: throw `no such column: X` on the first
 * unknown base column. `expr AS alias` only requires `expr` to resolve.
 */
function assertSelectColumnsExist(sql) {
  if (!/from\s+trail_5m_facts/i.test(sql)) return;
  const m = sql.match(/select\s+([\s\S]*?)\s+from\s/i);
  if (!m) return;
  for (const rawTerm of m[1].split(",")) {
    const term = rawTerm.trim();
    if (!term || term === "*") continue;
    // Base expression = everything before AS (if present).
    const base = term.split(/\s+as\s+/i)[0].trim();
    // Pull bare identifiers out of the base expression (handles
    // COUNT(*), MAX(col), plain col).
    const idents = base.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
    for (const ident of idents) {
      if (SQL_KEYWORDS.has(ident.toLowerCase())) continue;
      if (!TRAIL_5M_FACTS_COLUMNS.has(ident)) {
        throw new Error(`D1_ERROR: no such column: ${ident} at offset 33: SQLITE_ERROR`);
      }
    }
  }
}

function makeStubDb(rows) {
  let calls = 0;
  return {
    calls: () => calls,
    prepare(sql) {
      assertSelectColumnsExist(sql);
      return {
        bind() {
          return {
            async all() {
              calls += 1;
              // First page returns everything (< READ_BATCH_LIMIT), so
              // the pager terminates after one round trip.
              return { results: calls === 1 ? rows : [] };
            },
          };
        },
      };
    },
  };
}

function makeStubKv() {
  const puts = new Map();
  return {
    puts,
    async put(key, value) { puts.set(key, JSON.parse(value)); },
  };
}

function makeRows() {
  // Two tickers, alternating valid 4-state regime states with a
  // completion value on every row — the same shape the fixed SELECT
  // returns (alias max_completion over the real completion column).
  const rows = [];
  const states = ["HTF_BULL_LTF_BULL", "HTF_BULL_LTF_PULLBACK", "HTF_BULL_LTF_BULL", "HTF_BEAR_LTF_BEAR"];
  for (const ticker of ["AAA", "BBB"]) {
    for (let i = 0; i < 40; i++) {
      rows.push({
        ticker,
        bucket_ts: 1_700_000_000_000 + i * 300_000,
        state: states[i % states.length],
        max_completion: 0.1 + (i % 9) * 0.1,
      });
    }
  }
  return rows;
}

describe("computeAndPersistRegimeMatrix — trail_5m_facts read path", () => {
  it("schema guard self-test: rejects the phantom max_completion column", () => {
    // Guard the guard: the exact SQL shape PR #311 shipped must throw
    // the same error production threw. If the validator stops catching
    // it, this whole suite is meaningless.
    expect(() => assertSelectColumnsExist(
      `SELECT ticker, bucket_ts, state, max_completion
         FROM trail_5m_facts
        WHERE bucket_ts >= ?1`
    )).toThrow(/no such column: max_completion/);
    // ...while the corrected alias form passes.
    expect(() => assertSelectColumnsExist(
      `SELECT ticker, bucket_ts, state, completion AS max_completion
         FROM trail_5m_facts
        WHERE bucket_ts >= ?1`
    )).not.toThrow();
  });

  it("computes and persists the matrix against the real schema (no filter)", async () => {
    const db = makeStubDb(makeRows());
    const kv = makeStubKv();
    const res = await computeAndPersistRegimeMatrix({ DB: db, KV_TIMED: kv }, { windowDays: 90, minObs: 1 });

    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.rows_read).toBe(80);
    expect(res.distinct_tickers).toBe(2);
    expect(res.total_transitions).toBeGreaterThan(0);

    // Both the 4-state and the expanded 12-state matrices must persist.
    const global4 = kv.puts.get("timed:regime:matrix:global");
    expect(global4).toBeTruthy();
    expect(global4.total_transitions).toBeGreaterThan(0);
    const expanded = kv.puts.get("timed:regime:matrix:expanded:global");
    expect(expanded).toBeTruthy();
    // Completion bands only resolve when r.max_completion flows through
    // the row mapping — transitions land in the expanded matrix too.
    expect(expanded.total_transitions).toBeGreaterThan(0);
  });

  it("computes against the real schema with a ticker filter", async () => {
    const db = makeStubDb(makeRows().filter(r => r.ticker === "AAA"));
    const kv = makeStubKv();
    const res = await computeAndPersistRegimeMatrix(
      { DB: db, KV_TIMED: kv },
      { windowDays: 90, minObs: 1, tickers: ["AAA"] },
    );
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.rows_read).toBe(40);
  });
});
