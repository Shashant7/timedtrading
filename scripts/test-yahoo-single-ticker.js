#!/usr/bin/env node

// Test Yahoo Finance fetch for a single ticker
//
// Usage:
//   node scripts/test-yahoo-single-ticker.js AAPL
//
// With upload:
//   WORKER_URL=https://... API_KEY=... node scripts/test-yahoo-single-ticker.js AAPL

const https = require("https");

const ticker = process.argv[2] || "AAPL";
const WORKER_URL = process.env.WORKER_URL;
const API_KEY = process.env.API_KEY;

const TF_MAP = {
  "1": { yahoo: "1m", range: "5d" },
  "3": { yahoo: "5m", range: "5d" },
  "5": { yahoo: "5m", range: "5d" },
  "10": { yahoo: "15m", range: "1mo" },
  "30": { yahoo: "30m", range: "1mo" },
  "60": { yahoo: "1h", range: "3mo" },
  "240": { yahoo: "1h", range: "3mo" },
  D: { yahoo: "1d", range: "1y" },
  W: { yahoo: "1wk", range: "2y" },
};

async function fetchYahooCandles(ticker, interval, range) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
    console.log(`Fetching: ${url}`);
    
    https
      .get(url, { timeout: 15000 }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return resolve({ ok: false, status: res.statusCode, body: data.slice(0, 200) });
          }
          try {
            const json = JSON.parse(data);
            const result = json?.chart?.result?.[0];
            if (!result) {
              return resolve({ ok: false, error: "no_result" });
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
              const ts = timestamps[i] * 1000;
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
  console.log(`=== Yahoo Finance Test: ${ticker} ===\n`);

  const tfCandles = {};

  for (const [tf, config] of Object.entries(TF_MAP)) {
    console.log(`Fetching ${tf} (${config.yahoo}, ${config.range})...`);
    
    const res = await fetchYahooCandles(ticker, config.yahoo, config.range);
    
    if (!res.ok) {
      console.log(`  ✗ Failed: ${res.error || `HTTP ${res.status}`}`);
      if (res.body) console.log(`  Response: ${res.body}`);
      await sleep(2000);
      continue;
    }

    const candles = res.candles || [];
    console.log(`  ✓ Got ${candles.length} candles`);
    
    if (candles.length > 0) {
      tfCandles[tf] = candles;
      console.log(`    First: ${new Date(candles[0].ts).toISOString()} $${candles[0].c.toFixed(2)}`);
      console.log(`    Last:  ${new Date(candles[candles.length - 1].ts).toISOString()} $${candles[candles.length - 1].c.toFixed(2)}`);
    }
    
    await sleep(1000); // Rate limit
  }

  console.log(`\n=== Summary ===`);
  console.log(`TFs with data: ${Object.keys(tfCandles).length}/9`);
  for (const [tf, candles] of Object.entries(tfCandles)) {
    console.log(`  ${tf}: ${candles.length} bars`);
  }

  if (WORKER_URL && API_KEY && Object.keys(tfCandles).length > 0) {
    console.log(`\nUploading to Worker...`);
    try {
      const res = await postCandles(ticker, tfCandles);
      if (res.ok) {
        console.log(`✓ Upload success: ingested ${res.ingested || 0} candles`);
      } else {
        console.log(`✗ Upload failed: ${res.error || "unknown"}`);
      }
    } catch (e) {
      console.log(`✗ Upload error: ${e.message}`);
    }
  } else if (!WORKER_URL || !API_KEY) {
    console.log(`\nSkipping upload (set WORKER_URL and API_KEY to enable)`);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
