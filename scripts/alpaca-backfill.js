#!/usr/bin/env node
/**
 * Alpaca Historical Bar Backfill Script
 * Fetches historical OHLCV bars from Alpaca and uploads to the worker via /timed/ingest-candles.
 *
 * Usage:
 *   TIMED_API_KEY=AwesomeSauce node scripts/alpaca-backfill.js [--tf D] [--batch 30]
 *   node scripts/alpaca-backfill.js --tickers AXON,TSM,ARM --tf D
 *
 * Environment:
 *   ALPACA_API_KEY_ID     - Alpaca API Key ID
 *   ALPACA_API_SECRET_KEY - Alpaca API Secret Key
 *   TIMED_API_KEY         - Worker API key for ingest
 *   WORKER_BASE           - Worker base URL (default: https://timed-trading-ingest.shashant.workers.dev)
 */

const ALPACA_KEY = process.env.ALPACA_API_KEY_ID || "PKZH5IMHMGFQJNFRDCHWAOG4AQ";
const ALPACA_SECRET = process.env.ALPACA_API_SECRET_KEY || "AKgqwLSCKDkst1ZgcigsZu5eKp2ooQw4HXn95vDYwKM7";
const TIMED_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";
const WORKER_BASE = process.env.WORKER_BASE || "https://timed-trading-ingest.shashant.workers.dev";

const ALPACA_STOCKS_BASE = "https://data.alpaca.markets/v2";
const ALPACA_CRYPTO_BASE = "https://data.alpaca.markets/v1beta3/crypto/us";

// Dynamically import all tickers from SECTOR_MAP (single source of truth)
const { SECTOR_MAP } = require("../worker/sector-mapping.js");
const ALL_TICKERS = [...new Set(Object.keys(SECTOR_MAP))];

// Crypto symbol mapping: our internal ticker → Alpaca crypto format
const CRYPTO_MAP = {
  "BTCUSD": "BTC/USD",
  "ETHUSD": "ETH/USD",
};
const CRYPTO_TICKERS = new Set(Object.keys(CRYPTO_MAP));

// Stock symbol mapping: our internal ticker → Alpaca stock format
const STOCK_SYM_MAP = { "BRK-B": "BRK.B" };
const REVERSE_STOCK_MAP = Object.fromEntries(Object.entries(STOCK_SYM_MAP).map(([k, v]) => [v, k]));

// Canonical 9 timeframes: 1m, 5m, 10m, 30m, 1H, 4H, D, W, M
// (3m dropped — too noisy, causes whiplash)
const TF_CONFIGS = {
  "M":   { alpaca: "1Month", daysBack: 365 * 10, limit: 10000 },   // ~10 years of monthly bars (~200/ticker)
  "W":   { alpaca: "1Week",  daysBack: 365 * 6, limit: 10000 },    // ~6 years for ~200 weekly bars
  "D":   { alpaca: "1Day",   daysBack: 450, limit: 10000 },        // ~300 trading days
  "240": { alpaca: "4Hour",  daysBack: 200, limit: 10000 },        // ~300 4H bars
  "60":  { alpaca: "1Hour",  daysBack: 140, limit: 10000 },        // ~140 days → back to Oct 1 for scoring snapshots
  "30":  { alpaca: "30Min",  daysBack: 140, limit: 10000 },        // ~140 days → back to Oct 1 for scoring snapshots
  "10":  { alpaca: "10Min",  daysBack: 140, limit: 10000 },        // ~140 days → back to Oct 1 for scoring snapshots
  "5":   { alpaca: "5Min",   daysBack: 140, limit: 10000 },        // ~140 days → back to Oct 1 for scoring snapshots
  "1":   { alpaca: "1Min",   daysBack: 5, limit: 10000 },          // ~5 trading days of 1m bars (~390/day)
};

// Explicit order: highest TFs first (most important for indicators), 1m last (already flowing via cron)
const TF_ORDER = ["M", "W", "D", "240", "60", "30", "10", "5", "1"];

