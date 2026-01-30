#!/usr/bin/env node

// Backfill historical candles using Alpha Vantage (free tier: 25 calls/day)
//
// Setup:
//   1. Get free API key: https://www.alphavantage.co/support/#api-key
//   2. Set environment variables
//
// Usage:
//   ALPHAVANTAGE_KEY=your_av_key \
//   WORKER_URL=https://timed-trading-ingest.shashant.workers.dev \
//   API_KEY=your_worker_key \
//   node scripts/backfill-alphavantage.js
//
// Options:
//   TICKER=AAPL - backfill single ticker
//   SKIP=50 - skip first N tickers
//   LIMIT=10 - process only N tickers
//   DRY_RUN=1 - test mode

const https = require("https");
const fs = require("fs");

const ALPHAVANTAGE_KEY = process.env.ALPHAVANTAGE_KEY;
const WORKER_URL = process.env.WORKER_URL;
const API_KEY = process.env.API_KEY;
const SINGLE_TICKER = process.env.TICKER;
const SKIP = parseInt(process.env.SKIP || "0");
const LIMIT = parseInt(process.env.LIMIT || "999");
const DRY_RUN = process.env.DRY_RUN === "1";

if (!ALPHAVANTAGE_KEY) {
  console.error("Error: ALPHAVANTAGE_KEY required. Get one at https://www.alphavantage.co/support/#api-key");
  process.exit(1);
}

if (!WORKER_URL || (!API_KEY && !DRY_RUN)) {
  console.error("Error: WORKER_URL and API_KEY required (unless DRY_RUN=1)");
  process.exit(1);
}

// Alpha Vantage has different endpoints per TF group
// Free tier: 25 API calls/day, 5 calls/minute, "compact" output only (~100 most recent bars)
const TF_CONFIG = {
  D: { function: "TIME_SERIES_DAILY", outputsize: "compact" }, // Last ~100 days
  W: { function: "TIME_SERIES_WEEKLY", outputsize: "compact" }, // Last ~100 weeks (~2 years)
};

async function fetchAlphaVantage(ticker, config) {
  return new Promise((resolve) => {
    let url = `https://www.alphavantage.co/query?function=${config.function}&symbol=${ticker}&apikey=${ALPHAVANTAGE_KEY}&outputsize=${config.outputsize || "full"}&datatype=json`;
    
    if (config.interval) {
      url += `&interval=${config.interval}`;
    }
    
    https
      .get(url, { timeout: 30000 }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return resolve({ ok: false, status: res.statusCode });
          }
          try {
            const json = JSON.parse(data);
            
            // Check for rate limit message
            if (json.Note || json.Information) {
              return resolve({ ok: false, error: "rate_limited", message: json.Note || json.Information });
            }
            
            // Find time series data
            const timeSeriesKey = Object.keys(json).find((k) => k.includes("Time Series"));
            const timeSeries = json[timeSeriesKey];
            
            if (!timeSeries) {
              return resolve({ ok: false, error: "no_data" });
            }
            
            const candles = [];
            for (const [dateStr, values] of Object.entries(timeSeries)) {
              const ts = new Date(dateStr).getTime();
              const o = Number(values["1. open"]);
              const h = Number(values["2. high"]);
              const l = Number(values["3. low"]);
              const c = Number(values["4. close"]);
              const v = Number(values["5. volume"]);
              
              if (
                Number.isFinite(ts) &&
                [o, h, l, c].every((x) => Number.isFinite(x))
              ) {
                candles.push({ ts, o, h, l, c, v: Number.isFinite(v) ? v : null });
              }
            }
            
            // Sort oldest to newest
            candles.sort((a, b) => a.ts - b.ts);
            resolve({ ok: true, candles });
          } catch (e) {
            resolve({ ok: false, error: e.message });
          }
        });
      })
      .on("error", (e) => resolve({ ok: false, error: e.message }));
  });
}

