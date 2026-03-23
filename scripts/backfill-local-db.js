#!/usr/bin/env node
/**
 * Backfill local SQLite DB with historical candles from Alpaca.
 * Writes directly to data/timed-local.db — no D1 middleman.
 *
 * Usage:
 *   node scripts/backfill-local-db.js --tf 10          # backfill 10m only
 *   node scripts/backfill-local-db.js --tf 15          # backfill 15m only
 *   node scripts/backfill-local-db.js --tf 10,15       # backfill both
 *   node scripts/backfill-local-db.js --tf 10 --tickers AAPL,MSFT
 *   node scripts/backfill-local-db.js --tf 10 --start 2025-06-01
 *
 * Environment:
 *   ALPACA_API_KEY_ID       - required
 *   ALPACA_API_SECRET_KEY   - required
 */

const Database = require("better-sqlite3");
const path = require("path");
const { SECTOR_MAP } = require("../worker/sector-mapping.js");

const ALPACA_KEY = process.env.ALPACA_API_KEY_ID || "";
const ALPACA_SECRET = process.env.ALPACA_API_SECRET_KEY || "";

if (!ALPACA_KEY || !ALPACA_SECRET) {
  console.error("ERROR: ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY required.");
  console.error("  export ALPACA_API_KEY_ID=... ALPACA_API_SECRET_KEY=...");
  process.exit(1);
}

const ALPACA_STOCKS_BASE = "https://data.alpaca.markets/v2";
const ALPACA_CRYPTO_BASE = "https://data.alpaca.markets/v1beta3/crypto/us";

const CRYPTO_MAP = { BTCUSD: "BTC/USD", ETHUSD: "ETH/USD" };
const CRYPTO_TICKERS = new Set(Object.keys(CRYPTO_MAP));
const STOCK_SYM_MAP = { "BRK-B": "BRK.B" };
const REVERSE_STOCK_MAP = Object.fromEntries(
  Object.entries(STOCK_SYM_MAP).map(([k, v]) => [v, k])
);

const ALL_TICKERS = [...new Set(Object.keys(SECTOR_MAP))];

const TF_ALPACA_MAP = {
  "1": "1Min", "3": "3Min", "5": "5Min", "10": "10Min", "15": "15Min",
  "30": "30Min", "60": "1Hour", "240": "4Hour", D: "1Day", W: "1Week", M: "1Month",
};

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let tfFilter = null;
let tickerFilter = null;
let startDate = "2025-06-01";
let batchSize = 50;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--tf" && args[i + 1]) tfFilter = args[++i].split(",");
  if (args[i] === "--tickers" && args[i + 1]) tickerFilter = args[++i].split(",").map(s => s.trim().toUpperCase());
  if (args[i] === "--start" && args[i + 1]) startDate = args[++i];
  if (args[i] === "--batch" && args[i + 1]) batchSize = parseInt(args[++i]);
}

const tfsToProcess = tfFilter || ["10", "15"];
const tickers = tickerFilter || ALL_TICKERS.filter(t => !t.includes("!") && t !== "SPX");

// ── Database setup ──────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, "..", "data", "timed-local.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("cache_size = -200000");

db.exec(`
  CREATE TABLE IF NOT EXISTS ticker_candles (
    ticker TEXT NOT NULL,
    tf TEXT NOT NULL,
    ts INTEGER NOT NULL,
    o REAL, h REAL, l REAL, c REAL, v REAL,
    updated_at INTEGER
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tc_ticker_tf_ts ON ticker_candles(ticker, tf, ts)`);

const insertStmt = db.prepare(
  "INSERT OR REPLACE INTO ticker_candles (ticker, tf, ts, o, h, l, c, v, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
);

const insertMany = db.transaction((rows) => {
  for (const r of rows) {
    insertStmt.run(r.ticker, r.tf, r.ts, r.o, r.h, r.l, r.c, r.v, Date.now());
  }
});

