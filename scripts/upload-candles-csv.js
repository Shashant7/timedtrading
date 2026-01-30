#!/usr/bin/env node

// Upload historical candles CSV to Worker
//
// Usage:
//   WORKER_URL=https://timed-trading-ingest.shashant.workers.dev \
//   API_KEY=your_api_key \
//   node scripts/upload-candles-csv.js daily_export.csv
//
// CSV format (from TradingView export):
//   ticker,tf,ts,o,h,l,c,v

const fs = require("fs");
const https = require("https");

const WORKER_URL = process.env.WORKER_URL || "http://localhost:8787";
const API_KEY = process.env.API_KEY;
const DRY_RUN = process.env.DRY_RUN === "1";

const csvFile = process.argv[2];
if (!csvFile) {
  console.error("Usage: node upload-candles-csv.js <file.csv>");
  process.exit(1);
}

if (!API_KEY && !DRY_RUN) {
  console.error("Error: API_KEY environment variable required");
  process.exit(1);
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

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== CSV Candle Upload ===");
  console.log(`File: ${csvFile}`);
  console.log(`Worker: ${WORKER_URL}`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log("");

  const csv = fs.readFileSync(csvFile, "utf8");
  const lines = csv.split("\n").filter((l) => l.trim());

  // Group by ticker + TF
  const byTicker = {};
  let skipped = 0;

  for (const line of lines) {
    if (line.startsWith("ticker,") || line.startsWith("===")) continue;
    const parts = line.split(",");
    if (parts.length < 7) {
      skipped++;
      continue;
    }
    const [ticker, tf, ts, o, h, l, c, v] = parts;
    const tsNum = Number(ts);
    const oNum = Number(o);
    const hNum = Number(h);
    const lNum = Number(l);
    const cNum = Number(c);
    const vNum = v ? Number(v) : null;

    if (
      !ticker ||
      !tf ||
      !Number.isFinite(tsNum) ||
      ![oNum, hNum, lNum, cNum].every((x) => Number.isFinite(x))
    ) {
      skipped++;
      continue;
    }

    if (!byTicker[ticker]) byTicker[ticker] = {};
    if (!byTicker[ticker][tf]) byTicker[ticker][tf] = [];
    byTicker[ticker][tf].push({
      ts: tsNum,
      o: oNum,
      h: hNum,
      l: lNum,
      c: cNum,
      v: Number.isFinite(vNum) ? vNum : null,
    });
  }

  const tickers = Object.keys(byTicker);
  console.log(`Parsed ${lines.length - skipped} rows from ${tickers.length} tickers`);
  console.log(`Skipped ${skipped} invalid rows`);
  console.log("");

  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    const tfCandles = byTicker[ticker];
    const totalBars = Object.values(tfCandles).reduce(
      (sum, arr) => sum + arr.length,
      0,
    );
    console.log(`[${i + 1}/${tickers.length}] ${ticker} (${totalBars} bars across ${Object.keys(tfCandles).length} TFs)`);

    try {
      const postRes = await postCandles(ticker, tfCandles);
      if (postRes.ok) {
        console.log(`  ✓ Uploaded (ingested: ${postRes.ingested || 0})`);
        successCount++;
      } else {
        console.log(`  ✗ Failed: ${postRes.error || "unknown"}`);
        errorCount++;
      }
    } catch (e) {
      console.log(`  ✗ Error: ${e.message}`);
      errorCount++;
    }

    await sleep(300); // Rate limit Worker
  }

  console.log("");
  console.log("=== Upload Complete ===");
  console.log(`Success: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
