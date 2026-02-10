#!/usr/bin/env node
/**
 * Import TradingView CSV Export into the Worker
 *
 * TradingView "Export chart data" produces a CSV with columns:
 *   time, open, high, low, close, Volume
 *
 * Usage:
 *   node scripts/import-tv-csv.js --ticker ES1! --tf D --file ~/Downloads/ES1!_D.csv
 *   node scripts/import-tv-csv.js --ticker GOLD --tf 240 --file ~/Downloads/GOLD_4H.csv
 *   node scripts/import-tv-csv.js --dir ~/Downloads/tv-export/  (auto-detect from filenames)
 *
 * Environment:
 *   TIMED_API_KEY  - Worker API key (default: AwesomeSauce)
 *   WORKER_BASE    - Worker URL (default: https://timed-trading-ingest.shashant.workers.dev)
 */

const fs = require("fs");
const path = require("path");

const TIMED_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";
const WORKER_BASE = process.env.WORKER_BASE || "https://timed-trading-ingest.shashant.workers.dev";

// TradingView timeframe strings → our internal TF keys
const TV_TF_MAP = {
  "1":    "1",
  "1m":   "1",
  "3":    "3",
  "3m":   "3",
  "5":    "5",
  "5m":   "5",
  "10":   "10",
  "10m":  "10",
  "15":   "15",
  "15m":  "15",
  "30":   "30",
  "30m":  "30",
  "60":   "60",
  "1h":   "60",
  "240":  "240",
  "4h":   "240",
  "d":    "D",
  "1d":   "D",
  "daily": "D",
  "w":    "W",
  "1w":   "W",
  "weekly": "W",
  "m":    "M",
  "1m_tf": "M",  // disambiguate from 1-minute
  "monthly": "M",
};

function normalizeTF(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  return TV_TF_MAP[lower] || raw.toUpperCase();
}

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n");

  if (lines.length < 2) {
    console.error(`  File has no data rows: ${filePath}`);
    return [];
  }

  // Parse header (case-insensitive)
  const header = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/"/g, ""));

  // Find column indices
  const timeIdx = header.findIndex(h => h === "time" || h === "date" || h === "datetime" || h === "timestamp");
  const openIdx = header.findIndex(h => h === "open" || h === "o");
  const highIdx = header.findIndex(h => h === "high" || h === "h");
  const lowIdx  = header.findIndex(h => h === "low" || h === "l");
  const closeIdx = header.findIndex(h => h === "close" || h === "c");
  const volIdx  = header.findIndex(h => h === "volume" || h === "vol" || h === "v");

  if (timeIdx === -1 || openIdx === -1 || closeIdx === -1) {
    console.error(`  Could not find required columns (time, open, close) in: ${filePath}`);
    console.error(`  Header: ${header.join(", ")}`);
    return [];
  }

  const candles = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Handle quoted CSV fields
    const cols = line.split(",").map(c => c.trim().replace(/"/g, ""));

    const timeRaw = cols[timeIdx];
    const o = parseFloat(cols[openIdx]);
    const h = highIdx >= 0 ? parseFloat(cols[highIdx]) : o;
    const l = lowIdx >= 0 ? parseFloat(cols[lowIdx]) : o;
    const c = parseFloat(cols[closeIdx]);
    const v = volIdx >= 0 ? parseFloat(cols[volIdx]) || 0 : 0;

    if (isNaN(o) || isNaN(c)) continue;

    // Parse timestamp: TradingView uses Unix timestamps (seconds) or ISO format
    let ts;
    if (/^\d{6,13}$/.test(timeRaw)) {
      ts = parseInt(timeRaw);
      if (ts < 1e12) ts *= 1000; // seconds → ms
    } else {
      ts = new Date(timeRaw).getTime();
    }

    if (isNaN(ts) || ts <= 0) {
      console.error(`  Skipping row ${i}: invalid time "${timeRaw}"`);
      continue;
    }

    candles.push({ ts, o, h, l, c, v });
  }

  return candles;
}

