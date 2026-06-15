// worker/foundation/candle-chain-do.js
// ─────────────────────────────────────────────────────────────────────────────
//  FOUNDATION — Candle Chain SHARD Durable Object (Phase 1b).
//
//  Thin adapter: wraps the pure CandleChainShardCore (candle-chain-shard.js)
//  with the DO's transactional storage. Each DO instance is one SHARD that owns
//  a fixed slice of the universe (stable hash → shard id) and, within it, each
//  ticker's 5m + daily base — the single source every timeframe is derived from.
//
//  Per-shard (not per-ticker) keeps the DO count bounded at the universe size.
//  Single-writer per shard gives a torn-series-free guarantee.
//
//  DORMANT by default: nothing schedules it (no cron). It only does work when
//  explicitly called via the shard stub / admin proxy. Zero live behavior change
//  until wired into the ingestion lane (a later, operator-reviewed step).
// ─────────────────────────────────────────────────────────────────────────────

import { CandleChainShardCore, shardForTicker } from "./candle-chain-shard.js";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export class CandleChainShard {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    const storage = {
      get: (k) => state.storage.get(k),
      put: (k, v) => state.storage.put(k, v),
      delete: (k) => state.storage.delete(k),
      list: (prefix) => state.storage.list({ prefix }),
    };
    this.core = new CandleChainShardCore(storage, {
      retentionTradingDays: Number(env?.CANDLE_CHAIN_RETENTION_DAYS) || 150,
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/ingest") {
        const b = await request.json();
        const ingestOpts = b.gate ? { gate: true, fidelity: b.fidelity || {} } : {};
        // serialize ingest so concurrent writes to a shard can't tear a session
        return this.state.blockConcurrencyWhile(async () => json({ ok: true, ...(await this.core.ingest(b.ticker, b.tf, b.bars || [], ingestOpts)) }));
      }
      if (request.method === "GET" && url.pathname === "/series") {
        const p = url.searchParams;
        const view = await this.core.getSeries(p.get("ticker"), p.get("tf"), {
          startMs: Number(p.get("start")), endMs: Number(p.get("end")),
          asOf: p.get("asOf") ? Number(p.get("asOf")) : undefined,
          source: p.get("source") || "live",
        });
        return json({ ok: true, view });
      }
      if (request.method === "GET" && url.pathname === "/integrity") {
        const p = url.searchParams;
        return json({ ok: true, ...(await this.core.integrity(p.get("ticker"), { startMs: Number(p.get("start")), endMs: Number(p.get("end")) })) });
      }
      if (request.method === "GET" && url.pathname === "/tickers") {
        return json({ ok: true, tickers: await this.core.listTickers() });
      }
      if (request.method === "GET" && url.pathname === "/reconcile-daily") {
        const p = url.searchParams;
        return json({ ok: true, ...(await this.core.reconcileDaily(p.get("ticker"), { startMs: Number(p.get("start")), endMs: Number(p.get("end")) }, { requireOpenClose: p.get("oc") === "1" })) });
      }
      if (url.pathname === "/base-fidelity") {
        // GET reads the last shadow report; POST runs the gate now (report-only).
        const p = url.searchParams;
        const ticker = p.get("ticker") || (request.method === "POST" ? (await request.clone().json().catch(() => ({}))).ticker : null);
        if (request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const window = { startMs: b.startMs, endMs: b.endMs };
          const report = await this.core.runShadowGate(b.ticker, window, b.opts || {});
          return json({ ok: true, report });
        }
        return json({ ok: true, report: await this.core.lastFidelity(ticker) });
      }
      if (request.method === "POST" && url.pathname === "/retention") {
        const b = await request.json();
        return this.state.blockConcurrencyWhile(async () => json({ ok: true, ...(await this.core.retentionSweep(b.ticker, Number(b.asOf) || Date.now())) }));
      }
      return json({ ok: false, error: "not_found" }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err).slice(0, 400) }, 500);
    }
  }
}

/** Number of shards (override via env.CANDLE_CHAIN_SHARDS). */
export function candleChainShardCount(env) {
  const n = Number(env?.CANDLE_CHAIN_SHARDS);
  return Number.isFinite(n) && n > 0 ? n : 16;
}

/** Resolve the DO stub for a ticker's shard. Returns null if binding absent. */
export function candleShardStub(env, ticker) {
  const ns = env?.CANDLE_CHAIN_SHARD;
  if (!ns) return null;
  const shard = shardForTicker(ticker, candleChainShardCount(env));
  return ns.get(ns.idFromName(`candle-shard-${shard}`));
}
