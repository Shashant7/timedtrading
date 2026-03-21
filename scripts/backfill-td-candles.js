#!/usr/bin/env node
/**
 * Backfill 30m + 1H candles from TwelveData into local SQLite.
 * TwelveData Pro: 8 req/min, 800 credits/day.
 *
 * Usage:
 *   TWELVEDATA_API_KEY=xxx node scripts/backfill-td-candles.js
 *   TWELVEDATA_API_KEY=xxx node scripts/backfill-td-candles.js --tf 30,60 --start 2024-06-01
 *   TWELVEDATA_API_KEY=xxx node scripts/backfill-td-candles.js --tickers AAPL,MSFT --tf 60
 */

const Database = require("better-sqlite3");
const path = require("path");
const { SECTOR_MAP } = require("../worker/sector-mapping.js");

const API_KEY = process.env.TWELVEDATA_API_KEY;
if (!API_KEY) {
  console.error("ERROR: TWELVEDATA_API_KEY required.");
  process.exit(1);
}

const TD_BASE = "https://api.twelvedata.com";
const TD_INTERVAL_MAP = { "30": "30min", "60": "1h" };
const RATE_LIMIT_DELAY = 8000;

const args = process.argv.slice(2);
let tfFilter = null, tickerFilter = null, startDate = "2024-06-01", endDate = "2025-07-01";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--tf" && args[i + 1]) tfFilter = args[++i].split(",");
  if (args[i] === "--tickers" && args[i + 1]) tickerFilter = args[++i].split(",").map(s => s.trim().toUpperCase());
  if (args[i] === "--start" && args[i + 1]) startDate = args[++i];
  if (args[i] === "--end" && args[i + 1]) endDate = args[++i];
}

const tfsToProcess = tfFilter || ["30", "60"];
const ALL_TICKERS = Object.keys(SECTOR_MAP).filter(t => !t.includes("!"));
const tickers = tickerFilter || ALL_TICKERS;

const DB_PATH = path.join(__dirname, "..", "data", "timed-local.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("cache_size = -200000");

const insertStmt = db.prepare(
  "INSERT OR IGNORE INTO ticker_candles (ticker, tf, ts, o, h, l, c, v, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
);
const insertMany = db.transaction((rows) => {
  for (const r of rows) insertStmt.run(r.ticker, r.tf, r.ts, r.o, r.h, r.l, r.c, r.v, Date.now());
});
const countBeforeStmt = db.prepare(
  "SELECT COUNT(*) as cnt FROM ticker_candles WHERE ticker = ? AND tf = ? AND ts < ?"
);
const BACKTEST_START_TS = new Date("2025-07-01T00:00:00Z").getTime();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseTdDatetime(dt) {
  if (dt.includes("T")) return new Date(dt).getTime();
  if (dt.includes(" ")) return new Date(dt.replace(" ", "T")).getTime();
  return new Date(dt + "T00:00:00").getTime();
}

async function fetchTdTimeSeries(symbol, interval, start, end) {
  const params = new URLSearchParams({
    symbol,
    interval,
    start_date: start,
    end_date: end,
    apikey: API_KEY,
  });
  const url = `${TD_BASE}/time_series?${params}`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });

  if (resp.status === 429) return { ok: false, error: "rate_limited", retry: true };
  if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };

  const data = await resp.json();
  if (data.status === "error") return { ok: false, error: data.message || "td_error" };
  if (!data.values || data.values.length === 0) return { ok: true, candles: [] };

  const candles = [];
  for (const v of data.values) {
    const ts = parseTdDatetime(v.datetime);
    if (!Number.isFinite(ts)) continue;
    candles.push({
      ts,
      o: parseFloat(v.open),
      h: parseFloat(v.high),
      l: parseFloat(v.low),
      c: parseFloat(v.close),
      v: parseInt(v.volume) || 0,
    });
  }
  return { ok: true, candles };
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  TwelveData → Local SQLite Candle Backfill          ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`  TFs:      ${tfsToProcess.join(", ")}`);
  console.log(`  Tickers:  ${tickers.length}`);
  console.log(`  Range:    ${startDate} → ${endDate}`);
  console.log(`  DB:       ${DB_PATH}`);

  const totalCalls = tickers.length * tfsToProcess.length;
  const estMinutes = Math.ceil(totalCalls * (RATE_LIMIT_DELAY / 1000) / 60);
  console.log(`  Max calls: ${totalCalls} (est. ~${estMinutes} min at 8 req/min)`);
  console.log();

  let grandTotal = 0, skipped = 0, errors = 0;

  for (const tf of tfsToProcess) {
    const tdInterval = TD_INTERVAL_MAP[tf];
    if (!tdInterval) { console.log(`  Unknown TF ${tf}, skip`); continue; }
    console.log(`── TF: ${tf} (${tdInterval}) ──`);
    let tfTotal = 0;

    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i];

      const existing = countBeforeStmt.get(ticker, tf, BACKTEST_START_TS);
      if (existing.cnt >= 500) {
        skipped++;
        continue;
      }

      process.stdout.write(`  [${i + 1}/${tickers.length}] ${ticker} (have ${existing.cnt} pre-Jul): `);

      let retries = 0, result;
      while (retries < 3) {
        result = await fetchTdTimeSeries(ticker, tdInterval, startDate, endDate);
        if (result?.retry) {
          retries++;
          console.log(`rate limited, wait 60s (retry ${retries}/3)`);
          await sleep(60000);
          continue;
        }
        break;
      }

      if (!result?.ok) {
        console.log(`error: ${result?.error}`);
        errors++;
      } else if (result.candles.length === 0) {
        console.log("no data");
      } else {
        const rows = result.candles.map(c => ({ ticker, tf, ...c }));
        insertMany(rows);
        tfTotal += rows.length;
        const first = new Date(Math.min(...result.candles.map(c => c.ts))).toISOString().slice(0, 10);
        const last = new Date(Math.max(...result.candles.map(c => c.ts))).toISOString().slice(0, 10);
        console.log(`${rows.length} bars (${first} → ${last})`);
      }

      await sleep(RATE_LIMIT_DELAY);
    }

    grandTotal += tfTotal;
    console.log(`  ── TF ${tf} total: ${tfTotal.toLocaleString()} bars\n`);
  }

  const verify = db.prepare(
    "SELECT tf, COUNT(*) as cnt, COUNT(DISTINCT ticker) as tickers FROM ticker_candles WHERE tf IN ('30','60') GROUP BY tf"
  ).all();

  console.log("═".repeat(54));
  console.log(`  DONE: ${grandTotal.toLocaleString()} bars inserted, ${skipped} skipped, ${errors} errors`);
  for (const r of verify) console.log(`  ${r.tf}: ${r.cnt.toLocaleString()} rows, ${r.tickers} tickers`);
  console.log(`  DB size: ${(require("fs").statSync(DB_PATH).size / 1e9).toFixed(2)} GB`);
  console.log("═".repeat(54));

  db.close();
}

main().catch(e => { console.error("Fatal:", e); db.close(); process.exit(1); });