// ── Alpaca fetcher ──────────────────────────────────────────────────────────
async function fetchAlpacaBars(symbols, tfKey, startISO) {
  const alpacaTf = TF_ALPACA_MAP[tfKey];
  if (!alpacaTf) throw new Error(`Unknown TF: ${tfKey}`);

  const stockSymbols = symbols.filter(s => !CRYPTO_TICKERS.has(s));
  const cryptoSymbols = symbols.filter(s => CRYPTO_TICKERS.has(s));
  const allBars = {};

  if (stockSymbols.length > 0) {
    const alpacaStockSyms = stockSymbols.map(s => STOCK_SYM_MAP[s] || s);
    let pageToken = null;
    let pages = 0;
    do {
      const params = new URLSearchParams();
      params.set("symbols", alpacaStockSyms.join(","));
      params.set("timeframe", alpacaTf);
      params.set("start", startISO);
      params.set("limit", "10000");
      params.set("adjustment", "split");
      params.set("feed", "sip");
      params.set("sort", "asc");
      if (pageToken) params.set("page_token", pageToken);

      const url = `${ALPACA_STOCKS_BASE}/stocks/bars?${params.toString()}`;
      const resp = await fetch(url, {
        headers: {
          "APCA-API-KEY-ID": ALPACA_KEY,
          "APCA-API-SECRET-KEY": ALPACA_SECRET,
          Accept: "application/json",
        },
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.error(`  Alpaca HTTP ${resp.status}: ${text.slice(0, 200)}`);
        break;
      }

      const data = await resp.json();
      const bars = data.bars || {};
      for (const [sym, barArr] of Object.entries(bars)) {
        const ourSym = REVERSE_STOCK_MAP[sym] || sym;
        if (!allBars[ourSym]) allBars[ourSym] = [];
        allBars[ourSym].push(...barArr);
      }
      pageToken = data.next_page_token || null;
      pages++;
      if (pages % 10 === 0) process.stdout.write(` p${pages}`);
    } while (pageToken && pages < 500);
  }

  if (cryptoSymbols.length > 0) {
    const alpacaCryptoSyms = cryptoSymbols.map(s => CRYPTO_MAP[s]);
    let pageToken = null;
    let pages = 0;
    do {
      const params = new URLSearchParams();
      params.set("symbols", alpacaCryptoSyms.join(","));
      params.set("timeframe", alpacaTf);
      params.set("start", startISO);
      params.set("limit", "10000");
      params.set("sort", "asc");
      if (pageToken) params.set("page_token", pageToken);

      const url = `${ALPACA_CRYPTO_BASE}/bars?${params.toString()}`;
      const resp = await fetch(url, {
        headers: {
          "APCA-API-KEY-ID": ALPACA_KEY,
          "APCA-API-SECRET-KEY": ALPACA_SECRET,
          Accept: "application/json",
        },
      });

      if (!resp.ok) break;
      const data = await resp.json();
      const bars = data.bars || {};
      const reverseMap = Object.fromEntries(
        Object.entries(CRYPTO_MAP).map(([k, v]) => [v, k])
      );
      for (const [alpacaSym, barArr] of Object.entries(bars)) {
        const ourSym = reverseMap[alpacaSym] || alpacaSym.replace("/", "");
        if (!allBars[ourSym]) allBars[ourSym] = [];
        allBars[ourSym].push(...barArr);
      }
      pageToken = data.next_page_token || null;
      pages++;
    } while (pageToken && pages < 200);
  }

  return allBars;
}

function alpacaBarToRow(ticker, tf, bar) {
  const ts = new Date(bar.t).getTime();
  return { ticker, tf, ts, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v || 0 };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  Alpaca → Local SQLite Candle Backfill              ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`  TFs:      ${tfsToProcess.join(", ")}`);
  console.log(`  Tickers:  ${tickers.length}`);
  console.log(`  Start:    ${startDate}`);
  console.log(`  Batch:    ${batchSize} symbols per API call`);
  console.log(`  DB:       ${DB_PATH}`);
  console.log();

  const startISO = new Date(startDate + "T00:00:00Z").toISOString();
  let grandTotal = 0;

  for (const tf of tfsToProcess) {
    console.log(`\n── TF: ${tf} (${TF_ALPACA_MAP[tf]}) ──`);
    let tfTotal = 0;

    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(tickers.length / batchSize);
      process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${batch[0]}..${batch[batch.length - 1]}): `);

      try {
        const allBars = await fetchAlpacaBars(batch, tf, startISO);
        let batchRows = 0;

        for (const [sym, bars] of Object.entries(allBars)) {
          if (!Array.isArray(bars) || bars.length === 0) continue;
          const rows = bars.map(b => alpacaBarToRow(sym, tf, b));
          insertMany(rows);
          batchRows += rows.length;
        }

        tfTotal += batchRows;
        console.log(` ${Object.keys(allBars).length} symbols, ${batchRows.toLocaleString()} bars`);
      } catch (e) {
        console.error(` ERROR: ${e.message}`);
      }

      // Alpaca rate limit: 200 req/min. Be gentle.
      await new Promise(r => setTimeout(r, 300));
    }

    grandTotal += tfTotal;
    console.log(`  ── TF ${tf} total: ${tfTotal.toLocaleString()} bars`);
  }

  console.log(`\n${"═".repeat(54)}`);
  console.log(`  DONE: ${grandTotal.toLocaleString()} bars inserted`);
  console.log(`  DB size: ${(require("fs").statSync(DB_PATH).size / 1e9).toFixed(2)} GB`);
  console.log(`${"═".repeat(54)}`);

  db.close();
}

main().catch(e => {
  console.error("Fatal:", e);
  db.close();
  process.exit(1);
});
