#!/usr/bin/env node

// Backfill historical candles for all tickers from Yahoo Finance
//
// Usage:
//   WORKER_URL=https://timed-trading-ingest.shashant.workers.dev \
//   API_KEY=your_api_key \
//   node scripts/backfill-candles.js
//
// Options:
//   WORKER_URL - Your Worker URL
//   API_KEY - Your Worker API key
//   TICKER - Optional: backfill single ticker only (e.g., TICKER=AAPL)
//   TF - Optional: backfill single timeframe only (e.g., TF=30)
//   DRY_RUN=1 - Test mode: fetch and log but don't POST

const https = require("https");

const WORKER_URL = process.env.WORKER_URL || "http://localhost:8787";
const API_KEY = process.env.API_KEY;
const SINGLE_TICKER = process.env.TICKER;
const SINGLE_TF = process.env.TF;
const DRY_RUN = process.env.DRY_RUN === "1";

if (!API_KEY && !DRY_RUN) {
  console.error("Error: API_KEY environment variable required (unless DRY_RUN=1)");
  process.exit(1);
}

// Map our TF keys to Yahoo Finance intervals
const TF_MAP = {
  "1": "1m",
  "3": "5m", // Yahoo doesn't have 3m, use 5m as proxy
  "5": "5m",
  "10": "15m", // Yahoo doesn't have 10m, use 15m as proxy
  "30": "30m",
  "60": "1h",
  "240": "1h", // Yahoo doesn't have 4h, fetch 1h and aggregate
  D: "1d",
  W: "1wk",
};

// Yahoo Finance historical data endpoint (with retry logic)
async function fetchYahooCandles(ticker, interval, range = "1mo", retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await new Promise((resolve, reject) => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
        https
          .get(url, { timeout: 15000 }, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve({ status: res.statusCode, data }));
          })
          .on("error", reject);
      });

      if (res.status === 429) {
        const backoff = Math.min(30000, 2000 * Math.pow(2, attempt - 1));
        console.log(`  ${interval}: rate limited, retry in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      if (res.status !== 200) {
        return { ok: false, error: `HTTP ${res.status}` };
      }

      const json = JSON.parse(res.data);
      const result = json?.chart?.result?.[0];
      if (!result) {
        return { ok: false, error: "no_result" };
      }
      const timestamps = result.timestamp || [];
      const quote = result.indicators?.quote?.[0] || {};
      const o = quote.open || [];
      const h = quote.high || [];
      const l = quote.low || [];
      const c = quote.close || [];
      const v = quote.volume || [];

      const candles = [];
      for (let i = 0; i < timestamps.length; i++) {
        const ts = timestamps[i] * 1000; // Yahoo uses seconds
        const oo = Number(o[i]);
        const hh = Number(h[i]);
        const ll = Number(l[i]);
        const cc = Number(c[i]);
        const vv = Number(v[i]);
        if (
          Number.isFinite(ts) &&
          [oo, hh, ll, cc].every((x) => Number.isFinite(x))
        ) {
          candles.push({
            ts,
            o: oo,
            h: hh,
            l: ll,
            c: cc,
            v: Number.isFinite(vv) ? vv : null,
          });
        }
      }
      return { ok: true, candles };
    } catch (e) {
      if (attempt === retries) {
        return { ok: false, error: e.message };
      }
      const backoff = 1000 * Math.pow(2, attempt - 1);
      await sleep(backoff);
    }
  }
  return { ok: false, error: "max_retries" };
}

async function postCandles(ticker, tfCandles) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would POST ${ticker} with ${Object.keys(tfCandles).length} TFs`);
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
        timeout: 15000,
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
            const tickers = json.tickers || [];
            resolve(tickers);
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
  console.log("=== Historical Candle Backfill ===");
  console.log(`Worker: ${WORKER_URL}`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log("");

  let tickers = [];
  if (SINGLE_TICKER) {
    tickers = [SINGLE_TICKER.toUpperCase()];
    console.log(`Single ticker: ${tickers[0]}`);
  } else {
    console.log("Fetching ticker list from Worker...");
    tickers = await fetchTickers();
    console.log(`Found ${tickers.length} tickers`);
  }

  const tfsToBackfill = SINGLE_TF
    ? [SINGLE_TF]
    : ["1", "3", "5", "10", "30", "60", "240", "D", "W"];
  console.log(`Timeframes: ${tfsToBackfill.join(", ")}`);
  console.log("");

  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    console.log(`[${i + 1}/${tickers.length}] ${ticker}`);

    const tfCandles = {};

    for (const tf of tfsToBackfill) {
      const yahooInterval = TF_MAP[tf];
      if (!yahooInterval) {
        console.log(`  ${tf}: no Yahoo mapping, skip`);
        continue;
      }

      // Adjust range based on TF
      const range =
        tf === "1" || tf === "3" || tf === "5"
          ? "5d"
          : tf === "10" || tf === "30" || tf === "60"
            ? "1mo"
            : tf === "240"
              ? "3mo"
              : tf === "D"
                ? "1y"
                : "5y";

      try {
        const res = await fetchYahooCandles(ticker, yahooInterval, range);
        if (!res.ok || !res.candles || res.candles.length === 0) {
          console.log(`  ${tf}: no data`);
          continue;
        }

        // Take last 200 candles
        const last200 = res.candles.slice(-200);
        tfCandles[tf] = last200[last200.length - 1]; // Latest candle per TF
        console.log(`  ${tf}: ${res.candles.length} bars (using latest)`);

        await sleep(500); // Slow down Yahoo requests to avoid rate limits
      } catch (e) {
        console.log(`  ${tf}: error - ${e.message}`);
      }
    }

    if (Object.keys(tfCandles).length === 0) {
      console.log(`  No candles fetched, skip`);
      errorCount++;
      continue;
    }

    try {
      const postRes = await postCandles(ticker, tfCandles);
      if (postRes.ok) {
        console.log(`  ✓ Posted ${Object.keys(tfCandles).length} TFs`);
        successCount++;
      } else {
        console.log(`  ✗ POST failed: ${postRes.error || "unknown"}`);
        errorCount++;
      }
    } catch (e) {
      console.log(`  ✗ POST error: ${e.message}`);
      errorCount++;
    }

    await sleep(1000); // Slow down to avoid overwhelming Yahoo + Worker
  }

  console.log("");
  console.log("=== Backfill Complete ===");
  console.log(`Success: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`Total: ${tickers.length}`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
