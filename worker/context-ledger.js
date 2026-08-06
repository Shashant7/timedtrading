// worker/context-ledger.js
//
// Ticker Context Ledger — Phase 0 of the context-first scoring plan
// (tasks/2026-08-05-context-first-scoring-plan.md).
//
// History as IMMUTABLE FACTS: append-only D1 `ticker_context_facts` +
// a compact per-ticker rollup that can ride the hot path. Structural
// anchors (the ANET Daily-21 / CAT Weekly-retest memory class) are
// DERIVED from facts here instead of hand-stamped per incident.
//
// Fact kinds:
//   position_event  — every entry / trim / exit with price + reason
//   structural_test — anchor tested → held / failed / pending, with resolution
//   move            — weekly moves (≥ minPct) from candles / discovery
//   autopsy_verdict — operator or autopsy gradings (seeded, then automated)
//   operator_note   — dated operator notes ("Breakout retest Caterpillar Play")
//
// Immutability contract: facts are INSERT OR IGNORE only. Corrections are
// new facts carrying `supersedes`. Every fact's `ts` is when it HAPPENED,
// so replays can filter `ts <= replay_now` (no lookahead).

import { emaSeries, superTrendSeries } from "./indicators.js";
import { detectWeeklyMoves } from "./discovery/weekly-move-autopsy.js";
import { computeOptimalWindow } from "./discovery/optimal-window.js";

const DAY_MS = 86400000;

export const CONTEXT_FACT_KINDS = Object.freeze([
  "position_event",
  "structural_test",
  "move",
  "autopsy_verdict",
  "operator_note",
]);

/** Anchors tracked for structural tests. */
export const CONTEXT_ANCHORS = Object.freeze({
  W_EMA21: { tf: "W", kind: "ema21", bandPct: 3.5, resolveBars: 3 },
  W_ST: { tf: "W", kind: "supertrend", bandPct: 3.5, resolveBars: 3 },
  D_EMA21: { tf: "D", kind: "ema21", bandPct: 1.5, resolveBars: 5 },
});

