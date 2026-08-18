// worker/options-marks.js
//
// Options Marks Ledger — Stage 1 of the index-options readiness plan
// (tasks/2026-08-18-index-options-readiness.md).
//
// Records the contract path of every published SPY / QQQ / IWM / DIA
// day-trade options play so the scorecard can grade the CONTRACT, not
// just the underlying. A direction that was right but killed by theta
// looks identical to a direction that missed when we only grade the
// underlying — this is the blindfold we are removing.
//
// Design:
//   • Append-only D1 table `option_marks`. One row per (signal_id,
//     option_symbol, ts).
//   • Live path: /5 tick snapshots the live chain via Alpaca (already
//     wired in worker/alpaca-options.js) for every open play.
//   • Backfill path: Alpaca options bars (`/v1beta1/options/bars`)
//     reconstruct the mark path for plays published up to 30d back.
//   • Resolver extension: consume marks alongside underlying bars in
//     the nightly signal-outcomes resolver — max-gain, max-drawdown,
//     realized close.
//
// SHADOW-ONLY. Nothing here routes to the bridge. Enable per-cron
// with `options_marks_enabled` in model_config.

import { alpacaFetchOptionsChain, parseOCCSymbol } from "./alpaca-options.js";

const TABLE = "option_marks";
const ALPACA_DATA_BASE = "https://data.alpaca.markets";

let _schemaReady = false;

/** Idempotent DDL. Cheap on the isolate-warm path. */
export async function ensureOptionMarksSchema(env) {
  if (_schemaReady || !env?.DB) return;
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        mark_id        TEXT PRIMARY KEY,
        signal_id      TEXT NOT NULL,
        ticker         TEXT NOT NULL,
        option_symbol  TEXT NOT NULL,
        right          TEXT NOT NULL,
        strike         REAL,
        expiration     TEXT,
        ts             INTEGER NOT NULL,
        bid            REAL,
        ask            REAL,
        mid            REAL,
        last           REAL,
        iv             REAL,
        delta          REAL,
        gamma          REAL,
        theta          REAL,
        vega           REAL,
        underlying     REAL,
        source         TEXT NOT NULL,
        created_at     INTEGER NOT NULL
      )
    `).run();
    await env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_option_marks_signal_ts ON ${TABLE}(signal_id, ts)`
    ).run().catch(() => {});
    await env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_option_marks_symbol_ts ON ${TABLE}(option_symbol, ts)`
    ).run().catch(() => {});
    await env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_option_marks_ticker_ts ON ${TABLE}(ticker, ts DESC)`
    ).run().catch(() => {});
    _schemaReady = true;
  } catch (e) {
    console.warn("[OPTION_MARKS] schema ensure failed:", String(e?.message || e).slice(0, 200));
  }
}

/** Test hook so a mocked D1 re-runs the CREATE. */
export function _resetOptionMarksSchemaCache() {
  _schemaReady = false;
}

const flagOn = (v) => v === true || String(v ?? "").toLowerCase() === "true";

/**
 * Default OFF. The whole stage is invisible until the operator flips
 * this in `model_config` — same discipline as the trade-review flags.
 */
export function optionMarksEnabled(env) {
  const cfg = env?._deepAuditConfig || {};
  return flagOn(cfg.options_marks_enabled ?? env?.OPTIONS_MARKS_ENABLED ?? false);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** OCC symbol builder: SPY251218C00450000 = SPY 2025-12-18 C 450.00. */
export function buildOccSymbol(ticker, expirationIso, right, strike) {
  const t = String(ticker || "").toUpperCase();
  const iso = String(expirationIso || "");
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!t || !m) return null;
  const yy = m[1].slice(2);
  const yymmdd = `${yy}${m[2]}${m[3]}`;
  const r = String(right || "").toUpperCase() === "PUT" ? "P" : String(right).toUpperCase() === "CALL" ? "C" : String(right).toUpperCase();
  if (r !== "C" && r !== "P") return null;
  const strikeInt = Math.round(Number(strike) * 1000);
  if (!Number.isFinite(strikeInt) || strikeInt <= 0) return null;
  const strikeStr = String(strikeInt).padStart(8, "0");
  return `${t}${yymmdd}${r}${strikeStr}`;
}

