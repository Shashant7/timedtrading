// worker/foundation/candle-chain-shard.js
// ─────────────────────────────────────────────────────────────────────────────
//  FOUNDATION — Candle Chain SHARD core (Phase 1b of
//  tasks/2026-06-14-foundation-rebuild-plan.md).
//
//  Per-SHARD ownership: each shard owns a fixed slice of the universe (stable
//  hash), and within it owns each ticker's 5m base + daily base as the single
//  source from which every timeframe is derived. This is the pure,
//  storage-injected core; the Durable Object (candle-chain-do.js) is a thin
//  adapter that passes its own storage in. Keeping the logic here makes it unit-
//  testable without the Workers runtime and keeps the DO replaceable.
//
//  Storage model (values are capped at 128 KiB in DO SQLite storage, so the 5m
//  base is chunked by ET session — which also makes retention a clean key drop):
//    b5:<TICKER>:<YYYY-MM-DD>  -> that session's 5m bars (array)
//    bd:<TICKER>               -> daily bars (array; small)
//
//  Storage adapter interface (async): get(key), put(key,val), delete(key),
//  list(prefix) -> Map<key,val>.
// ─────────────────────────────────────────────────────────────────────────────

import { ingestBase, normalizeDailyBars, canonicalDailyTs, deriveTimeframe, checkBaseIntegrity, hotWindowStartMs } from "./candle-chain.js";
import { etDateStr } from "./trading-calendar.js";
import { reconcileDailyRollup, crossSourceConsensus } from "./reconcile.js";

/** Stable FNV-1a hash → shard index. Deterministic across runs/machines. */
export function shardForTicker(ticker, numShards = 16) {
  const s = String(ticker || "").toUpperCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % numShards;
}

const b5Key = (t, day) => `b5:${t}:${day}`;
const bdKey = (t) => `bd:${t}`;

export class CandleChainShardCore {
  /** @param {{get,put,delete,list}} storage  @param {object} [opts] */
  constructor(storage, opts = {}) {
    this.storage = storage;
    this.retentionTradingDays = Number(opts.retentionTradingDays) || 150;
    // DORMANT by default. When true, every 5m/D ingest also runs the base-
    // fidelity shadow gate (reconcileDailyRollup [+ crossSourceConsensus]) and
    // records the report — it NEVER blocks or alters the write. Phase 1 shadow.
    this.gateOnIngest = opts.gateOnIngest === true;
  }

  /**
   * Ingest provider bars. tf "5" → chunked-by-session 5m base; tf "D" → daily
   * base. Other TFs are ignored (they are DERIVED, never stored). Idempotent.
   *
   * @param {Object} [opts] { gate?:boolean, fidelity?:object }  gate=true runs the
   *   base-fidelity shadow gate after the write (also honored via gateOnIngest).
   */
  async ingest(ticker, tf, bars, opts = {}) {
    const t = String(ticker).toUpperCase();
    if (!Array.isArray(bars) || bars.length === 0) return { written: 0 };
    const maybeGate = async (result) => {
      if (this.gateOnIngest || opts.gate === true) {
        // shadow: report-only, must never throw into the ingest path
        result.fidelity = await this.runShadowGate(t, {}, opts.fidelity || {});
      }
      return result;
    };
    if (String(tf) === "5") {
      const byDay = new Map();
      for (const b of bars) {
        if (!b || !Number.isFinite(Number(b.ts))) continue;
        const day = etDateStr(Number(b.ts));
        (byDay.get(day) || byDay.set(day, []).get(day)).push(b);
      }
      let written = 0;
      for (const [day, dayBars] of byDay) {
        const key = b5Key(t, day);
        const existing = (await this.storage.get(key)) || [];
        const merged = ingestBase(existing, dayBars);
        await this.storage.put(key, merged);
        written += merged.length;
      }
      return maybeGate({ written, days: byDay.size });
    }
    if (String(tf) === "D") {
      const key = bdKey(t);
      const existing = (await this.storage.get(key)) || [];
      // Normalize to the canonical daily anchor + dedup, so a trading day has
      // exactly ONE bar regardless of provider stamp convention (kills the
      // 00:00Z/04:00Z double-write). Idempotent across re-ingest.
      const merged = normalizeDailyBars([...existing, ...bars]);
      await this.storage.put(key, merged);
      return maybeGate({ written: merged.length });
    }
    return { written: 0, ignored: String(tf) };
  }

