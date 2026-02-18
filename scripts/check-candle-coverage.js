#!/usr/bin/env node

/**
 * Check candle coverage for a set of tickers across all timeframes
 */

const BASE_URL = "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = "AwesomeSauce";

const TICKERS = [
  // Sample stocks
  "AAPL", "MSFT", "TSLA", "GOOGL", "AMD", "META", "AMZN", "NVDA", "SPY", "QQQ",
  // Crypto
  "BTCUSD", "ETHUSD",
  // Futures (TV-sourced)
  "ES1!", "NQ1!", "GOLD", "SILVER", "US500", "VX1!"
];

const TIMEFRAMES = ["1", "5", "10", "30", "60", "240", "D", "W", "M"];
const SHORT_TFS = ["1", "5", "10"]; // TFs to check latest timestamp for

async function fetchCandles(ticker, tf) {
  const url = `${BASE_URL}/timed/candles?key=${API_KEY}&ticker=${ticker}&tf=${tf}&limit=5`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    return data;
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function formatTimestamp(ts) {
  if (!ts) return "N/A";
  const date = new Date(ts);
  return date.toISOString().replace("T", " ").substring(0, 19);
}

function getLatestTimestamp(candles) {
  if (!candles || candles.length === 0) return null;
  // Candles are sorted ascending by ts, so last one is latest
  return candles[candles.length - 1]?.ts || null;
}

async function checkTicker(ticker) {
  const results = {
    ticker,
    hasData: [],
    missing: [],
    latestTimestamps: {}
  };

  console.log(`\nChecking ${ticker}...`);

  for (const tf of TIMEFRAMES) {
    const data = await fetchCandles(ticker, tf);
    
    if (data.ok && data.candles && Array.isArray(data.candles)) {
      const candleCount = data.candles.length;
      
      if (candleCount > 0) {
        results.hasData.push(tf);
        
        // For short TFs, record latest timestamp
        if (SHORT_TFS.includes(tf)) {
          const latestTs = getLatestTimestamp(data.candles);
          results.latestTimestamps[tf] = latestTs;
        }
      } else {
        results.missing.push(tf);
      }
    } else {
      results.missing.push(tf);
    }
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return results;
}

async function main() {
  console.log("Checking candle coverage for tickers...");
  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log(`Timeframes: ${TIMEFRAMES.join(", ")}`);
  
  const allResults = [];
  
  for (const ticker of TICKERS) {
    const result = await checkTicker(ticker);
    allResults.push(result);
  }

  // Generate report
  console.log("\n" + "=".repeat(80));
  console.log("CANDLE COVERAGE REPORT");
  console.log("=".repeat(80));

  // Per-ticker details
  console.log("\n## Per-Ticker Details\n");
  
  for (const result of allResults) {
    console.log(`\n### ${result.ticker}`);
    console.log(`  Has data: ${result.hasData.length > 0 ? result.hasData.join(", ") : "NONE"}`);
    
    if (result.missing.length > 0) {
      console.log(`  MISSING: ${result.missing.join(", ")}`);
    } else {
      console.log(`  ✓ All timeframes have data`);
    }
    
    if (Object.keys(result.latestTimestamps).length > 0) {
      console.log(`  Latest timestamps:`);
      for (const [tf, ts] of Object.entries(result.latestTimestamps)) {
        console.log(`    TF ${tf}: ${formatTimestamp(ts)}`);
      }
    }
  }

  // Summary statistics
  console.log("\n" + "=".repeat(80));
  console.log("## Summary Statistics\n");
  
  // Tickers with gaps
  const tickersWithGaps = allResults.filter(r => r.missing.length > 0);
  console.log(`Tickers with gaps: ${tickersWithGaps.length}/${allResults.length}`);
  if (tickersWithGaps.length > 0) {
    console.log("  " + tickersWithGaps.map(r => `${r.ticker} (missing: ${r.missing.join(", ")})`).join("\n  "));
  }

  // TF coverage statistics
  console.log(`\nTimeframe coverage:`);
  const tfCounts = {};
  for (const tf of TIMEFRAMES) {
    tfCounts[tf] = allResults.filter(r => r.hasData.includes(tf)).length;
  }
  
  for (const [tf, count] of Object.entries(tfCounts)) {
    const pct = ((count / allResults.length) * 100).toFixed(1);
    const bar = "█".repeat(Math.round(count / allResults.length * 20));
    console.log(`  TF ${tf.padEnd(3)}: ${String(count).padStart(2)}/${allResults.length} (${pct.padStart(5)}%) ${bar}`);
  }

  // Most commonly missing TFs
  const missingCounts = {};
  for (const result of allResults) {
    for (const tf of result.missing) {
      missingCounts[tf] = (missingCounts[tf] || 0) + 1;
    }
  }
  
  const sortedMissing = Object.entries(missingCounts)
    .sort((a, b) => b[1] - a[1]);
  
  if (sortedMissing.length > 0) {
    console.log(`\nMost commonly missing timeframes:`);
    for (const [tf, count] of sortedMissing) {
      console.log(`  TF ${tf}: missing in ${count} ticker(s)`);
    }
  } else {
    console.log(`\n✓ All timeframes have data for all tickers!`);
  }

  // Freshness check for short TFs
  console.log("\n" + "=".repeat(80));
  console.log("## Freshness Check (Latest Timestamps for TFs 1, 3, 5, 10)\n");
  
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);
  
  for (const result of allResults) {
    if (Object.keys(result.latestTimestamps).length === 0) continue;
    
    console.log(`\n${result.ticker}:`);
    for (const tf of SHORT_TFS) {
      const ts = result.latestTimestamps[tf];
      if (ts) {
        const ageMs = now - ts;
        const ageHours = (ageMs / (60 * 60 * 1000)).toFixed(1);
        const isRecent = ts >= oneHourAgo;
        const status = isRecent ? "✓" : "⚠";
        console.log(`  ${status} TF ${tf}: ${formatTimestamp(ts)} (${ageHours}h ago)`);
      } else {
        console.log(`  ✗ TF ${tf}: No data`);
      }
    }
  }

  console.log("\n" + "=".repeat(80));
}

main().catch(console.error);