export async function ensureContextFactsTable(db) {
  if (!db) return false;
  await db.prepare(`CREATE TABLE IF NOT EXISTS ticker_context_facts (
    fact_id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    kind TEXT NOT NULL,
    ts INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    source TEXT,
    supersedes TEXT,
    created_at INTEGER NOT NULL
  )`).run();
  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_ctx_facts_ticker_ts ON ticker_context_facts (ticker, ts)`,
  ).run();
  return true;
}

export function contextFactId(ticker, kind, key) {
  return `${String(ticker).toUpperCase()}:${kind}:${key}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Candle hygiene — ticker_candles carries near-duplicate rows per bucket
// (UTC-midnight vs session-offset ts). Dedupe by NY date (D) / NY week (W),
// keeping the row with the LATEST ts in each bucket.
// ─────────────────────────────────────────────────────────────────────────────

function nyDateKey(ms) {
  return new Date(Number(ms)).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function utcWeekBucket(ms) {
  // Weekly duplicate rows differ by a few hours around UTC Monday 00:00
  // (session-offset vs midnight variants). A UTC Monday-anchored bucket
  // groups them correctly; an NY-week bucket would split the pair that
  // straddles Sunday-NY / Monday-NY.
  const d = new Date(Number(ms));
  const dow = d.getUTCDay();
  const sinceMon = (dow + 6) % 7;
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return new Date(utcMidnight - sinceMon * DAY_MS).toISOString().slice(0, 10);
}

export function dedupeCandles(candles = [], tf = "D") {
  const keyFn = tf === "W" ? utcWeekBucket : nyDateKey;
  const byKey = new Map();
  for (const c of candles || []) {
    const ts = Number(c.ts ?? c.t);
    if (!Number.isFinite(ts)) continue;
    const k = keyFn(ts);
    const prev = byKey.get(k);
    if (!prev || ts > Number(prev.ts ?? prev.t)) byKey.set(k, c);
  }
  return [...byKey.values()].sort((a, b) => Number(a.ts ?? a.t) - Number(b.ts ?? b.t));
}

// ─────────────────────────────────────────────────────────────────────────────
// Fact builders (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * position_event facts from trader `trades` rows + investor lots.
 * One fact per event (trade entry, trade exit, investor lot).
 */
export function buildPositionEventFacts({ ticker, trades = [], investorLots = [], investorPositions = [] } = {}) {
  const sym = String(ticker || "").toUpperCase();
  const facts = [];
  const posById = {};
  for (const p of investorPositions || []) posById[p.id] = p;

  for (const t of trades || []) {
    const id = t.trade_id || t.id;
    if (!id) continue;
    const entryTs = Number(t.entry_ts);
    if (Number.isFinite(entryTs) && entryTs > 0) {
      facts.push({
        fact_id: contextFactId(sym, "position_event", `trade:${id}:ENTRY`),
        ticker: sym,
        kind: "position_event",
        ts: entryTs,
        source: "trades",
        payload: {
          lane: "trader",
          event: "ENTRY",
          direction: t.direction || "LONG",
          price: Number(t.entry_price) || null,
          setup: t.setup_name || t.entry_path || null,
        },
      });
    }
    const exitTs = Number(t.exit_ts);
    if (Number.isFinite(exitTs) && exitTs > 0) {
      facts.push({
        fact_id: contextFactId(sym, "position_event", `trade:${id}:EXIT`),
        ticker: sym,
        kind: "position_event",
        ts: exitTs,
        source: "trades",
        payload: {
          lane: "trader",
          event: "EXIT",
          direction: t.direction || "LONG",
          price: Number(t.exit_price) || null,
          reason: t.exit_reason || null,
          pnl_pct: Number.isFinite(Number(t.pnl_pct)) ? Math.round(Number(t.pnl_pct) * 100) / 100 : null,
          outcome: t.status || null,
        },
      });
    }
  }

  for (const lot of investorLots || []) {
    const id = lot.id;
    const ts = Number(lot.ts);
    if (!id || !Number.isFinite(ts)) continue;
    const pos = posById[lot.position_id] || {};
    const action = String(lot.action || "").toUpperCase();
    const avgEntry = Number(pos.avg_entry) || null;
    const price = Number(lot.price) || null;
    let pnlPct = null;
    if (action === "SELL" && avgEntry > 0 && price > 0) {
      pnlPct = Math.round(((price - avgEntry) / avgEntry) * 10000) / 100;
    }
    facts.push({
      fact_id: contextFactId(sym, "position_event", `lot:${id}`),
      ticker: sym,
      kind: "position_event",
      ts,
      source: "investor_lots",
      payload: {
        lane: "investor",
        event: action === "BUY" ? "ENTRY" : "EXIT",
        action,
        price,
        shares: Number(lot.shares) || null,
        reason: lot.reason || null,
        position_id: lot.position_id || null,
        avg_entry: avgEntry,
        pnl_pct: pnlPct,
      },
    });
  }
  return facts;
}

/**
 * structural_test facts: for each anchor (Weekly EMA21 / Weekly ST / Daily
 * EMA21), find bars where the low tested the level from above and resolve
 * held / failed / pending by looking at subsequent closes. The look-ahead
 * here is legitimate — these are HISTORICAL facts and the resolution ts is
 * stamped, so replays still see only what had resolved by their `now`.
 */
export function detectStructuralTestFacts({ ticker, weeklyCandles = [], dailyCandles = [], sinceTs = 0 } = {}) {
  const sym = String(ticker || "").toUpperCase();
  const facts = [];
  const w = dedupeCandles(weeklyCandles, "W");
  const d = dedupeCandles(dailyCandles, "D");

  const seriesFor = (anchorKey) => {
    const spec = CONTEXT_ANCHORS[anchorKey];
    const bars = (spec.tf === "W" ? w : d).map((c) => ({
      ts: Number(c.ts ?? c.t), o: Number(c.o ?? c.open), h: Number(c.h ?? c.high),
      l: Number(c.l ?? c.low), c: Number(c.c ?? c.close),
    })).filter((b) => Number.isFinite(b.c) && b.c > 0);
    if (bars.length < 25) return null;
    let levels;
    if (spec.kind === "ema21") {
      levels = emaSeries(bars.map((b) => b.c), 21);
    } else {
      const st = superTrendSeries(bars, 3.0, 10);
      // Support role only — the line is support while direction is bull (-1).
      levels = st.line.map((v, i) => (st.dir[i] === -1 ? v : NaN));
    }
    return { spec, bars, levels };
  };

  for (const anchorKey of Object.keys(CONTEXT_ANCHORS)) {
    const s = seriesFor(anchorKey);
    if (!s) continue;
    const { spec, bars, levels } = s;
    const band = spec.bandPct / 100;
    let lastTestIdx = -10;
    for (let i = 1; i < bars.length; i++) {
      const lvl = levels[i];
      if (!Number.isFinite(lvl) || lvl <= 0) continue;
      const prevClose = bars[i - 1].c;
      const prevLvl = Number.isFinite(levels[i - 1]) ? levels[i - 1] : lvl;
      // Anchor is in a support role: prior close above it.
      if (!(prevClose > prevLvl)) continue;
      const touched = bars[i].l <= lvl * (1 + band) && bars[i].l >= lvl * (1 - band * 1.5);
      if (!touched) continue;
      // Merge consecutive test bars into one event.
      if (i - lastTestIdx <= 1) { lastTestIdx = i; continue; }
      lastTestIdx = i;
      if (bars[i].ts < sinceTs) continue;

      // Resolve: within resolveBars, does a close land back at/above the level?
      let resolution = "pending";
      let resolvedTs = null;
      let barsToResolve = null;
      if (bars[i].c >= lvl) {
        resolution = "held";
        resolvedTs = bars[i].ts;
        barsToResolve = 0;
      } else {
        for (let j = i + 1; j <= Math.min(i + spec.resolveBars, bars.length - 1); j++) {
          const lvlJ = Number.isFinite(levels[j]) ? levels[j] : lvl;
          if (bars[j].c >= lvlJ) {
            resolution = "held";
            resolvedTs = bars[j].ts;
            barsToResolve = j - i;
            break;
          }
        }
        if (resolution === "pending" && bars.length - 1 - i >= spec.resolveBars) {
          resolution = "failed";
          resolvedTs = bars[Math.min(i + spec.resolveBars, bars.length - 1)].ts;
          barsToResolve = spec.resolveBars;
        }
      }

      facts.push({
        fact_id: contextFactId(sym, "structural_test", `${anchorKey}:${bars[i].ts}`),
        ticker: sym,
        kind: "structural_test",
        ts: bars[i].ts,
        source: "candles",
        payload: {
          anchor: anchorKey,
          tf: spec.tf,
          level: Math.round(lvl * 100) / 100,
          low: Math.round(bars[i].l * 100) / 100,
          close: Math.round(bars[i].c * 100) / 100,
          resolution,
          resolved_ts: resolvedTs,
          bars_to_resolve: barsToResolve,
        },
      });
    }
  }
  return facts;
}

/** move facts — weekly moves ≥ minPct from daily candles. */
export function buildMoveFacts(ticker, dailyCandles = [], { minPct = 8, sinceTs = 0 } = {}) {
  const sym = String(ticker || "").toUpperCase();
  const moves = detectWeeklyMoves(dedupeCandles(dailyCandles, "D"), { minPct });
  const facts = [];
  for (const m of moves) {
    const ts = Number(m.last_ts || m.first_ts);
    if (!Number.isFinite(ts) || ts < sinceTs) continue;
    facts.push({
      fact_id: contextFactId(sym, "move", `${m.week_key}:${m.direction}`),
      ticker: sym,
      kind: "move",
      ts,
      source: "discovery",
      payload: {
        week_key: m.week_key,
        direction: m.direction,
        move_pct: m.move_pct,
        oc_pct: m.oc_pct,
        range_pct: m.range_pct,
        days: m.days,
        first_ts: m.first_ts,
        last_ts: m.last_ts,
      },
    });
  }
  return facts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anchors + rollup (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive structural respect memory from facts. An anchor earns `respect`
 * after >= 2 held tests with no fails inside the lookback (default 180d).
 * This generalizes INVESTOR_STRUCTURAL_ANCHORS — no more PR per incident.
 */
export function deriveStructuralAnchors(facts = [], { now = Date.now(), lookbackDays = 180 } = {}) {
  const since = now - lookbackDays * DAY_MS;
  const byAnchor = {};
  for (const f of facts) {
    if (f.kind !== "structural_test") continue;
    const p = f.payload || {};
    if (Number(f.ts) < since) continue;
    const a = (byAnchor[p.anchor] = byAnchor[p.anchor] || { tested: 0, held: 0, failed: 0, last_ts: 0, last_resolution: null });
    a.tested += 1;
    if (p.resolution === "held") a.held += 1;
    else if (p.resolution === "failed") a.failed += 1;
    if (Number(f.ts) > a.last_ts) {
      a.last_ts = Number(f.ts);
      a.last_resolution = p.resolution;
    }
  }
  const out = {};
  for (const [anchor, a] of Object.entries(byAnchor)) {
    out[anchor] = {
      ...a,
      respect: a.held >= 2 && a.failed === 0,
    };
  }
  return out;
}

/** Compact per-ticker rollup — must stay small (hot-path artifact). */
export function rollupTickerContext({ ticker, facts = [], windowDays = 30, leadinDays = 5, now = Date.now() } = {}) {
  const sym = String(ticker || "").toUpperCase();
  const anchors = deriveStructuralAnchors(facts, { now });

  const posEvents = facts
    .filter((f) => f.kind === "position_event")
    .sort((a, b) => Number(b.ts) - Number(a.ts));
  const lastExit = posEvents.find((f) => f.payload?.event === "EXIT");
  const lastEntry = posEvents.find((f) => f.payload?.event === "ENTRY");

  const tests = facts
    .filter((f) => f.kind === "structural_test")
    .sort((a, b) => Number(b.ts) - Number(a.ts))
    .slice(0, 6)
    .map((f) => ({
      anchor: f.payload?.anchor,
      ts: Number(f.ts),
      level: f.payload?.level,
      resolution: f.payload?.resolution,
    }));

  const moves = facts.filter((f) => f.kind === "move");
  const movePcts = moves.map((f) => Math.abs(Number(f.payload?.move_pct))).filter(Number.isFinite).sort((a, b) => a - b);
  const medianMovePct = movePcts.length ? movePcts[Math.floor(movePcts.length / 2)] : null;

  const notes = facts
    .filter((f) => f.kind === "operator_note" || f.kind === "autopsy_verdict")
    .sort((a, b) => Number(b.ts) - Number(a.ts))
    .slice(0, 3)
    .map((f) => ({ ts: Number(f.ts), kind: f.kind, note: String(f.payload?.note || "").slice(0, 200) }));

  return {
    v: 1,
    ticker: sym,
    updated: now,
    window_days: windowDays,
    leadin_days: leadinDays,
    anchors,
    last_entry: lastEntry ? {
      ts: Number(lastEntry.ts), lane: lastEntry.payload?.lane,
      price: lastEntry.payload?.price, reason: lastEntry.payload?.reason || lastEntry.payload?.setup || null,
    } : null,
    last_exit: lastExit ? {
      ts: Number(lastExit.ts), lane: lastExit.payload?.lane,
      price: lastExit.payload?.price, reason: lastExit.payload?.reason || null,
      pnl_pct: lastExit.payload?.pnl_pct ?? null,
    } : null,
    position_events_n: posEvents.length,
    recent_tests: tests,
    moves: { n: moves.length, median_pct: medianMovePct },
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// D1 persistence
// ─────────────────────────────────────────────────────────────────────────────

export async function appendContextFacts(db, facts = []) {
  if (!db || !facts.length) return { inserted: 0 };
  let inserted = 0;
  const now = Date.now();
  const BATCH = 20;
  for (let i = 0; i < facts.length; i += BATCH) {
    const chunk = facts.slice(i, i + BATCH);
    const stmts = chunk.map((f) => db.prepare(
      `INSERT OR IGNORE INTO ticker_context_facts
         (fact_id, ticker, kind, ts, payload_json, source, supersedes, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(
      f.fact_id, f.ticker, f.kind, Number(f.ts),
      JSON.stringify(f.payload || {}), f.source || null, f.supersedes || null, now,
    ));
    const results = await db.batch(stmts);
    for (const r of results) inserted += Number(r?.meta?.changes) || 0;
  }
  return { inserted };
}

export async function readContextFacts(db, ticker, { sinceTs = 0, upToTs = null, limit = 500 } = {}) {
  if (!db) return [];
  const sym = String(ticker || "").toUpperCase();
  const upper = Number.isFinite(Number(upToTs)) && upToTs != null ? Number(upToTs) : 8.64e15;
  const rows = (await db.prepare(
    `SELECT fact_id, ticker, kind, ts, payload_json, source, supersedes
       FROM ticker_context_facts
      WHERE ticker = ?1 AND ts >= ?2 AND ts <= ?3
      ORDER BY ts DESC LIMIT ?4`,
  ).bind(sym, Number(sinceTs) || 0, upper, Math.min(Math.max(Number(limit) || 500, 1), 2000)).all())?.results || [];
  return rows.map((r) => ({
    fact_id: r.fact_id,
    ticker: r.ticker,
    kind: r.kind,
    ts: Number(r.ts),
    source: r.source,
    supersedes: r.supersedes,
    payload: (() => { try { return JSON.parse(r.payload_json); } catch { return {}; } })(),
  }));
}

/** Persist the rollup: ticker_profiles.learning_json.context + KV mirror. */
export async function persistContextRollup(env, ticker, rollup) {
  const db = env?.DB;
  const sym = String(ticker || "").toUpperCase();
  if (db) {
    try {
      await db.prepare(`INSERT OR IGNORE INTO ticker_profiles (ticker) VALUES (?1)`).bind(sym).run();
      const row = await db.prepare(`SELECT learning_json FROM ticker_profiles WHERE ticker = ?1`).bind(sym).first();
      let learning = {};
      if (row?.learning_json) {
        try { learning = JSON.parse(row.learning_json) || {}; } catch { learning = {}; }
      }
      learning.context = rollup;
      await db.prepare(`UPDATE ticker_profiles SET learning_json = ?1 WHERE ticker = ?2`)
        .bind(JSON.stringify(learning), sym).run();
    } catch (e) {
      console.warn(`[CONTEXT] learning_json update failed for ${sym}:`, String(e?.message || e).slice(0, 140));
    }
  }
  const KV = env?.KV_TIMED;
  if (KV) {
    try {
      await KV.put(`timed:context:${sym}`, JSON.stringify(rollup), { expirationTtl: 14 * 86400 });
      await KV.delete(`timed:profile:${sym}`).catch(() => {});
    } catch { /* best-effort */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Backfill orchestration
// ─────────────────────────────────────────────────────────────────────────────

async function loadCandles(db, ticker, tf, limit) {
  const rows = (await db.prepare(
    `SELECT ts, o, h, l, c FROM ticker_candles
      WHERE ticker = ?1 AND tf = ?2
      ORDER BY ts DESC LIMIT ?3`,
  ).bind(ticker, tf, limit).all())?.results || [];
  return rows.reverse();
}

/** Backfill one ticker: build facts from D1 history, append, rollup, persist. */
export async function backfillTickerContext(env, ticker, { days = 180, now = Date.now(), discoveryMoves = [] } = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db" };
  const sym = String(ticker || "").toUpperCase();
  const sinceTs = now - days * DAY_MS;

  const [wCandles, dCandles, tradeRows, lotRows, posRows] = await Promise.all([
    loadCandles(db, sym, "W", 320),
    loadCandles(db, sym, "D", 300),
    db.prepare(
      `SELECT trade_id, direction, status, entry_ts, entry_price, exit_ts, exit_price,
              exit_reason, pnl_pct, setup_name, entry_path
         FROM trades
        WHERE ticker = ?1 AND (run_id IS NULL OR run_id = '') AND entry_ts >= ?2
        ORDER BY entry_ts DESC LIMIT 60`,
    ).bind(sym, sinceTs).all().then((r) => r?.results || []).catch(() => []),
    db.prepare(
      `SELECT id, position_id, action, shares, price, ts, reason
         FROM investor_lots WHERE ticker = ?1 AND ts >= ?2
        ORDER BY ts DESC LIMIT 80`,
    ).bind(sym, sinceTs).all().then((r) => r?.results || []).catch(() => []),
    db.prepare(
      `SELECT id, avg_entry, status FROM investor_positions WHERE ticker = ?1
        ORDER BY created_at DESC LIMIT 20`,
    ).bind(sym).all().then((r) => r?.results || []).catch(() => []),
  ]);

  if (!dCandles.length && !wCandles.length) {
    return { ok: false, ticker: sym, error: "no_candles" };
  }

  const facts = [
    ...buildPositionEventFacts({ ticker: sym, trades: tradeRows, investorLots: lotRows, investorPositions: posRows }),
    ...detectStructuralTestFacts({ ticker: sym, weeklyCandles: wCandles, dailyCandles: dCandles, sinceTs }),
    ...buildMoveFacts(sym, dCandles, { minPct: 8, sinceTs }),
  ];

  const { inserted } = await appendContextFacts(db, facts);

  // Window from ALL known move facts (not only this pass) so it stabilizes.
  // Weekly moves alone cap durations at ~5 days; merge Move Discovery's
  // multi-window (3-20d) ATR-scaled moves so the window reflects how long
  // this ticker's moves actually take to develop.
  const allFacts = await readContextFacts(db, sym, { sinceTs: now - 400 * DAY_MS, limit: 1000 });
  const moveDurations = allFacts
    .filter((f) => f.kind === "move")
    .map((f) => ({ duration_days: Number(f.payload?.days) }))
    .filter((m) => Number.isFinite(m.duration_days) && m.duration_days > 0);
  for (const m of discoveryMoves || []) {
    const d = Number(m.window ?? m.duration_days);
    if (Number.isFinite(d) && d > 0) moveDurations.push({ duration_days: d });
  }
  const win = computeOptimalWindow(moveDurations);

  const rollup = rollupTickerContext({
    ticker: sym, facts: allFacts, windowDays: win.window_days, leadinDays: win.leadin_days, now,
  });
  await persistContextRollup(env, sym, rollup);

  return {
    ok: true,
    ticker: sym,
    facts_built: facts.length,
    facts_inserted: inserted,
    facts_total: allFacts.length,
    window_days: win.window_days,
    anchors: rollup.anchors,
  };
}

/**
 * Backfill a batch of tickers sequentially (D1-storm safe: small jitter,
 * caller controls chunking via `tickers` / `max`).
 */
export async function runContextBackfill(env, { tickers = [], days = 180, max = 100, jitterMs = 60 } = {}) {
  const out = { ok: true, processed: 0, inserted: 0, errors: [], results: [] };
  const list = tickers.slice(0, Math.max(1, Math.min(Number(max) || 100, 400)));

  // One KV read for the whole batch: discovery moves grouped by ticker.
  let discoveryByTicker = {};
  try {
    const report = await env?.KV_TIMED?.get("timed:move-discovery", "json");
    for (const m of report?.moves || []) {
      const t = String(m.ticker || "").toUpperCase();
      if (t) (discoveryByTicker[t] = discoveryByTicker[t] || []).push(m);
    }
  } catch { discoveryByTicker = {}; }

  for (const t of list) {
    try {
      const r = await backfillTickerContext(env, t, { days, discoveryMoves: discoveryByTicker[String(t).toUpperCase()] || [] });
      out.processed += 1;
      if (r.ok) {
        out.inserted += r.facts_inserted || 0;
        out.results.push({ ticker: r.ticker, inserted: r.facts_inserted, window_days: r.window_days });
      } else {
        out.errors.push({ ticker: String(t).toUpperCase(), error: r.error });
      }
    } catch (e) {
      out.errors.push({ ticker: String(t).toUpperCase(), error: String(e?.message || e).slice(0, 140) });
    }
    if (jitterMs > 0) await new Promise((res) => setTimeout(res, jitterMs + Math.random() * jitterMs));
  }
  return out;
}
