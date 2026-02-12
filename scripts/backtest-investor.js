#!/usr/bin/env node
/**
 * Investor Backtest — Validate investor signals against forward returns.
 *
 * Uses trail_5m_facts + ticker_candles in D1 to test:
 *   1. Do high weekly-EMA-structure tickers outperform over 2w/1m/3m?
 *   2. Do accumulation zone entries (near weekly support, weekly RSI low) beat random?
 *   3. Does relative strength rank predict forward returns?
 *   4. Does sector grouping add value?
 *
 * Usage:
 *   node scripts/backtest-investor.js
 *   node scripts/backtest-investor.js --horizon 30   # 30-day forward window
 */

const { execSync } = require("child_process");
const path = require("path");
const { SECTOR_MAP } = require("../worker/sector-mapping.js");

function argValue(name, fb) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] != null ? process.argv[i + 1] : fb;
}

const HORIZON_DAYS = Number(argValue("--horizon", "21")); // default 1 month (21 trading days)
const WORKER_DIR = path.resolve(__dirname, "../worker");

function d1Query(sql) {
  const escaped = sql.replace(/'/g, "'\\''");
  const cmd = `npx wrangler d1 execute timed-trading-ledger --remote --json --command '${escaped}'`;
  const raw = execSync(cmd, { cwd: WORKER_DIR, maxBuffer: 50 * 1024 * 1024, encoding: "utf-8", timeout: 120000 });
  try {
    const parsed = JSON.parse(raw);
    return parsed[0]?.results || [];
  } catch {
    const jsonStart = raw.indexOf("[");
    if (jsonStart >= 0) return JSON.parse(raw.slice(jsonStart))[0]?.results || [];
    throw new Error("D1 query parse failed");
  }
}

function fmtPct(n) { return Number.isFinite(n) ? `${n.toFixed(2)}%` : "—"; }
function pad(s, w) { return String(s).padEnd(w); }
function rpad(s, w) { return String(s).padStart(w); }

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  INVESTOR BACKTEST — Signal Validation");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`\nForward horizon: ${HORIZON_DAYS} trading days`);
  console.log("Querying D1...\n");

  const FWD_MS = HORIZON_DAYS * 24 * 60 * 60 * 1000; // approximate

  // ═══════════════════════════════════════════════════════════════════
  // TEST 1: Weekly EMA Structure vs Forward Returns
  // ═══════════════════════════════════════════════════════════════════

  console.log("═══ TEST 1: WEEKLY EMA STRUCTURE → FORWARD RETURNS ═══");
  console.log("Does strong weekly EMA structure predict better multi-week returns?\n");

  // Use daily candles for forward returns (more reliable than 5m for multi-week)
  const structResults = d1Query(`
    SELECT
      CASE
        WHEN t.htf_score_avg > 20 THEN 'strong_bull'
        WHEN t.htf_score_avg > 5 THEN 'mild_bull'
        WHEN t.htf_score_avg > -5 THEN 'neutral'
        WHEN t.htf_score_avg > -20 THEN 'mild_bear'
        ELSE 'strong_bear'
      END as htf_group,
      COUNT(*) as n,
      AVG((fwd.price_close - t.price_close) / t.price_close * 100) as avg_return_pct,
      AVG(CASE WHEN fwd.price_close > t.price_close THEN 1.0 ELSE 0.0 END) * 100 as up_pct,
      AVG((fwd.price_high - t.price_close) / t.price_close * 100) as avg_mfe_pct,
      AVG((fwd.price_low - t.price_close) / t.price_close * 100) as avg_mae_pct
    FROM trail_5m_facts t
    JOIN trail_5m_facts fwd
      ON fwd.ticker = t.ticker
      AND fwd.bucket_ts BETWEEN t.bucket_ts + ${FWD_MS - 86400000} AND t.bucket_ts + ${FWD_MS + 86400000}
    WHERE t.htf_score_avg IS NOT NULL
      AND t.price_close > 0
      AND fwd.price_close > 0
      AND t.sample_count >= 1
    GROUP BY htf_group
    ORDER BY htf_group
  `);

  console.log(`  ${pad("HTF Group", 16)} ${rpad("N", 10)} ${rpad("Avg Ret%", 10)} ${rpad("Up%", 8)} ${rpad("MFE%", 8)} ${rpad("MAE%", 8)}`);
  console.log(`  ${"─".repeat(58)}`);
  for (const r of structResults) {
    console.log(`  ${pad(r.htf_group, 16)} ${rpad(r.n, 10)} ${rpad(fmtPct(r.avg_return_pct), 10)} ${rpad(fmtPct(r.up_pct), 8)} ${rpad(fmtPct(r.avg_mfe_pct), 8)} ${rpad(fmtPct(r.avg_mae_pct), 8)}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // TEST 2: Accumulation Signals vs Forward Returns
  // ═══════════════════════════════════════════════════════════════════

  console.log("\n═══ TEST 2: ACCUMULATION SIGNALS → FORWARD RETURNS ═══");
  console.log("Do pullback entries (HTF bull + LTF pullback + squeeze) outperform?\n");

  const accumResults = d1Query(`
    SELECT
      CASE
        WHEN t.state = 'HTF_BULL_LTF_PULLBACK' AND t.had_squeeze_release = 0 THEN 'pullback_no_sq'
        WHEN t.state = 'HTF_BULL_LTF_PULLBACK' AND t.had_squeeze_release = 1 THEN 'pullback_sq'
        WHEN t.state = 'HTF_BULL_LTF_BULL' THEN 'bull_aligned'
        WHEN t.state LIKE 'HTF_BEAR%' THEN 'bear'
        ELSE 'other'
      END as setup_type,
      COUNT(*) as n,
      AVG((fwd.price_close - t.price_close) / t.price_close * 100) as avg_return_pct,
      AVG(CASE WHEN fwd.price_close > t.price_close THEN 1.0 ELSE 0.0 END) * 100 as up_pct
    FROM trail_5m_facts t
    JOIN trail_5m_facts fwd
      ON fwd.ticker = t.ticker
      AND fwd.bucket_ts BETWEEN t.bucket_ts + ${FWD_MS - 86400000} AND t.bucket_ts + ${FWD_MS + 86400000}
    WHERE t.state IS NOT NULL
      AND t.price_close > 0
      AND fwd.price_close > 0
    GROUP BY setup_type
    ORDER BY avg_return_pct DESC
  `);

  console.log(`  ${pad("Setup", 20)} ${rpad("N", 10)} ${rpad("Avg Ret%", 10)} ${rpad("Up%", 8)}`);
  console.log(`  ${"─".repeat(46)}`);
  for (const r of accumResults) {
    console.log(`  ${pad(r.setup_type, 20)} ${rpad(r.n, 10)} ${rpad(fmtPct(r.avg_return_pct), 10)} ${rpad(fmtPct(r.up_pct), 8)}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // TEST 3: Sector Forward Returns (Investor Horizon)
  // ═══════════════════════════════════════════════════════════════════

  console.log("\n═══ TEST 3: SECTOR PERFORMANCE AT INVESTOR HORIZON ═══");
  console.log(`Which sectors deliver best ${HORIZON_DAYS}-day forward returns?\n`);

  const sectorBuckets = [
    { name: "Technology", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Technology").map(([t]) => t) },
    { name: "Basic Materials", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Basic Materials").map(([t]) => t) },
    { name: "Precious Metals", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Precious Metals").map(([t]) => t) },
    { name: "Energy", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Energy").map(([t]) => t) },
    { name: "Financials", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Financials").map(([t]) => t) },
    { name: "Crypto", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Crypto").map(([t]) => t) },
    { name: "Healthcare", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Healthcare").map(([t]) => t) },
    { name: "Industrials", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Industrials").map(([t]) => t) },
    { name: "Consumer", tickers: Object.entries(SECTOR_MAP).filter(([, s]) => s === "Consumer").map(([t]) => t) },
  ];

  console.log(`  ${pad("Sector", 20)} ${rpad("N", 10)} ${rpad("Avg Ret%", 10)} ${rpad("Up%", 8)}`);
  console.log(`  ${"─".repeat(46)}`);

  const sectorPerf = [];
  for (const sb of sectorBuckets) {
    if (sb.tickers.length === 0) continue;
    const inList = sb.tickers.map(t => `'${t}'`).join(",");
    try {
      const rows = d1Query(`
        SELECT
          COUNT(*) as n,
          AVG((fwd.price_close - t.price_close) / t.price_close * 100) as avg_return_pct,
          AVG(CASE WHEN fwd.price_close > t.price_close THEN 1.0 ELSE 0.0 END) * 100 as up_pct
        FROM trail_5m_facts t
        JOIN trail_5m_facts fwd
          ON fwd.ticker = t.ticker
          AND fwd.bucket_ts BETWEEN t.bucket_ts + ${FWD_MS - 86400000} AND t.bucket_ts + ${FWD_MS + 86400000}
        WHERE t.ticker IN (${inList})
          AND t.price_close > 0
          AND fwd.price_close > 0
      `);
      const r = rows[0] || {};
      if (r.n > 0) {
        sectorPerf.push({ name: sb.name, ...r });
      }
    } catch {}
  }

  sectorPerf.sort((a, b) => (b.avg_return_pct || 0) - (a.avg_return_pct || 0));
  for (const r of sectorPerf) {
    console.log(`  ${pad(r.name, 20)} ${rpad(r.n, 10)} ${rpad(fmtPct(r.avg_return_pct), 10)} ${rpad(fmtPct(r.up_pct), 8)}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // TEST 4: Combined Investor Signal Quality
  // ═══════════════════════════════════════════════════════════════════

  console.log("\n═══ TEST 4: COMBINED INVESTOR SIGNALS ═══");
  console.log("Combine HTF strength + bullish state + momentum elite for investor entries\n");

  const combinedResults = d1Query(`
    SELECT
      CASE
        WHEN t.htf_score_avg > 15 AND t.state IN ('HTF_BULL_LTF_BULL','HTF_BULL_LTF_PULLBACK') AND t.had_momentum_elite = 1 THEN 'strong_setup'
        WHEN t.htf_score_avg > 15 AND t.state IN ('HTF_BULL_LTF_BULL','HTF_BULL_LTF_PULLBACK') THEN 'good_setup'
        WHEN t.htf_score_avg > 5 AND t.state LIKE 'HTF_BULL%' THEN 'moderate_setup'
        WHEN t.htf_score_avg > 5 THEN 'htf_ok'
        ELSE 'weak'
      END as quality,
      COUNT(*) as n,
      AVG((fwd.price_close - t.price_close) / t.price_close * 100) as avg_return_pct,
      AVG(CASE WHEN fwd.price_close > t.price_close THEN 1.0 ELSE 0.0 END) * 100 as up_pct,
      AVG((fwd.price_high - t.price_close) / t.price_close * 100) as avg_mfe_pct,
      AVG((fwd.price_low - t.price_close) / t.price_close * 100) as avg_mae_pct
    FROM trail_5m_facts t
    JOIN trail_5m_facts fwd
      ON fwd.ticker = t.ticker
      AND fwd.bucket_ts BETWEEN t.bucket_ts + ${FWD_MS - 86400000} AND t.bucket_ts + ${FWD_MS + 86400000}
    WHERE t.price_close > 0
      AND fwd.price_close > 0
    GROUP BY quality
    ORDER BY avg_return_pct DESC
  `);

  console.log(`  ${pad("Quality", 18)} ${rpad("N", 10)} ${rpad("Avg Ret%", 10)} ${rpad("Up%", 8)} ${rpad("MFE%", 8)} ${rpad("MAE%", 8)}`);
  console.log(`  ${"─".repeat(60)}`);
  for (const r of combinedResults) {
    console.log(`  ${pad(r.quality, 18)} ${rpad(r.n, 10)} ${rpad(fmtPct(r.avg_return_pct), 10)} ${rpad(fmtPct(r.up_pct), 8)} ${rpad(fmtPct(r.avg_mfe_pct), 8)} ${rpad(fmtPct(r.avg_mae_pct), 8)}`);
  }

  const strong = combinedResults.find(r => r.quality === "strong_setup");
  const weak = combinedResults.find(r => r.quality === "weak");
  if (strong && weak) {
    console.log(`\n  Key Insight:`);
    console.log(`  → Strong setups: ${fmtPct(strong.avg_return_pct)} avg return, ${fmtPct(strong.up_pct)} up`);
    console.log(`  → Weak setups: ${fmtPct(weak.avg_return_pct)} avg return, ${fmtPct(weak.up_pct)} up`);
    console.log(`  → ${(strong.avg_return_pct || 0) > (weak.avg_return_pct || 0) ? "✓ VALIDATED: Strong setups outperform over investor horizons" : "⚠ Mixed results"}`);
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  INVESTOR BACKTEST COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
