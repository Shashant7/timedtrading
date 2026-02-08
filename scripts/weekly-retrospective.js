#!/usr/bin/env node
/**
 * Phase 3.2: Weekly Retrospective
 *
 * Full re-mine of recent data to:
 *   1. Evaluate current pattern library performance on recent moves
 *   2. Discover new high-performing feature combos not in the library
 *   3. Detect regime changes (patterns degrading or improving)
 *   4. Generate a Model Health Report with proposed adjustments
 *   5. Write change proposals to model_changelog
 *
 * Usage:
 *   node scripts/weekly-retrospective.js [--lookback 90] [--recent 30] [--min-pct 5]
 *
 * Output:
 *   docs/MODEL_HEALTH_REPORT.md
 *   docs/retrospective_data.json
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

const LOOKBACK_DAYS = Number(getArg("lookback", "90"));  // full analysis window
const RECENT_DAYS = Number(getArg("recent", "30"));       // "recent" subset for regime comparison
const MIN_MOVE_PCT = Number(getArg("min-pct", "5"));
const WINDOWS = [3, 5, 10, 20];
const LEADUP_DAYS = 5;
const MIN_VOLUME_AVG = 500_000;

const now = Date.now();
const lookbackStart = now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
const recentStart = now - RECENT_DAYS * 24 * 60 * 60 * 1000;
const workerDir = path.join(__dirname, "../worker");

console.log(`\n╔══════════════════════════════════════════════════╗`);
console.log(`║   Phase 3.2: Weekly Retrospective                 ║`);
console.log(`╚══════════════════════════════════════════════════════╝`);
console.log(`  Full window:   ${LOOKBACK_DAYS} days (since ${new Date(lookbackStart).toISOString().slice(0, 10)})`);
console.log(`  Recent window: ${RECENT_DAYS} days (since ${new Date(recentStart).toISOString().slice(0, 10)})`);
console.log(`  Min move:      ±${MIN_MOVE_PCT}%`);
console.log(`  Tickers:       ${Object.keys(SECTOR_MAP).length}`);
console.log();

// ─── D1 Query Helper ─────────────────────────────────────────────────────────

function queryD1(sql) {
  const cmd = `cd "${workerDir}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${sql.replace(/"/g, '\\"')}"`;
  try {
    const raw = execSync(cmd, { maxBuffer: 50 * 1024 * 1024, encoding: "utf-8" });
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed[0]?.results) return parsed[0].results;
    return [];
  } catch (e) {
    // wrangler sometimes mixes progress output into JSON; try to extract
    const raw = String(e.stdout || e.message || "");
    const jsonStart = raw.indexOf("[{");
    if (jsonStart >= 0) {
      try {
        const parsed = JSON.parse(raw.slice(jsonStart));
        if (parsed[0]?.results) return parsed[0].results;
      } catch {}
    }
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: Re-mine moves in the lookback window
// ═══════════════════════════════════════════════════════════════════════════════

console.log("  Step 1: Mining moves in lookback window...");

// Fetch daily candles
let allCandles = [];
let offset = 0;
while (true) {
  const rows = queryD1(
    `SELECT ticker, ts, o, h, l, c, v FROM ticker_candles WHERE tf='D' AND ts >= ${lookbackStart - 30 * 86400000} ORDER BY ticker, ts LIMIT 15000 OFFSET ${offset}`
  );
  allCandles = allCandles.concat(rows);
  if (rows.length < 15000) break;
  offset += 15000;
}
console.log(`    ${allCandles.length} daily candles fetched`);

// Group by ticker
const byTicker = {};
for (const c of allCandles) {
  const t = String(c.ticker).toUpperCase();
  if (!SECTOR_MAP[t]) continue;
  if (!byTicker[t]) byTicker[t] = [];
  byTicker[t].push({ ts: Number(c.ts), o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v || 0) });
}
for (const t of Object.keys(byTicker)) byTicker[t].sort((a, b) => a.ts - b.ts);

// Identify moves
const allMoves = [];
for (const ticker of Object.keys(byTicker)) {
  const candles = byTicker[ticker];
  if (candles.length < 20) continue;
  const sector = SECTOR_MAP[ticker] || "Unknown";

  for (const window of WINDOWS) {
    for (let i = 0; i <= candles.length - window - 1; i++) {
      const start = candles[i];
      if (start.ts < lookbackStart) continue;
      const end = candles[Math.min(i + window, candles.length - 1)];
      const changePct = ((end.c - start.c) / start.c) * 100;
      if (Math.abs(changePct) < MIN_MOVE_PCT) continue;

      let peakPrice = start.c, troughPrice = start.c, peakIdx = i, troughIdx = i;
      for (let j = i + 1; j <= Math.min(i + window, candles.length - 1); j++) {
        if (candles[j].h > peakPrice) { peakPrice = candles[j].h; peakIdx = j; }
        if (candles[j].l < troughPrice) { troughPrice = candles[j].l; troughIdx = j; }
      }

      const direction = changePct > 0 ? "UP" : "DOWN";
      const magnitude = direction === "UP"
        ? ((peakPrice - start.c) / start.c) * 100
        : ((troughPrice - start.c) / start.c) * 100;

      allMoves.push({
        ticker, sector, direction, window, magnitude: Math.round(magnitude * 100) / 100,
        changePct: Math.round(changePct * 100) / 100,
        startTs: start.ts, endTs: end.ts,
        startDate: new Date(start.ts).toISOString().slice(0, 10),
        peakDate: new Date(candles[direction === "UP" ? peakIdx : troughIdx].ts).toISOString().slice(0, 10),
        startPrice: start.c,
        isRecent: start.ts >= recentStart,
      });
    }
  }
}

// Dedup
allMoves.sort((a, b) => Math.abs(b.magnitude) - Math.abs(a.magnitude));
const seen = new Set();
const moves = [];
for (const m of allMoves) {
  const bucket = Math.floor(m.startTs / (3 * 86400000));
  const key = `${m.ticker}:${m.direction}:${bucket}`;
  if (seen.has(key)) continue;
  seen.add(key);
  seen.add(`${m.ticker}:${m.direction}:${bucket - 1}`);
  seen.add(`${m.ticker}:${m.direction}:${bucket + 1}`);
  moves.push(m);
}

const recentMoves = moves.filter((m) => m.isRecent);
console.log(`    ${moves.length} unique moves (${recentMoves.length} in recent ${RECENT_DAYS}d window)\n`);

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: Extract features for each move from trail_5m_facts
// ═══════════════════════════════════════════════════════════════════════════════

console.log("  Step 2: Extracting features from trail_5m_facts...");

// Limit to top 800 moves by magnitude for performance
const movesToAnalyze = moves.slice(0, 800);
const movesByTicker = {};
for (const m of movesToAnalyze) {
  if (!movesByTicker[m.ticker]) movesByTicker[m.ticker] = [];
  movesByTicker[m.ticker].push(m);
}

const LEADUP_MS = LEADUP_DAYS * 86400000;

function extractFeatures(trailBefore) {
  if (!trailBefore || trailBefore.length === 0) return null;

  const f = {};
  const htf = trailBefore.map((r) => Number(r.htf_score_avg)).filter(Number.isFinite);
  const ltf = trailBefore.map((r) => Number(r.ltf_score_avg)).filter(Number.isFinite);

  if (htf.length > 1) {
    f.htf_mean = Math.round((htf.reduce((s, v) => s + v, 0) / htf.length) * 10) / 10;
    f.htf_delta = Math.round((htf[htf.length - 1] - htf[0]) * 10) / 10;
    f.htf_rising = f.htf_delta > 5;
    f.htf_falling = f.htf_delta < -5;
    f.htf_high = f.htf_mean > 60;
    f.htf_low = f.htf_mean < 40;
  }
  if (ltf.length > 1) {
    f.ltf_mean = Math.round((ltf.reduce((s, v) => s + v, 0) / ltf.length) * 10) / 10;
    f.ltf_delta = Math.round((ltf[ltf.length - 1] - ltf[0]) * 10) / 10;
    f.ltf_rising = f.ltf_delta > 5;
    f.ltf_falling = f.ltf_delta < -5;
  }

  if (f.htf_delta != null && f.ltf_delta != null) {
    f.scores_aligned = (f.htf_delta > 0 && f.ltf_delta > 0) || (f.htf_delta < 0 && f.ltf_delta < 0);
    f.htf_ltf_diverging = (f.htf_delta > 5 && f.ltf_delta < -5) || (f.htf_delta < -5 && f.ltf_delta > 5);
  }

  const states = trailBefore.map((r) => r.state).filter(Boolean);
  f.final_state = states[states.length - 1] || null;
  f.had_bull_bull = states.includes("HTF_BULL_LTF_BULL");
  f.had_bull_pullback = states.includes("HTF_BULL_LTF_PULLBACK");
  f.had_bear_bear = states.includes("HTF_BEAR_LTF_BEAR");
  f.had_bear_pullback = states.includes("HTF_BEAR_LTF_PULLBACK");

  // Q4→Q1 transition
  f.had_q4_to_q1 = false;
  for (let i = 1; i < states.length; i++) {
    if (states[i - 1] === "HTF_BULL_LTF_PULLBACK" && states[i] === "HTF_BULL_LTF_BULL") {
      f.had_q4_to_q1 = true; break;
    }
  }

  f.squeeze_releases = trailBefore.filter((r) => r.had_squeeze_release).length;
  f.ema_crosses = trailBefore.filter((r) => r.had_ema_cross).length;
  f.st_flips = trailBefore.filter((r) => r.had_st_flip).length;
  f.momentum_elite = trailBefore.filter((r) => r.had_momentum_elite).length;
  f.flip_watches = trailBefore.filter((r) => r.had_flip_watch).length;

  const kanban = trailBefore.map((r) => r.kanban_stage_end).filter(Boolean);
  f.had_enter_now = kanban.includes("enter_now");
  f.kanban_transitions = trailBefore.filter((r) => r.kanban_changed).length;

  const comp = trailBefore.map((r) => Number(r.completion)).filter(Number.isFinite);
  const phases = trailBefore.map((r) => Number(r.phase_pct)).filter(Number.isFinite);
  if (comp.length > 0) f.completion_end = comp[comp.length - 1];
  if (phases.length > 0) f.phase_end = phases[phases.length - 1];

  const ranks = trailBefore.map((r) => Number(r.rank)).filter(Number.isFinite);
  if (ranks.length > 0) f.rank_end = ranks[ranks.length - 1];

  f.leadup_buckets = trailBefore.length;
  return f;
}

let featExtracted = 0;
const startTime = Date.now();

for (const ticker of Object.keys(movesByTicker)) {
  const tickerMoves = movesByTicker[ticker];
  const earliest = Math.min(...tickerMoves.map((m) => m.startTs)) - LEADUP_MS * 2;
  const latest = Math.max(...tickerMoves.map((m) => m.endTs || m.startTs)) + 5 * 86400000;

  const trail = queryD1(
    `SELECT bucket_ts, htf_score_avg, ltf_score_avg, state, rank, completion, phase_pct, had_squeeze_release, had_ema_cross, had_st_flip, had_momentum_elite, had_flip_watch, kanban_stage_end, kanban_changed FROM trail_5m_facts WHERE ticker = '${ticker}' AND bucket_ts >= ${earliest} AND bucket_ts <= ${latest} ORDER BY bucket_ts`
  );

  for (const m of tickerMoves) {
    const before = trail.filter((r) => Number(r.bucket_ts) >= m.startTs - LEADUP_MS && Number(r.bucket_ts) < m.startTs);
    m.features = extractFeatures(before);
    if (m.features) featExtracted++;
  }

  process.stdout.write(`\r    [${featExtracted}/${movesToAnalyze.length}] ${ticker.padEnd(6)} (${((Date.now() - startTime) / 60000).toFixed(1)}m)`);
}

const withFeatures = movesToAnalyze.filter((m) => m.features);
const recentWithFeatures = withFeatures.filter((m) => m.isRecent);
console.log(`\n    ${withFeatures.length} moves with features (${recentWithFeatures.length} recent)\n`);

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3: Evaluate current pattern library against recent moves
// ═══════════════════════════════════════════════════════════════════════════════

console.log("  Step 3: Evaluating current pattern library...");

// Load existing patterns from D1
const patternsRaw = queryD1(
  `SELECT pattern_id, name, expected_direction, definition_json, hit_rate, sample_count, confidence, expected_value, status FROM pattern_library WHERE status = 'active'`
);

// Parse definitions
const patterns = patternsRaw.map((p) => ({
  ...p,
  definition: JSON.parse(p.definition_json || "[]"),
}));

// For each pattern, evaluate against recent moves using feature-based matching
// (We can't use the real-time snapshot matcher here since we have trail features, not live payloads)
// Instead, define a parallel matcher that works on trail features

function featureMatchesPattern(features, patternId) {
  if (!features) return false;
  const f = features;

  const matchers = {
    bull_state_dominance: () => f.final_state === "HTF_BULL_LTF_BULL",
    st_flip_bull_state: () => f.st_flips > 0 && (f.final_state === "HTF_BULL_LTF_BULL" || f.had_q4_to_q1),
    st_flip_bull_state_1h: () => f.st_flips > 0 && f.had_bull_bull,
    ema_cross_rising_htf: () => f.ema_crosses > 0 && f.htf_rising,
    high_momentum_elite: () => f.momentum_elite > 0,
    htf_bull_pullback_recovery: () => f.htf_rising && f.had_bull_pullback,
    strong_htf_surge: () => f.htf_high && f.htf_rising,
    ltf_recovery_high_htf: () => f.ltf_rising && f.htf_high,
    bull_momentum_elite_bull_state: () => f.final_state === "HTF_BULL_LTF_BULL" && f.momentum_elite > 0,
    squeeze_release_bear: () => f.squeeze_releases > 0 && !f.had_bull_bull,
    bear_state_dominance: () => f.final_state === "HTF_BEAR_LTF_BEAR",
    st_flip_bear_state: () => f.st_flips > 0 && (f.final_state === "HTF_BEAR_LTF_BEAR" || f.final_state === "HTF_BEAR_LTF_PULLBACK"),
    htf_collapse: () => f.htf_low && f.htf_falling,
    bear_squeeze_multi_signal: () => f.squeeze_releases > 0 && f.st_flips > 0 && f.had_bear_bear,
    htf_ltf_divergence_bear: () => f.htf_falling && f.ltf_rising,
    multi_signal_cluster: () => [f.squeeze_releases > 0, f.st_flips > 0, f.ema_crosses > 0, f.momentum_elite > 0, f.flip_watches > 0].filter(Boolean).length >= 3,
    high_completion_exhaustion: () => f.completion_end > 0.7 && f.phase_end > 70,
  };

  return matchers[patternId] ? matchers[patternId]() : false;
}

const patternPerf = {};
for (const p of patterns) {
  const allMatches = withFeatures.filter((m) => featureMatchesPattern(m.features, p.pattern_id));
  const recentMatches = allMatches.filter((m) => m.isRecent);
  const historicalMatches = allMatches.filter((m) => !m.isRecent);

  const score = (subset) => {
    if (subset.length === 0) return null;
    const up = subset.filter((m) => m.direction === "UP");
    const down = subset.filter((m) => m.direction === "DOWN");
    const upPct = (up.length / subset.length) * 100;
    const avgUpMag = up.length > 0 ? up.reduce((s, m) => s + m.magnitude, 0) / up.length : 0;
    const avgDnMag = down.length > 0 ? down.reduce((s, m) => s + Math.abs(m.magnitude), 0) / down.length : 0;
    const ev = (upPct * avgUpMag - (100 - upPct) * avgDnMag) / 100;
    return { n: subset.length, upPct: Math.round(upPct * 10) / 10, avgUpMag: Math.round(avgUpMag * 10) / 10, avgDnMag: Math.round(avgDnMag * 10) / 10, ev: Math.round(ev * 10) / 10 };
  };

  patternPerf[p.pattern_id] = {
    name: p.name,
    expectedDir: p.expected_direction,
    seedHitRate: p.hit_rate,
    seedSampleCount: p.sample_count,
    seedEV: p.expected_value,
    all: score(allMatches),
    recent: score(recentMatches),
    historical: score(historicalMatches),
  };
}

console.log("    Pattern performance (all / recent / historical):\n");
console.log("    " + "Pattern".padEnd(35) + "All N".padStart(6) + "All UP%".padStart(8) + "Rcnt N".padStart(7) + "Rcnt UP%".padStart(9) + "Hist N".padStart(7) + "Hist UP%".padStart(9) + "  Regime");
console.log("    " + "─".repeat(92));

const regimeChanges = [];
for (const [pid, perf] of Object.entries(patternPerf)) {
  const a = perf.all;
  const r = perf.recent;
  const h = perf.historical;

  let regime = "";
  if (r && h && r.n >= 5 && h.n >= 5) {
    const shift = r.upPct - h.upPct;
    if (Math.abs(shift) > 15) {
      regime = shift > 0 ? "⬆ IMPROVING" : "⬇ DEGRADING";
      regimeChanges.push({ pattern_id: pid, name: perf.name, shift, recentUpPct: r.upPct, histUpPct: h.upPct, recentN: r.n, histN: h.n });
    }
  }

  console.log(
    "    " +
    perf.name.padEnd(35) +
    (a ? String(a.n) : "—").padStart(6) +
    (a ? `${a.upPct}%` : "—").padStart(8) +
    (r ? String(r.n) : "—").padStart(7) +
    (r ? `${r.upPct}%` : "—").padStart(9) +
    (h ? String(h.n) : "—").padStart(7) +
    (h ? `${h.upPct}%` : "—").padStart(9) +
    `  ${regime}`
  );
}
console.log();

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4: Pattern Discovery — find new feature combos
// ═══════════════════════════════════════════════════════════════════════════════

console.log("  Step 4: Discovering new pattern candidates...");

const BOOL_FEATURES = [
  "htf_rising", "htf_falling", "htf_high", "htf_low",
  "ltf_rising", "ltf_falling",
  "scores_aligned", "htf_ltf_diverging",
  "had_bull_bull", "had_bull_pullback", "had_bear_bear", "had_bear_pullback",
  "had_q4_to_q1", "had_enter_now",
];

const SIGNAL_FEATURES = [
  "squeeze_releases", "ema_crosses", "st_flips", "momentum_elite", "flip_watches",
];

// For signal features, convert to boolean
function boolFeature(f, feat) {
  if (SIGNAL_FEATURES.includes(feat)) return (f[feat] || 0) > 0;
  return !!f[feat];
}

// Test all 2-feature combinations
const candidates = [];
const allBoolFeats = [...BOOL_FEATURES, ...SIGNAL_FEATURES];

for (let i = 0; i < allBoolFeats.length; i++) {
  for (let j = i + 1; j < allBoolFeats.length; j++) {
    const f1 = allBoolFeats[i];
    const f2 = allBoolFeats[j];

    const matches = withFeatures.filter((m) => m.features && boolFeature(m.features, f1) && boolFeature(m.features, f2));
    if (matches.length < 10) continue;

    const up = matches.filter((m) => m.direction === "UP");
    const down = matches.filter((m) => m.direction === "DOWN");
    const upPct = (up.length / matches.length) * 100;
    const avgUpMag = up.length > 0 ? up.reduce((s, m) => s + m.magnitude, 0) / up.length : 0;
    const avgDnMag = down.length > 0 ? down.reduce((s, m) => s + Math.abs(m.magnitude), 0) / down.length : 0;
    const ev = (upPct * avgUpMag - (100 - upPct) * avgDnMag) / 100;

    // Only keep combos with strong directional bias (>65% or <35% UP)
    if (upPct < 65 && upPct > 35) continue;

    // Check if this combo is already substantially covered by an existing pattern
    const alreadyCovered = Object.entries(patternPerf).some(([pid, perf]) => {
      if (!perf.all || perf.all.n < 5) return false;
      // If ≥80% of this combo's matches also match an existing pattern, it's covered
      const overlapCount = matches.filter((m) => featureMatchesPattern(m.features, pid)).length;
      return overlapCount >= matches.length * 0.8;
    });

    candidates.push({
      features: [f1, f2],
      name: `${f1} + ${f2}`,
      n: matches.length,
      upPct: Math.round(upPct * 10) / 10,
      downPct: Math.round((100 - upPct) * 10) / 10,
      avgUpMag: Math.round(avgUpMag * 10) / 10,
      avgDnMag: Math.round(avgDnMag * 10) / 10,
      ev: Math.round(ev * 10) / 10,
      direction: upPct > 50 ? "UP" : "DOWN",
      alreadyCovered,
    });
  }
}

// Also test 3-feature combinations (top features only for performance)
const topFeats = ["htf_rising", "htf_falling", "htf_high", "htf_low", "had_bull_bull", "had_bear_bear", "scores_aligned", "squeeze_releases", "st_flips", "momentum_elite", "had_q4_to_q1"];
for (let i = 0; i < topFeats.length; i++) {
  for (let j = i + 1; j < topFeats.length; j++) {
    for (let k = j + 1; k < topFeats.length; k++) {
      const f1 = topFeats[i], f2 = topFeats[j], f3 = topFeats[k];
      const matches = withFeatures.filter((m) => m.features && boolFeature(m.features, f1) && boolFeature(m.features, f2) && boolFeature(m.features, f3));
      if (matches.length < 8) continue;

      const up = matches.filter((m) => m.direction === "UP");
      const upPct = (up.length / matches.length) * 100;
      if (upPct < 70 && upPct > 30) continue;

      const avgUpMag = up.length > 0 ? up.reduce((s, m) => s + m.magnitude, 0) / up.length : 0;
      const down = matches.filter((m) => m.direction === "DOWN");
      const avgDnMag = down.length > 0 ? down.reduce((s, m) => s + Math.abs(m.magnitude), 0) / down.length : 0;
      const ev = (upPct * avgUpMag - (100 - upPct) * avgDnMag) / 100;

      const alreadyCovered = Object.entries(patternPerf).some(([pid, perf]) => {
        if (!perf.all || perf.all.n < 5) return false;
        const overlapCount = matches.filter((m) => featureMatchesPattern(m.features, pid)).length;
        return overlapCount >= matches.length * 0.8;
      });

      candidates.push({
        features: [f1, f2, f3],
        name: `${f1} + ${f2} + ${f3}`,
        n: matches.length,
        upPct: Math.round(upPct * 10) / 10,
        downPct: Math.round((100 - upPct) * 10) / 10,
        avgUpMag: Math.round(avgUpMag * 10) / 10,
        avgDnMag: Math.round(avgDnMag * 10) / 10,
        ev: Math.round(ev * 10) / 10,
        direction: upPct > 50 ? "UP" : "DOWN",
        alreadyCovered,
      });
    }
  }
}

candidates.sort((a, b) => Math.abs(b.ev) - Math.abs(a.ev));
const newCandidates = candidates.filter((c) => !c.alreadyCovered);
const allCandidatesSorted = candidates.slice(0, 30);

console.log(`    ${candidates.length} candidate combos found (${newCandidates.length} not covered by existing patterns)`);
console.log(`\n    Top NEW pattern candidates:\n`);
console.log("    " + "Combo".padEnd(50) + "N".padStart(5) + "UP%".padStart(7) + "EV".padStart(8) + "  New?");
console.log("    " + "─".repeat(75));
for (const c of newCandidates.slice(0, 15)) {
  console.log(
    "    " +
    c.name.padEnd(50) +
    String(c.n).padStart(5) +
    `${c.upPct}%`.padStart(7) +
    `${c.ev > 0 ? "+" : ""}${c.ev}`.padStart(8) +
    `  ${c.alreadyCovered ? "covered" : "✦ NEW"}`
  );
}
console.log();

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 5: Sector analysis
// ═══════════════════════════════════════════════════════════════════════════════

console.log("  Step 5: Sector regime analysis...");

const sectorPerf = {};
for (const m of withFeatures) {
  const s = m.sector;
  if (!sectorPerf[s]) sectorPerf[s] = { all: [], recent: [], historical: [] };
  sectorPerf[s].all.push(m);
  if (m.isRecent) sectorPerf[s].recent.push(m);
  else sectorPerf[s].historical.push(m);
}

console.log("\n    " + "Sector".padEnd(25) + "All N".padStart(6) + "All UP%".padStart(8) + "Rcnt N".padStart(7) + "Rcnt UP%".padStart(9) + "  Regime");
console.log("    " + "─".repeat(60));

const sectorRegimes = [];
for (const [sector, data] of Object.entries(sectorPerf).sort((a, b) => b[1].all.length - a[1].all.length)) {
  const allUpPct = data.all.length > 0 ? (data.all.filter((m) => m.direction === "UP").length / data.all.length * 100) : 0;
  const recentUpPct = data.recent.length > 0 ? (data.recent.filter((m) => m.direction === "UP").length / data.recent.length * 100) : null;
  const histUpPct = data.historical.length > 0 ? (data.historical.filter((m) => m.direction === "UP").length / data.historical.length * 100) : null;

  let regime = "";
  if (recentUpPct != null && histUpPct != null && data.recent.length >= 3 && data.historical.length >= 3) {
    const shift = recentUpPct - histUpPct;
    if (Math.abs(shift) > 15) {
      regime = shift > 0 ? "⬆ IMPROVING" : "⬇ DEGRADING";
      sectorRegimes.push({ sector, shift, recentUpPct, histUpPct, recentN: data.recent.length, histN: data.historical.length });
    }
  }

  console.log(
    "    " +
    sector.padEnd(25) +
    String(data.all.length).padStart(6) +
    `${Math.round(allUpPct)}%`.padStart(8) +
    (data.recent.length > 0 ? String(data.recent.length) : "—").padStart(7) +
    (recentUpPct != null ? `${Math.round(recentUpPct)}%` : "—").padStart(9) +
    `  ${regime}`
  );
}
console.log();

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 6: Generate change proposals
// ═══════════════════════════════════════════════════════════════════════════════

console.log("  Step 6: Generating change proposals...");

const proposals = [];

// Propose degrading patterns
for (const rc of regimeChanges) {
  if (rc.shift < -15) {
    proposals.push({
      type: "degrade_pattern",
      pattern_id: rc.pattern_id,
      description: `Pattern "${rc.name}" regime shift: recent ${RECENT_DAYS}d UP% = ${rc.recentUpPct.toFixed(0)}% vs historical ${rc.histUpPct.toFixed(0)}% (Δ${rc.shift.toFixed(0)}pp, n_recent=${rc.recentN}, n_hist=${rc.histN})`,
      severity: Math.abs(rc.shift) > 25 ? "high" : "medium",
    });
  } else if (rc.shift > 15) {
    proposals.push({
      type: "promote_pattern",
      pattern_id: rc.pattern_id,
      description: `Pattern "${rc.name}" showing improvement: recent ${RECENT_DAYS}d UP% = ${rc.recentUpPct.toFixed(0)}% vs historical ${rc.histUpPct.toFixed(0)}% (Δ+${rc.shift.toFixed(0)}pp, n_recent=${rc.recentN}, n_hist=${rc.histN})`,
      severity: "low",
    });
  }
}

// Propose new patterns (top 5 uncovered candidates with strong edge)
for (const c of newCandidates.slice(0, 5)) {
  if (Math.abs(c.ev) > 10 && c.n >= 10) {
    proposals.push({
      type: "add_pattern",
      pattern_id: null,
      description: `New pattern candidate: [${c.name}] — ${c.direction} bias ${c.upPct}% UP, EV=${c.ev > 0 ? "+" : ""}${c.ev}, n=${c.n}`,
      severity: c.n >= 20 ? "medium" : "low",
      candidate: c,
    });
  }
}

// Propose sector alerts
for (const sr of sectorRegimes) {
  proposals.push({
    type: "sector_regime_change",
    pattern_id: null,
    description: `Sector "${sr.sector}" regime shift: recent ${RECENT_DAYS}d UP% = ${sr.recentUpPct.toFixed(0)}% vs historical ${sr.histUpPct.toFixed(0)}% (n_recent=${sr.recentN})`,
    severity: Math.abs(sr.shift) > 25 ? "medium" : "low",
  });
}

console.log(`    ${proposals.length} proposals generated\n`);

// Write proposals to D1
const sqlFile = path.join(workerDir, "migrations", "_retrospective_proposals.sql");
const sqlLines = [];
for (const p of proposals) {
  const id = `chg:retro:${p.type}:${p.pattern_id || "global"}:${now}:${Math.random().toString(36).slice(2, 8)}`;
  const esc = (s) => (s || "").replace(/'/g, "''");
  sqlLines.push(
    `INSERT OR IGNORE INTO model_changelog (change_id, change_type, pattern_id, description, evidence_json, status, proposed_at, created_at) VALUES ('${esc(id)}', '${esc(p.type)}', ${p.pattern_id ? "'" + esc(p.pattern_id) + "'" : "NULL"}, '${esc(p.description)}', '${esc(JSON.stringify({ severity: p.severity, candidate: p.candidate || null }))}', 'proposed', ${now}, ${now});`
  );
}

if (sqlLines.length > 0) {
  fs.writeFileSync(sqlFile, sqlLines.join("\n"));
  try {
    execSync(`cd "${workerDir}" && npx wrangler d1 execute timed-trading-ledger --file=migrations/_retrospective_proposals.sql --env production --remote 2>&1`, { maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" });
    console.log(`    ✅ ${sqlLines.length} proposals written to model_changelog`);
  } catch (e) {
    console.log(`    ⚠️  Proposals may have been written (check D1)`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 7: Generate MODEL_HEALTH_REPORT.md
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n  Step 7: Generating health report...");

const docsDir = path.join(__dirname, "../docs");
const md = [];
md.push("# Model Health Report — Weekly Retrospective");
md.push("");
md.push(`> Generated: ${new Date().toISOString()}`);
md.push(`> Full window: ${LOOKBACK_DAYS} days (${new Date(lookbackStart).toISOString().slice(0, 10)} → ${new Date().toISOString().slice(0, 10)})`);
md.push(`> Recent window: ${RECENT_DAYS} days (${new Date(recentStart).toISOString().slice(0, 10)} → now)`);
md.push(`> Moves analyzed: ${withFeatures.length} with trail data (${recentWithFeatures.length} recent)`);
md.push("");

// Overall health
const allUpPct = withFeatures.length > 0 ? (withFeatures.filter((m) => m.direction === "UP").length / withFeatures.length * 100) : 0;
const recentUpPct = recentWithFeatures.length > 0 ? (recentWithFeatures.filter((m) => m.direction === "UP").length / recentWithFeatures.length * 100) : 0;

md.push("## Market Regime");
md.push("");
md.push(`| Period | Moves | UP% | DOWN% |`);
md.push(`|--------|-------|-----|-------|`);
md.push(`| Full ${LOOKBACK_DAYS}d | ${withFeatures.length} | ${allUpPct.toFixed(0)}% | ${(100 - allUpPct).toFixed(0)}% |`);
md.push(`| Recent ${RECENT_DAYS}d | ${recentWithFeatures.length} | ${recentUpPct.toFixed(0)}% | ${(100 - recentUpPct).toFixed(0)}% |`);
md.push("");

// Pattern performance table
md.push("## Pattern Performance");
md.push("");
md.push("| Pattern | Seed HR | All N | All UP% | Recent N | Recent UP% | Regime |");
md.push("|---------|---------|-------|---------|----------|------------|--------|");
for (const [pid, perf] of Object.entries(patternPerf).sort((a, b) => Math.abs(b[1].all?.ev || 0) - Math.abs(a[1].all?.ev || 0))) {
  const a = perf.all;
  const r = perf.recent;
  const regime = regimeChanges.find((rc) => rc.pattern_id === pid);
  const regimeStr = regime ? (regime.shift > 0 ? "⬆ Improving" : "⬇ Degrading") : "Stable";
  md.push(`| ${perf.name} | ${(perf.seedHitRate * 100).toFixed(0)}% | ${a ? a.n : "—"} | ${a ? a.upPct + "%" : "—"} | ${r ? r.n : "—"} | ${r ? r.upPct + "%" : "—"} | ${regimeStr} |`);
}
md.push("");

// Regime changes
if (regimeChanges.length > 0) {
  md.push("## Regime Changes Detected");
  md.push("");
  for (const rc of regimeChanges) {
    const arrow = rc.shift > 0 ? "⬆" : "⬇";
    md.push(`- ${arrow} **${rc.name}**: Recent ${RECENT_DAYS}d UP% = ${rc.recentUpPct.toFixed(0)}% vs Historical ${rc.histUpPct.toFixed(0)}% (${rc.shift > 0 ? "+" : ""}${rc.shift.toFixed(0)}pp shift)`);
  }
  md.push("");
}

// New pattern candidates
if (newCandidates.length > 0) {
  md.push("## New Pattern Candidates");
  md.push("");
  md.push("Feature combinations with directional edge not covered by existing patterns:");
  md.push("");
  md.push("| Combo | N | Dir | UP% | EV | Status |");
  md.push("|-------|---|-----|-----|-----|--------|");
  for (const c of newCandidates.slice(0, 20)) {
    md.push(`| ${c.name} | ${c.n} | ${c.direction} | ${c.upPct}% | ${c.ev > 0 ? "+" : ""}${c.ev} | Candidate |`);
  }
  md.push("");
}

// Sector regimes
if (sectorRegimes.length > 0) {
  md.push("## Sector Regime Shifts");
  md.push("");
  for (const sr of sectorRegimes) {
    const arrow = sr.shift > 0 ? "⬆" : "⬇";
    md.push(`- ${arrow} **${sr.sector}**: Recent ${RECENT_DAYS}d UP% = ${sr.recentUpPct.toFixed(0)}% vs Historical ${sr.histUpPct.toFixed(0)}%`);
  }
  md.push("");
}

// Proposals
md.push("## Proposals");
md.push("");
if (proposals.length === 0) {
  md.push("No proposals at this time. All patterns performing within expected ranges.");
} else {
  md.push("| Type | Pattern | Description | Severity |");
  md.push("|------|---------|-------------|----------|");
  for (const p of proposals) {
    md.push(`| ${p.type} | ${p.pattern_id || "—"} | ${p.description} | ${p.severity} |`);
  }
}
md.push("");
md.push("---");
md.push(`*Generated by weekly-retrospective.js — ${proposals.length} proposals pending review*`);

fs.writeFileSync(path.join(docsDir, "MODEL_HEALTH_REPORT.md"), md.join("\n"));

// Also write structured data
const retroData = {
  generated: new Date().toISOString(),
  config: { lookbackDays: LOOKBACK_DAYS, recentDays: RECENT_DAYS, minMovePct: MIN_MOVE_PCT },
  summary: { totalMoves: moves.length, withFeatures: withFeatures.length, recentMoves: recentMoves.length, recentWithFeatures: recentWithFeatures.length },
  patternPerformance: patternPerf,
  regimeChanges,
  newCandidates: newCandidates.slice(0, 30),
  sectorRegimes,
  proposals,
};
fs.writeFileSync(path.join(docsDir, "retrospective_data.json"), JSON.stringify(retroData, null, 2));

console.log(`\n  ✅ Output written:`);
console.log(`     docs/MODEL_HEALTH_REPORT.md`);
console.log(`     docs/retrospective_data.json`);
console.log(`     ${proposals.length} proposals → model_changelog (status: proposed)`);
console.log(`\n  Review proposals at: GET /timed/model/patterns or in model_changelog table\n`);
