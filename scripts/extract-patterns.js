#!/usr/bin/env node
/**
 * Phase 1.2: Lead-Up Pattern Extraction
 *
 * For each significant move identified in Phase 1.1 (within trail coverage),
 * pulls trail_5m_facts data for the N days BEFORE the move started and extracts
 * a feature vector capturing the scoring state, signals, and transitions.
 *
 * Also extracts "exhaustion" features from the move's peak period.
 *
 * Usage:
 *   node scripts/extract-patterns.js [--leadup-days 5] [--max-moves 500] [--workers 5]
 *
 * Input:  docs/moves.json (from Phase 1.1)
 * Output: docs/pattern_features.json
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ─── Configuration ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : dflt;
};

const LEADUP_DAYS = Number(getArg("leadup-days", "5"));    // days before the move to analyze
const MAX_MOVES = Number(getArg("max-moves", "1000"));     // limit for manageable processing
const WORKER_BASE = "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";

console.log(`\n╔══════════════════════════════════════════════╗`);
console.log(`║   Phase 1.2: Lead-Up Pattern Extraction       ║`);
console.log(`╚══════════════════════════════════════════════╝`);
console.log(`  Lead-up window: ${LEADUP_DAYS} trading days`);
console.log(`  Max moves to analyze: ${MAX_MOVES}`);
console.log();

// ─── Step 1: Load moves from Phase 1.1 ──────────────────────────────────────

const movesPath = path.join(__dirname, "../docs/moves.json");
if (!fs.existsSync(movesPath)) {
  console.error("  ❌ docs/moves.json not found. Run Phase 1.1 first.");
  process.exit(1);
}

const movesData = JSON.parse(fs.readFileSync(movesPath, "utf-8"));
const allMoves = movesData.moves || [];

// Filter to moves within trail coverage (Oct 2025 – Feb 2026)
const trailStart = new Date("2025-10-01").getTime();
const trailEnd = new Date("2026-02-10").getTime();
const coveredMoves = allMoves
  .filter((m) => m.startTs >= trailStart && m.startTs <= trailEnd)
  .sort((a, b) => Math.abs(b.moveMagnitude) - Math.abs(a.moveMagnitude))
  .slice(0, MAX_MOVES);

console.log(`  Moves with trail coverage: ${coveredMoves.length} (of ${allMoves.length} total)`);
console.log();

// ─── Step 2: Query trail_5m_facts via D1 ─────────────────────────────────────

const workerDir = path.join(__dirname, "../worker");

function queryD1(sql) {
  const cmd = `cd "${workerDir}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${sql.replace(/"/g, '\\"')}"`;
  try {
    const raw = execSync(cmd, { maxBuffer: 50 * 1024 * 1024, encoding: "utf-8" });
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed[0]?.results) return parsed[0].results;
    return [];
  } catch (e) {
    console.error(`    D1 query failed: ${String(e.message || e).slice(0, 200)}`);
    return [];
  }
}

// ─── Step 3: Extract features for each move ──────────────────────────────────

function extractFeatures(ticker, trailBefore, trailDuring) {
  const features = {};

  // === LEAD-UP FEATURES (N days before the move) ===
  if (trailBefore.length > 0) {
    // HTF/LTF score trajectories
    const htfScores = trailBefore.map((r) => Number(r.htf_score_avg)).filter(Number.isFinite);
    const ltfScores = trailBefore.map((r) => Number(r.ltf_score_avg)).filter(Number.isFinite);

    if (htfScores.length > 1) {
      features.htf_mean = Math.round((htfScores.reduce((s, v) => s + v, 0) / htfScores.length) * 10) / 10;
      features.htf_start = htfScores[0];
      features.htf_end = htfScores[htfScores.length - 1];
      features.htf_delta = Math.round((features.htf_end - features.htf_start) * 10) / 10;
      features.htf_min = Math.min(...htfScores);
      features.htf_max = Math.max(...htfScores);
      features.htf_rising = features.htf_delta > 5;
      features.htf_falling = features.htf_delta < -5;
    }

    if (ltfScores.length > 1) {
      features.ltf_mean = Math.round((ltfScores.reduce((s, v) => s + v, 0) / ltfScores.length) * 10) / 10;
      features.ltf_start = ltfScores[0];
      features.ltf_end = ltfScores[ltfScores.length - 1];
      features.ltf_delta = Math.round((features.ltf_end - features.ltf_start) * 10) / 10;
      features.ltf_min = Math.min(...ltfScores);
      features.ltf_max = Math.max(...ltfScores);
      features.ltf_rising = features.ltf_delta > 5;
      features.ltf_falling = features.ltf_delta < -5;
    }

    // Score alignment: HTF and LTF moving same direction
    if (features.htf_delta != null && features.ltf_delta != null) {
      features.scores_aligned = (features.htf_delta > 0 && features.ltf_delta > 0) ||
                                 (features.htf_delta < 0 && features.ltf_delta < 0);
      features.htf_ltf_diverging = (features.htf_delta > 5 && features.ltf_delta < -5) ||
                                    (features.htf_delta < -5 && features.ltf_delta > 5);
    }

    // State transitions
    const states = trailBefore.map((r) => r.state).filter(Boolean);
    const uniqueStates = [...new Set(states)];
    features.state_count = uniqueStates.length;
    features.dominant_state = mostFrequent(states);
    features.final_state = states[states.length - 1] || null;

    // State transition patterns
    features.had_bull_bull = states.includes("HTF_BULL_LTF_BULL");
    features.had_bull_pullback = states.includes("HTF_BULL_LTF_PULLBACK");
    features.had_bear_bear = states.includes("HTF_BEAR_LTF_BEAR");
    features.had_bear_pullback = states.includes("HTF_BEAR_LTF_PULLBACK");

    // Ideal entry pattern: Q4→Q1 (pullback → bull continuation)
    features.had_q4_to_q1 = false;
    for (let i = 1; i < states.length; i++) {
      if (states[i - 1] === "HTF_BULL_LTF_PULLBACK" && states[i] === "HTF_BULL_LTF_BULL") {
        features.had_q4_to_q1 = true;
        break;
      }
    }

    // Signal flags aggregation
    features.squeeze_releases = trailBefore.filter((r) => r.had_squeeze_release).length;
    features.ema_crosses = trailBefore.filter((r) => r.had_ema_cross).length;
    features.st_flips = trailBefore.filter((r) => r.had_st_flip).length;
    features.momentum_elite = trailBefore.filter((r) => r.had_momentum_elite).length;
    features.flip_watches = trailBefore.filter((r) => r.had_flip_watch).length;

    // Kanban stage progression
    const kanbanStages = trailBefore.map((r) => r.kanban_stage_end).filter(Boolean);
    features.kanban_stages_seen = [...new Set(kanbanStages)];
    features.had_enter_now = kanbanStages.includes("enter_now");
    features.kanban_transitions = trailBefore.filter((r) => r.kanban_changed).length;

    // Completion and phase
    const completions = trailBefore.map((r) => Number(r.completion)).filter(Number.isFinite);
    const phases = trailBefore.map((r) => Number(r.phase_pct)).filter(Number.isFinite);
    if (completions.length > 0) {
      features.completion_mean = Math.round((completions.reduce((s, v) => s + v, 0) / completions.length) * 100) / 100;
      features.completion_end = completions[completions.length - 1];
    }
    if (phases.length > 0) {
      features.phase_mean = Math.round((phases.reduce((s, v) => s + v, 0) / phases.length) * 100) / 100;
      features.phase_end = phases[phases.length - 1];
    }

    // Rank
    const ranks = trailBefore.map((r) => Number(r.rank)).filter(Number.isFinite);
    if (ranks.length > 0) {
      features.rank_mean = Math.round(ranks.reduce((s, v) => s + v, 0) / ranks.length);
      features.rank_end = ranks[ranks.length - 1];
    }

    features.leadup_buckets = trailBefore.length;
  }

  // === DURING-MOVE FEATURES (at the peak/exhaustion) ===
  if (trailDuring.length > 0) {
    const htfScores = trailDuring.map((r) => Number(r.htf_score_avg)).filter(Number.isFinite);
    const ltfScores = trailDuring.map((r) => Number(r.ltf_score_avg)).filter(Number.isFinite);

    if (htfScores.length > 0) {
      features.peak_htf_mean = Math.round((htfScores.reduce((s, v) => s + v, 0) / htfScores.length) * 10) / 10;
      features.peak_htf_max = Math.max(...htfScores);
    }
    if (ltfScores.length > 0) {
      features.peak_ltf_mean = Math.round((ltfScores.reduce((s, v) => s + v, 0) / ltfScores.length) * 10) / 10;
      features.peak_ltf_max = Math.max(...ltfScores);
    }

    const peakStates = trailDuring.map((r) => r.state).filter(Boolean);
    features.peak_state = peakStates[peakStates.length - 1] || null;

    features.peak_squeeze_releases = trailDuring.filter((r) => r.had_squeeze_release).length;
    features.peak_st_flips = trailDuring.filter((r) => r.had_st_flip).length;

    features.peak_buckets = trailDuring.length;
  }

  return features;
}

function mostFrequent(arr) {
  const counts = {};
  for (const v of arr) {
    counts[v] = (counts[v] || 0) + 1;
  }
  let best = null;
  let bestCount = 0;
  for (const [k, c] of Object.entries(counts)) {
    if (c > bestCount) {
      best = k;
      bestCount = c;
    }
  }
  return best;
}

// ─── Step 4: Process moves in batches ────────────────────────────────────────
// Group moves by ticker to minimize D1 queries

const movesByTicker = {};
for (const m of coveredMoves) {
  if (!movesByTicker[m.ticker]) movesByTicker[m.ticker] = [];
  movesByTicker[m.ticker].push(m);
}

const tickerList = Object.keys(movesByTicker);
console.log(`  Processing ${coveredMoves.length} moves across ${tickerList.length} tickers...\n`);

const results = [];
let processed = 0;
const startTime = Date.now();

for (const ticker of tickerList) {
  const moves = movesByTicker[ticker];

  // Find the broadest date range needed for this ticker
  const LEADUP_MS = LEADUP_DAYS * 24 * 60 * 60 * 1000;
  const earliestStart = Math.min(...moves.map((m) => m.startTs)) - LEADUP_MS * 2;
  const latestEnd = Math.max(...moves.map((m) => m.endTs || m.startTs)) + 5 * 24 * 60 * 60 * 1000;

  // Query all trail_5m_facts for this ticker in one shot
  const trailRows = queryD1(
    `SELECT bucket_ts, htf_score_avg, ltf_score_avg, price_open, price_close, state, rank, completion, phase_pct, had_squeeze_release, had_ema_cross, had_st_flip, had_momentum_elite, had_flip_watch, kanban_stage_start, kanban_stage_end, kanban_changed FROM trail_5m_facts WHERE ticker = '${ticker}' AND bucket_ts >= ${earliestStart} AND bucket_ts <= ${latestEnd} ORDER BY bucket_ts`
  );

  for (const move of moves) {
    // Lead-up: N days before the move start
    const leadupStart = move.startTs - LEADUP_MS;
    const leadupEnd = move.startTs;
    const trailBefore = trailRows.filter(
      (r) => Number(r.bucket_ts) >= leadupStart && Number(r.bucket_ts) < leadupEnd
    );

    // During move: from start to peak (or end)
    const peakTs = move.endTs || move.startTs + move.duration * 24 * 60 * 60 * 1000;
    const trailDuring = trailRows.filter(
      (r) => Number(r.bucket_ts) >= move.startTs && Number(r.bucket_ts) <= peakTs
    );

    const features = extractFeatures(ticker, trailBefore, trailDuring);

    results.push({
      ticker: move.ticker,
      sector: move.sector,
      direction: move.direction,
      magnitude: move.moveMagnitude,
      window: move.window,
      startDate: move.startDate,
      peakDate: move.peakDate,
      endDate: move.endDate,
      startPrice: move.startPrice,
      peakPrice: move.peakPrice,
      features,
    });

    processed++;
  }

  // Progress
  const elapsed = (Date.now() - startTime) / 60000;
  const pct = ((processed / coveredMoves.length) * 100).toFixed(0);
  process.stdout.write(
    `\r  [${processed}/${coveredMoves.length}] ${pct}% — ${ticker.padEnd(6)} (${trailRows.length} trail pts, ${elapsed.toFixed(1)}m elapsed)`
  );
}

console.log(`\n\n  ✅ Extracted features for ${results.length} moves`);

// ─── Step 5: Compute aggregate statistics ────────────────────────────────────

const withFeatures = results.filter((r) => r.features.leadup_buckets > 0);
const noFeatures = results.filter((r) => !r.features.leadup_buckets);

console.log(`     With trail data: ${withFeatures.length}`);
console.log(`     No trail data:   ${noFeatures.length}`);

// Quick pattern prevalence stats
const upWithFeatures = withFeatures.filter((r) => r.direction === "UP");
const downWithFeatures = withFeatures.filter((r) => r.direction === "DOWN");

const countPct = (arr, pred) => {
  const n = arr.filter(pred).length;
  return `${n} (${((n / arr.length) * 100).toFixed(0)}%)`;
};

console.log(`\n  Lead-Up Pattern Prevalence (moves with trail data):`);
console.log(`    UP moves (${upWithFeatures.length}):`);
console.log(`      HTF rising:        ${countPct(upWithFeatures, (r) => r.features.htf_rising)}`);
console.log(`      LTF rising:        ${countPct(upWithFeatures, (r) => r.features.ltf_rising)}`);
console.log(`      Scores aligned:    ${countPct(upWithFeatures, (r) => r.features.scores_aligned)}`);
console.log(`      Q4→Q1 transition:  ${countPct(upWithFeatures, (r) => r.features.had_q4_to_q1)}`);
console.log(`      Squeeze release:   ${countPct(upWithFeatures, (r) => r.features.squeeze_releases > 0)}`);
console.log(`      ST flip:           ${countPct(upWithFeatures, (r) => r.features.st_flips > 0)}`);
console.log(`      EMA cross:         ${countPct(upWithFeatures, (r) => r.features.ema_crosses > 0)}`);
console.log(`      Enter Now fired:   ${countPct(upWithFeatures, (r) => r.features.had_enter_now)}`);
console.log(`      Final state BULL/BULL: ${countPct(upWithFeatures, (r) => r.features.final_state === "HTF_BULL_LTF_BULL")}`);
console.log();
console.log(`    DOWN moves (${downWithFeatures.length}):`);
console.log(`      HTF falling:       ${countPct(downWithFeatures, (r) => r.features.htf_falling)}`);
console.log(`      LTF falling:       ${countPct(downWithFeatures, (r) => r.features.ltf_falling)}`);
console.log(`      Scores aligned:    ${countPct(downWithFeatures, (r) => r.features.scores_aligned)}`);
console.log(`      Squeeze release:   ${countPct(downWithFeatures, (r) => r.features.squeeze_releases > 0)}`);
console.log(`      ST flip:           ${countPct(downWithFeatures, (r) => r.features.st_flips > 0)}`);
console.log(`      Final state BEAR/BEAR: ${countPct(downWithFeatures, (r) => r.features.final_state === "HTF_BEAR_LTF_BEAR")}`);

// ─── Step 6: Write output ────────────────────────────────────────────────────

const docsDir = path.join(__dirname, "../docs");
const output = {
  generated: new Date().toISOString(),
  config: {
    leadupDays: LEADUP_DAYS,
    maxMoves: MAX_MOVES,
    trailCoverage: "2025-10-01 to 2026-02-08",
  },
  summary: {
    totalMoves: results.length,
    withTrailData: withFeatures.length,
    withoutTrailData: noFeatures.length,
    upMoves: upWithFeatures.length,
    downMoves: downWithFeatures.length,
  },
  patterns: results,
};

fs.writeFileSync(path.join(docsDir, "pattern_features.json"), JSON.stringify(output, null, 2));
console.log(`\n  ✅ Output: docs/pattern_features.json (${results.length} patterns)`);
console.log(`\n  Next: Phase 1.3 — run scripts/cluster-patterns.js to score and rank patterns\n`);