  /**
   * Load the contiguous 5m base across [startMs, endMs) from session chunks.
   *
   * ADDITIVE READ: the day-chunk keys are date-stamped (`b5:<T>:<YYYY-MM-DD>`), so
   * we fetch ONLY the chunks whose date falls in the window (a bounded set of
   * point-gets) instead of `storage.list`-ing the ENTIRE retained base (~150 days)
   * on every read. A new bar only ever lands in today's chunk, so serving a 50-day
   * score window must not re-scan 150 days × 255 tickers × every cron tick — that
   * O(full-history) read is what overloaded the cron and dropped scoring back to
   * stale legacy. Falls back to a prefix list only if the window is unbounded.
   */
  async loadBase5(ticker, startMs, endMs) {
    const t = String(ticker).toUpperCase();
    const out = [];
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      const DAY = 24 * 60 * 60 * 1000;
      // ET date keys spanning the window (±1 day cushions session/DST edges).
      const days = new Set();
      for (let ms = startMs - DAY; ms <= endMs + DAY; ms += DAY) days.add(etDateStr(ms));
      const chunks = await Promise.all([...days].map((d) => this.storage.get(b5Key(t, d))));
      for (const chunk of chunks) {
        if (!Array.isArray(chunk)) continue;
        for (const b of chunk) if (b.ts >= startMs && b.ts < endMs) out.push(b);
      }
      return out.sort((a, b) => a.ts - b.ts);
    }
    // Unbounded fallback (no window) — full scan.
    const map = await this.storage.list(`b5:${t}:`);
    for (const [, dayBars] of map) {
      if (!Array.isArray(dayBars)) continue;
      for (const b of dayBars) out.push(b);
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  async loadBaseDaily(ticker) {
    return (await this.storage.get(bdKey(String(ticker).toUpperCase()))) || [];
  }

  /** Derive a timeframe's SeriesView from the stored bases. */
  async getSeries(ticker, tf, { startMs, endMs, asOf, source = "live" }) {
    const t = String(ticker).toUpperCase();
    const base5 = await this.loadBase5(t, startMs, endMs);
    const baseDaily = await this.loadBaseDaily(t);
    return deriveTimeframe(tf, { ticker: t, base5m: base5, baseDaily, asOf: asOf ?? endMs, windowStartMs: startMs, windowEndMs: endMs, source });
  }

  /**
   * Derive MANY timeframes in ONE pass: load the 5m base + daily base ONCE, then
   * derive each requested TF from the in-memory base. This is what the live score
   * path calls per ticker — the per-TF getSeries() path did a FULL storage.list
   * per TF (4× for LTF), and returned each view's full history (~8.5k bars/ticker,
   * ~1 MB), which intermittently failed under the 255-ticker cron and dropped
   * scoring back to STALE legacy → freshness quarantine. Here we list once and
   * cap each view to the last `cap` bars so the response stays small + reliable.
   */
  async getSeriesMulti(ticker, tfs, { startMs, endMs, asOf, source = "live", cap = 0 } = {}) {
    const t = String(ticker).toUpperCase();
    const base5 = await this.loadBase5(t, startMs, endMs);      // ONE list, not one-per-TF
    const baseDaily = await this.loadBaseDaily(t);
    const views = {};
    for (const tf of tfs) {
      const view = deriveTimeframe(tf, { ticker: t, base5m: base5, baseDaily, asOf: asOf ?? endMs, windowStartMs: startMs, windowEndMs: endMs, source });
      if (cap > 0 && view && Array.isArray(view.bars) && view.bars.length > cap) {
        view.bars = view.bars.slice(-cap); // keep the freshest `cap` bars; shrinks payload
      }
      views[tf] = view;
    }
    return views;
  }

  /** Integrity of the 5m base (the single freshness point) over a window. */
  async integrity(ticker, { startMs, endMs }) {
    const base5 = await this.loadBase5(ticker, startMs, endMs);
    return checkBaseIntegrity(base5, { startMs, endMs });
  }

  /**
   * Base-FIDELITY self-check (the "calculated vs source" guarantee): roll up the
   * 5m base per day and compare High/Low/Volume to the stored provider daily
   * bar. Any missing/extra/bad 5m bar surfaces here, anchor-independently.
   */
  async reconcileDaily(ticker, { startMs, endMs }, opts) {
    const base5 = await this.loadBase5(ticker, startMs, endMs);
    const daily = await this.loadBaseDaily(ticker);
    return reconcileDailyRollup(base5, daily, opts);
  }

  /**
   * Cross-source consensus of THIS chain's daily bars against one or more
   * alternate-provider daily series (e.g. { alpaca:[bars], web:[bars] }), keyed
   * by canonical trading day. Per the source-of-truth policy: where >= quorum
   * sources agree on H/L/C that is ground truth; disagreements are flagged for
   * audit (never silently overwritten). Pure aggregation over crossSourceConsensus.
   */
  _consensusAgainstDaily(chainDaily, altDailyMap, opts = {}) {
    const byDay = (bars) => {
      const m = new Map();
      for (const b of bars || []) {
        if (!b || !Number.isFinite(Number(b.ts))) continue;
        m.set(canonicalDailyTs(Number(b.ts)), b);
      }
      return m;
    };
    const chain = byDay(chainDaily);
    const alts = {};
    for (const [name, bars] of Object.entries(altDailyMap || {})) alts[name] = byDay(bars);
    let days = 0, agreed = 0;
    const disagreements = [];
    const outlierCounts = {};
    for (const [day, cBar] of chain) {
      const sources = { chain: cBar };
      for (const [name, m] of Object.entries(alts)) { const b = m.get(day); if (b) sources[name] = b; }
      if (Object.keys(sources).length < (opts.quorum ?? 2)) continue;
      days++;
      const con = crossSourceConsensus(sources, opts);
      if (con.agreed) agreed++;
      else disagreements.push({ ts: day, field_agreement: con.field_agreement, sources: con.sources });
      for (const o of con.outliers) outlierCounts[o] = (outlierCounts[o] || 0) + 1;
    }
    return {
      ok: disagreements.length === 0,
      days, agreed,
      agreement_pct: days ? +(100 * agreed / days).toFixed(2) : null,
      disagreements: disagreements.slice(0, 50),
      outlier_counts: outlierCounts,
    };
  }

  /**
   * BASE-FIDELITY report (the gate the chain runs in shadow): the internal
   * roll-up completeness check (reconcileDailyRollup) plus, when alternate-
   * provider daily bars are supplied, cross-source consensus. Report-only.
   *
   * @param {string} ticker
   * @param {{startMs?:number,endMs?:number}} [window]  defaults to the stored 5m span
   * @param {Object} [opts] { reconcile?:object, altDaily?:object, consensus?:object, asOf?:number }
   */
  async baseFidelity(ticker, window = {}, opts = {}) {
    const t = String(ticker).toUpperCase();
    let { startMs, endMs } = window;
    if (startMs == null || endMs == null) {
      const map = await this.storage.list(`b5:${t}:`);
      let min = Infinity, max = -Infinity;
      for (const [, dayBars] of map) for (const b of dayBars) { if (b.ts < min) min = b.ts; if (b.ts > max) max = b.ts; }
      if (startMs == null) startMs = Number.isFinite(min) ? min : 0;
      if (endMs == null) endMs = Number.isFinite(max) ? max + 1 : (opts.asOf ?? Date.now());
    }
    const base5 = await this.loadBase5(t, startMs, endMs);
    const daily = await this.loadBaseDaily(t);
    const reconcile = reconcileDailyRollup(base5, daily, opts.reconcile || {});
    const consensus = (opts.altDaily && typeof opts.altDaily === "object")
      ? this._consensusAgainstDaily(daily, opts.altDaily, opts.consensus || {})
      : null;
    return {
      ok: reconcile.ok && (!consensus || consensus.ok),
      checked_at: opts.asOf ?? Date.now(),
      window: { startMs, endMs },
      reconcile,
      consensus,
    };
  }

  /**
   * Run baseFidelity in SHADOW: persist the latest report to `fid:<TICKER>` and
   * NEVER throw (a fidelity failure must not break ingestion). Returns the report.
   */
  async runShadowGate(ticker, window = {}, opts = {}) {
    const t = String(ticker).toUpperCase();
    let report;
    try {
      report = await this.baseFidelity(t, window, opts);
    } catch (e) {
      report = { ok: null, error: String(e?.message || e).slice(0, 200), checked_at: Date.now() };
    }
    try { await this.storage.put(`fid:${t}`, report); } catch { /* best-effort */ }
    return report;
  }

  /** Read the last persisted base-fidelity shadow report for a ticker. */
  async lastFidelity(ticker) {
    return (await this.storage.get(`fid:${String(ticker).toUpperCase()}`)) || null;
  }

  /** List the tickers this shard currently holds 5m base for. */
  async listTickers() {
    const map = await this.storage.list("b5:");
    const set = new Set();
    for (const key of map.keys()) {
      const parts = key.split(":"); // b5:TICKER:DATE
      if (parts.length >= 3) set.add(parts[1]);
    }
    return [...set].sort();
  }

  /**
   * Drop 5m session chunks older than the bounded hot window (cold bars are
   * expected to have been shipped to R2 first). Keeps the D1/DO footprint
   * constant per plan §3.6. Returns the keys dropped.
   */
  async retentionSweep(ticker, asOf) {
    const t = String(ticker).toUpperCase();
    const cutoff = hotWindowStartMs(asOf, this.retentionTradingDays);
    const cutoffDay = etDateStr(cutoff);
    const map = await this.storage.list(`b5:${t}:`);
    const dropped = [];
    for (const key of map.keys()) {
      const day = key.split(":")[2];
      if (day && day < cutoffDay) { await this.storage.delete(key); dropped.push(key); }
    }
    return { dropped, cutoffDay };
  }
}
