#!/usr/bin/env node
/**
 * analyze-missed-tickers.js — Data coverage + signal pattern analysis for never-traded tickers.
 *
 * Step 1: Query D1 for candle and trail_5m_facts coverage.
 * Step 2: (later) Signal pattern analysis on move discovery output.
 *
 * Usage:
 *   TIMED_API_KEY=... node scripts/analyze-missed-tickers.js --check-coverage
 *   TIMED_API_KEY=... node scripts/analyze-missed-tickers.js --analyze-patterns --input data/move-discovery-*.json
 */

const API_BASE = process.env.API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || process.env.API_KEY || "AwesomeSauce";
const SINCE_TS = new Date("2025-07-01T00:00:00Z").getTime();

const MISSED_TICKERS = [
  "DY","STRL","IBP","DCI","AVAV","AXON","MLI","NXT","CARR","CW","FLR","VMI","UNP","ARRY",
  "JPM","GS","AXP","SPGI","PNC","BK","ALLY","EWBC","WAL","SOFI","HOOD","MTB","COIN",
  "AMD","KLAC","CDNS","MDB","PATH","SANM","IONQ","LITE","MSTR","LSCC","SHOP","SMCI",
  "VST","FSLR","TLN","WFRD","CVX","DINO","OKE","TPL","AR",
  "AMGN","GILD","UTHR","NBIS","EXEL","HALO","UHS","VRTX","ISRG",
  "MP","SN","APD","PKG","PPG",
  "META","GOOGL","NFLX","RDDT",
  "GLXY","RIOT","ETHA",
  "BABA","LRN",
  "RKLB","NOC",
  "ELF"
];

const SECTOR_MAP = {
  DY:"Industrials",STRL:"Industrials",IBP:"Industrials",DCI:"Industrials",AVAV:"Industrials",
  AXON:"Industrials",MLI:"Industrials",NXT:"Industrials",CARR:"Industrials",CW:"Industrials",
  FLR:"Industrials",VMI:"Industrials",UNP:"Industrials",ARRY:"Industrials",
  JPM:"Financials",GS:"Financials",AXP:"Financials",SPGI:"Financials",PNC:"Financials",
  BK:"Financials",ALLY:"Financials",EWBC:"Financials",WAL:"Financials",SOFI:"Financials",
  HOOD:"Financials",MTB:"Financials",COIN:"Financials",
  AMD:"IT",KLAC:"IT",CDNS:"IT",MDB:"IT",PATH:"IT",SANM:"IT",IONQ:"IT",LITE:"IT",
  MSTR:"IT",LSCC:"IT",SHOP:"IT",SMCI:"IT",
  VST:"Energy",FSLR:"Energy",TLN:"Energy",WFRD:"Energy",CVX:"Energy",DINO:"Energy",
  OKE:"Energy",TPL:"Energy",AR:"Energy",
  AMGN:"Health Care",GILD:"Health Care",UTHR:"Health Care",NBIS:"Health Care",EXEL:"Health Care",
  HALO:"Health Care",UHS:"Health Care",VRTX:"Health Care",ISRG:"Health Care",
  MP:"Materials",SN:"Materials",APD:"Materials",PKG:"Materials",PPG:"Materials",
  META:"Comm Svcs",GOOGL:"Comm Svcs",NFLX:"Comm Svcs",RDDT:"Comm Svcs",
  GLXY:"Crypto",RIOT:"Crypto",ETHA:"Crypto",
  BABA:"Consumer Disc",LRN:"Consumer Disc",
  RKLB:"Aero/Defense",NOC:"Aero/Defense",
  ELF:"Consumer Staples"
};

async function apiFetch(path) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${API_BASE}${path}${sep}key=${API_KEY}`;
  const resp = await fetch(url);
  return resp.json();
}

async function checkCoverage() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("STEP 1: Data Coverage Check for 74 Missed Tickers");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const results = [];
  const BATCH = 5;

  for (let i = 0; i < MISSED_TICKERS.length; i += BATCH) {
    const batch = MISSED_TICKERS.slice(i, i + BATCH);
    const promises = batch.map(async (ticker) => {
      try {
        const trailUrl = `/timed/admin/d1-query?sql=${encodeURIComponent(
          `SELECT COUNT(*) as cnt FROM trail_5m_facts WHERE ticker='${ticker}' AND bucket_ts >= ${SINCE_TS}`
        )}`;
        const candleUrl = `/timed/admin/d1-query?sql=${encodeURIComponent(
          `SELECT COUNT(*) as cnt FROM ticker_candles WHERE ticker='${ticker}' AND tf='D' AND ts >= ${SINCE_TS}`
        )}`;
        const [trailResp, candleResp] = await Promise.all([apiFetch(trailUrl), apiFetch(candleUrl)]);
        const trailCount = trailResp?.results?.[0]?.cnt ?? trailResp?.rows?.[0]?.cnt ?? 0;
        const candleCount = candleResp?.results?.[0]?.cnt ?? candleResp?.rows?.[0]?.cnt ?? 0;
        return { ticker, trailCount: Number(trailCount), candleCount: Number(candleCount) };
      } catch (e) {
        return { ticker, trailCount: 0, candleCount: 0, error: String(e.message).slice(0, 80) };
      }
    });
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
    if (i + BATCH < MISSED_TICKERS.length) {
      process.stdout.write(`  Checked ${Math.min(i + BATCH, MISSED_TICKERS.length)}/${MISSED_TICKERS.length}...\r`);
      await new Promise(r => setTimeout(r, 300));
    }
  }

  const sufficient = results.filter(r => r.candleCount >= 50 && r.trailCount >= 100);
  const noCandles = results.filter(r => r.candleCount < 50);
  const noTrail = results.filter(r => r.candleCount >= 50 && r.trailCount < 100);

  console.log(`\nTotal tickers: ${results.length}`);
  console.log(`Sufficient data (>=50 candles, >=100 trail rows): ${sufficient.length}`);
  console.log(`Missing candles (<50 daily): ${noCandles.length}`);
  console.log(`Missing trail (<100 rows): ${noTrail.length}`);

  console.log("\n── SUFFICIENT DATA ──");
  console.log("Ticker   Candles  Trail5m  Sector");
  for (const r of sufficient.sort((a, b) => b.trailCount - a.trailCount)) {
    console.log(`  ${r.ticker.padEnd(6)} ${String(r.candleCount).padStart(6)}  ${String(r.trailCount).padStart(7)}  ${SECTOR_MAP[r.ticker] || "?"}`);
  }

  if (noCandles.length > 0) {
    console.log("\n── MISSING CANDLES (<50 daily) ──");
    for (const r of noCandles) {
      console.log(`  ${r.ticker.padEnd(6)} candles=${r.candleCount}  trail=${r.trailCount}  ${SECTOR_MAP[r.ticker] || "?"}`);
    }
  }

  if (noTrail.length > 0) {
    console.log("\n── MISSING TRAIL DATA (<100 rows) ──");
    for (const r of noTrail) {
      console.log(`  ${r.ticker.padEnd(6)} candles=${r.candleCount}  trail=${r.trailCount}  ${SECTOR_MAP[r.ticker] || "?"}`);
    }
  }

  return { results, sufficient, noCandles, noTrail };
}

async function main() {
  const mode = process.argv[2] || "--check-coverage";
  if (mode === "--check-coverage") {
    await checkCoverage();
  } else {
    console.log("Usage: node scripts/analyze-missed-tickers.js --check-coverage");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
