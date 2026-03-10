#!/usr/bin/env node
/**
 * Debug TwelveData 5min API for 10m pagination
 * Tests: single symbol vs batch, outputsize behavior, pagination
 *
 * Usage: TWELVEDATA_API_KEY=xxx node scripts/debug-td-10m.js
 */

const TD_KEY = process.env.TWELVEDATA_API_KEY;
const TD_BASE = "https://api.twelvedata.com";

if (!TD_KEY) {
  console.error("TWELVEDATA_API_KEY required");
  process.exit(1);
}

const START = "2024-12-04T00:00:00Z"; // 450 days ago

async function fetchPage(symbols, startISO, outputsize = 5000) {
  const params = new URLSearchParams({
    symbol: Array.isArray(symbols) ? symbols.join(",") : symbols,
    interval: "5min",
    apikey: TD_KEY,
    outputsize: String(outputsize),
    order: "asc",
    timezone: "UTC",
  });
  params.set("start_date", startISO.replace("Z", "").replace("T", " ").slice(0, 19));

  const url = `${TD_BASE}/time_series?${params}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) {
    console.error("HTTP", resp.status, await resp.text().slice(0, 200));
    return null;
  }
  return resp.json();
}

async function main() {
  console.log("=== TwelveData 5min API Debug ===\n");
  console.log("Start date:", START);
  console.log("");

  // Test 1: Single symbol, outputsize 5000
  console.log("1. Single symbol (AAPL), outputsize=5000:");
  const single = await fetchPage("AAPL", START);
  if (single) {
    const vals = single.values || [];
    console.log("   Response keys:", Object.keys(single));
    console.log("   values.length:", vals.length);
    if (vals.length > 0) {
      console.log("   First:", vals[0]?.datetime);
      console.log("   Last:", vals[vals.length - 1]?.datetime);
      const firstTs = new Date(vals[0].datetime).getTime();
      const lastTs = new Date(vals[vals.length - 1].datetime).getTime();
      const days = (lastTs - firstTs) / (24 * 60 * 60 * 1000);
      console.log("   Span: ~" + Math.round(days) + " days");
    }
  }
  console.log("");

  // Test 2: Batch of 8 symbols, outputsize 5000
  console.log("2. Batch of 8 symbols, outputsize=5000:");
  const batch = ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA", "JPM"];
  const multi = await fetchPage(batch, START);
  if (multi) {
    console.log("   Response keys:", Object.keys(multi).filter(k => k !== "status"));
    for (const [sym, data] of Object.entries(multi)) {
      if (sym === "status" || !data?.values) continue;
      const vals = data.values;
      console.log(`   ${sym}: ${vals.length} bars`);
      if (vals.length > 0) {
        const firstTs = new Date(vals[0].datetime).getTime();
        const lastTs = new Date(vals[vals.length - 1].datetime).getTime();
        const days = (lastTs - firstTs) / (24 * 60 * 60 * 1000);
        console.log(`      → ${vals[0].datetime} .. ${vals[vals.length - 1].datetime} (~${Math.round(days)}d)`);
      }
    }
    const counts = Object.entries(multi)
      .filter(([k, d]) => k !== "status" && d?.values)
      .map(([, d]) => d.values.length);
    const minC = Math.min(...counts);
    const maxC = Math.max(...counts);
    console.log("   Min/Max bars per symbol:", minC, "/", maxC);
  }
  console.log("");

  // Test 3: Second page (start after last bar of first page)
  if (multi && multi.AAPL?.values?.length >= 5000) {
    const last = multi.AAPL.values[multi.AAPL.values.length - 1];

    console.log("3. Second page (start 5min after last bar of page 1):");
    const lastDt = last.datetime;
    const lastMs = new Date(lastDt.replace(" ", "T") + "Z").getTime();
    const nextStart = new Date(lastMs + 5 * 60 * 1000).toISOString();
    console.log("   Next start:", nextStart);

    const page2 = await fetchPage("AAPL", nextStart);
    if (page2?.values?.length) {
      console.log("   Page 2 values.length:", page2.values.length);
      console.log("   First:", page2.values[0]?.datetime);
      console.log("   Last:", page2.values[page2.values.length - 1]?.datetime);
    } else {
      console.log("   Page 2: no data or error");
    }
  }
  console.log("");

  // Test 4: start_date + end_date to force a specific window (oldest chunk)
  console.log("4. Single symbol, start_date + end_date (first 64 days), outputsize=5000:");
  const chunkEnd = "2025-02-06T00:00:00Z"; // ~64 days after 2024-12-04
  const params4 = new URLSearchParams({
    symbol: "AAPL",
    interval: "5min",
    apikey: TD_KEY,
    outputsize: "5000",
    order: "asc",
    timezone: "UTC",
  });
  params4.set("start_date", START.replace("Z", "").replace("T", " ").slice(0, 19));
  params4.set("end_date", chunkEnd.replace("Z", "").replace("T", " ").slice(0, 19));
  const url4 = `${TD_BASE}/time_series?${params4}`;
  const resp4 = await fetch(url4, { signal: AbortSignal.timeout(60000) });
  const data4 = await resp4.json();
  if (data4?.values?.length) {
    console.log("   values.length:", data4.values.length);
    console.log("   First:", data4.values[0]?.datetime);
    console.log("   Last:", data4.values[data4.values.length - 1]?.datetime);
  } else {
    console.log("   No values or error:", data4.status || data4.code || "?");
  }
  console.log("");

  // Test 5: Try outputsize 10000 (single symbol)
  console.log("5. Single symbol (AAPL), outputsize=10000:");
  const big = await fetchPage("AAPL", START, 10000);
  if (big) {
    const vals = big.values || [];
    console.log("   values.length:", vals.length);
    if (vals.length > 0) {
      const firstTs = new Date(vals[0].datetime).getTime();
      const lastTs = new Date(vals[vals.length - 1].datetime).getTime();
      const days = (lastTs - firstTs) / (24 * 60 * 60 * 1000);
      console.log("   Span: ~" + Math.round(days) + " days");
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