async function uploadCandles(ticker, tf, candles) {
  const BATCH_SIZE = 500;
  let totalUpserted = 0;

  for (let i = 0; i < candles.length; i += BATCH_SIZE) {
    const batch = candles.slice(i, i + BATCH_SIZE);
    const tfCandles = {};
    tfCandles[tf] = batch;

    try {
      const resp = await fetch(`${WORKER_BASE}/timed/ingest-candles?key=${TIMED_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, tf_candles: tfCandles }),
      });
      const data = await resp.json();
      if (data.ok) {
        totalUpserted += data.ingested || batch.length;
      } else {
        console.error(`  Upload error: ${JSON.stringify(data)}`);
      }
    } catch (e) {
      console.error(`  Upload exception: ${e.message}`);
    }
  }

  return totalUpserted;
}

// Known exchange prefixes in TradingView filenames → our internal ticker
const TV_TICKER_MAP = {
  "CME_MINI_ES1!": "ES1!",
  "CME_MINI_NQ1!": "NQ1!",
  "CME_MINI_MES1!": "ES1!",   // Micro E-mini → same as ES1!
  "CME_MINI_MNQ1!": "NQ1!",   // Micro E-mini NQ → same as NQ1!
  "CAPITALCOM_US500": "US500",
  "TVC_VIX": "VIX",
  "TVC_GOLD": "GC1!",
  "TVC_SILVER": "SI1!",
  "COMEX_GC1!": "GC1!",
  "COMEX_SI1!": "SI1!",
  "MCX_GOLD1!": "GC1!",
  "MCX_SILVER1!": "SI1!",
  "OANDA_XAUUSD": "GC1!",
};

// TradingView TF strings in filenames (may include leading "1" like "1D", "1W", "1M")
const TV_FILE_TF_MAP = {
  "1":   "1",
  "3":   "3",
  "5":   "5",
  "10":  "10",
  "15":  "15",
  "30":  "30",
  "60":  "60",
  "240": "240",
  "1d":  "D",
  "d":   "D",
  "1w":  "W",
  "w":   "W",
  "1m":  "M",  // In filename context after comma, "1M" means Monthly (not 1-minute)
  "m":   "M",
};

// Try to auto-detect ticker and TF from filename
// TradingView exports: "EXCHANGE_TICKER, TF_hash.csv"
// Examples: "CME_MINI_ES1!, 1D_724af.csv", "TVC_VIX, 240_7726e.csv", "CAPITALCOM_US500, 1W_aa861.csv"
function detectFromFilename(filename) {
  const base = path.basename(filename, path.extname(filename));

  // Pattern: "EXCHANGE_TICKER, TF_HASH" (TradingView export with hash suffix)
  const tvMatch = base.match(/^(.+),\s*(\w+?)_([0-9a-f]{4,})$/i);
  if (tvMatch) {
    const rawExchangeTicker = tvMatch[1].trim();
    const rawTF = tvMatch[2].trim().toLowerCase();
    // Strip trailing hash, resolve ticker
    const ticker = TV_TICKER_MAP[rawExchangeTicker] || rawExchangeTicker.replace(/^[A-Z]+_/, "").toUpperCase();
    const tf = TV_FILE_TF_MAP[rawTF] || normalizeTF(rawTF);
    return { ticker, tf };
  }

  // Simpler pattern: "TICKER, TF" (no hash)
  const commaMatch = base.match(/^(.+),\s*(\S+)/i);
  if (commaMatch) {
    const rawTicker = commaMatch[1].trim();
    const rawTF = commaMatch[2].trim();
    const ticker = TV_TICKER_MAP[rawTicker] || rawTicker.toUpperCase();
    const tf = TV_FILE_TF_MAP[rawTF.toLowerCase()] || normalizeTF(rawTF);
    return { ticker, tf };
  }

  // Underscore separated: "TICKER_TF"
  const underscoreMatch = base.match(/^([A-Z0-9!./-]+)[_\s]+(\w+)$/i);
  if (underscoreMatch) {
    return { ticker: underscoreMatch[1].toUpperCase(), tf: normalizeTF(underscoreMatch[2]) };
  }

  return { ticker: null, tf: null };
}

async function processFile(filePath, tickerOverride, tfOverride) {
  const { ticker: detectedTicker, tf: detectedTF } = detectFromFilename(filePath);
  const ticker = tickerOverride || detectedTicker;
  const tf = tfOverride || detectedTF;

  if (!ticker || !tf) {
    console.error(`  Cannot determine ticker/tf for: ${filePath}`);
    console.error(`  Use --ticker and --tf flags, or rename file like "ES1!, D.csv"`);
    return 0;
  }

  const candles = parseCSV(filePath);
  if (candles.length === 0) {
    console.error(`  No valid candles in: ${filePath}`);
    return 0;
  }

  // Sort by timestamp
  candles.sort((a, b) => a.ts - b.ts);

  const earliest = new Date(candles[0].ts).toISOString().split("T")[0];
  const latest = new Date(candles[candles.length - 1].ts).toISOString().split("T")[0];
  process.stdout.write(`  ${ticker} ${tf}: ${candles.length} candles (${earliest} → ${latest}) ... `);

  const upserted = await uploadCandles(ticker, tf, candles);
  console.log(`${upserted} uploaded`);
  return upserted;
}

async function main() {
  const args = process.argv.slice(2);
  let ticker = null;
  let tf = null;
  let filePath = null;
  let dirPath = null;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--ticker" || args[i] === "-t") && args[i + 1]) ticker = args[++i].toUpperCase();
    if ((args[i] === "--tf") && args[i + 1]) tf = normalizeTF(args[++i]);
    if ((args[i] === "--file" || args[i] === "-f") && args[i + 1]) filePath = args[++i];
    if ((args[i] === "--dir" || args[i] === "-d") && args[i + 1]) dirPath = args[++i];
  }

  if (!filePath && !dirPath && args.length > 0) {
    // Last arg might be a file/dir path
    const last = args[args.length - 1];
    if (fs.existsSync(last)) {
      if (fs.statSync(last).isDirectory()) dirPath = last;
      else filePath = last;
    }
  }

  if (!filePath && !dirPath) {
    console.log("TradingView CSV Import Tool");
    console.log("===========================");
    console.log("");
    console.log("Usage:");
    console.log("  Single file:  node scripts/import-tv-csv.js --ticker ES1! --tf D --file ~/Downloads/chart.csv");
    console.log("  Auto-detect:  node scripts/import-tv-csv.js --file '~/Downloads/ES1!, D.csv'");
    console.log("  Directory:    node scripts/import-tv-csv.js --dir ~/Downloads/tv-exports/");
    console.log("");
    console.log("TradingView exports CSV as 'TICKER, TF.csv' — the script auto-detects from the filename.");
    console.log("Supported TF strings: 1, 3, 5, 10, 15, 30, 1H, 4H, D, W, M");
    process.exit(1);
  }

  let totalUpserted = 0;

  if (dirPath) {
    console.log(`\nScanning directory: ${dirPath}`);
    const files = fs.readdirSync(dirPath).filter(f => f.toLowerCase().endsWith(".csv"));
    if (files.length === 0) {
      console.error("No .csv files found in directory.");
      process.exit(1);
    }
    console.log(`Found ${files.length} CSV files\n`);

    // Preview auto-detection before uploading
    const detections = files.sort().map(f => {
      const { ticker: t, tf: tfKey } = detectFromFilename(f);
      return { file: f, ticker: t, tf: tfKey };
    });
    console.log("Auto-detected mappings:");
    for (const d of detections) {
      console.log(`  ${d.file}  →  ${d.ticker || "?"} ${d.tf || "?"}`);
    }
    console.log("");

    for (const f of files.sort()) {
      totalUpserted += await processFile(path.join(dirPath, f), ticker, tf);
    }
  } else {
    totalUpserted = await processFile(filePath, ticker, tf);
  }

  console.log(`\n========================================`);
  console.log(`DONE: ${totalUpserted} candles imported`);
  console.log(`========================================`);

  // Offer to score
  if (totalUpserted > 0 && ticker) {
    console.log(`\nTo score this ticker, run:`);
    console.log(`  curl -s -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/alpaca-compute?key=AwesomeSauce&ticker=${ticker}"`);
  }
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
