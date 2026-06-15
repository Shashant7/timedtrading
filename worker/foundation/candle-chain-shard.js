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

import { ingestBase, deriveTimeframe, checkBaseIntegrity, hotWindowStartMs } from "./candle-chain.js";
import { etDateStr } from "./trading-calendar.js";

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
  }

  /**
   * Ingest provider bars. tf "5" → chunked-by-session 5m base; tf "D" → daily
   * base. Other TFs are ignored (they are DERIVED, never stored). Idempotent.
   */
  async ingest(ticker, tf, bars) {
    const t = String(ticker).toUpperCase();
    if (!Array.isArray(bars) || bars.length === 0) return { written: 0 };
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
      return { written, days: byDay.size };
    }
    if (String(tf) === "D") {
      const key = bdKey(t);
      const existing = (await this.storage.get(key)) || [];
      const merged = ingestBase(existing, bars);
      await this.storage.put(key, merged);
      return { written: merged.length };
    }
    return { written: 0, ignored: String(tf) };
  }

  /** Load the contiguous 5m base across [startMs, endMs) from session chunks. */
  async loadBase5(ticker, startMs, endMs) {
    const t = String(ticker).toUpperCase();
    const map = await this.storage.list(`b5:${t}:`);
    const out = [];
    for (const [, dayBars] of map) {
      for (const b of dayBars) {
        if (b.ts >= startMs && b.ts < endMs) out.push(b);
      }
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

  /** Integrity of the 5m base (the single freshness point) over a window. */
  async integrity(ticker, { startMs, endMs }) {
    const base5 = await this.loadBase5(ticker, startMs, endMs);
    return checkBaseIntegrity(base5, { startMs, endMs });
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
