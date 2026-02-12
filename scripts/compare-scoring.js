#!/usr/bin/env node
/**
 * Scoring A/B Comparison — SQL-based backtester
 *
 * Validates the 3 threshold changes against actual forward price outcomes
 * using trail_5m_facts + ticker_candles data in D1.
 *
 * No need to re-process trades; queries existing 820K trail snapshots directly.
 *
 * Usage:
 *   node scripts/compare-scoring.js
 *   node scripts/compare-scoring.js --hours 4       # forward window
 */

const { execSync } = require("child_process");
const path = require("path");
const { SECTOR_MAP } = require("../worker/sector-mapping.js");

function argValue(name, fb) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] != null ? process.argv[i + 1] : fb;
}

const FWD_HOURS = Number(argValue("--hours", "4"));
const FWD_BUCKETS = Math.round(FWD_HOURS * 12); // 12 five-min buckets per hour
const WORKER_DIR = path.resolve(__dirname, "../worker");

// ─── D1 Query Helper ────────────────────────────────────────────────────────

function d1Query(sql) {
  // Escape the SQL for shell
  const escaped = sql.replace(/'/g, "'\\''");
  const cmd = `npx wrangler d1 execute timed-trading-ledger --remote --json --command '${escaped}'`;
  const raw = execSync(cmd, { cwd: WORKER_DIR, maxBuffer: 50 * 1024 * 1024, encoding: "utf-8", timeout: 120000 });
  try {
    const parsed = JSON.parse(raw);
    return parsed[0]?.results || [];
  } catch (e) {
    // wrangler sometimes prepends non-JSON lines
    const jsonStart = raw.indexOf("[");
    if (jsonStart >= 0) {
      const parsed = JSON.parse(raw.slice(jsonStart));
      return parsed[0]?.results || [];
    }
    throw new Error(`D1 query failed: ${e.message}`);
  }
}

function fmtPct(n) { return Number.isFinite(n) ? `${n.toFixed(1)}%` : "—"; }
function fmtNum(n, d = 2) { return Number.isFinite(n) ? n.toFixed(d) : "—"; }
function pad(s, w) { return String(s).padEnd(w); }
function rpad(s, w) { return String(s).padStart(w); }

// ─── Build sector lookup SQL ────────────────────────────────────────────────

// Build CASE expression for sector from SECTOR_MAP
function sectorCase() {
  const seen = {};
  const clauses = [];
  for (const [ticker, sector] of Object.entries(SECTOR_MAP)) {
    if (!seen[sector]) seen[sector] = [];
    seen[sector].push(ticker);
  }
  // Group by sector for efficiency
  for (const [sector, tickers] of Object.entries(seen)) {
    const inList = tickers.map(t => `'${t}'`).join(",");
    clauses.push(`WHEN t.ticker IN (${inList}) THEN '${sector}'`);
  }
  return `CASE ${clauses.join(" ")} ELSE 'Unknown' END`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  SCORING A/B BACKTEST — SQL Direct on D1 Trail Data");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`\nForward window: ${FWD_HOURS}h (${FWD_BUCKETS} × 5m buckets)`);
  console.log("Querying D1 directly... (each query takes 1-5 seconds)\n");

  // ─── Overall dataset stats ─────────────────────────────────────────────────
  console.log("📊 Dataset overview...");
  const overview = d1Query(`
    SELECT 
      COUNT(*) as total_rows,
      COUNT(DISTINCT ticker) as tickers,
      MIN(bucket_ts) as min_ts,
      MAX(bucket_ts) as max_ts,
      SUM(CASE WHEN had_squeeze_release = 1 THEN 1 ELSE 0 END) as sq_release_rows,
      SUM(CASE WHEN had_momentum_elite = 1 THEN 1 ELSE 0 END) as elite_rows,
      SUM(CASE WHEN had_ema_cross = 1 THEN 1 ELSE 0 END) as ema_cross_rows
    FROM trail_5m_facts
  `);
  const ov = overview[0] || {};
  console.log(`  Total rows:        ${ov.total_rows?.toLocaleString()}`);
  console.log(`  Tickers:           ${ov.tickers}`);
  console.log(`  Date range:        ${new Date(ov.min_ts).toISOString().slice(0,10)} → ${new Date(ov.max_ts).toISOString().slice(0,10)}`);
  console.log(`  Squeeze releases:  ${ov.sq_release_rows?.toLocaleString()}`);
  console.log(`  Momentum elite:    ${ov.elite_rows?.toLocaleString()}`);
  console.log(`  EMA crosses:       ${ov.ema_cross_rows?.toLocaleString()}\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 1: Squeeze Release by State
  // Old: unconditional +12 → New: setup +6, aligned +2, other -2
  // Hypothesis: squeeze releases in non-pullback states should have WORSE outcomes
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("═══ TEST 1: SQUEEZE RELEASE × STATE ═══");
  console.log("Change: unconditional +12 → setup +6, aligned +2, other -2\n");

  const sqByState = d1Query(`
    SELECT 
      CASE 
        WHEN t.state IN ('HTF_BULL_LTF_PULLBACK','HTF_BEAR_LTF_PULLBACK') THEN 'pullback'
        WHEN t.state IN ('HTF_BULL_LTF_BULL','HTF_BEAR_LTF_BEAR') THEN 'aligned'
        ELSE 'other'
      END as state_group,
      t.had_squeeze_release as sq_release,
      COUNT(*) as n,
      AVG((fwd.price_close - t.price_close) / t.price_close * 100) as avg_return_pct,
      AVG(CASE WHEN fwd.price_close > t.price_close THEN 1.0 ELSE 0.0 END) * 100 as up_pct,
      AVG((fwd.price_high - t.price_close) / t.price_close * 100) as avg_mfe_pct,
      AVG((fwd.price_low - t.price_close) / t.price_close * 100) as avg_mae_pct
    FROM trail_5m_facts t
    JOIN trail_5m_facts fwd 
      ON fwd.ticker = t.ticker 
      AND fwd.bucket_ts BETWEEN t.bucket_ts + ${FWD_BUCKETS * 300000 - 300000} AND t.bucket_ts + ${FWD_BUCKETS * 300000 + 300000}
    WHERE t.state IS NOT NULL
      AND t.price_close > 0
      AND fwd.price_close > 0
    GROUP BY state_group, t.had_squeeze_release
    ORDER BY state_group, t.had_squeeze_release
  `);

  console.log(`  ${pad("State", 12)} ${pad("Sq.Rel", 8)} ${rpad("N", 8)} ${rpad("Avg Ret%", 10)} ${rpad("Up%", 8)} ${rpad("MFE%", 8)} ${rpad("MAE%", 8)} ${rpad("Δ Score", 8)}`);
  console.log(`  ${"─".repeat(78)}`);
  for (const r of sqByState) {
    const oldBonus = r.sq_release ? 12 : 0;
    let newBonus = 0;
    if (r.sq_release) {
      if (r.state_group === "pullback") newBonus = 6;
      else if (r.state_group === "aligned") newBonus = 2;
      else newBonus = -2;
    }
    const delta = newBonus - oldBonus;
    const deltaStr = delta === 0 ? "—" : (delta > 0 ? `+${delta}` : `${delta}`);
    console.log(`  ${pad(r.state_group, 12)} ${pad(r.sq_release ? "YES" : "no", 8)} ${rpad(r.n, 8)} ${rpad(fmtPct(r.avg_return_pct), 10)} ${rpad(fmtPct(r.up_pct), 8)} ${rpad(fmtPct(r.avg_mfe_pct), 8)} ${rpad(fmtPct(r.avg_mae_pct), 8)} ${rpad(deltaStr, 8)}`);
  }

  // Interpretation
  const sqAligned = sqByState.find(r => r.state_group === "aligned" && r.sq_release);
  const sqPullback = sqByState.find(r => r.state_group === "pullback" && r.sq_release);
  const sqOther = sqByState.find(r => r.state_group === "other" && r.sq_release);
  console.log("\n  Interpretation:");
  if (sqAligned) console.log(`  → Aligned + squeeze release: ${fmtPct(sqAligned.avg_return_pct)} avg return ${sqAligned.avg_return_pct < 0 ? "(SUPPORTS -10 penalty)" : "(challenge: positive return)"}`);
  if (sqPullback) console.log(`  → Pullback + squeeze release: ${fmtPct(sqPullback.avg_return_pct)} avg return ${sqPullback.avg_return_pct > 0 ? "(SUPPORTS keeping +6)" : "(note: negative)"}`);
  if (sqOther) console.log(`  → Other + squeeze release: ${fmtPct(sqOther.avg_return_pct)} avg return ${sqOther.avg_return_pct < 0 ? "(SUPPORTS -14 penalty)" : "(challenge: positive return)"}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 2: HTF/LTF DIVERGENCE
  // Old: 0 → New: -5 penalty when HTF and LTF disagree
  // Hypothesis: diverging states should have worse outcomes
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("\n═══ TEST 2: HTF/LTF DIVERGENCE ═══");
  console.log("Change: 0 → -5 penalty when HTF > 5 and LTF < -5 (or vice versa)\n");

  const divResults = d1Query(`
    SELECT
      CASE 
        WHEN (t.htf_score_avg > 5 AND t.ltf_score_avg < -5) 
          OR (t.htf_score_avg < -5 AND t.ltf_score_avg > 5) 
        THEN 'diverging'
        ELSE 'aligned'
      END as htf_ltf,
      COUNT(*) as n,
      AVG((fwd.price_close - t.price_close) / t.price_close * 100) as avg_return_pct,
      AVG(CASE WHEN fwd.price_close > t.price_close THEN 1.0 ELSE 0.0 END) * 100 as up_pct,
      AVG((fwd.price_high - t.price_close) / t.price_close * 100) as avg_mfe_pct,
      AVG((fwd.price_low - t.price_close) / t.price_close * 100) as avg_mae_pct
    FROM trail_5m_facts t
    JOIN trail_5m_facts fwd
      ON fwd.ticker = t.ticker
      AND fwd.bucket_ts BETWEEN t.bucket_ts + ${FWD_BUCKETS * 300000 - 300000} AND t.bucket_ts + ${FWD_BUCKETS * 300000 + 300000}
    WHERE t.htf_score_avg IS NOT NULL 
      AND t.ltf_score_avg IS NOT NULL
      AND t.price_close > 0 
      AND fwd.price_close > 0
    GROUP BY htf_ltf
    ORDER BY htf_ltf
  `);

  console.log(`  ${pad("HTF/LTF", 14)} ${rpad("N", 10)} ${rpad("Avg Ret%", 10)} ${rpad("Up%", 8)} ${rpad("MFE%", 8)} ${rpad("MAE%", 8)} ${rpad("Δ Score", 8)}`);
  console.log(`  ${"─".repeat(64)}`);
  for (const r of divResults) {
    const delta = r.htf_ltf === "diverging" ? -5 : 0;
    const deltaStr = delta === 0 ? "—" : `${delta}`;
    console.log(`  ${pad(r.htf_ltf, 14)} ${rpad(r.n, 10)} ${rpad(fmtPct(r.avg_return_pct), 10)} ${rpad(fmtPct(r.up_pct), 8)} ${rpad(fmtPct(r.avg_mfe_pct), 8)} ${rpad(fmtPct(r.avg_mae_pct), 8)} ${rpad(deltaStr, 8)}`);
  }

  const divRow = divResults.find(r => r.htf_ltf === "diverging");
  const algRow = divResults.find(r => r.htf_ltf === "aligned");
  if (divRow && algRow) {
    console.log(`\n  Interpretation:`);
    console.log(`  → Diverging: ${fmtPct(divRow.avg_return_pct)} avg return vs Aligned: ${fmtPct(algRow.avg_return_pct)}`);
    console.log(`  → ${divRow.avg_return_pct < algRow.avg_return_pct ? "SUPPORTS" : "CHALLENGES"} the -5 penalty (diverging ${divRow.avg_return_pct < algRow.avg_return_pct ? "underperforms" : "outperforms"} aligned)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 3: SECTOR BIAS
  // Old: 0 → New: +3 bullish sectors, -4 Financials, -2 Crypto
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("\n═══ TEST 3: SECTOR FORWARD RETURNS ═══");
  console.log("Change: +3 (Basics/PrecMetals/Energy), -4 (Financials), -2 (Crypto)\n");

  // Build individual sector queries for manageable result sets
  const sectorBuckets = [
    { name: "Basic Materials", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Basic Materials").map(([t]) => t) },
    { name: "Precious Metals", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Precious Metals").map(([t]) => t) },
    { name: "Energy", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Energy").map(([t]) => t) },
    { name: "Financials", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Financials").map(([t]) => t) },
    { name: "Crypto", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Crypto").map(([t]) => t) },
    { name: "Technology", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Technology").map(([t]) => t) },
    { name: "Consumer", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Consumer").map(([t]) => t) },
    { name: "Healthcare", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Healthcare").map(([t]) => t) },
    { name: "Industrials", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Industrials").map(([t]) => t) },
    { name: "Real Estate", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Real Estate").map(([t]) => t) },
    { name: "Utilities", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Utilities").map(([t]) => t) },
  ];

  console.log(`  ${pad("Sector", 20)} ${rpad("N", 10)} ${rpad("Avg Ret%", 10)} ${rpad("Up%", 8)} ${rpad("MFE%", 8)} ${rpad("MAE%", 8)} ${rpad("Δ Score", 8)}`);
  console.log(`  ${"─".repeat(70)}`);

  for (const sb of sectorBuckets) {
    if (sb.tickers.length === 0) continue;
    const inList = sb.tickers.map(t => `'${t}'`).join(",");
    try {
      const rows = d1Query(`
        SELECT
          COUNT(*) as n,
          AVG((fwd.price_close - t.price_close) / t.price_close * 100) as avg_return_pct,
          AVG(CASE WHEN fwd.price_close > t.price_close THEN 1.0 ELSE 0.0 END) * 100 as up_pct,
          AVG((fwd.price_high - t.price_close) / t.price_close * 100) as avg_mfe_pct,
          AVG((fwd.price_low - t.price_close) / t.price_close * 100) as avg_mae_pct
        FROM trail_5m_facts t
        JOIN trail_5m_facts fwd
          ON fwd.ticker = t.ticker
          AND fwd.bucket_ts BETWEEN t.bucket_ts + ${FWD_BUCKETS * 300000 - 300000} AND t.bucket_ts + ${FWD_BUCKETS * 300000 + 300000}
        WHERE t.ticker IN (${inList})
          AND t.price_close > 0
          AND fwd.price_close > 0
      `);
      const r = rows[0] || {};
      if (!r.n || r.n < 10) continue;
      let delta = 0;
      if (["Basic Materials", "Precious Metals", "Energy"].includes(sb.name)) delta = 3;
      else if (sb.name === "Financials") delta = -4;
      else if (sb.name === "Crypto") delta = -2;
      const deltaStr = delta === 0 ? "—" : (delta > 0 ? `+${delta}` : `${delta}`);
      console.log(`  ${pad(sb.name, 20)} ${rpad(r.n, 10)} ${rpad(fmtPct(r.avg_return_pct), 10)} ${rpad(fmtPct(r.up_pct), 8)} ${rpad(fmtPct(r.avg_mfe_pct), 8)} ${rpad(fmtPct(r.avg_mae_pct), 8)} ${rpad(deltaStr, 8)}`);
    } catch (e) {
      console.log(`  ${pad(sb.name, 20)} [query error: ${e.message.slice(0, 40)}]`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 4: Combined effect — who gets filtered?
  // Score shift analysis: how many entries shift across the threshold
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("\n═══ TEST 4: COMBINED RANK DELTA IMPACT ═══");
  console.log("Shows forward returns grouped by how much the new formula shifts rank\n");

  // Group by delta bucket: big penalty (<= -10), small penalty (-1 to -9), no change (0), small boost (1-4), big boost (5+)
  // We compute delta per row in SQL using CASE statements
  const deltaResults = d1Query(`
    SELECT
      CASE
        WHEN (
          CASE WHEN t.had_squeeze_release = 1 AND t.state IN ('HTF_BULL_LTF_PULLBACK','HTF_BEAR_LTF_PULLBACK') THEN -6
               WHEN t.had_squeeze_release = 1 AND t.state IN ('HTF_BULL_LTF_BULL','HTF_BEAR_LTF_BEAR') THEN -10
               WHEN t.had_squeeze_release = 1 THEN -14
               ELSE 0 END
          + CASE WHEN (t.htf_score_avg > 5 AND t.ltf_score_avg < -5) OR (t.htf_score_avg < -5 AND t.ltf_score_avg > 5) THEN -5 ELSE 0 END
        ) <= -10 THEN 'penalized_hard'
        WHEN (
          CASE WHEN t.had_squeeze_release = 1 AND t.state IN ('HTF_BULL_LTF_PULLBACK','HTF_BEAR_LTF_PULLBACK') THEN -6
               WHEN t.had_squeeze_release = 1 AND t.state IN ('HTF_BULL_LTF_BULL','HTF_BEAR_LTF_BEAR') THEN -10
               WHEN t.had_squeeze_release = 1 THEN -14
               ELSE 0 END
          + CASE WHEN (t.htf_score_avg > 5 AND t.ltf_score_avg < -5) OR (t.htf_score_avg < -5 AND t.ltf_score_avg > 5) THEN -5 ELSE 0 END
        ) < 0 THEN 'penalized_mild'
        ELSE 'unchanged_or_boosted'
      END as delta_group,
      COUNT(*) as n,
      AVG((fwd.price_close - t.price_close) / t.price_close * 100) as avg_return_pct,
      AVG(CASE WHEN fwd.price_close > t.price_close THEN 1.0 ELSE 0.0 END) * 100 as up_pct,
      AVG((fwd.price_high - t.price_close) / t.price_close * 100) as avg_mfe_pct,
      AVG((fwd.price_low - t.price_close) / t.price_close * 100) as avg_mae_pct
    FROM trail_5m_facts t
    JOIN trail_5m_facts fwd
      ON fwd.ticker = t.ticker
      AND fwd.bucket_ts BETWEEN t.bucket_ts + ${FWD_BUCKETS * 300000 - 300000} AND t.bucket_ts + ${FWD_BUCKETS * 300000 + 300000}
    WHERE t.price_close > 0
      AND fwd.price_close > 0
    GROUP BY delta_group
    ORDER BY delta_group
  `);

  console.log(`  ${pad("Delta Group", 24)} ${rpad("N", 10)} ${rpad("Avg Ret%", 10)} ${rpad("Up%", 8)} ${rpad("MFE%", 8)} ${rpad("MAE%", 8)}`);
  console.log(`  ${"─".repeat(66)}`);
  for (const r of deltaResults) {
    console.log(`  ${pad(r.delta_group, 24)} ${rpad(r.n, 10)} ${rpad(fmtPct(r.avg_return_pct), 10)} ${rpad(fmtPct(r.up_pct), 8)} ${rpad(fmtPct(r.avg_mfe_pct), 8)} ${rpad(fmtPct(r.avg_mae_pct), 8)}`);
  }

  const penHard = deltaResults.find(r => r.delta_group === "penalized_hard");
  const unchanged = deltaResults.find(r => r.delta_group === "unchanged_or_boosted");
  if (penHard && unchanged) {
    console.log(`\n  Key insight:`);
    console.log(`  → Hard-penalized: ${fmtPct(penHard.avg_return_pct)} avg return, ${fmtPct(penHard.up_pct)} up`);
    console.log(`  → Unchanged/boosted: ${fmtPct(unchanged.avg_return_pct)} avg return, ${fmtPct(unchanged.up_pct)} up`);
    console.log(`  → ${penHard.avg_return_pct < unchanged.avg_return_pct ? "✓ VALIDATED: Penalized entries DO have worse outcomes" : "⚠ Mixed: penalized entries don't clearly underperform"}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 5: Entry quality gate — squeeze release + direction
  // qualifiesForEnter adds +10 to minQuality for LONG during squeeze release
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("\n═══ TEST 5: SQUEEZE RELEASE × DIRECTION ═══");
  console.log("qualifiesForEnter: +10 minQuality for LONG entries during squeeze release\n");

  const sqDirResults = d1Query(`
    SELECT
      CASE WHEN t.state LIKE 'HTF_BULL%' THEN 'LONG' ELSE 'SHORT' END as direction,
      t.had_squeeze_release as sq_release,
      COUNT(*) as n,
      AVG((fwd.price_close - t.price_close) / t.price_close * 100) as avg_return_pct,
      AVG(CASE WHEN fwd.price_close > t.price_close THEN 1.0 ELSE 0.0 END) * 100 as up_pct,
      AVG((fwd.price_high - t.price_close) / t.price_close * 100) as avg_mfe_pct,
      AVG((fwd.price_low - t.price_close) / t.price_close * 100) as avg_mae_pct
    FROM trail_5m_facts t
    JOIN trail_5m_facts fwd
      ON fwd.ticker = t.ticker
      AND fwd.bucket_ts BETWEEN t.bucket_ts + ${FWD_BUCKETS * 300000 - 300000} AND t.bucket_ts + ${FWD_BUCKETS * 300000 + 300000}
    WHERE t.state IS NOT NULL
      AND t.price_close > 0
      AND fwd.price_close > 0
      AND (t.state LIKE 'HTF_BULL%' OR t.state LIKE 'HTF_BEAR%')
    GROUP BY direction, t.had_squeeze_release
    ORDER BY direction, t.had_squeeze_release
  `);

  console.log(`  ${pad("Direction", 12)} ${pad("Sq.Rel", 8)} ${rpad("N", 10)} ${rpad("Avg Ret%", 10)} ${rpad("Up%", 8)} ${rpad("MFE%", 8)} ${rpad("MAE%", 8)}`);
  console.log(`  ${"─".repeat(64)}`);
  for (const r of sqDirResults) {
    console.log(`  ${pad(r.direction, 12)} ${pad(r.sq_release ? "YES" : "no", 8)} ${rpad(r.n, 10)} ${rpad(fmtPct(r.avg_return_pct), 10)} ${rpad(fmtPct(r.up_pct), 8)} ${rpad(fmtPct(r.avg_mfe_pct), 8)} ${rpad(fmtPct(r.avg_mae_pct), 8)}`);
  }

  const longSq = sqDirResults.find(r => r.direction === "LONG" && r.sq_release);
  const longNoSq = sqDirResults.find(r => r.direction === "LONG" && !r.sq_release);
  if (longSq && longNoSq) {
    console.log(`\n  Interpretation:`);
    console.log(`  → LONG + squeeze release: ${fmtPct(longSq.avg_return_pct)} vs no squeeze: ${fmtPct(longNoSq.avg_return_pct)}`);
    console.log(`  → ${longSq.avg_return_pct < longNoSq.avg_return_pct ? "✓ SUPPORTS +10 minQuality gate (squeeze LONGs underperform)" : "⚠ Challenge: squeeze LONGs don't underperform"}`);
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  BACKTEST COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
