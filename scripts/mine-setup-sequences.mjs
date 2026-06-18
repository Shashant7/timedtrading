#!/usr/bin/env node
/**
 * Read-only setup sequence replay mining.
 *
 * Loads closed trades + timed_trail payloads, runs shadow sequence diagnostics
 * at each trade entry, and emits reliability tables. No writes to D1/KV.
 *
 * Usage:
 *   TIMED_API_KEY=... node scripts/mine-setup-sequences.mjs --live --limit 25
 *   TIMED_API_KEY=... node scripts/mine-setup-sequences.mjs --tickers USO,TSLA --limit 10
 *   node scripts/mine-setup-sequences.mjs --trades-file data/trade-autopsy-trades.json --trail-file data/uso-trail.json
 *
 *   node scripts/mine-setup-sequences.mjs --wrangler-d1 production --trail-source 5m --limit 50
 *
 * Options:
 *   --api-base URL          default TIMED_API_BASE or ingest worker URL
 *   --live                  fetch live closed trades (run_id IS NULL path)
 *   --run-id ID             fetch archived run trades instead of live
 *   --tickers A,B           filter tickers
 *   --limit N               max trades to analyze (default 25)
 *   --pre-entry-hours H     snapshot lookback before entry (default 48)
 *   --out-dir PATH          write summary.json + summary.md (default stdout only)
 *   --wrangler-d1 ENV       read trail directly from D1 (preprod|production)
 *   --trail-source SRC      trail table: raw (timed_trail) or 5m (trail_5m_facts); default 5m when --wrangler-d1 set
 *   --d1-trades             fetch closed trades from D1 instead of trade-autopsy API (requires --wrangler-d1)
 *   --trades-file PATH      local trades JSON ({ trades: [...] } or array)
 *   --trail-file PATH       local trail rows JSON for single-ticker offline runs
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildReliabilityReport,
  formatReliabilityMarkdown,
  joinTradeWithSequenceDiagnostics,
} from "../worker/foundation/setup-replay-mining.js";

const API_BASE = process.env.TIMED_API_BASE
  || process.env.API_BASE
  || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  if (v == null || v.startsWith("--")) return fallback;
  return v;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const LIVE = hasFlag("--live");
const RUN_ID = argValue("--run-id", "");
const TICKERS_RAW = argValue("--tickers", "");
const LIMIT = Math.max(1, Number(argValue("--limit", "25")) || 25);
const PRE_ENTRY_HOURS = Number(argValue("--pre-entry-hours", "48")) || 48;
const OUT_DIR = argValue("--out-dir", "");
const TRADES_FILE = argValue("--trades-file", "");
const TRAIL_FILE = argValue("--trail-file", "");
const API_BASE_ARG = argValue("--api-base", API_BASE);
const WRANGLER_D1 = argValue("--wrangler-d1", "");
const D1_TRADES = hasFlag("--d1-trades") || Boolean(WRANGLER_D1);
const TRAIL_SOURCE = argValue("--trail-source", WRANGLER_D1 ? "5m" : "raw");

function fetchD1Rows(wranglerEnv, sql) {
  const dbName = wranglerEnv === "preprod" ? "timed-trading-ledger-preprod" : "timed-trading-ledger";
  const out = execFileSync(path.join(process.cwd(), "node_modules/.bin/wrangler"), [
    "d1", "execute", dbName,
    "--env", wranglerEnv,
    "--remote", "--json",
    "--command", sql,
  ], {
    cwd: path.join(process.cwd(), "worker"),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(out);
  return parsed[0]?.results || [];
}

function fetchTrailRowsViaWrangler(ticker, sinceTs, untilTs, wranglerEnv = "preprod") {
  const sym = String(ticker || "").toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  if (!sym) return [];
  if (TRAIL_SOURCE === "5m") {
    const sql = `SELECT bucket_ts, price_close, state, kanban_stage_end, phase_pct, pdz_zone, pdz_pct, fvg_bull_count, fvg_bear_count, ema_regime_D, had_squeeze_release, had_ema_cross, had_st_flip, had_momentum_elite FROM trail_5m_facts WHERE ticker='${sym}' AND bucket_ts >= ${Number(sinceTs)} AND bucket_ts <= ${Number(untilTs)} ORDER BY bucket_ts ASC LIMIT 2000`;
    return fetchD1Rows(wranglerEnv, sql);
  }
  const sql = `SELECT ts, price, state, kanban_stage, phase_pct, flags_json, payload_json FROM timed_trail WHERE ticker='${sym}' AND ts >= ${Number(sinceTs)} AND ts <= ${Number(untilTs)} ORDER BY ts ASC LIMIT 2000`;
  return fetchD1Rows(wranglerEnv, sql);
}

function fetchTradesViaWrangler(wranglerEnv = "preprod") {
  const table = LIVE ? "trades" : "backtest_run_trades";
  const liveFilter = LIVE ? " AND run_id IS NULL" : "";
  const sql = `SELECT trade_id, ticker, direction, entry_ts, exit_ts, pnl_pct, status, entry_path FROM ${table} WHERE status IN ('WIN','LOSS')${liveFilter} ORDER BY entry_ts DESC LIMIT ${Math.max(LIMIT * 4, 100)}`;
  return fetchD1Rows(wranglerEnv, sql);
}

async function fetchJson(url) {
  const resp = await fetch(url, { headers: { "User-Agent": "mine-setup-sequences/1.0" } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${resp.status} for ${url}`);
  }
  return data;
}

function loadJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function normalizeTrades(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.trades)) return payload.trades;
  return [];
}

function closedTradesOnly(trades) {
  return trades.filter((t) => {
    const status = String(t.status || "").toUpperCase();
    if (status === "OPEN") return false;
    const exitTs = Number(t.exit_ts ?? t.exitTs);
    const entryTs = Number(t.entry_ts ?? t.entryTs);
    return Number.isFinite(entryTs) && Number.isFinite(exitTs);
  });
}

async function fetchTrades() {
  if (TRADES_FILE) {
    return closedTradesOnly(normalizeTrades(loadJsonFile(TRADES_FILE)));
  }
  if (D1_TRADES && WRANGLER_D1) {
    return closedTradesOnly(fetchTradesViaWrangler(WRANGLER_D1));
  }
  if (!API_KEY) {
    throw new Error("TIMED_API_KEY required unless --trades-file or --wrangler-d1 is provided");
  }
  const params = new URLSearchParams({ key: API_KEY, limit: String(Math.max(LIMIT * 4, 100)) });
  if (LIVE) params.set("live", "1");
  if (RUN_ID) params.set("run_id", RUN_ID);
  const data = await fetchJson(`${API_BASE_ARG}/timed/admin/trade-autopsy/trades?${params}`);
  return closedTradesOnly(data.trades || []);
}

async function fetchTrailRows(ticker, sinceTs, untilTs) {
  if (TRAIL_FILE) {
    const payload = loadJsonFile(TRAIL_FILE);
    const rows = Array.isArray(payload) ? payload : (payload.rows || []);
    return rows;
  }
  if (WRANGLER_D1) {
    return fetchTrailRowsViaWrangler(ticker, sinceTs, untilTs, WRANGLER_D1);
  }
  const params = new URLSearchParams({
    key: API_KEY,
    ticker,
    since: String(sinceTs),
    until: String(untilTs),
    limit: "2000",
  });
  const data = await fetchJson(`${API_BASE_ARG}/timed/admin/trail-payload?${params}`);
  return data.rows || [];
}

function filterTickers(trades) {
  if (!TICKERS_RAW) return trades;
  const set = new Set(TICKERS_RAW.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean));
  return trades.filter((t) => set.has(String(t.ticker || "").toUpperCase()));
}

async function main() {
  let trades = filterTickers(await fetchTrades());
  trades = trades.slice(0, LIMIT);

  if (!trades.length) {
    console.error("No closed trades found for mining.");
    process.exit(1);
  }

  const preEntryMs = PRE_ENTRY_HOURS * 60 * 60 * 1000;
  const joined = [];
  const trailCache = new Map();

  for (const trade of trades) {
    const ticker = String(trade.ticker || "").toUpperCase();
    const entryTs = Number(trade.entry_ts ?? trade.entryTs);
    const exitTs = Number(trade.exit_ts ?? trade.exitTs);
    const since = entryTs - preEntryMs;
    const until = exitTs || entryTs;

    let rows;
    if (TRAIL_FILE) {
      rows = await fetchTrailRows(ticker, since, until);
    } else {
      const cacheKey = `${ticker}:${since}:${until}`;
      if (!trailCache.has(cacheKey)) {
        try {
          trailCache.set(cacheKey, await fetchTrailRows(ticker, since, until));
        } catch (e) {
          trailCache.set(cacheKey, []);
          joined.push({
            ...joinTradeWithSequenceDiagnostics(trade, [], { preEntryMs }),
            diagnostics_ok: false,
            diagnostics_reason: `trail_fetch_failed:${String(e.message || e).slice(0, 120)}`,
          });
          continue;
        }
      }
      rows = trailCache.get(cacheKey);
    }

    joined.push(joinTradeWithSequenceDiagnostics(trade, rows, {
      preEntryMs,
      derivationOpts: { tdTfs: ["D", "W", "60"], signalTfs: ["D", "60", "30"] },
    }));
  }

  const report = buildReliabilityReport(joined, {
    api_base: API_BASE_ARG,
    live: LIVE,
    run_id: RUN_ID || null,
    tickers: TICKERS_RAW || null,
    limit: LIMIT,
    pre_entry_hours: PRE_ENTRY_HOURS,
    trades_source: TRADES_FILE || (D1_TRADES && WRANGLER_D1 ? `wrangler-d1-trades:${WRANGLER_D1}` : "trade-autopsy-api"),
    trail_source: TRAIL_FILE || (WRANGLER_D1 ? `wrangler-d1:${WRANGLER_D1}:${TRAIL_SOURCE}` : "trail-payload-api"),
    trail_table: TRAIL_SOURCE === "5m" ? "trail_5m_facts" : "timed_trail",
  });

  const markdown = formatReliabilityMarkdown(report);

  if (OUT_DIR) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, "summary.md"), markdown);
    console.log(`Wrote ${OUT_DIR}/summary.json and summary.md`);
    console.log(`Trades: ${report.reliability.total_trades}, with sequence: ${report.reliability.with_sequence}`);
  } else {
    console.log(markdown);
    console.log("\n--- JSON summary ---");
    console.log(JSON.stringify(report.reliability, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
