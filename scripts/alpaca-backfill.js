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

const ALPACA_BASE = "https://data.alpaca.markets/v2";

// Dynamically import all tickers from SECTOR_MAP (single source of truth)
const { SECTOR_MAP } = require("../worker/sector-mapping.js");
const ALL_TICKERS = [...new Set(Object.keys(SECTOR_MAP))];

// Timeframe configs: our TF key -> Alpaca format -> how far back to go
const TF_CONFIGS = {
  "M":   { alpaca: "1Month", daysBack: 365 * 10, limit: 10000 },   // ~10 years of monthly bars (~120/ticker)
  "W":   { alpaca: "1Week",  daysBack: 365 * 6, limit: 10000 },    // ~6 years for 300 weekly bars
  "D":   { alpaca: "1Day",   daysBack: 450, limit: 10000 },        // ~300 trading days
  "240": { alpaca: "4Hour",  daysBack: 200, limit: 10000 },        // ~300 4H bars
  "60":  { alpaca: "1Hour",  daysBack: 50, limit: 10000 },         // ~300 hourly bars
  "30":  { alpaca: "30Min",  daysBack: 25, limit: 10000 },         // ~300 30m bars
  "10":  { alpaca: "10Min",  daysBack: 180, limit: 10000 },        // ~180 days of 10m bars (~7,020/ticker) back to ~Aug 2025
  "5":   { alpaca: "5Min",   daysBack: 60, limit: 10000 },         // ~60 trading days of 5m bars (~4,680/ticker)
  "3":   { alpaca: "3Min",   daysBack: 60, limit: 10000 },         // ~60 days of 3m bars (~15,600/ticker) back to ~Dec 2025
};

async function fetchAlpacaBars(symbols, tfKey, startISO) {
  const cfg = TF_CONFIGS[tfKey];
  if (!cfg) throw new Error(`Unknown TF: ${tfKey}`);

  const allBars = {};
  let pageToken = null;
  let pages = 0;

  do {
    const params = new URLSearchParams();
    params.set("symbols", symbols.join(","));
    params.set("timeframe", cfg.alpaca);
    params.set("start", startISO);
    params.set("limit", String(cfg.limit));
    params.set("adjustment", "split");
    params.set("feed", "sip");
    params.set("sort", "asc");
    if (pageToken) params.set("page_token", pageToken);

    const url = `${ALPACA_BASE}/stocks/bars?${params.toString()}`;
    const resp = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": ALPACA_KEY,
        "APCA-API-SECRET-KEY": ALPACA_SECRET,
        "Accept": "application/json",
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
      if (!allBars[sym]) allBars[sym] = [];
      allBars[sym].push(...barArr);
    }
    pageToken = data.next_page_token || null;
    pages++;

    if (pages % 5 === 0) process.stdout.write(`    (page ${pages}...)`);
  } while (pageToken && pages < 100);

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

  const tfsToProcess = tfFilter ? [tfFilter] : Object.keys(TF_CONFIGS);
  const tickers = tickerFilter || [...new Set(ALL_TICKERS)];

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