async function postCandles(ticker, tfCandles) {
  if (DRY_RUN) {
    const totalBars = Object.values(tfCandles).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`  [DRY RUN] Would POST ${ticker}: ${totalBars} bars across ${Object.keys(tfCandles).length} TFs`);
    return { ok: true };
  }

  const payload = {
    ticker,
    ts: Date.now(),
    tf_candles: tfCandles,
    ingest_kind: "candles",
  };

  const url = `${WORKER_URL}/timed/ingest-candles?key=${API_KEY}`;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch {
            resolve({ ok: false, error: "bad_response", status: res.statusCode });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function fetchTickers() {
  return new Promise((resolve, reject) => {
    const url = `${WORKER_URL}/timed/tickers`;
    https
      .get(url, { timeout: 10000 }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json.tickers || []);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== Alpha Vantage Historical Backfill ===");
  console.log(`Worker: ${WORKER_URL}`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`API Calls available today: ~25 (Alpha Vantage free tier)`);
  console.log("");

  let tickers = [];
  if (SINGLE_TICKER) {
    tickers = [SINGLE_TICKER.toUpperCase()];
  } else {
    console.log("Fetching ticker list...");
    tickers = await fetchTickers();
    console.log(`Found ${tickers.length} tickers`);
    
    if (SKIP > 0) {
      tickers = tickers.slice(SKIP);
      console.log(`Skipped first ${SKIP}, processing ${tickers.length}`);
    }
    
    if (LIMIT < tickers.length) {
      tickers = tickers.slice(0, LIMIT);
      console.log(`Limited to ${LIMIT} tickers`);
    }
  }
  
  console.log("");
  console.log("⚠️  Alpha Vantage free tier: 25 API calls/day, 5 calls/minute");
  console.log(`    This run will use ${tickers.length * 2} calls (Daily + Weekly per ticker)`);
  console.log(`    Recommend: LIMIT=10 to stay under daily quota`);
  console.log("");

  let successCount = 0;
  let errorCount = 0;
  let apiCallsUsed = 0;

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    console.log(`[${i + 1}/${tickers.length}] ${ticker}`);

    const tfCandles = {};

    // Only fetch D and W (most important for context, and uses fewest API calls)
    for (const tf of ["D", "W"]) {
      const config = TF_CONFIG[tf];
      if (!config) continue;

      try {
        console.log(`  ${tf}...`);
        const res = await fetchAlphaVantage(ticker, config);
        apiCallsUsed++;

        if (!res.ok) {
          if (res.error === "rate_limited") {
            console.log(`  ✗ Rate limited: ${res.message}`);
            console.log(`\nStopping. Used ${apiCallsUsed} API calls today.`);
            console.log(`Resume tomorrow with: SKIP=${SKIP + i}`);
            process.exit(0);
          }
          console.log(`  ✗ ${res.error || `HTTP ${res.status}`}`);
          continue;
        }

        const candles = res.candles.slice(-200); // Keep last 200
        tfCandles[tf] = candles;
        console.log(`  ✓ ${candles.length} bars`);

        await sleep(13000); // 5 calls/min = 12s between calls + 1s buffer
      } catch (e) {
        console.log(`  ✗ Error: ${e.message}`);
      }
    }

    if (Object.keys(tfCandles).length === 0) {
      console.log(`  No data, skip`);
      errorCount++;
      continue;
    }

    try {
      const postRes = await postCandles(ticker, tfCandles);
      if (postRes.ok) {
        const totalBars = Object.values(tfCandles).reduce(
          (sum, arr) => sum + arr.length,
          0,
        );
        console.log(`  ✓ Uploaded ${totalBars} bars`);
        successCount++;
      } else {
        console.log(`  ✗ Upload failed: ${postRes.error}`);
        errorCount++;
      }
    } catch (e) {
      console.log(`  ✗ Upload error: ${e.message}`);
      errorCount++;
    }

    await sleep(1000);
  }

  console.log("");
  console.log("=== Backfill Complete ===");
  console.log(`Success: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`API calls used: ${apiCallsUsed}`);
  console.log("");
  console.log(`Tickers processed: ${SKIP} to ${SKIP + tickers.length}`);
  if (SKIP + tickers.length < 159) {
    console.log(`\nTo continue tomorrow: SKIP=${SKIP + tickers.length} LIMIT=10`);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