/**
 * Persist one mark row. Idempotent on (signal_id, option_symbol, ts).
 */
export async function writeMark(env, mark) {
  const db = env?.DB;
  if (!db || !mark?.signal_id || !mark?.option_symbol || !Number.isFinite(Number(mark.ts))) {
    return { ok: false, error: "bad_args" };
  }
  await ensureOptionMarksSchema(env);
  const markId = `${mark.signal_id}|${mark.option_symbol}|${Number(mark.ts)}`;
  try {
    await db.prepare(
      `INSERT OR IGNORE INTO ${TABLE}
         (mark_id, signal_id, ticker, option_symbol, right, strike, expiration, ts,
          bid, ask, mid, last, iv, delta, gamma, theta, vega, underlying,
          source, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)`
    ).bind(
      markId,
      String(mark.signal_id),
      String(mark.ticker || "").toUpperCase(),
      String(mark.option_symbol).toUpperCase(),
      String(mark.right || "").toUpperCase().slice(0, 1),
      num(mark.strike),
      mark.expiration ? String(mark.expiration).slice(0, 10) : null,
      Number(mark.ts),
      num(mark.bid),
      num(mark.ask),
      num(mark.mid),
      num(mark.last),
      num(mark.iv),
      num(mark.delta),
      num(mark.gamma),
      num(mark.theta),
      num(mark.vega),
      num(mark.underlying),
      String(mark.source || "alpaca"),
      Date.now(),
    ).run();
    return { ok: true, mark_id: markId };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Pull every mark for one signal (or a set of option symbols) inside a
 * time window. Returns rows ascending.
 */
export async function readMarks(env, { signalId, optionSymbol, fromTs, toTs, limit = 1000 } = {}) {
  const db = env?.DB;
  if (!db) return [];
  await ensureOptionMarksSchema(env);
  const where = [];
  const binds = [];
  if (signalId) { binds.push(String(signalId)); where.push(`signal_id = ?${binds.length}`); }
  if (optionSymbol) { binds.push(String(optionSymbol).toUpperCase()); where.push(`option_symbol = ?${binds.length}`); }
  if (Number.isFinite(Number(fromTs))) { binds.push(Number(fromTs)); where.push(`ts >= ?${binds.length}`); }
  if (Number.isFinite(Number(toTs))) { binds.push(Number(toTs)); where.push(`ts <= ?${binds.length}`); }
  const sql = `SELECT * FROM ${TABLE}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
                ORDER BY ts ASC LIMIT ?${binds.length + 1}`;
  binds.push(Math.max(1, Math.min(5000, Number(limit) || 1000)));
  try {
    const { results } = await db.prepare(sql).bind(...binds).all();
    return results || [];
  } catch {
    return [];
  }
}

/**
 * Compute the contract-side outcome from a mark path.
 *
 *   max_gain_pct     — best (mid - entry) / entry over the path, in %
 *   max_drawdown_pct — worst dip in % (negative)
 *   close_pct        — last mark relative to entry
 *   theta_realized_pct — close - max_gain, so a right-direction-that-
 *                       -bled shows large negative theta_realized
 *   tp_hit_25 / _50 / _100 — first ts that gain crossed 25/50/100%
 *
 * Pure. Input is entry premium + ascending marks; output is the deck's
 * summary block. Written to `signal_outcomes.payload_json`.
 */
export function computeOptionOutcome(entryMid, marks = []) {
  const entry = Number(entryMid);
  if (!(entry > 0) || !Array.isArray(marks) || marks.length === 0) return null;
  let maxMid = -Infinity;
  let minMid = Infinity;
  let maxTs = null;
  let minTs = null;
  const tps = { 25: null, 50: null, 100: null };
  for (const m of marks) {
    const mid = Number(m?.mid);
    const ts = Number(m?.ts);
    if (!Number.isFinite(mid) || !Number.isFinite(ts)) continue;
    if (mid > maxMid) { maxMid = mid; maxTs = ts; }
    if (mid < minMid) { minMid = mid; minTs = ts; }
    const gainPct = ((mid - entry) / entry) * 100;
    if (tps["25"] == null && gainPct >= 25) tps["25"] = ts;
    if (tps["50"] == null && gainPct >= 50) tps["50"] = ts;
    if (tps["100"] == null && gainPct >= 100) tps["100"] = ts;
  }
  if (!Number.isFinite(maxMid) || !Number.isFinite(minMid)) return null;
  const close = Number(marks[marks.length - 1]?.mid);
  const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  const maxGainPct = ((maxMid - entry) / entry) * 100;
  const maxDdPct = ((minMid - entry) / entry) * 100;
  const closePct = Number.isFinite(close) ? ((close - entry) / entry) * 100 : null;
  return {
    entry_mid: round2(entry),
    max_mid: round2(maxMid),
    min_mid: round2(minMid),
    close_mid: round2(close),
    max_gain_pct: round2(maxGainPct),
    max_drawdown_pct: round2(maxDdPct),
    close_pct: round2(closePct),
    theta_realized_pct: Number.isFinite(closePct) ? round2(closePct - maxGainPct) : null,
    max_gain_ts: maxTs,
    max_drawdown_ts: minTs,
    tp_hit_25: tps["25"],
    tp_hit_50: tps["50"],
    tp_hit_100: tps["100"],
    n_marks: marks.length,
  };
}

/**
 * Fetch options bars for one OCC symbol from Alpaca. Used by the
 * 30-day backfill — reconstructs the mark path from historical bars
 * for plays that predate the live snapshot cron.
 *
 * Alpaca returns 1-minute bars by default; we use `timeframe=5Min`
 * because the live cron writes ~5min snapshots and we want the
 * backfill grain to match.
 */
export async function fetchOptionBars(env, occSymbol, { start, end, timeframe = "5Min", limit = 1000 } = {}) {
  const keyId = env?.ALPACA_API_KEY_ID;
  const secret = env?.ALPACA_API_SECRET_KEY;
  if (!keyId || !secret || !occSymbol) return { ok: false, error: "bad_args" };
  const params = new URLSearchParams({
    timeframe,
    limit: String(Math.max(1, Math.min(10000, Number(limit) || 1000))),
  });
  if (start) params.set("start", new Date(Number(start) || start).toISOString());
  if (end) params.set("end", new Date(Number(end) || end).toISOString());
  const url = `${ALPACA_DATA_BASE}/v1beta1/options/bars/${encodeURIComponent(occSymbol)}?${params.toString()}`;
  try {
    const r = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": keyId,
        "APCA-API-SECRET-KEY": secret,
        "Accept": "application/json",
      },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { ok: false, error: `http_${r.status}`, body: body.slice(0, 200) };
    }
    const j = await r.json();
    const bars = Array.isArray(j?.bars) ? j.bars : [];
    return {
      ok: true,
      symbol: occSymbol,
      bars: bars.map((b) => ({
        ts: Date.parse(b?.t),
        o: num(b?.o),
        h: num(b?.h),
        l: num(b?.l),
        c: num(b?.c),
        v: num(b?.v),
      })).filter((b) => Number.isFinite(b.ts)),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Live snapshot: for one open signal, hit the chain, extract the leg,
 * append one mark row. Idempotent on ts to the second — a cron re-run
 * inside the same minute will not stack rows.
 */
export async function snapshotSignal(env, signal, now = Date.now()) {
  if (!signal?.signal_id || !signal.ticker || !signal.option_symbol) {
    return { ok: false, error: "bad_signal" };
  }
  const chain = await alpacaFetchOptionsChain(env, signal.ticker, signal.expiration, { skipOI: true });
  if (!chain?.ok) return { ok: false, error: chain?.error || "chain_fetch_failed" };
  const legs = signal.right === "C" ? chain.calls : chain.puts;
  const leg = (legs || []).find((l) => l.symbol === signal.option_symbol)
    || (legs || []).find((l) => Math.abs(Number(l.strike) - Number(signal.strike)) < 0.01);
  if (!leg) return { ok: false, error: "leg_not_in_chain" };
  const res = await writeMark(env, {
    signal_id: signal.signal_id,
    ticker: signal.ticker,
    option_symbol: leg.symbol,
    right: signal.right,
    strike: leg.strike,
    expiration: leg.expiration || signal.expiration,
    ts: Math.floor(now / 60000) * 60000, // minute-bucketed idempotency
    bid: leg.bid,
    ask: leg.ask,
    mid: leg.mid,
    last: leg.last,
    iv: leg.implied_volatility,
    delta: leg.delta,
    gamma: leg.gamma,
    theta: leg.theta,
    vega: leg.vega,
    underlying: chain.underlying_price,
    source: "live_chain",
  });
  return res;
}

/**
 * Backfill: for one open signal, pull the option bars and write one
 * mark row per bar. Safe to re-run — writeMark is idempotent.
 */
export async function backfillSignal(env, signal, { start, end } = {}) {
  if (!signal?.signal_id || !signal.option_symbol) return { ok: false, error: "bad_signal" };
  const res = await fetchOptionBars(env, signal.option_symbol, { start, end });
  if (!res.ok) return res;
  let written = 0;
  for (const bar of res.bars) {
    const w = await writeMark(env, {
      signal_id: signal.signal_id,
      ticker: signal.ticker,
      option_symbol: signal.option_symbol,
      right: signal.right,
      strike: signal.strike,
      expiration: signal.expiration,
      ts: bar.ts,
      mid: bar.c, // close of the bar is the best single mark
      last: bar.c,
      source: "backfill_bars",
    });
    if (w.ok) written += 1;
  }
  return { ok: true, symbol: signal.option_symbol, bars: res.bars.length, written };
}

/**
 * Aggregate scorecard rollup — pure. Input: a list of signal rows
 * joined with their outcome payload. Output: the numbers the operator
 * needs to see before flipping stage 4/5/8.
 */
export function summarizeScorecard(rows) {
  const buckets = {}; // key = `${ticker}|${tier || 'any'}|${conviction}`
  for (const r of rows || []) {
    if (!r) continue;
    const tk = String(r.ticker || "").toUpperCase();
    if (!tk) continue;
    const tier = r.tier || r.play_tier || "gamma";
    const conviction = r.conviction || r.day_lean_conviction || "unknown";
    const key = `${tk}|${tier}|${conviction}`;
    const b = (buckets[key] = buckets[key] || {
      ticker: tk, tier, conviction,
      n: 0, wins: 0, max_gain_sum: 0, max_dd_sum: 0, close_sum: 0,
      tp25: 0, tp50: 0, tp100: 0,
    });
    b.n += 1;
    const maxGain = Number(r.max_gain_pct);
    const maxDd = Number(r.max_drawdown_pct);
    const closePct = Number(r.close_pct);
    if (Number.isFinite(closePct) && closePct > 0) b.wins += 1;
    if (Number.isFinite(maxGain)) b.max_gain_sum += maxGain;
    if (Number.isFinite(maxDd)) b.max_dd_sum += maxDd;
    if (Number.isFinite(closePct)) b.close_sum += closePct;
    if (r.tp_hit_25) b.tp25 += 1;
    if (r.tp_hit_50) b.tp50 += 1;
    if (r.tp_hit_100) b.tp100 += 1;
  }
  const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  return Object.values(buckets).map((b) => ({
    ticker: b.ticker,
    tier: b.tier,
    conviction: b.conviction,
    n: b.n,
    win_rate: b.n ? Math.round((b.wins / b.n) * 100) : null,
    median_close_pct: round1(b.close_sum / b.n),
    avg_max_gain_pct: round1(b.max_gain_sum / b.n),
    avg_max_drawdown_pct: round1(b.max_dd_sum / b.n),
    tp25_rate: b.n ? Math.round((b.tp25 / b.n) * 100) : null,
    tp50_rate: b.n ? Math.round((b.tp50 / b.n) * 100) : null,
    tp100_rate: b.n ? Math.round((b.tp100 / b.n) * 100) : null,
  })).sort((a, b) => (b.n - a.n));
}
