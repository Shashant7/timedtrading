#!/usr/bin/env node
/**
 * Phase 1.1: Move Identification
 *
 * Scans daily candle data across the entire ticker universe to identify
 * significant price moves (up and down). For each move, captures:
 *   - Ticker, sector, direction, magnitude, duration
 *   - Start date, peak date, end date
 *   - Pre-move price, peak price
 *
 * Usage:
 *   node scripts/identify-moves.js [--min-pct 5] [--windows 3,5,10,20]
 *
 * Output:
 *   docs/moves.json          — structured move data
 *   docs/MOVES_SUMMARY.md    — human-readable summary
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { SECTOR_MAP } = require("../worker/sector-mapping.js");

// ─── Configuration ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : dflt;
};

const MIN_MOVE_PCT = Number(getArg("min-pct", "5"));        // minimum % move to qualify
const WINDOWS = getArg("windows", "3,5,10,20").split(",").map(Number); // rolling windows in trading days
const MIN_VOLUME_AVG = 500_000;  // minimum avg daily volume to filter penny stocks
const LOOKBACK_DAYS = 400;       // how far back to scan (matches our candle depth)

console.log(`\n╔══════════════════════════════════════════════╗`);
console.log(`║   Phase 1.1: Move Identification             ║`);
console.log(`╚══════════════════════════════════════════════╝`);
console.log(`  Min move: ±${MIN_MOVE_PCT}%`);
console.log(`  Windows: ${WINDOWS.join(", ")} trading days`);
console.log(`  Tickers: ${Object.keys(SECTOR_MAP).length}`);
console.log();

// ─── Step 1: Fetch all daily candles from D1 ────────────────────────────────

function queryD1(sql) {
  const cmd = `cd ${path.join(__dirname, "../worker")} && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${sql.replace(/"/g, '\\"')}"`;
  const raw = execSync(cmd, { maxBuffer: 50 * 1024 * 1024, encoding: "utf-8" });
  // wrangler --json wraps in an array of result objects
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed) && parsed[0]?.results) return parsed[0].results;
  if (parsed?.results) return parsed.results;
  return [];
}

console.log("  Fetching daily candles from D1...");

// Query in chunks to avoid D1 row limits
const CHUNK_SIZE = 15000;
let allCandles = [];
let offset = 0;
let done = false;

while (!done) {
  const rows = queryD1(
    `SELECT ticker, ts, o, h, l, c, v FROM ticker_candles WHERE tf='D' ORDER BY ticker, ts LIMIT ${CHUNK_SIZE} OFFSET ${offset}`
  );
  allCandles = allCandles.concat(rows);
  console.log(`    Fetched ${allCandles.length} candles (offset ${offset})...`);
  if (rows.length < CHUNK_SIZE) {
    done = true;
  } else {
    offset += CHUNK_SIZE;
  }
}

console.log(`  Total: ${allCandles.length} daily candles\n`);

// ─── Step 2: Group by ticker ─────────────────────────────────────────────────

const byTicker = {};
for (const c of allCandles) {
  const t = String(c.ticker).toUpperCase();
  if (!byTicker[t]) byTicker[t] = [];
  byTicker[t].push({
    ts: Number(c.ts),
    o: Number(c.o),
    h: Number(c.h),
    l: Number(c.l),
    c: Number(c.c),
    v: Number(c.v || 0),
  });
}

// Sort each ticker's candles by timestamp ascending
for (const t of Object.keys(byTicker)) {
  byTicker[t].sort((a, b) => a.ts - b.ts);
}

const watchlistOnly = !args.includes("--all-tickers");
const tickers = Object.keys(byTicker).filter((t) => {
  // Default: only analyze tickers in our SECTOR_MAP (our active watchlist)
  if (watchlistOnly && !SECTOR_MAP[t]) return false;
  const candles = byTicker[t];
  if (candles.length < 30) return false; // need minimum history
  // Filter by average volume
  const avgVol = candles.reduce((s, c) => s + c.v, 0) / candles.length;
  return avgVol >= MIN_VOLUME_AVG || !candles[0].v; // keep if volume data missing
});

console.log(`  Analyzing ${tickers.length} tickers (filtered by min history + volume)\n`);

// ─── Step 3: Identify moves ─────────────────────────────────────────────────

function dateStr(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

const allMoves = [];

for (const ticker of tickers) {
  const candles = byTicker[ticker];
  const sector = SECTOR_MAP[ticker] || "Unknown";

  for (const window of WINDOWS) {
    // Slide through the candle series
    for (let i = 0; i <= candles.length - window - 1; i++) {
      const startCandle = candles[i];
      const startPrice = startCandle.c;
      if (!Number.isFinite(startPrice) || startPrice <= 0) continue;

      // Look at the price over the next `window` trading days
      const endIdx = Math.min(i + window, candles.length - 1);
      const endCandle = candles[endIdx];
      const endPrice = endCandle.c;
      if (!Number.isFinite(endPrice) || endPrice <= 0) continue;

      const changePct = ((endPrice - startPrice) / startPrice) * 100;

      if (Math.abs(changePct) < MIN_MOVE_PCT) continue;

      // Find the peak (or trough) within the window
      let peakIdx = i;
      let peakPrice = startPrice;
      let troughIdx = i;
      let troughPrice = startPrice;

      for (let j = i + 1; j <= endIdx; j++) {
        if (candles[j].h > peakPrice) {
          peakPrice = candles[j].h;
          peakIdx = j;
        }
        if (candles[j].l < troughPrice) {
          troughPrice = candles[j].l;
          troughIdx = j;
        }
      }

      const direction = changePct > 0 ? "UP" : "DOWN";

      // For UP moves, use trough-to-peak. For DOWN, peak-to-trough.
      let moveStart, moveEnd, moveMagnitude, maxExcursion;
      if (direction === "UP") {
        moveStart = startPrice;
        moveEnd = peakPrice;
        moveMagnitude = ((peakPrice - startPrice) / startPrice) * 100;
        maxExcursion = ((troughPrice - startPrice) / startPrice) * 100; // max adverse
      } else {
        moveStart = startPrice;
        moveEnd = troughPrice;
        moveMagnitude = ((troughPrice - startPrice) / startPrice) * 100;
        maxExcursion = ((peakPrice - startPrice) / startPrice) * 100; // max adverse (up)
      }

      allMoves.push({
        ticker,
        sector,
        direction,
        window,
        startDate: dateStr(startCandle.ts),
        endDate: dateStr(endCandle.ts),
        peakDate: dateStr(candles[direction === "UP" ? peakIdx : troughIdx].ts),
        startPrice: Math.round(startPrice * 100) / 100,
        endPrice: Math.round(endPrice * 100) / 100,
        peakPrice: Math.round((direction === "UP" ? peakPrice : troughPrice) * 100) / 100,
        changePct: Math.round(changePct * 100) / 100,
        moveMagnitude: Math.round(moveMagnitude * 100) / 100,
        maxAdverseExcursion: Math.round(maxExcursion * 100) / 100,
        duration: window,
        startTs: startCandle.ts,
        endTs: endCandle.ts,
      });
    }
  }
}

console.log(`  Raw moves found: ${allMoves.length}`);

// ─── Step 4: Deduplicate overlapping moves ───────────────────────────────────
// For the same ticker, if multiple windows detect overlapping moves, keep the
// one with the largest magnitude. Also cluster moves that start within 3 days
// of each other for the same ticker+direction.

allMoves.sort((a, b) => Math.abs(b.moveMagnitude) - Math.abs(a.moveMagnitude));

const deduped = [];
const seen = new Set();

for (const move of allMoves) {
  // Create a cluster key: ticker + direction + approximate start (within 3-day buckets)
  const bucketStart = Math.floor(move.startTs / (3 * 24 * 60 * 60 * 1000));
  const key = `${move.ticker}:${move.direction}:${bucketStart}`;

  if (seen.has(key)) continue;
  seen.add(key);

  // Also mark adjacent buckets as seen to prevent near-duplicates
  seen.add(`${move.ticker}:${move.direction}:${bucketStart - 1}`);
  seen.add(`${move.ticker}:${move.direction}:${bucketStart + 1}`);

  deduped.push(move);
}

// Sort by magnitude descending
deduped.sort((a, b) => Math.abs(b.moveMagnitude) - Math.abs(a.moveMagnitude));

console.log(`  After dedup: ${deduped.length} unique moves\n`);

// ─── Step 5: Statistics ──────────────────────────────────────────────────────

const upMoves = deduped.filter((m) => m.direction === "UP");
const downMoves = deduped.filter((m) => m.direction === "DOWN");

const bySector = {};
for (const m of deduped) {
  if (!bySector[m.sector]) bySector[m.sector] = { up: 0, down: 0, moves: [] };
  bySector[m.sector][m.direction === "UP" ? "up" : "down"]++;
  bySector[m.sector].moves.push(m);
}

const byWindow = {};
for (const m of deduped) {
  if (!byWindow[m.window]) byWindow[m.window] = { up: 0, down: 0, total: 0 };
  byWindow[m.window][m.direction === "UP" ? "up" : "down"]++;
  byWindow[m.window].total++;
}

// Date range with trail_5m_facts coverage (Oct 2025 – Feb 2026)
const trailCoverageStart = new Date("2025-10-01").getTime();
const trailCoverageEnd = new Date("2026-02-08").getTime();
const movesWithTrailCoverage = deduped.filter(
  (m) => m.startTs >= trailCoverageStart && m.startTs <= trailCoverageEnd
);

console.log(`  Summary:`);
console.log(`    UP moves:   ${upMoves.length} (avg ${(upMoves.reduce((s, m) => s + m.moveMagnitude, 0) / upMoves.length).toFixed(1)}%)`);
console.log(`    DOWN moves: ${downMoves.length} (avg ${(downMoves.reduce((s, m) => s + Math.abs(m.moveMagnitude), 0) / downMoves.length).toFixed(1)}%)`);
console.log(`    With trail coverage (Oct 2025–Feb 2026): ${movesWithTrailCoverage.length}`);
console.log();

// Top 20 biggest moves
console.log(`  Top 20 Biggest Moves:`);
for (const m of deduped.slice(0, 20)) {
  const dir = m.direction === "UP" ? "▲" : "▼";
  console.log(
    `    ${dir} ${m.ticker.padEnd(6)} ${m.moveMagnitude > 0 ? "+" : ""}${m.moveMagnitude.toFixed(1)}% over ${m.window}d  (${m.startDate} → ${m.peakDate})  [${m.sector}]`
  );
}

// ─── Step 6: Write outputs ───────────────────────────────────────────────────

const docsDir = path.join(__dirname, "../docs");
if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

// JSON output
const output = {
  generated: new Date().toISOString(),
  config: {
    minMovePct: MIN_MOVE_PCT,
    windows: WINDOWS,
    minVolumeAvg: MIN_VOLUME_AVG,
  },
  summary: {
    totalMoves: deduped.length,
    upMoves: upMoves.length,
    downMoves: downMoves.length,
    tickersAnalyzed: tickers.length,
    candlesAnalyzed: allCandles.length,
    movesWithTrailCoverage: movesWithTrailCoverage.length,
    bySector: Object.fromEntries(
      Object.entries(bySector)
        .sort((a, b) => b[1].moves.length - a[1].moves.length)
        .map(([k, v]) => [k, { up: v.up, down: v.down, total: v.moves.length }])
    ),
    byWindow: byWindow,
  },
  moves: deduped,
  // Separately tag moves within trail coverage for Phase 1.2
  movesWithTrailCoverage: movesWithTrailCoverage.map((m) => m.ticker + ":" + m.startDate + ":" + m.direction),
};

fs.writeFileSync(path.join(docsDir, "moves.json"), JSON.stringify(output, null, 2));

// Markdown summary
const md = [];
md.push("# Move Identification Results");
md.push("");
md.push(`> Generated: ${new Date().toISOString()}`);
md.push(`> Config: ≥${MIN_MOVE_PCT}% moves, windows: ${WINDOWS.join(", ")}d, ${tickers.length} tickers, ${allCandles.length} candles`);
md.push("");
md.push("## Summary");
md.push("");
md.push(`| Metric | Value |`);
md.push(`|--------|-------|`);
md.push(`| Total significant moves | ${deduped.length} |`);
md.push(`| UP moves | ${upMoves.length} (${((upMoves.length / deduped.length) * 100).toFixed(0)}%) |`);
md.push(`| DOWN moves | ${downMoves.length} (${((downMoves.length / deduped.length) * 100).toFixed(0)}%) |`);
md.push(`| Avg UP magnitude | +${(upMoves.reduce((s, m) => s + m.moveMagnitude, 0) / (upMoves.length || 1)).toFixed(1)}% |`);
md.push(`| Avg DOWN magnitude | ${(downMoves.reduce((s, m) => s + m.moveMagnitude, 0) / (downMoves.length || 1)).toFixed(1)}% |`);
md.push(`| Moves with trail coverage | ${movesWithTrailCoverage.length} |`);
md.push("");
md.push("## By Window Size");
md.push("");
md.push("| Window | UP | DOWN | Total |");
md.push("|--------|-----|------|-------|");
for (const w of WINDOWS) {
  const d = byWindow[w] || { up: 0, down: 0, total: 0 };
  md.push(`| ${w}D | ${d.up} | ${d.down} | ${d.total} |`);
}
md.push("");
md.push("## By Sector");
md.push("");
md.push("| Sector | UP | DOWN | Total |");
md.push("|--------|-----|------|-------|");
for (const [sector, data] of Object.entries(bySector).sort((a, b) => b[1].moves.length - a[1].moves.length)) {
  md.push(`| ${sector} | ${data.up} | ${data.down} | ${data.moves.length} |`);
}
md.push("");
md.push("## Top 30 Biggest Moves");
md.push("");
md.push("| Rank | Ticker | Dir | Magnitude | Window | Start | Peak | Sector |");
md.push("|------|--------|-----|-----------|--------|-------|------|--------|");
for (let i = 0; i < Math.min(30, deduped.length); i++) {
  const m = deduped[i];
  const dir = m.direction === "UP" ? "▲" : "▼";
  md.push(
    `| ${i + 1} | ${m.ticker} | ${dir} | ${m.moveMagnitude > 0 ? "+" : ""}${m.moveMagnitude.toFixed(1)}% | ${m.window}D | ${m.startDate} | ${m.peakDate} | ${m.sector} |`
  );
}
md.push("");
md.push("## Moves Within Trail Coverage (Oct 2025 – Feb 2026)");
md.push("");
md.push(`These ${movesWithTrailCoverage.length} moves have full scoring trail data available for pattern extraction in Phase 1.2.`);
md.push("");
md.push("| Ticker | Dir | Magnitude | Window | Start | Peak | Sector |");
md.push("|--------|-----|-----------|--------|-------|------|--------|");
for (const m of movesWithTrailCoverage.slice(0, 50)) {
  const dir = m.direction === "UP" ? "▲" : "▼";
  md.push(
    `| ${m.ticker} | ${dir} | ${m.moveMagnitude > 0 ? "+" : ""}${m.moveMagnitude.toFixed(1)}% | ${m.window}D | ${m.startDate} | ${m.peakDate} | ${m.sector} |`
  );
}
if (movesWithTrailCoverage.length > 50) {
  md.push(`| ... | | | | | | *(${movesWithTrailCoverage.length - 50} more)* |`);
}

fs.writeFileSync(path.join(docsDir, "MOVES_SUMMARY.md"), md.join("\n"));

console.log(`\n  ✅ Output written:`);
console.log(`     docs/moves.json (${deduped.length} moves)`);
console.log(`     docs/MOVES_SUMMARY.md`);
console.log(`\n  Next: Phase 1.2 — run scripts/extract-patterns.js to trace lead-up signals\n`);
