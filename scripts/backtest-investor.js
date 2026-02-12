#!/usr/bin/env node
/**
 * Investor Backtest — Validate investor signals against forward returns.
 *
 * Two-pass approach (avoids expensive D1 self-joins):
 *   Pass 1: Fetch all trail_5m_facts snapshots with scores
 *   Pass 2: Fetch daily candles for forward return lookup
 *   In-memory: match snapshots to forward returns and compute stats
 *
 * Usage:
 *   node scripts/backtest-investor.js
 *   node scripts/backtest-investor.js --horizon 30
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { SECTOR_MAP } = require("../worker/sector-mapping.js");

function argValue(name, fb) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] != null ? process.argv[i + 1] : fb;
}

const HORIZON_DAYS = Number(argValue("--horizon", "21"));
const WORKER_DIR = path.resolve(__dirname, "../worker");

function d1Query(sql) {
  // Use --command with double-quote wrapping; collapse whitespace and escape inner quotes
  const clean = sql.replace(/\s+/g, " ").trim();
  const escaped = clean.replace(/"/g, '\\"');
  const cmd = `npx wrangler d1 execute timed-trading-ledger --remote --json --command "${escaped}"`;
  const raw = execSync(cmd, { cwd: WORKER_DIR, maxBuffer: 100 * 1024 * 1024, encoding: "utf-8", timeout: 180000 });
  try {
    const parsed = JSON.parse(raw);
    return parsed[0]?.results || [];
  } catch {
    const jsonStart = raw.indexOf("[");
    if (jsonStart >= 0) return JSON.parse(raw.slice(jsonStart))[0]?.results || [];
    throw new Error("D1 parse failed: " + raw.substring(0, 200));
  }
}

function fmtPct(n) { return Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "—"; }
function pad(s, w) { return String(s).padEnd(w); }
function rpad(s, w) { return String(s).padStart(w); }

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  INVESTOR BACKTEST — Signal Validation");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`\nForward horizon: ${HORIZON_DAYS} trading days`);
  console.log("Fetching data from D1...\n");

  // ── Pass 1: Get trail snapshots (sampled — take every 6th bucket per ticker) ──
  // D1 remote has row limits, so we sample to keep under 100K rows
  console.log("  Fetching trail_5m_facts snapshots (sampled)...");
  const snapshots = d1Query(`
    SELECT ticker, bucket_ts, price_close, price_high, price_low,
           htf_score_avg, state, had_squeeze_release, had_ema_cross,
           had_momentum_elite, sample_count
    FROM trail_5m_facts
    WHERE price_close > 0 AND sample_count >= 1
      AND (ROWID % 6) = 0
    ORDER BY ticker, bucket_ts
    LIMIT 80000
  `);
  console.log(`  → ${snapshots.length} snapshots loaded`);

  // ── Pass 2: Get daily candles for forward return computation ──
  console.log("  Fetching daily candles...");
  const candles = d1Query(`
    SELECT ticker, ts, c
    FROM ticker_candles
    WHERE tf = 'D' AND c > 0
    ORDER BY ticker, ts
    LIMIT 100000
  `);
  console.log(`  → ${candles.length} daily candles loaded`);

  // ── Build lookup: ticker → sorted daily closes ──
  const dailyMap = {}; // ticker → [{ts, c}]
  for (const c of candles) {
    const sym = String(c.ticker).toUpperCase();
    if (!dailyMap[sym]) dailyMap[sym] = [];
    dailyMap[sym].push({ ts: Number(c.ts), c: Number(c.c) });
  }

  // Forward return helper: find close ~HORIZON_DAYS trading days later
  const FWD_MS = HORIZON_DAYS * 24 * 60 * 60 * 1000;
  function forwardReturn(ticker, entryTs, entryPrice) {
    const bars = dailyMap[ticker];
    if (!bars) return null;
    const targetTs = entryTs + FWD_MS;
    // Find the closest bar to targetTs (within 2 days tolerance)
    let best = null, bestDist = Infinity;
    for (const b of bars) {
      const dist = Math.abs(b.ts - targetTs);
      if (dist < bestDist && b.ts >= entryTs + FWD_MS * 0.8) {
        bestDist = dist;
        best = b;
      }
    }
    if (!best || bestDist > 3 * 86400000) return null;
    return (best.c - entryPrice) / entryPrice * 100;
  }

  // ── Compute forward returns for each snapshot ──
  console.log("\n  Computing forward returns...");
  const results = [];
  let matched = 0, unmatched = 0;
  for (const snap of snapshots) {
    const ticker = String(snap.ticker).toUpperCase();
    const entryTs = Number(snap.bucket_ts);
    const entryPrice = Number(snap.price_close);
    const fwdRet = forwardReturn(ticker, entryTs, entryPrice);
    if (fwdRet != null) {
      results.push({
        ticker,
        htf: Number(snap.htf_score_avg) || 0,
        state: snap.state || "",
        sqRel: snap.had_squeeze_release ? 1 : 0,
        emaCross: snap.had_ema_cross ? 1 : 0,
        momElite: snap.had_momentum_elite ? 1 : 0,
        sector: SECTOR_MAP[ticker] || "Unknown",
        ret: fwdRet,
        up: fwdRet > 0 ? 1 : 0,
      });
      matched++;
    } else {
      unmatched++;
    }
  }
  console.log(`  → ${matched} matched, ${unmatched} no forward data\n`);

  if (results.length === 0) {
    console.log("  ⚠ No matched results. Need more daily candle data.\n");
    return;
  }

  // ── Aggregation helpers ──
  function stats(arr) {
    if (!arr.length) return { n: 0, avgRet: 0, upPct: 0 };
    const n = arr.length;
    const avgRet = arr.reduce((s, r) => s + r.ret, 0) / n;
    const upPct = arr.reduce((s, r) => s + r.up, 0) / n * 100;
    return { n, avgRet, upPct };
  }

  // ═══════════════════════════════════════════════════════════════════
  // TEST 1: HTF Score Buckets
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══ TEST 1: HTF SCORE → FORWARD RETURNS ═══\n");

  const htfBuckets = {
    strong_bull: results.filter(r => r.htf > 20),
    mild_bull: results.filter(r => r.htf > 5 && r.htf <= 20),
    neutral: results.filter(r => r.htf >= -5 && r.htf <= 5),
    mild_bear: results.filter(r => r.htf < -5 && r.htf >= -20),
    strong_bear: results.filter(r => r.htf < -20),
  };

  console.log(`  ${pad("Group", 16)} ${rpad("N", 8)} ${rpad("Avg Ret", 10)} ${rpad("Up%", 8)}`);
  console.log(`  ${"─".repeat(40)}`);
  for (const [label, arr] of Object.entries(htfBuckets)) {
    const s = stats(arr);
    console.log(`  ${pad(label, 16)} ${rpad(s.n, 8)} ${rpad(fmtPct(s.avgRet), 10)} ${rpad(fmtPct(s.upPct), 8)}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // TEST 2: State-based setups
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n═══ TEST 2: SETUP TYPE → FORWARD RETURNS ═══\n");

  const setupBuckets = {
    pullback_sq: results.filter(r => r.state === "HTF_BULL_LTF_PULLBACK" && r.sqRel),
    pullback_no_sq: results.filter(r => r.state === "HTF_BULL_LTF_PULLBACK" && !r.sqRel),
    bull_aligned: results.filter(r => r.state === "HTF_BULL_LTF_BULL"),
    bear: results.filter(r => r.state.startsWith("HTF_BEAR")),
  };

  console.log(`  ${pad("Setup", 20)} ${rpad("N", 8)} ${rpad("Avg Ret", 10)} ${rpad("Up%", 8)}`);
  console.log(`  ${"─".repeat(44)}`);
  for (const [label, arr] of Object.entries(setupBuckets)) {
    const s = stats(arr);
    console.log(`  ${pad(label, 20)} ${rpad(s.n, 8)} ${rpad(fmtPct(s.avgRet), 10)} ${rpad(fmtPct(s.upPct), 8)}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // TEST 3: Sector performance
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n═══ TEST 3: SECTOR PERFORMANCE ═══\n");

  const sectorGroups = {};
  for (const r of results) {
    if (!sectorGroups[r.sector]) sectorGroups[r.sector] = [];
    sectorGroups[r.sector].push(r);
  }

  const sectorStats = Object.entries(sectorGroups)
    .map(([sector, arr]) => ({ sector, ...stats(arr) }))
    .filter(s => s.n >= 10)
    .sort((a, b) => b.avgRet - a.avgRet);

  console.log(`  ${pad("Sector", 22)} ${rpad("N", 8)} ${rpad("Avg Ret", 10)} ${rpad("Up%", 8)}`);
  console.log(`  ${"─".repeat(46)}`);
  for (const s of sectorStats) {
    console.log(`  ${pad(s.sector, 22)} ${rpad(s.n, 8)} ${rpad(fmtPct(s.avgRet), 10)} ${rpad(fmtPct(s.upPct), 8)}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // TEST 4: Combined quality signal
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n═══ TEST 4: COMBINED SIGNAL QUALITY ═══\n");

  const qualityBuckets = {
    strong_setup: results.filter(r => r.htf > 15 && r.state.includes("HTF_BULL") && r.momElite),
    good_setup: results.filter(r => r.htf > 15 && r.state.includes("HTF_BULL") && !r.momElite),
    moderate: results.filter(r => r.htf > 5 && r.htf <= 15 && r.state.includes("BULL")),
    weak: results.filter(r => r.htf <= 5),
  };

  console.log(`  ${pad("Quality", 18)} ${rpad("N", 8)} ${rpad("Avg Ret", 10)} ${rpad("Up%", 8)}`);
  console.log(`  ${"─".repeat(42)}`);
  for (const [label, arr] of Object.entries(qualityBuckets)) {
    const s = stats(arr);
    console.log(`  ${pad(label, 18)} ${rpad(s.n, 8)} ${rpad(fmtPct(s.avgRet), 10)} ${rpad(fmtPct(s.upPct), 8)}`);
  }

  // ── Summary ──
  const strong = stats(qualityBuckets.strong_setup);
  const weak = stats(qualityBuckets.weak);
  if (strong.n > 0 && weak.n > 0) {
    console.log(`\n  Key Insight:`);
    console.log(`  → Strong setups: ${fmtPct(strong.avgRet)} avg, ${fmtPct(strong.upPct)} up rate`);
    console.log(`  → Weak setups:   ${fmtPct(weak.avgRet)} avg, ${fmtPct(weak.upPct)} up rate`);
    console.log(`  → ${strong.avgRet > weak.avgRet ? "✓ VALIDATED: Strong setups outperform" : "⚠ Mixed results"}`);
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  INVESTOR BACKTEST COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
