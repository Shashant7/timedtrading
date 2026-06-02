// worker/discovery/move-discovery.test.js
//
// Unit tests for the worker-native Move Discovery.
//
// Why these exist: the v1 of this module bound `Math.floor(sinceTs/
// 1000)` (a SECONDS value) to a D1 query against the `ticker_candles.
// ts` column, which stores MILLISECONDS. Result: every row in the
// table matched `ts >= 1.7e9`, D1 returned a gigantic payload, and
// the worker OOM-crashed. The fix bound milliseconds, but the bug
// could trivially regress; these tests pin the contract.
//
// Coverage:
//   • bindsMillisecondTimestamp — the smoking gun. The D1 mock
//     captures the bound value; assert it's > 1e12.
//   • emptyDb — no rows → ok:true, summary all zeros, no throw.
//   • missingDB — env without DB binding → ok:false, error:no_db.
//   • candleQueryFailure — D1 throws → ok:false with helpful error.
//   • tradeQueryFailure — non-fatal; missed-count still computed.
//   • classifiesMissedMoves — a known 5x-ATR move with no matching
//     trade gets capture=MISSED.
//   • classifiesFullCapture — same move + a trade entered in first
//     30% of window + exited at >= 60% → FULL.
//   • classifiesChurn — 3 trades inside one move → CHURNED with
//     aggregated missed_upside.
//   • persistsToKv — successful run writes report to the KV key the
//     dashboard reads (`timed:move-discovery`).
//   • capsTickers — 250 tickers → only top 200 by recent magnitude.

import { describe, it, expect, beforeEach } from "vitest";
import { runMoveDiscovery } from "./move-discovery.js";

// ── Test helpers ─────────────────────────────────────────────────────

function makeStmt(rowsByQuery) {
  /* A minimal mock of a D1 PreparedStatement that records its bind
     args and returns canned rows. The first .bind() arg is captured
     onto a shared `_lastBind` object. */
  let boundParams = [];
  const stmt = {
    _lastSql: "",
    bind(...args) { boundParams = args; return stmt; },
    async all() {
      const sql = stmt._lastSql;
      stmt._capturedBind = boundParams;
      const handler = Object.entries(rowsByQuery).find(([substr]) => sql.includes(substr));
      if (!handler) return { results: [] };
      const [, value] = handler;
      if (typeof value === "function") return value(boundParams);
      if (value instanceof Error) throw value;
      return { results: value || [] };
    },
  };
  return stmt;
}

function makeDb(rowsByQuery) {
  let lastStmt = null;
  return {
    prepare(sql) {
      const s = makeStmt(rowsByQuery);
      s._lastSql = sql;
      lastStmt = s;
      return s;
    },
    _lastStmt: () => lastStmt,
  };
}

