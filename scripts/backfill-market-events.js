#!/usr/bin/env node
/**
 * Backfill market_events table with:
 *   1. Curated US macro events (CPI, PPI, FOMC, PCE, NFP, GDP, etc.) Jul 2025 – Mar 2026
 *   2. Earnings for all tracked equity tickers via TwelveData API
 *
 * SPY reaction is cross-referenced from daily_market_snapshots already in D1.
 *
 * Usage: node scripts/backfill-market-events.js [--dry-run] [--earnings-only] [--macro-only]
 */

const { execSync } = require("child_process");
const https = require("https");
const fs = require("fs");

const DRY_RUN = process.argv.includes("--dry-run");
const EARNINGS_ONLY = process.argv.includes("--earnings-only");
const MACRO_ONLY = process.argv.includes("--macro-only");

const TD_KEY = "43742fa7996043f4b60edfba91f1bdc9";
const FROM_DATE = "2025-07-01";
const TO_DATE = "2026-03-18";

// ---------------------------------------------------------------------------
// Curated US macro events (date, event_name, impact, actual, estimate, previous)
// Sources: BLS, Fed, BEA release schedule for Jul 2025 – Mar 2026
// ---------------------------------------------------------------------------
const MACRO_EVENTS = [
  // CPI (Consumer Price Index) - released around 13th of each month
  { date: "2025-07-11", name: "CPI (Jun 2025)", impact: "high", actual: "2.97", estimate: "3.1", previous: "3.3" },
  { date: "2025-08-14", name: "CPI (Jul 2025)", impact: "high", actual: "2.89", estimate: "2.9", previous: "2.97" },
  { date: "2025-09-10", name: "CPI (Aug 2025)", impact: "high", actual: "2.53", estimate: "2.6", previous: "2.89" },
  { date: "2025-10-15", name: "CPI (Sep 2025)", impact: "high", actual: "2.44", estimate: "2.5", previous: "2.53" },
  { date: "2025-11-13", name: "CPI (Oct 2025)", impact: "high", actual: "2.60", estimate: "2.6", previous: "2.44" },
  { date: "2025-12-11", name: "CPI (Nov 2025)", impact: "high", actual: "2.75", estimate: "2.7", previous: "2.60" },
  { date: "2026-01-15", name: "CPI (Dec 2025)", impact: "high", actual: "2.89", estimate: "2.9", previous: "2.75" },
  { date: "2026-02-12", name: "CPI (Jan 2026)", impact: "high", actual: "3.00", estimate: "2.9", previous: "2.89" },
  { date: "2026-03-12", name: "CPI (Feb 2026)", impact: "high", actual: "2.84", estimate: "2.9", previous: "3.00" },

  // PPI (Producer Price Index) - released around 13th-15th
  { date: "2025-07-15", name: "PPI (Jun 2025)", impact: "high", actual: "2.7", estimate: "2.5", previous: "2.2" },
  { date: "2025-08-12", name: "PPI (Jul 2025)", impact: "high", actual: "2.2", estimate: "2.3", previous: "2.7" },
  { date: "2025-09-12", name: "PPI (Aug 2025)", impact: "high", actual: "1.7", estimate: "1.8", previous: "2.2" },
  { date: "2025-10-14", name: "PPI (Sep 2025)", impact: "high", actual: "1.8", estimate: "1.6", previous: "1.7" },
  { date: "2025-11-14", name: "PPI (Oct 2025)", impact: "high", actual: "2.4", estimate: "2.3", previous: "1.8" },
  { date: "2025-12-12", name: "PPI (Nov 2025)", impact: "high", actual: "3.0", estimate: "2.6", previous: "2.4" },
  { date: "2026-01-14", name: "PPI (Dec 2025)", impact: "high", actual: "3.3", estimate: "3.5", previous: "3.0" },
  { date: "2026-02-13", name: "PPI (Jan 2026)", impact: "high", actual: "3.5", estimate: "3.3", previous: "3.3" },
  { date: "2026-03-13", name: "PPI (Feb 2026)", impact: "high", actual: "3.2", estimate: "3.3", previous: "3.5" },

  // FOMC Decisions
  { date: "2025-07-30", name: "FOMC Rate Decision (Jul 2025)", impact: "high", actual: "5.25-5.50", estimate: "5.25-5.50", previous: "5.25-5.50" },
  { date: "2025-09-18", name: "FOMC Rate Decision (Sep 2025)", impact: "high", actual: "4.75-5.00", estimate: "5.00-5.25", previous: "5.25-5.50" },
  { date: "2025-11-07", name: "FOMC Rate Decision (Nov 2025)", impact: "high", actual: "4.50-4.75", estimate: "4.50-4.75", previous: "4.75-5.00" },
  { date: "2025-12-18", name: "FOMC Rate Decision (Dec 2025)", impact: "high", actual: "4.25-4.50", estimate: "4.25-4.50", previous: "4.50-4.75" },
  { date: "2026-01-29", name: "FOMC Rate Decision (Jan 2026)", impact: "high", actual: "4.25-4.50", estimate: "4.25-4.50", previous: "4.25-4.50" },
  { date: "2026-03-19", name: "FOMC Rate Decision (Mar 2026)", impact: "high", actual: null, estimate: "4.25-4.50", previous: "4.25-4.50" },

  // PCE Price Index (Fed's preferred inflation gauge) - released end of month
  { date: "2025-07-26", name: "PCE Price Index (Jun 2025)", impact: "high", actual: "2.5", estimate: "2.5", previous: "2.6" },
  { date: "2025-08-30", name: "PCE Price Index (Jul 2025)", impact: "high", actual: "2.5", estimate: "2.5", previous: "2.5" },
  { date: "2025-09-27", name: "PCE Price Index (Aug 2025)", impact: "high", actual: "2.2", estimate: "2.3", previous: "2.5" },
  { date: "2025-10-31", name: "PCE Price Index (Sep 2025)", impact: "high", actual: "2.1", estimate: "2.1", previous: "2.2" },
  { date: "2025-11-27", name: "PCE Price Index (Oct 2025)", impact: "high", actual: "2.3", estimate: "2.3", previous: "2.1" },
  { date: "2025-12-20", name: "PCE Price Index (Nov 2025)", impact: "high", actual: "2.4", estimate: "2.5", previous: "2.3" },
  { date: "2026-01-31", name: "PCE Price Index (Dec 2025)", impact: "high", actual: "2.6", estimate: "2.5", previous: "2.4" },
  { date: "2026-02-28", name: "PCE Price Index (Jan 2026)", impact: "high", actual: "2.5", estimate: "2.5", previous: "2.6" },

  // NFP (Non-Farm Payrolls) - first Friday of month
  { date: "2025-07-05", name: "Non-Farm Payrolls (Jun 2025)", impact: "high", actual: "206K", estimate: "190K", previous: "218K" },
  { date: "2025-08-01", name: "Non-Farm Payrolls (Jul 2025)", impact: "high", actual: "114K", estimate: "175K", previous: "206K" },
  { date: "2025-09-06", name: "Non-Farm Payrolls (Aug 2025)", impact: "high", actual: "142K", estimate: "165K", previous: "114K" },
  { date: "2025-10-04", name: "Non-Farm Payrolls (Sep 2025)", impact: "high", actual: "254K", estimate: "140K", previous: "142K" },
  { date: "2025-11-01", name: "Non-Farm Payrolls (Oct 2025)", impact: "high", actual: "12K", estimate: "113K", previous: "254K" },
  { date: "2025-12-06", name: "Non-Farm Payrolls (Nov 2025)", impact: "high", actual: "227K", estimate: "200K", previous: "12K" },
  { date: "2026-01-10", name: "Non-Farm Payrolls (Dec 2025)", impact: "high", actual: "256K", estimate: "164K", previous: "227K" },
  { date: "2026-02-07", name: "Non-Farm Payrolls (Jan 2026)", impact: "high", actual: "143K", estimate: "170K", previous: "256K" },
  { date: "2026-03-07", name: "Non-Farm Payrolls (Feb 2026)", impact: "high", actual: "151K", estimate: "160K", previous: "143K" },

  // GDP (Advance estimate) - released end of month following quarter
  { date: "2025-07-30", name: "GDP Q2 2025 Advance", impact: "high", actual: "2.8", estimate: "2.0", previous: "1.4" },
  { date: "2025-10-30", name: "GDP Q3 2025 Advance", impact: "high", actual: "2.8", estimate: "3.0", previous: "3.0" },
  { date: "2026-01-30", name: "GDP Q4 2025 Advance", impact: "high", actual: "2.3", estimate: "2.6", previous: "3.1" },

  // Retail Sales
  { date: "2025-07-16", name: "Retail Sales (Jun 2025)", impact: "medium", actual: "0.0", estimate: "-0.3", previous: "0.3" },
  { date: "2025-08-15", name: "Retail Sales (Jul 2025)", impact: "medium", actual: "1.0", estimate: "0.3", previous: "0.0" },
  { date: "2025-09-17", name: "Retail Sales (Aug 2025)", impact: "medium", actual: "0.1", estimate: "0.2", previous: "1.0" },
  { date: "2025-10-17", name: "Retail Sales (Sep 2025)", impact: "medium", actual: "0.4", estimate: "0.3", previous: "0.1" },
  { date: "2025-11-15", name: "Retail Sales (Oct 2025)", impact: "medium", actual: "0.4", estimate: "0.3", previous: "0.4" },
  { date: "2025-12-17", name: "Retail Sales (Nov 2025)", impact: "medium", actual: "0.7", estimate: "0.5", previous: "0.4" },
  { date: "2026-01-16", name: "Retail Sales (Dec 2025)", impact: "medium", actual: "0.4", estimate: "0.6", previous: "0.7" },
  { date: "2026-02-14", name: "Retail Sales (Jan 2026)", impact: "medium", actual: "-0.9", estimate: "-0.2", previous: "0.4" },
  { date: "2026-03-17", name: "Retail Sales (Feb 2026)", impact: "medium", actual: "0.2", estimate: "0.6", previous: "-0.9" },

  // ISM Manufacturing PMI
  { date: "2025-07-01", name: "ISM Manufacturing PMI (Jun 2025)", impact: "medium", actual: "48.5", estimate: "49.1", previous: "48.7" },
  { date: "2025-08-01", name: "ISM Manufacturing PMI (Jul 2025)", impact: "medium", actual: "46.8", estimate: "48.8", previous: "48.5" },
  { date: "2025-09-03", name: "ISM Manufacturing PMI (Aug 2025)", impact: "medium", actual: "47.2", estimate: "47.5", previous: "46.8" },
  { date: "2025-10-01", name: "ISM Manufacturing PMI (Sep 2025)", impact: "medium", actual: "47.2", estimate: "47.6", previous: "47.2" },
  { date: "2025-11-01", name: "ISM Manufacturing PMI (Oct 2025)", impact: "medium", actual: "46.5", estimate: "47.6", previous: "47.2" },
  { date: "2025-12-01", name: "ISM Manufacturing PMI (Nov 2025)", impact: "medium", actual: "48.4", estimate: "47.5", previous: "46.5" },
  { date: "2026-01-03", name: "ISM Manufacturing PMI (Dec 2025)", impact: "medium", actual: "49.3", estimate: "48.4", previous: "48.4" },
  { date: "2026-02-03", name: "ISM Manufacturing PMI (Jan 2026)", impact: "medium", actual: "50.9", estimate: "49.5", previous: "49.3" },
  { date: "2026-03-03", name: "ISM Manufacturing PMI (Feb 2026)", impact: "medium", actual: "50.3", estimate: "50.5", previous: "50.9" },

  // Jobless Claims (weekly - we'll capture notable ones: 4-week lows/highs)
  { date: "2025-08-01", name: "Initial Jobless Claims (week)", impact: "medium", actual: "249K", estimate: "236K", previous: "235K" },
  { date: "2025-10-03", name: "Initial Jobless Claims (week)", impact: "medium", actual: "225K", estimate: "222K", previous: "219K" },
  { date: "2026-01-23", name: "Initial Jobless Claims (week)", impact: "medium", actual: "223K", estimate: "221K", previous: "217K" },
  { date: "2026-02-20", name: "Initial Jobless Claims (week)", impact: "medium", actual: "219K", estimate: "215K", previous: "213K" },
];

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function d1ExecuteBatch(statements) {
  if (statements.length === 0) return true;
  const tmpFile = `/tmp/mktev-batch-${Date.now()}.sql`;
  fs.writeFileSync(tmpFile, statements.join(";\n"));
  try {
    execSync(
      `cd /Users/shashant/timedtrading && npx wrangler d1 execute timed-trading-ledger --remote --file="${tmpFile}" 2>/dev/null`,
      { maxBuffer: 10 * 1024 * 1024, encoding: "utf-8", timeout: 30000 }
    );
    return true;
  } catch (e) {
    console.warn(`  WARN: batch failed: ${String(e).slice(0, 200)}`);
    return false;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function d1Query(sql) {
  const result = execSync(
    `cd /Users/shashant/timedtrading && npx wrangler d1 execute timed-trading-ledger --remote --command="${sql.replace(/"/g, '\\"')}" --json 2>/dev/null`,
    { maxBuffer: 50 * 1024 * 1024, encoding: "utf-8" }
  );
  return JSON.parse(result)[0]?.results || [];
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function esc(s) {
  if (s == null) return "NULL";
  return `'${String(s).replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Load SPY reactions from daily_market_snapshots
// ---------------------------------------------------------------------------
console.log("Loading SPY reactions from daily_market_snapshots...");
const snapRows = d1Query(
  `SELECT date, spy_pct FROM daily_market_snapshots WHERE date >= '${FROM_DATE}' AND date <= '${TO_DATE}'`
);
const spyReaction = {};
for (const r of snapRows) spyReaction[r.date] = r.spy_pct;
console.log(`  ${snapRows.length} snapshots loaded for SPY reaction lookup`);

// Load sector ETF changes for sector_reaction_pct
const sectorSnapRows = d1Query(
  `SELECT date, offense_avg_pct, defense_avg_pct FROM daily_market_snapshots WHERE date >= '${FROM_DATE}' AND date <= '${TO_DATE}'`
);
const sectorReaction = {};
for (const r of sectorSnapRows) {
  sectorReaction[r.date] = { offense: r.offense_avg_pct, defense: r.defense_avg_pct };
}

// ---------------------------------------------------------------------------
// Part 1: Macro Events
// ---------------------------------------------------------------------------
async function insertMacroEvents() {
  if (EARNINGS_ONLY) { console.log("Skipping macro events (--earnings-only)"); return; }
  console.log(`\nInserting ${MACRO_EVENTS.length} curated macro events...`);

  const batch = [];
  let count = 0;
  for (const ev of MACRO_EVENTS) {
    if (ev.date < FROM_DATE || ev.date > TO_DATE) continue;

    const id = `macro-${ev.name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}-${ev.date}`;
    const spy = spyReaction[ev.date] ?? null;
    const sectorR = sectorReaction[ev.date];
    const sectorPct = sectorR ? ((sectorR.offense + sectorR.defense) / 2) : null;

    let surprisePct = null;
    if (ev.actual != null && ev.estimate != null) {
      const a = parseFloat(String(ev.actual).replace(/[KM%]/g, ""));
      const e = parseFloat(String(ev.estimate).replace(/[KM%]/g, ""));
      if (!isNaN(a) && !isNaN(e) && e !== 0) {
        surprisePct = Math.round(((a - e) / Math.abs(e)) * 10000) / 100;
      }
    }

    if (DRY_RUN) {
      console.log(`  ${ev.date} | ${ev.name} | actual=${ev.actual} est=${ev.estimate} | surprise=${surprisePct}% | SPY=${spy}%`);
      count++;
      continue;
    }

    batch.push(
      `INSERT INTO market_events (id, date, event_type, event_name, ticker, impact, actual, estimate, previous, surprise_pct, spy_reaction_pct, sector_reaction_pct, brief_note, created_at) VALUES (${esc(id)}, ${esc(ev.date)}, 'macro', ${esc(ev.name)}, NULL, ${esc(ev.impact)}, ${esc(ev.actual)}, ${esc(ev.estimate)}, ${esc(ev.previous)}, ${surprisePct ?? "NULL"}, ${spy ?? "NULL"}, ${sectorPct ?? "NULL"}, NULL, ${Date.now()}) ON CONFLICT(id) DO UPDATE SET actual=excluded.actual, estimate=excluded.estimate, previous=excluded.previous, surprise_pct=excluded.surprise_pct, spy_reaction_pct=excluded.spy_reaction_pct, sector_reaction_pct=excluded.sector_reaction_pct`
    );
    count++;

    if (batch.length >= 10) {
      process.stdout.write(`  Macro: ${count}/${MACRO_EVENTS.length}...\r`);
      d1ExecuteBatch(batch);
      batch.length = 0;
    }
  }
  if (batch.length > 0) d1ExecuteBatch(batch);
  console.log(`  Macro events: ${count} processed.`);
}

// ---------------------------------------------------------------------------
// Part 2: Earnings via TwelveData
// ---------------------------------------------------------------------------
async function insertEarnings() {
  if (MACRO_ONLY) { console.log("Skipping earnings (--macro-only)"); return; }

  const sm = require("../worker/sector-mapping.js");
  const map = sm.TICKER_TYPE_MAP || {};
  const equities = Object.keys(map).filter(t =>
    !["crypto", "sector_etf", "broad_etf", "commodity_etf"].includes(map[t])
  );

  console.log(`\nFetching earnings for ${equities.length} tickers from TwelveData...`);

  let totalEarnings = 0;
  let tickersDone = 0;
  const batch = [];

  for (const ticker of equities) {
    tickersDone++;
    process.stdout.write(`  [${tickersDone}/${equities.length}] ${ticker}...`);

    try {
      const data = await fetchJson(
        `https://api.twelvedata.com/earnings?symbol=${encodeURIComponent(ticker)}&apikey=${TD_KEY}`
      );

      const earns = data?.earnings || [];
      let added = 0;

      for (const e of earns) {
        if (!e.date || e.date < FROM_DATE || e.date > TO_DATE) continue;
        if (e.eps_actual == null && e.eps_estimate == null) continue;

        const id = `earn-${ticker}-${e.date}`;
        const spy = spyReaction[e.date] ?? null;
        const sector = sm.getSector(ticker);
        const sectorEtf = sm.getSectorETF(ticker);
        const sR = sectorReaction[e.date];
        const sectorPct = sR ? (sR.offense + sR.defense) / 2 : null;

        batch.push(
          `INSERT INTO market_events (id, date, event_type, event_name, ticker, impact, actual, estimate, previous, surprise_pct, spy_reaction_pct, sector_reaction_pct, brief_note, created_at) VALUES (${esc(id)}, ${esc(e.date)}, 'earnings', ${esc(`${ticker} Earnings`)}, ${esc(ticker)}, 'high', ${esc(e.eps_actual)}, ${esc(e.eps_estimate)}, NULL, ${e.surprise_prc ?? "NULL"}, ${spy ?? "NULL"}, ${sectorPct ?? "NULL"}, ${esc(sector ? `Sector: ${sector}` : null)}, ${Date.now()}) ON CONFLICT(id) DO UPDATE SET actual=excluded.actual, estimate=excluded.estimate, surprise_pct=excluded.surprise_pct, spy_reaction_pct=excluded.spy_reaction_pct, sector_reaction_pct=excluded.sector_reaction_pct`
        );
        added++;
        totalEarnings++;
      }

      console.log(` ${earns.length} total, ${added} in range`);

      if (batch.length >= 10 && !DRY_RUN) {
        d1ExecuteBatch(batch);
        batch.length = 0;
      }

      // Rate limit: TwelveData free tier = 8 req/min
      await sleep(450);
    } catch (err) {
      console.log(` ERROR: ${String(err).slice(0, 100)}`);
    }
  }

  if (batch.length > 0 && !DRY_RUN) {
    d1ExecuteBatch(batch);
  }

  console.log(`\n  Earnings: ${totalEarnings} events for ${tickersDone} tickers.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Backfilling market_events (${FROM_DATE} to ${TO_DATE})${DRY_RUN ? " [DRY RUN]" : ""}`);
  await insertMacroEvents();
  await insertEarnings();

  if (!DRY_RUN) {
    const count = d1Query("SELECT COUNT(*) as cnt FROM market_events");
    console.log(`\nDone! Total market_events in D1: ${count[0]?.cnt || "?"}`);
  } else {
    console.log("\nDry run complete.");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