async function fetchAlpacaBars(symbols, tfKey, startISO) {
  const cfg = TF_CONFIGS[tfKey];
  if (!cfg) throw new Error(`Unknown TF: ${tfKey}`);

  // Split symbols into stocks and crypto
  const stockSymbols = symbols.filter(s => !CRYPTO_TICKERS.has(s));
  const cryptoSymbols = symbols.filter(s => CRYPTO_TICKERS.has(s));

  const allBars = {};

  // Fetch stock bars
  if (stockSymbols.length > 0) {
    // Map internal symbols to Alpaca format (e.g. BRK-B → BRK.B)
    const alpacaStockSyms = stockSymbols.map(s => STOCK_SYM_MAP[s] || s);
    let pageToken = null;
    let pages = 0;
    do {
      const params = new URLSearchParams();
      params.set("symbols", alpacaStockSyms.join(","));
      params.set("timeframe", cfg.alpaca);
      params.set("start", startISO);
      params.set("limit", String(cfg.limit));
      params.set("adjustment", "split");
      params.set("feed", "sip");
      params.set("sort", "asc");
      if (pageToken) params.set("page_token", pageToken);

      const url = `${ALPACA_STOCKS_BASE}/stocks/bars?${params.toString()}`;
      const resp = await fetch(url, {
        headers: {
          "APCA-API-KEY-ID": ALPACA_KEY,
          "APCA-API-SECRET-KEY": ALPACA_SECRET,
          "Accept": "application/json",
        },
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.error(`  Alpaca Stocks HTTP ${resp.status}: ${text.slice(0, 200)}`);
        break;
      }

      const data = await resp.json();
      const bars = data.bars || {};
      for (const [sym, barArr] of Object.entries(bars)) {
        // Map Alpaca symbol back to internal format (e.g. BRK.B → BRK-B)
        const ourSym = REVERSE_STOCK_MAP[sym] || sym;
        if (!allBars[ourSym]) allBars[ourSym] = [];
        allBars[ourSym].push(...barArr);
      }
      pageToken = data.next_page_token || null;
      pages++;

      if (pages % 5 === 0) process.stdout.write(`    (page ${pages}...)`);
    } while (pageToken && pages < 100);
  }

  // Fetch crypto bars (different API endpoint, different symbol format)
  if (cryptoSymbols.length > 0) {
    const alpacaCryptoSyms = cryptoSymbols.map(s => CRYPTO_MAP[s]);
    let pageToken = null;
    let pages = 0;
    do {
      const params = new URLSearchParams();
      params.set("symbols", alpacaCryptoSyms.join(","));
      params.set("timeframe", cfg.alpaca);
      params.set("start", startISO);
      params.set("limit", String(cfg.limit));
      params.set("sort", "asc");
      if (pageToken) params.set("page_token", pageToken);

      const url = `${ALPACA_CRYPTO_BASE}/bars?${params.toString()}`;
      const resp = await fetch(url, {
        headers: {
          "APCA-API-KEY-ID": ALPACA_KEY,
          "APCA-API-SECRET-KEY": ALPACA_SECRET,
          "Accept": "application/json",
        },
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.error(`  Alpaca Crypto HTTP ${resp.status}: ${text.slice(0, 200)}`);
        break;
      }

      const data = await resp.json();
      const bars = data.bars || {};
      // Reverse-map crypto symbols: "BTC/USD" → "BTCUSD"
      const reverseMap = Object.fromEntries(Object.entries(CRYPTO_MAP).map(([k, v]) => [v, k]));
      for (const [alpacaSym, barArr] of Object.entries(bars)) {
        const ourSym = reverseMap[alpacaSym] || alpacaSym.replace("/", "");
        if (!allBars[ourSym]) allBars[ourSym] = [];
        allBars[ourSym].push(...barArr);
      }
      pageToken = data.next_page_token || null;
      pages++;

      if (pages % 5 === 0) process.stdout.write(`    (page ${pages}...)`);
    } while (pageToken && pages < 100);
  }

  return allBars;
}

async function uploadCandles(ticker, tfKey, candles, retries = 2) {
  const tfCandles = {};
  tfCandles[tfKey] = candles.map(bar => ({
    ts: new Date(bar.t).getTime(),
    o: bar.o,
    h: bar.h,
    l: bar.l,
    c: bar.c,
    v: bar.v || 0,
  }));

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(`${WORKER_BASE}/timed/ingest-candles?key=${TIMED_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, tf_candles: tfCandles }),
      });
      const data = await resp.json();
      return data;
    } catch (e) {
      if (attempt === retries) return { ok: false, error: String(e) };
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

// Fetch active (non-removed) ticker list from worker.
// Returns SECTOR_MAP tickers that are NOT on the timed:removed blocklist.
async function fetchActiveTickers() {
  try {
    console.log("Fetching active ticker list from worker...");
    const res = await fetch(`${WORKER_BASE}/timed/tickers`);
    const data = await res.json();
    if (data?.ok && Array.isArray(data.tickers) && data.tickers.length > 0) {
      const activeSet = new Set(data.tickers.map(t => String(t).toUpperCase()));
      const filtered = ALL_TICKERS.filter(t => activeSet.has(t));
      console.log(`  Active tickers: ${data.tickers.length} from worker, ${filtered.length} matched in SECTOR_MAP`);
      return filtered;
    }
    console.warn("  Worker returned empty ticker list, falling back to full SECTOR_MAP");
  } catch (e) {
    console.warn(`  Could not fetch active tickers (${e.message}), falling back to full SECTOR_MAP`);
  }
  return [...new Set(ALL_TICKERS)];
}

async function main() {
  const args = process.argv.slice(2);
  let tfFilter = null;
  let batchSize = 30;
  let tickerFilter = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tf" && args[i + 1]) tfFilter = args[++i];
    if (args[i] === "--batch" && args[i + 1]) batchSize = parseInt(args[++i]);
    if (args[i] === "--tickers" && args[i + 1]) tickerFilter = args[++i].split(",").map(t => t.trim().toUpperCase());
  }

  const tfsToProcess = tfFilter ? [tfFilter] : TF_ORDER;
  const tickers = tickerFilter || await fetchActiveTickers();

  console.log(`Alpaca Backfill: ${tickers.length} tickers × ${tfsToProcess.length} timeframes`);
  console.log(`Batch size: ${batchSize} symbols per API call`);
  console.log(`Timeframes: ${tfsToProcess.join(", ")}`);
  console.log();

  let totalUpserted = 0;
  let totalErrors = 0;

  for (const tf of tfsToProcess) {
    const cfg = TF_CONFIGS[tf];
    const start = new Date(Date.now() - cfg.daysBack * 24 * 60 * 60 * 1000).toISOString();
    console.log(`\n== TF: ${tf} (${cfg.alpaca}) — fetching from ${start.split("T")[0]} ==`);

    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);
      process.stdout.write(`  Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(tickers.length / batchSize)} (${batch[0]}..${batch[batch.length - 1]}): `);

      try {
        const allBars = await fetchAlpacaBars(batch, tf, start);
        let batchUpserted = 0;

        for (const [sym, bars] of Object.entries(allBars)) {
          if (!Array.isArray(bars) || bars.length === 0) continue;
          try {
            const result = await uploadCandles(sym, tf, bars);
            if (result.ok) {
              batchUpserted += result.ingested || bars.length;
            } else {
              totalErrors++;
              console.error(`\n    Upload error for ${sym}: ${JSON.stringify(result)}`);
            }
          } catch (e) {
            totalErrors++;
          }
        }

        totalUpserted += batchUpserted;
        console.log(`${Object.keys(allBars).length} symbols, ${batchUpserted} bars uploaded`);
      } catch (e) {
        totalErrors++;
        console.error(`\n    Batch error: ${e.message}`);
      }

      // Small delay to be nice to rate limits
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`\n========================================`);
  console.log(`DONE: ${totalUpserted} bars upserted, ${totalErrors} errors`);
  console.log(`========================================`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