function makeKv() {
  const store = new Map();
  return {
    _store: store,
    /* CF KV's get supports a second `type` arg ("json", "text", etc).
       Mirror the "json" branch so callers reading
       KV.get(key, "json") get parsed objects, not raw strings. */
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

function makeEnv({ db, kv } = {}) {
  return { DB: db, KV_TIMED: kv };
}

function makeCandle(ts, c, atrSeed = 0) {
  /* Simple OHLC with small body, true range approx atrSeed. */
  return {
    ticker: "TEST",
    ts, // ms
    o: c, h: c + Math.max(0.01, atrSeed), l: c - Math.max(0.01, atrSeed),
    c, v: 1000,
  };
}

function flatHistory(ticker, days, basePrice, opts = {}) {
  /* Generate `days` daily candles ending now, flat at basePrice
     except for an injected move starting at startDayIdx. */
  const out = [];
  const startMs = Date.now() - days * 86400000;
  const { startDayIdx = null, endDayIdx = null, endPrice = basePrice } = opts;
  for (let i = 0; i < days; i++) {
    const ts = startMs + i * 86400000;
    let price = basePrice;
    if (startDayIdx != null && endDayIdx != null && i >= startDayIdx && i <= endDayIdx) {
      const span = Math.max(1, endDayIdx - startDayIdx);
      const t = (i - startDayIdx) / span;
      price = basePrice + (endPrice - basePrice) * t;
    } else if (startDayIdx != null && i > endDayIdx) {
      price = endPrice;
    }
    out.push({ ticker, ts, o: price, h: price + 0.2, l: price - 0.2, c: price, v: 1000 });
  }
  return out;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("runMoveDiscovery", () => {
  it("returns error when no DB binding", async () => {
    const result = await runMoveDiscovery({});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_db");
  });

  it("binds millisecond timestamp to candle query (regression for v1 crash)", async () => {
    /* The original bug: bound seconds (~1.7e9) to a ms column,
       matching every historical row and OOM-ing the worker. This
       test pins the contract. */
    let bound = null;
    const db = makeDb({
      "ticker_candles": (b) => { bound = b; return { results: [] }; },
      "trades": [],
    });
    await runMoveDiscovery(makeEnv({ db, kv: makeKv() }));
    expect(bound).toHaveLength(1);
    expect(bound[0]).toBeGreaterThan(1e12);
    expect(bound[0]).toBeLessThan(Date.now() + 1);
  });

  it("handles empty DB cleanly (no candles, no trades)", async () => {
    const db = makeDb({ "ticker_candles": [], "trades": [] });
    const result = await runMoveDiscovery(makeEnv({ db, kv: makeKv() }));
    expect(result.ok).toBe(true);
    expect(result.summary.total_moves).toBe(0);
    expect(result.summary.missed).toBe(0);
    expect(result.summary.full_capture).toBe(0);
  });

  it("returns error envelope when candle query throws", async () => {
    const db = makeDb({
      "ticker_candles": new Error("D1_ERROR: too many rows"),
      "trades": [],
    });
    const result = await runMoveDiscovery(makeEnv({ db, kv: makeKv() }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/candle_query_failed/);
    expect(result.error).toMatch(/too many rows/);
  });

  it("survives trade query failure (still produces missed-counts)", async () => {
    const candles = flatHistory("MOVE1", 30, 100, {
      startDayIdx: 24, endDayIdx: 29, endPrice: 130, // +30% in 5 days
    });
    const db = makeDb({
      "ticker_candles": candles,
      "trades": new Error("D1_ERROR: trades unavailable"),
    });
    const result = await runMoveDiscovery(makeEnv({ db, kv: makeKv() }));
    expect(result.ok).toBe(true);
    // No trades → every move is MISSED.
    expect(result.summary.missed).toBeGreaterThan(0);
    expect(result.summary.full_capture).toBe(0);
  });

  it("classifies a move with no trade as MISSED", async () => {
    const candles = flatHistory("MISSED1", 30, 100, {
      startDayIdx: 24, endDayIdx: 29, endPrice: 140, // +40% spike
    });
    const db = makeDb({ "ticker_candles": candles, "trades": [] });
    const result = await runMoveDiscovery(makeEnv({ db, kv: makeKv() }));
    expect(result.ok).toBe(true);
    expect(result.summary.missed).toBeGreaterThan(0);
    expect(result.missed_signals.top_missed[0].ticker).toBe("MISSED1");
  });

  it("classifies a move with a well-timed trade as FULL capture", async () => {
    const ticker = "FULL1";
    const days = 40;
    const startDayIdx = 30;
    const endDayIdx = 39;
    const candles = flatHistory(ticker, days, 100, {
      startDayIdx, endDayIdx, endPrice: 140,
    });
    const startMs = Date.now() - days * 86400000;
    const trade = {
      trade_id: "t1", ticker, direction: "LONG",
      entry_ts: startMs + (startDayIdx + 1) * 86400000, // early in move
      exit_ts: startMs + (endDayIdx - 1) * 86400000,    // late in move
      entry_price: 102, exit_price: 138, pnl_pct: 35,
      status: "WIN", exit_reason: "tp_hit",
    };
    const db = makeDb({ "ticker_candles": candles, "trades": [trade] });
    const result = await runMoveDiscovery(makeEnv({ db, kv: makeKv() }));
    expect(result.ok).toBe(true);
    expect(result.summary.full_capture).toBeGreaterThan(0);
  });

  it("classifies 3 overlapping trades on one move as CHURNED", async () => {
    const ticker = "CHURN1";
    const days = 40;
    const startDayIdx = 30;
    const endDayIdx = 39;
    const candles = flatHistory(ticker, days, 100, {
      startDayIdx, endDayIdx, endPrice: 140,
    });
    const startMs = Date.now() - days * 86400000;
    const mk = (id, dayOffset, price, pnl) => ({
      trade_id: id, ticker, direction: "LONG",
      entry_ts: startMs + (startDayIdx + dayOffset) * 86400000,
      exit_ts: startMs + (startDayIdx + dayOffset + 1) * 86400000,
      entry_price: price, exit_price: price * (1 + pnl / 100),
      pnl_pct: pnl, status: pnl > 0 ? "WIN" : "LOSS", exit_reason: "trail",
    });
    const trades = [
      mk("c1", 0, 100, 2),
      mk("c2", 2, 110, -1),
      mk("c3", 5, 125, 3),
    ];
    const db = makeDb({ "ticker_candles": candles, "trades": trades });
    const result = await runMoveDiscovery(makeEnv({ db, kv: makeKv() }));
    expect(result.ok).toBe(true);
    expect(result.summary.churned).toBeGreaterThan(0);
  });

  it("persists report to KV at the dashboard's key", async () => {
    const candles = flatHistory("KV1", 30, 100, {
      startDayIdx: 24, endDayIdx: 29, endPrice: 130,
    });
    const kv = makeKv();
    const db = makeDb({ "ticker_candles": candles, "trades": [] });
    await runMoveDiscovery(makeEnv({ db, kv }));
    expect(kv._store.has("timed:move-discovery")).toBe(true);
    const stored = JSON.parse(kv._store.get("timed:move-discovery"));
    expect(stored.source).toBe("worker_coo");
    expect(stored.summary).toBeDefined();
    expect(Array.isArray(stored.moves)).toBe(true);
  });

  it("respects MAX_TICKERS cap (200)", async () => {
    /* Generate 250 tickers, each with 30 days of flat candles. */
    const allCandles = [];
    for (let i = 0; i < 250; i++) {
      const ticker = `T${String(i).padStart(3, "0")}`;
      allCandles.push(...flatHistory(ticker, 30, 50 + i, {}));
    }
    const db = makeDb({ "ticker_candles": allCandles, "trades": [] });
    const result = await runMoveDiscovery(makeEnv({ db, kv: makeKv() }));
    expect(result.ok).toBe(true);
    expect(result.summary.tickers_scanned).toBeLessThanOrEqual(200);
  });

  it("clamps minAtr + windowDays to safe ranges", async () => {
    const db = makeDb({ "ticker_candles": [], "trades": [] });
    const r1 = await runMoveDiscovery(makeEnv({ db, kv: makeKv() }), { windowDays: 9999, minAtr: 100 });
    expect(r1.ok).toBe(true);
    // Just verify it didn't blow up; the clamps prevent silly inputs.
  });

  it("rejects malformed candle rows (non-finite OHLC)", async () => {
    const candles = [
      { ticker: "BAD", ts: Date.now(), o: NaN, h: 1, l: 1, c: 1, v: 0 },
      { ticker: "BAD", ts: Date.now(), o: 1, h: 1, l: 1, c: 1, v: 0 },
    ];
    const db = makeDb({ "ticker_candles": candles, "trades": [] });
    const result = await runMoveDiscovery(makeEnv({ db, kv: makeKv() }));
    expect(result.ok).toBe(true);
    expect(result.summary.candles_scanned).toBe(2);
    // BAD has only 1 valid candle → filtered out (needs >= 20).
    expect(result.summary.tickers_scanned).toBe(0);
  });

  it("attaches a recommendations[] array to every run", async () => {
    const candles = flatHistory("RECS1", 30, 100, {
      startDayIdx: 24, endDayIdx: 29, endPrice: 130,
    });
    const db = makeDb({ "ticker_candles": candles, "trades": [] });
    const kv = makeKv();
    /* Seed the universe so the recommendations engine has a real
       in/out-of-universe split. */
    await kv.put("timed:tickers", JSON.stringify(["AAPL", "RECS1"]));
    const env = makeEnv({ db, kv });
    const result = await runMoveDiscovery(env);
    expect(result.ok).toBe(true);
    /* The full report is on KV; the return envelope summary doesn't
       include the recs[] but the report on KV does. Read it. */
    const stored = JSON.parse(kv._store.get("timed:move-discovery"));
    expect(Array.isArray(stored.recommendations)).toBe(true);
    /* The 'info_summary' recommendation is always present. */
    expect(stored.recommendations.some((r) => r.id === "info_summary")).toBe(true);
  });

  it("recommends lowering screener threshold when many missed moves are out-of-universe", async () => {
    /* Build a scenario: 10 tickers with big moves, NONE in universe. */
    const allCandles = [];
    for (let i = 0; i < 10; i++) {
      const ticker = `OOU${i}`;
      allCandles.push(...flatHistory(ticker, 30, 100, {
        startDayIdx: 24, endDayIdx: 29, endPrice: 130,
      }));
    }
    const db = makeDb({ "ticker_candles": allCandles, "trades": [] });
    const kv = makeKv();
    await kv.put("timed:tickers", JSON.stringify([])); // empty universe
    const env = makeEnv({ db, kv });
    await runMoveDiscovery(env);
    const stored = JSON.parse(kv._store.get("timed:move-discovery"));
    expect(stored.recommendations.some((r) => r.id === "lower_screener_threshold")).toBe(true);
  });

  it("recommends lowering accumulate score when many missed moves are in-universe", async () => {
    const allCandles = [];
    const tickers = [];
    for (let i = 0; i < 15; i++) {
      const ticker = `INU${i}`;
      tickers.push(ticker);
      allCandles.push(...flatHistory(ticker, 30, 100, {
        startDayIdx: 24, endDayIdx: 29, endPrice: 130,
      }));
    }
    const db = makeDb({ "ticker_candles": allCandles, "trades": [] });
    const kv = makeKv();
    await kv.put("timed:tickers", JSON.stringify(tickers)); // all in universe
    const env = makeEnv({ db, kv });
    await runMoveDiscovery(env);
    const stored = JSON.parse(kv._store.get("timed:move-discovery"));
    expect(stored.recommendations.some((r) => r.id === "lower_investor_accumulate_strong_score")).toBe(true);
  });

  it("normalizes ts in candle rows when DB returns seconds instead of ms", async () => {
    /* Defensive: even if old rows somehow stored seconds, we should
       not crash. The function detects ts < 1e12 and multiplies. */
    const sec = Math.floor(Date.now() / 1000);
    const candles = [];
    for (let i = 0; i < 25; i++) {
      candles.push({ ticker: "OLDFMT", ts: sec - i * 86400, o: 100, h: 100.5, l: 99.5, c: 100, v: 0 });
    }
    /* These rows have ts < sinceTsMs after the seconds-vs-ms gate
       (the function multiplies them, so they're in the recent window).
       But our query mock returns them anyway since the mock doesn't
       apply the WHERE. The runtime gate inside the function handles
       this without throwing. */
    const db = makeDb({ "ticker_candles": candles, "trades": [] });
    const result = await runMoveDiscovery(makeEnv({ db, kv: makeKv() }));
    expect(result.ok).toBe(true);
  });
});
