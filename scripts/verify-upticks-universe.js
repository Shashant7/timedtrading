#!/usr/bin/env node
/**
 * Verify TT universe reflects Upticks group changes:
 * - Added: BG, MRK, QXO, AXP
 * - Removed from Upticks: APP, GLXY, SPGI (still in SECTOR_MAP)
 *
 * Checks: ticker index, ingestion status (candle coverage), scores.
 * Usage: TIMED_API_KEY=your_key node scripts/verify-upticks-universe.js
 */
const API_BASE = process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";

const UPTICKS_ADDED = ["BG", "MRK", "QXO", "AXP"];
const UPTICKS_REMOVED = ["APP", "GLXY", "SPGI"];

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  TT Universe Verification (Upticks: BG, MRK, QXO, AXP)       ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const results = { inIndex: [], notInIndex: [], withScores: [], noScores: [], ingestion: {} };

  // 1. GET /timed/tickers — list of active tickers
  console.log("1. Fetching /timed/tickers...");
  let tickers = [];
  try {
    const res = await fetchJson(`${API_BASE}/timed/tickers`);
    tickers = res.tickers || res || [];
    if (!Array.isArray(tickers)) tickers = [];
    const tickerSet = new Set(tickers.map((t) => String(t || "").toUpperCase()));
    console.log(`   Total tickers in index: ${tickers.length}`);

    for (const t of UPTICKS_ADDED) {
      if (tickerSet.has(t)) {
        results.inIndex.push(t);
      } else {
        results.notInIndex.push(t);
      }
    }
    console.log(`   Upticks added (BG, MRK, QXO, AXP): in index=${results.inIndex.join(", ") || "none"}`);
    if (results.notInIndex.length) console.log(`   NOT in index: ${results.notInIndex.join(", ")}`);
  } catch (e) {
    console.error("   Error:", e.message);
  }

  // 2. GET /timed/all — snapshot for scores
  console.log("\n2. Fetching /timed/all (scores snapshot)...");
  try {
    const allRes = await fetchJson(`${API_BASE}/timed/all`);
    const data = allRes.data || allRes || {};
    for (const t of UPTICKS_ADDED) {
      const d = data[t];
      const hasScore = d && (d.rank != null || d.htf_score != null || d.ltf_score != null || (d.price != null && d.price > 0));
      if (hasScore) results.withScores.push(t);
      else results.noScores.push(t);
    }
    console.log(`   With scores: ${results.withScores.join(", ") || "none"}`);
    if (results.noScores.length) console.log(`   No scores: ${results.noScores.join(", ")}`);
  } catch (e) {
    console.error("   Error:", e.message);
  }

  // 3. GET /timed/admin/ingestion-status — candle coverage (requires key)
  console.log("\n3. Fetching /timed/admin/ingestion-status (candle coverage)...");
  try {
    const ingRes = await fetchJson(`${API_BASE}/timed/admin/ingestion-status?key=${API_KEY}`);
    const tickerList = ingRes.tickers || [];
    const byTicker = tickerList.reduce((acc, r) => {
      acc[r.ticker] = r;
      return acc;
    }, {});

    for (const t of UPTICKS_ADDED) {
      const r = byTicker[t];
      const dCount = r?.tfs?.D?.count ?? 0;
      const wCount = r?.tfs?.W?.count ?? 0;
      results.ingestion[t] = r
        ? {
            hasData: dCount > 0 || wCount > 0,
            D: dCount,
            W: wCount,
            status: r.pct != null ? `pct=${r.pct}` : "unknown",
          }
        : { hasData: false, D: 0, W: 0, status: "not_in_report" };
    }
    for (const t of UPTICKS_ADDED) {
      const ing = results.ingestion[t];
      console.log(`   ${t}: D=${ing.D}, W=${ing.W} ${ing.hasData ? "✓" : "✗"}`);
    }
  } catch (e) {
    console.error("   Error:", e.message, "(may need API key or admin auth)");
  }

  // Summary
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════");
  const allInIndex = results.notInIndex.length === 0;
  const allScored = results.noScores.length === 0;
  const allHaveCandles = UPTICKS_ADDED.every((t) => results.ingestion[t]?.hasData);

  if (allInIndex) console.log("✓ All 4 Upticks (BG, MRK, QXO, AXP) are in the ticker index");
  else console.log(`✗ Missing from index: ${results.notInIndex.join(", ")} — run POST /timed/admin/sync-universe`);

  if (allScored) console.log("✓ All 4 have scores in /timed/all");
  else console.log(`✗ No scores: ${results.noScores.join(", ")} — run POST /timed/admin/onboard?ticker=BG,MRK,QXO,AXP`);

  if (allHaveCandles) console.log("✓ All 4 have candle data (backfill complete)");
  else {
    const missing = UPTICKS_ADDED.filter((t) => !results.ingestion[t]?.hasData);
    console.log(`✗ Missing candles: ${missing.join(", ")} — run POST /timed/admin/onboard?ticker=...`);
  }

  if (!allInIndex || !allScored || !allHaveCandles) {
    console.log("\nRecommended actions:");
    if (!allInIndex) console.log(`  curl -X POST "${API_BASE}/timed/admin/sync-universe?key=${API_KEY}"`);
    if (!allScored || !allHaveCandles) console.log(`  curl -X POST "${API_BASE}/timed/admin/onboard?ticker=BG,MRK,QXO,AXP&key=${API_KEY}"`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
