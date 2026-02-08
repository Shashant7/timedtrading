/**
 * Backtest Harness: Scoring Rules vs Historical Outcomes
 *
 * Fetches trail data for all tickers, simulates entries based on scoring
 * thresholds, then measures forward outcomes (hit TP, hit SL, MFE/MAE).
 *
 * Reports:
 *   1. Per-score-bucket win rates and expected value
 *   2. Per-signal (flags) predictive power
 *   3. Overall system performance at each score threshold
 *
 * Usage:
 *   node scripts/backtest-scoring.js
 *   node scripts/backtest-scoring.js --days 14 --threshold 60
 *   node scripts/backtest-scoring.js --since 2026-01-25 --until 2026-02-07
 */

const API_BASE = process.env.API_BASE || "https://timed-trading-ingest.shashant.workers.dev";

// ─── CLI Arguments ──────────────────────────────────────────────────────────

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  return v != null ? v : fallback;
}

const DAYS = Number(argValue("--days", "14"));
const SINCE_RAW = argValue("--since", "");
const UNTIL_RAW = argValue("--until", "");
const SCORE_THRESHOLD = Number(argValue("--threshold", "0")); // min score to enter
const HOLD_BARS = Number(argValue("--hold", "48")); // max bars (5m each) to hold = 4 hours
const OUTPUT_JSON = argValue("--json", "docs/BACKTEST_RESULTS.json");
const OUTPUT_MD = argValue("--md", "docs/BACKTEST_RESULTS.md");
const VERBOSE = process.argv.includes("--verbose");

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function fmtPct(n, d = 1) { return Number.isFinite(n) ? `${(n * 100).toFixed(d)}%` : "—"; }
function fmtNum(n, d = 2) { return Number.isFinite(n) ? n.toFixed(d) : "—"; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Signal Detection ───────────────────────────────────────────────────────

/**
 * Detect entry signals from a trail point.
 * Returns { shouldEnter, direction, score, signals[] } or null.
 */
function detectEntry(point) {
  const rank = Number(point.rank);
  const htf = Number(point.htf_score);
  const ltf = Number(point.ltf_score);
  const state = String(point.state || "");
  const completion = Number(point.completion);
  const phase = Number(point.phase_pct);
  const flags = point.flags || {};

  if (!Number.isFinite(rank) || !Number.isFinite(htf)) return null;
  if (!Number.isFinite(point.price) || point.price <= 0) return null;

  // Direction from HTF
  const dir = state.startsWith("HTF_BULL") ? "LONG" : state.startsWith("HTF_BEAR") ? "SHORT" : null;
  if (!dir) return null;

  // Collect active signals
  const signals = [];
  if (state.includes("PULLBACK")) signals.push("ltf_pullback");
  if (flags.sq30_release) signals.push("sq30_release");
  if (flags.sq30_on && !flags.sq30_release) signals.push("sq30_on");
  if (flags.momentum_elite) signals.push("momentum_elite");
  if (flags.thesis_match) signals.push("thesis_match");
  if (flags.flip_watch) signals.push("flip_watch");
  if (flags.st_flip_1h) signals.push("st_flip_1h");
  if (flags.ema_cross_1h_13_48) signals.push("ema_cross_1h");
  if (flags.htf_improving_4h) signals.push("htf_improving");

  // Aligned states (not pullback)
  const isAligned = (state === "HTF_BULL_LTF_BULL") || (state === "HTF_BEAR_LTF_BEAR");
  if (isAligned) signals.push("aligned");

  // In corridor (completion < 0.6 and phase < 0.5)
  const inCorridor = Number.isFinite(completion) && completion < 0.6 &&
                     Number.isFinite(phase) && phase < 0.5;
  if (inCorridor) signals.push("in_corridor");

  // Score from rank (server-computed)
  const score = rank;

  return {
    shouldEnter: score >= SCORE_THRESHOLD,
    direction: dir,
    score,
    signals,
    completion: Number.isFinite(completion) ? completion : null,
    phase: Number.isFinite(phase) ? phase : null,
  };
}

// ─── Forward Outcome Measurement ────────────────────────────────────────────

/**
 * Measure forward outcome from an entry point.
 * Walks forward through trail points, tracking MFE (max favorable), MAE (max adverse).
 */
function measureOutcome(trail, entryIdx, direction, holdBars) {
  const entry = trail[entryIdx];
  const entryPrice = entry.price;
  const endIdx = Math.min(trail.length - 1, entryIdx + holdBars);

  let mfe = 0;       // Max Favorable Excursion (best unrealized gain)
  let mae = 0;       // Max Adverse Excursion (worst unrealized drawdown)
  let mfeTs = entry.ts;
  let maeTs = entry.ts;
  let exitPrice = entryPrice;
  let exitTs = entry.ts;

  for (let i = entryIdx + 1; i <= endIdx; i++) {
    const p = trail[i];
    if (!Number.isFinite(p.price) || p.price <= 0) continue;

    const pnlPct = direction === "LONG"
      ? (p.price - entryPrice) / entryPrice
      : (entryPrice - p.price) / entryPrice;

    if (pnlPct > mfe) { mfe = pnlPct; mfeTs = p.ts; }
    if (pnlPct < mae) { mae = pnlPct; maeTs = p.ts; }

    exitPrice = p.price;
    exitTs = p.ts;
  }

  const finalPnlPct = direction === "LONG"
    ? (exitPrice - entryPrice) / entryPrice
    : (entryPrice - exitPrice) / entryPrice;

  // Simulate TP/SL hits using ATR-based levels
  // TP1 = 0.618% of move, TP2 = 1.0%, XP = 1.618%
  // SL = -1.5% adverse
  const hitTP1 = mfe >= 0.00618; // 0.618% gain
  const hitTP2 = mfe >= 0.01;    // 1.0% gain
  const hitXP  = mfe >= 0.01618; // 1.618% gain
  const hitSL  = mae <= -0.015;  // 1.5% adverse

  // Win/loss classification
  // Win: hit TP1 before SL (approximate)
  const isWin = hitTP1 && (!hitSL || mfeTs <= maeTs);
  const isLoss = hitSL && (!hitTP1 || maeTs < mfeTs);

  return {
    entryPrice,
    exitPrice,
    entryTs: entry.ts,
    exitTs,
    finalPnlPct,
    mfe,
    mae,
    hitTP1,
    hitTP2,
    hitXP,
    hitSL,
    isWin,
    isLoss,
    holdMinutes: (exitTs - entry.ts) / 60000,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  BACKTEST HARNESS: Scoring Rules vs Historical Outcomes");
  console.log("═══════════════════════════════════════════════════════════════");

  const now = Date.now();
  const sinceMs = SINCE_RAW ? Date.parse(SINCE_RAW) : now - DAYS * 24 * 60 * 60 * 1000;
  const untilMs = UNTIL_RAW ? Date.parse(UNTIL_RAW) + 24 * 60 * 60 * 1000 : now;
  console.log(`\nPeriod: ${new Date(sinceMs).toISOString().slice(0,10)} to ${new Date(untilMs).toISOString().slice(0,10)}`);
  console.log(`Score threshold: >= ${SCORE_THRESHOLD}`);
  console.log(`Hold window: ${HOLD_BARS} bars (${(HOLD_BARS * 5 / 60).toFixed(1)} hours)`);

  // 1. Fetch all tickers
  const tickersResp = await fetchJson(`${API_BASE}/timed/tickers`);
  const allTickers = tickersResp?.tickers || [];
  const tickerSyms = allTickers.map(t => typeof t === "string" ? t : t.ticker).filter(Boolean);
  console.log(`\nLoaded ${tickerSyms.length} tickers. Fetching trail data...`);

  // 2. Fetch trail data for each ticker
  const allEntries = [];
  let fetchedCount = 0;
  let skippedCount = 0;

  for (const ticker of tickerSyms) {
    try {
      const url = `${API_BASE}/timed/trail?ticker=${ticker}&since=${sinceMs}&limit=20000`;
      const resp = await fetchJson(url);
      const trail = resp?.trail || [];

      if (trail.length < 10) {
        skippedCount++;
        continue;
      }

      // Sort by timestamp
      trail.sort((a, b) => a.ts - b.ts);

      // Filter to window
      const filtered = trail.filter(p => p.ts >= sinceMs && p.ts <= untilMs);
      if (filtered.length < 10) {
        skippedCount++;
        continue;
      }

      // Walk through trail, detect entries, measure outcomes
      // Minimum gap between entries for same ticker: 30 minutes (6 bars of 5m)
      let lastEntryTs = 0;
      const MIN_GAP_MS = 30 * 60 * 1000;

      for (let i = 0; i < filtered.length - HOLD_BARS; i++) {
        const point = filtered[i];
        if (point.ts - lastEntryTs < MIN_GAP_MS) continue;

        const entry = detectEntry(point);
        if (!entry || !entry.shouldEnter) continue;

        const outcome = measureOutcome(filtered, i, entry.direction, HOLD_BARS);

        allEntries.push({
          ticker,
          ts: point.ts,
          price: point.price,
          direction: entry.direction,
          score: entry.score,
          signals: entry.signals,
          completion: entry.completion,
          phase: entry.phase,
          state: point.state,
          ...outcome,
        });

        lastEntryTs = point.ts;
      }

      fetchedCount++;
      if (fetchedCount % 20 === 0) {
        process.stdout.write(`  ${fetchedCount}/${tickerSyms.length} tickers, ${allEntries.length} entries so far\r`);
      }

      // Rate limit to avoid hammering the API
      if (fetchedCount % 5 === 0) await sleep(100);
    } catch (err) {
      if (VERBOSE) console.warn(`  [WARN] ${ticker}: ${err.message}`);
      skippedCount++;
    }
  }

  console.log(`\nFetched ${fetchedCount} tickers (${skippedCount} skipped). Found ${allEntries.length} simulated entries.`);

  if (allEntries.length === 0) {
    console.log("\nNo entries found. Try lowering --threshold or extending --days.");
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 1: Overall Performance
  // ═══════════════════════════════════════════════════════════════════════════

  const wins = allEntries.filter(e => e.isWin);
  const losses = allEntries.filter(e => e.isLoss);
  const neutrals = allEntries.filter(e => !e.isWin && !e.isLoss);

  const winRate = wins.length / (wins.length + losses.length) || 0;
  const avgMFE = median(allEntries.map(e => e.mfe));
  const avgMAE = median(allEntries.map(e => e.mae));
  const avgPnl = median(allEntries.map(e => e.finalPnlPct));
  const tp1HitRate = allEntries.filter(e => e.hitTP1).length / allEntries.length;
  const tp2HitRate = allEntries.filter(e => e.hitTP2).length / allEntries.length;
  const xpHitRate = allEntries.filter(e => e.hitXP).length / allEntries.length;

  const overallStats = {
    totalEntries: allEntries.length,
    wins: wins.length,
    losses: losses.length,
    neutrals: neutrals.length,
    winRate,
    avgMFE,
    avgMAE,
    medianPnl: avgPnl,
    tp1HitRate,
    tp2HitRate,
    xpHitRate,
  };

  console.log("\n═══ OVERALL PERFORMANCE ═══");
  console.log(`  Total entries:     ${allEntries.length}`);
  console.log(`  Wins / Losses:     ${wins.length} / ${losses.length} (${neutrals.length} neutral)`);
  console.log(`  Win rate:          ${fmtPct(winRate)}`);
  console.log(`  Median MFE:        ${fmtPct(avgMFE)}`);
  console.log(`  Median MAE:        ${fmtPct(avgMAE)}`);
  console.log(`  Median final PnL:  ${fmtPct(avgPnl)}`);
  console.log(`  TP1 hit rate:      ${fmtPct(tp1HitRate)} (0.618%)`);
  console.log(`  TP2 hit rate:      ${fmtPct(tp2HitRate)} (1.0%)`);
  console.log(`  XP hit rate:       ${fmtPct(xpHitRate)} (1.618%)`);

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 2: Performance by Score Bucket
  // ═══════════════════════════════════════════════════════════════════════════

  const scoreBuckets = [
    { label: "0-30", min: 0, max: 30 },
    { label: "30-50", min: 30, max: 50 },
    { label: "50-60", min: 50, max: 60 },
    { label: "60-70", min: 60, max: 70 },
    { label: "70-80", min: 70, max: 80 },
    { label: "80-90", min: 80, max: 90 },
    { label: "90-100", min: 90, max: 100 },
    { label: "100+", min: 100, max: Infinity },
  ];

  const bucketResults = scoreBuckets.map(bucket => {
    const entries = allEntries.filter(e => e.score >= bucket.min && e.score < bucket.max);
    if (entries.length === 0) return { ...bucket, count: 0 };

    const bWins = entries.filter(e => e.isWin);
    const bLosses = entries.filter(e => e.isLoss);
    return {
      ...bucket,
      count: entries.length,
      wins: bWins.length,
      losses: bLosses.length,
      winRate: bWins.length / (bWins.length + bLosses.length) || 0,
      medianMFE: median(entries.map(e => e.mfe)),
      medianMAE: median(entries.map(e => e.mae)),
      medianPnl: median(entries.map(e => e.finalPnlPct)),
      tp1Rate: entries.filter(e => e.hitTP1).length / entries.length,
      tp2Rate: entries.filter(e => e.hitTP2).length / entries.length,
    };
  });

  console.log("\n═══ PERFORMANCE BY SCORE BUCKET ═══");
  console.log("  Score      Count  Win%   MFE     MAE      Median PnL  TP1%   TP2%");
  console.log("  ─────────  ─────  ─────  ──────  ───────  ──────────  ─────  ─────");
  for (const b of bucketResults) {
    if (b.count === 0) continue;
    console.log(
      `  ${b.label.padEnd(9)}  ${String(b.count).padStart(5)}  ` +
      `${fmtPct(b.winRate, 0).padStart(5)}  ` +
      `${fmtPct(b.medianMFE).padStart(6)}  ` +
      `${fmtPct(b.medianMAE).padStart(7)}  ` +
      `${fmtPct(b.medianPnl).padStart(10)}  ` +
      `${fmtPct(b.tp1Rate, 0).padStart(5)}  ` +
      `${fmtPct(b.tp2Rate, 0).padStart(5)}`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 3: Cumulative Threshold Analysis
  // ═══════════════════════════════════════════════════════════════════════════

  const thresholds = [0, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const thresholdResults = thresholds.map(threshold => {
    const entries = allEntries.filter(e => e.score >= threshold);
    if (entries.length === 0) return { threshold, count: 0 };

    const tWins = entries.filter(e => e.isWin);
    const tLosses = entries.filter(e => e.isLoss);
    const totalPnl = entries.reduce((s, e) => s + e.finalPnlPct, 0);

    return {
      threshold,
      count: entries.length,
      wins: tWins.length,
      losses: tLosses.length,
      winRate: tWins.length / (tWins.length + tLosses.length) || 0,
      totalPnl,
      avgPnl: totalPnl / entries.length,
      medianPnl: median(entries.map(e => e.finalPnlPct)),
      expectancy: (tWins.length * median(tWins.map(e => e.mfe) || [0]) +
                   tLosses.length * median(tLosses.map(e => e.mae) || [0])) /
                  (tWins.length + tLosses.length) || 0,
    };
  });

  console.log("\n═══ CUMULATIVE THRESHOLD ANALYSIS ═══");
  console.log("  Score>=  Count  Win%   Avg PnL     Expectancy");
  console.log("  ───────  ─────  ─────  ──────────  ──────────");
  for (const t of thresholdResults) {
    if (t.count === 0) continue;
    console.log(
      `  >= ${String(t.threshold).padEnd(4)}  ${String(t.count).padStart(5)}  ` +
      `${fmtPct(t.winRate, 0).padStart(5)}  ` +
      `${fmtPct(t.avgPnl).padStart(10)}  ` +
      `${fmtPct(t.expectancy).padStart(10)}`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 4: Signal Predictive Power
  // ═══════════════════════════════════════════════════════════════════════════

  const signalNames = [
    "ltf_pullback", "sq30_release", "sq30_on", "momentum_elite",
    "thesis_match", "flip_watch", "st_flip_1h", "ema_cross_1h",
    "htf_improving", "aligned", "in_corridor",
  ];

  const signalResults = signalNames.map(signal => {
    const withSignal = allEntries.filter(e => e.signals.includes(signal));
    const withoutSignal = allEntries.filter(e => !e.signals.includes(signal));

    const calcStats = (entries) => {
      if (!entries.length) return { count: 0 };
      const w = entries.filter(e => e.isWin);
      const l = entries.filter(e => e.isLoss);
      return {
        count: entries.length,
        winRate: w.length / (w.length + l.length) || 0,
        medianMFE: median(entries.map(e => e.mfe)),
        medianMAE: median(entries.map(e => e.mae)),
        medianPnl: median(entries.map(e => e.finalPnlPct)),
      };
    };

    return {
      signal,
      with: calcStats(withSignal),
      without: calcStats(withoutSignal),
      lift: withSignal.length > 0 && withoutSignal.length > 0
        ? (calcStats(withSignal).winRate - calcStats(withoutSignal).winRate)
        : null,
    };
  });

  console.log("\n═══ SIGNAL PREDICTIVE POWER ═══");
  console.log("  Signal             With(N)  Win%    Without(N)  Win%    Lift");
  console.log("  ─────────────────  ───────  ──────  ──────────  ──────  ──────");
  for (const s of signalResults) {
    if (s.with.count === 0 && s.without.count === 0) continue;
    console.log(
      `  ${s.signal.padEnd(19)}  ${String(s.with.count).padStart(6)}  ` +
      `${fmtPct(s.with.winRate, 0).padStart(6)}  ` +
      `${String(s.without.count).padStart(9)}  ` +
      `${fmtPct(s.without.winRate, 0).padStart(6)}  ` +
      `${s.lift != null ? (s.lift >= 0 ? "+" : "") + fmtPct(s.lift, 1) : "—".padStart(6)}`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 5: Direction Analysis
  // ═══════════════════════════════════════════════════════════════════════════

  const longEntries = allEntries.filter(e => e.direction === "LONG");
  const shortEntries = allEntries.filter(e => e.direction === "SHORT");

  const dirStats = (entries, label) => {
    const w = entries.filter(e => e.isWin);
    const l = entries.filter(e => e.isLoss);
    return {
      label,
      count: entries.length,
      winRate: w.length / (w.length + l.length) || 0,
      medianMFE: median(entries.map(e => e.mfe)),
      medianMAE: median(entries.map(e => e.mae)),
      medianPnl: median(entries.map(e => e.finalPnlPct)),
    };
  };

  const dirResults = [dirStats(longEntries, "LONG"), dirStats(shortEntries, "SHORT")];

  console.log("\n═══ DIRECTION ANALYSIS ═══");
  console.log("  Dir    Count  Win%   MFE     MAE      Median PnL");
  console.log("  ─────  ─────  ─────  ──────  ───────  ──────────");
  for (const d of dirResults) {
    console.log(
      `  ${d.label.padEnd(5)}  ${String(d.count).padStart(5)}  ` +
      `${fmtPct(d.winRate, 0).padStart(5)}  ` +
      `${fmtPct(d.medianMFE).padStart(6)}  ` +
      `${fmtPct(d.medianMAE).padStart(7)}  ` +
      `${fmtPct(d.medianPnl).padStart(10)}`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 6: Top/Bottom Tickers
  // ═══════════════════════════════════════════════════════════════════════════

  const byTicker = {};
  for (const e of allEntries) {
    if (!byTicker[e.ticker]) byTicker[e.ticker] = [];
    byTicker[e.ticker].push(e);
  }

  const tickerSummaries = Object.entries(byTicker)
    .map(([ticker, entries]) => {
      const w = entries.filter(e => e.isWin).length;
      const l = entries.filter(e => e.isLoss).length;
      return {
        ticker,
        count: entries.length,
        wins: w,
        losses: l,
        winRate: (w + l) > 0 ? w / (w + l) : null,
        totalPnl: entries.reduce((s, e) => s + e.finalPnlPct, 0),
        medianPnl: median(entries.map(e => e.finalPnlPct)),
      };
    })
    .filter(t => t.count >= 3) // Minimum sample size
    .sort((a, b) => (b.totalPnl || 0) - (a.totalPnl || 0));

  console.log("\n═══ TOP 10 TICKERS (by total PnL) ═══");
  console.log("  Ticker  Entries  Win%   Total PnL");
  console.log("  ──────  ───────  ─────  ─────────");
  for (const t of tickerSummaries.slice(0, 10)) {
    console.log(
      `  ${t.ticker.padEnd(6)}  ${String(t.count).padStart(7)}  ` +
      `${fmtPct(t.winRate, 0).padStart(5)}  ` +
      `${fmtPct(t.totalPnl).padStart(9)}`
    );
  }

  console.log("\n═══ BOTTOM 10 TICKERS (by total PnL) ═══");
  console.log("  Ticker  Entries  Win%   Total PnL");
  console.log("  ──────  ───────  ─────  ─────────");
  for (const t of tickerSummaries.slice(-10).reverse()) {
    console.log(
      `  ${t.ticker.padEnd(6)}  ${String(t.count).padStart(7)}  ` +
      `${fmtPct(t.winRate, 0).padStart(5)}  ` +
      `${fmtPct(t.totalPnl).padStart(9)}`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Save Results
  // ═══════════════════════════════════════════════════════════════════════════

  const results = {
    metadata: {
      runDate: new Date().toISOString(),
      period: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() },
      scoreThreshold: SCORE_THRESHOLD,
      holdBars: HOLD_BARS,
      holdHours: HOLD_BARS * 5 / 60,
      tickersFetched: fetchedCount,
      tickersSkipped: skippedCount,
    },
    overall: overallStats,
    scoreBuckets: bucketResults,
    thresholdAnalysis: thresholdResults,
    signalPower: signalResults,
    directionAnalysis: dirResults,
    topTickers: tickerSummaries.slice(0, 20),
    bottomTickers: tickerSummaries.slice(-20).reverse(),
  };

  // Write JSON
  const fs = await import("fs");
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(results, null, 2));
  console.log(`\n[backtest] JSON saved: ${OUTPUT_JSON}`);

  // Write Markdown report
  const md = generateMarkdown(results);
  fs.writeFileSync(OUTPUT_MD, md);
  console.log(`[backtest] Markdown saved: ${OUTPUT_MD}`);

  console.log("\n═══ DONE ═══");
}

function generateMarkdown(r) {
  const m = r.metadata;
  let md = `# Backtest Results\n\n`;
  md += `**Run date:** ${m.runDate}  \n`;
  md += `**Period:** ${m.period.since.slice(0,10)} to ${m.period.until.slice(0,10)}  \n`;
  md += `**Score threshold:** >= ${m.scoreThreshold}  \n`;
  md += `**Hold window:** ${m.holdBars} bars (${m.holdHours.toFixed(1)} hours)  \n`;
  md += `**Tickers:** ${m.tickersFetched} fetched, ${m.tickersSkipped} skipped  \n\n`;

  md += `## Overall Performance\n\n`;
  md += `| Metric | Value |\n|---|---|\n`;
  md += `| Total entries | ${r.overall.totalEntries} |\n`;
  md += `| Wins / Losses | ${r.overall.wins} / ${r.overall.losses} (${r.overall.neutrals} neutral) |\n`;
  md += `| Win rate | ${fmtPct(r.overall.winRate)} |\n`;
  md += `| Median MFE | ${fmtPct(r.overall.avgMFE)} |\n`;
  md += `| Median MAE | ${fmtPct(r.overall.avgMAE)} |\n`;
  md += `| Median PnL | ${fmtPct(r.overall.medianPnl)} |\n`;
  md += `| TP1 hit rate (0.618%) | ${fmtPct(r.overall.tp1HitRate)} |\n`;
  md += `| TP2 hit rate (1.0%) | ${fmtPct(r.overall.tp2HitRate)} |\n`;
  md += `| XP hit rate (1.618%) | ${fmtPct(r.overall.xpHitRate)} |\n\n`;

  md += `## Score Bucket Performance\n\n`;
  md += `| Score | Count | Win% | MFE | MAE | Median PnL | TP1% | TP2% |\n`;
  md += `|---|---|---|---|---|---|---|---|\n`;
  for (const b of r.scoreBuckets) {
    if (b.count === 0) continue;
    md += `| ${b.label} | ${b.count} | ${fmtPct(b.winRate)} | ${fmtPct(b.medianMFE)} | ${fmtPct(b.medianMAE)} | ${fmtPct(b.medianPnl)} | ${fmtPct(b.tp1Rate)} | ${fmtPct(b.tp2Rate)} |\n`;
  }

  md += `\n## Threshold Analysis (cumulative)\n\n`;
  md += `| Score >= | Count | Win% | Avg PnL | Expectancy |\n`;
  md += `|---|---|---|---|---|\n`;
  for (const t of r.thresholdAnalysis) {
    if (t.count === 0) continue;
    md += `| ${t.threshold} | ${t.count} | ${fmtPct(t.winRate)} | ${fmtPct(t.avgPnl)} | ${fmtPct(t.expectancy)} |\n`;
  }

  md += `\n## Signal Predictive Power\n\n`;
  md += `| Signal | With (N) | Win% | Without (N) | Win% | Lift |\n`;
  md += `|---|---|---|---|---|---|\n`;
  for (const s of r.signalPower) {
    if (s.with.count === 0 && s.without.count === 0) continue;
    const lift = s.lift != null ? (s.lift >= 0 ? "+" : "") + fmtPct(s.lift, 1) : "—";
    md += `| ${s.signal} | ${s.with.count} | ${fmtPct(s.with.winRate)} | ${s.without.count} | ${fmtPct(s.without.winRate)} | ${lift} |\n`;
  }

  md += `\n## Direction Analysis\n\n`;
  md += `| Dir | Count | Win% | MFE | MAE | Median PnL |\n`;
  md += `|---|---|---|---|---|---|\n`;
  for (const d of r.directionAnalysis) {
    md += `| ${d.label} | ${d.count} | ${fmtPct(d.winRate)} | ${fmtPct(d.medianMFE)} | ${fmtPct(d.medianMAE)} | ${fmtPct(d.medianPnl)} |\n`;
  }

  md += `\n## Top 10 Tickers\n\n`;
  md += `| Ticker | Entries | Win% | Total PnL |\n`;
  md += `|---|---|---|---|\n`;
  for (const t of r.topTickers.slice(0, 10)) {
    md += `| ${t.ticker} | ${t.count} | ${fmtPct(t.winRate)} | ${fmtPct(t.totalPnl)} |\n`;
  }

  md += `\n## Bottom 10 Tickers\n\n`;
  md += `| Ticker | Entries | Win% | Total PnL |\n`;
  md += `|---|---|---|---|\n`;
  for (const t of r.bottomTickers.slice(0, 10)) {
    md += `| ${t.ticker} | ${t.count} | ${fmtPct(t.winRate)} | ${fmtPct(t.totalPnl)} |\n`;
  }

  return md;
}

main().catch(err => {
  console.error("[backtest] Fatal error:", err);
  process.exit(1);
});
