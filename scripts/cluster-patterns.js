#!/usr/bin/env node
/**
 * Phase 1.3: Pattern Clustering & Scoring
 *
 * Takes the feature vectors from Phase 1.2, groups them into rule-based
 * pattern archetypes, and scores each archetype by:
 *   - Hit rate (% leading to UP vs DOWN)
 *   - Average magnitude
 *   - Predictive edge over baseline
 *
 * Also computes a "baseline" distribution for comparison and identifies
 * the highest-value pattern combinations.
 *
 * Usage:
 *   node scripts/cluster-patterns.js
 *
 * Input:  docs/pattern_features.json (from Phase 1.2)
 * Output: docs/pattern_scores.json, docs/MODEL_FINDINGS.md
 */

const fs = require("fs");
const path = require("path");

console.log(`\n╔══════════════════════════════════════════════╗`);
console.log(`║   Phase 1.3: Pattern Clustering & Scoring     ║`);
console.log(`╚══════════════════════════════════════════════╝\n`);

// ─── Step 1: Load pattern data ───────────────────────────────────────────────

const dataPath = path.join(__dirname, "../docs/pattern_features.json");
if (!fs.existsSync(dataPath)) {
  console.error("  ❌ docs/pattern_features.json not found. Run Phase 1.2 first.");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
const allPatterns = data.patterns || [];
const withTrail = allPatterns.filter((p) => p.features.leadup_buckets > 0);

console.log(`  Total patterns: ${allPatterns.length}`);
console.log(`  With trail data: ${withTrail.length}`);

const upMoves = withTrail.filter((p) => p.direction === "UP");
const downMoves = withTrail.filter((p) => p.direction === "DOWN");

console.log(`  UP moves: ${upMoves.length}, DOWN moves: ${downMoves.length}\n`);

// ─── Step 2: Define Pattern Archetypes ───────────────────────────────────────
// Each archetype is a named rule that checks if a move's features match.

const archetypes = [
  // === BULLISH SETUP ARCHETYPES ===
  {
    name: "Bull Alignment",
    desc: "HTF & LTF both rising, scores aligned — strong trend continuation setup",
    test: (f) => f.htf_rising && f.ltf_rising && f.scores_aligned,
    expectedDir: "UP",
  },
  {
    name: "Bull State Dominance",
    desc: "Final state is HTF_BULL_LTF_BULL — already in bullish quadrant",
    test: (f) => f.final_state === "HTF_BULL_LTF_BULL",
    expectedDir: "UP",
  },
  {
    name: "Pullback Entry (Q4→Q1)",
    desc: "HTF_BULL_LTF_PULLBACK → HTF_BULL_LTF_BULL transition — classic dip-buy",
    test: (f) => f.had_q4_to_q1,
    expectedDir: "UP",
  },
  {
    name: "HTF Bull + Pullback State",
    desc: "HTF rising while in pullback state — bullish divergence, pending recovery",
    test: (f) => f.htf_rising && f.had_bull_pullback,
    expectedDir: "UP",
  },
  {
    name: "Squeeze Release (Bull)",
    desc: "Squeeze release with HTF bull state — volatility expansion in trend direction",
    test: (f) => f.squeeze_releases > 0 && f.had_bull_bull,
    expectedDir: "UP",
  },
  {
    name: "ST Flip + Bull State",
    desc: "SuperTrend flip while in or transitioning to bull state",
    test: (f) => f.st_flips > 0 && (f.final_state === "HTF_BULL_LTF_BULL" || f.had_q4_to_q1),
    expectedDir: "UP",
  },
  {
    name: "High Momentum Elite",
    desc: "Multiple momentum elite signals in lead-up — strong buying pressure",
    test: (f) => f.momentum_elite >= 2,
    expectedDir: "UP",
  },
  {
    name: "EMA Cross + Rising HTF",
    desc: "EMA crossover combined with rising HTF scores — trend confirmation",
    test: (f) => f.ema_crosses > 0 && f.htf_rising,
    expectedDir: "UP",
  },
  {
    name: "Strong HTF Surge",
    desc: "HTF score delta > +15 — rapid HTF strengthening",
    test: (f) => f.htf_delta > 15,
    expectedDir: "UP",
  },
  {
    name: "LTF Recovery + High HTF",
    desc: "LTF rising from low with HTF mean above 50 — recovery in strong context",
    test: (f) => f.ltf_rising && f.htf_mean > 50,
    expectedDir: "UP",
  },

  // === BEARISH SETUP ARCHETYPES ===
  {
    name: "Bear Alignment",
    desc: "HTF & LTF both falling, scores aligned — strong downtrend",
    test: (f) => f.htf_falling && f.ltf_falling && f.scores_aligned,
    expectedDir: "DOWN",
  },
  {
    name: "Bear State Dominance",
    desc: "Final state is HTF_BEAR_LTF_BEAR — already in bearish quadrant",
    test: (f) => f.final_state === "HTF_BEAR_LTF_BEAR",
    expectedDir: "DOWN",
  },
  {
    name: "HTF Collapse",
    desc: "HTF score delta < -15 — rapid HTF deterioration",
    test: (f) => f.htf_delta < -15,
    expectedDir: "DOWN",
  },
  {
    name: "Squeeze Release (Bear)",
    desc: "Squeeze release without bull state — expansion into weakness",
    test: (f) => f.squeeze_releases > 0 && !f.had_bull_bull && f.final_state !== "HTF_BULL_LTF_BULL",
    expectedDir: "DOWN",
  },
  {
    name: "ST Flip + Bear State",
    desc: "SuperTrend flip while in or transitioning to bear state",
    test: (f) => f.st_flips > 0 && (f.final_state === "HTF_BEAR_LTF_BEAR" || f.final_state === "HTF_BEAR_LTF_PULLBACK"),
    expectedDir: "DOWN",
  },
  {
    name: "HTF Bear + Pullback Fail",
    desc: "HTF falling with a bear pullback — failed recovery attempt",
    test: (f) => f.htf_falling && f.had_bear_pullback,
    expectedDir: "DOWN",
  },

  // === SIGNAL-BASED ARCHETYPES ===
  {
    name: "Multiple ST Flips",
    desc: "2+ SuperTrend flips — high volatility, potential reversal/breakout",
    test: (f) => f.st_flips >= 2,
    expectedDir: null, // neutral
  },
  {
    name: "Multi-Signal Cluster",
    desc: "3+ different signal types firing — convergence of indicators",
    test: (f) => {
      const signals = [
        f.squeeze_releases > 0 ? 1 : 0,
        f.st_flips > 0 ? 1 : 0,
        f.ema_crosses > 0 ? 1 : 0,
        f.momentum_elite > 0 ? 1 : 0,
        f.flip_watches > 0 ? 1 : 0,
      ];
      return signals.reduce((s, v) => s + v, 0) >= 3;
    },
    expectedDir: null,
  },
  {
    name: "High Completion + High Phase",
    desc: "Completion > 0.7 AND phase > 70% — near cycle end, exhaustion likely",
    test: (f) => f.completion_end > 0.7 && f.phase_end > 70,
    expectedDir: null,
  },
  {
    name: "Low Rank Rising",
    desc: "Final rank in top 30 with rising HTF — strength leader emerging",
    test: (f) => f.rank_end <= 30 && f.rank_end > 0 && f.htf_rising,
    expectedDir: "UP",
  },
  {
    name: "HTF/LTF Divergence (Bull)",
    desc: "HTF rising while LTF falling — bullish divergence, LTF may snap back",
    test: (f) => f.htf_rising && f.ltf_falling,
    expectedDir: "UP",
  },
  {
    name: "HTF/LTF Divergence (Bear)",
    desc: "HTF falling while LTF rising — bearish divergence, LTF bounce unsustainable",
    test: (f) => f.htf_falling && f.ltf_rising,
    expectedDir: "DOWN",
  },
];

// ─── Step 3: Score each archetype ────────────────────────────────────────────

function scoreArchetype(archetype, patterns) {
  const matches = patterns.filter((p) => archetype.test(p.features));
  if (matches.length === 0) return null;

  const matchUp = matches.filter((p) => p.direction === "UP");
  const matchDown = matches.filter((p) => p.direction === "DOWN");

  const upPct = (matchUp.length / matches.length) * 100;
  const downPct = (matchDown.length / matches.length) * 100;

  const avgUpMag = matchUp.length > 0
    ? matchUp.reduce((s, p) => s + p.magnitude, 0) / matchUp.length
    : 0;
  const avgDownMag = matchDown.length > 0
    ? matchDown.reduce((s, p) => s + Math.abs(p.magnitude), 0) / matchDown.length
    : 0;

  // Expected value: (upPct * avgUpMag - downPct * avgDownMag) / 100
  const expectedValue = (upPct * avgUpMag - downPct * avgDownMag) / 100;

  return {
    name: archetype.name,
    desc: archetype.desc,
    expectedDir: archetype.expectedDir,
    matches: matches.length,
    matchPct: Math.round((matches.length / patterns.length) * 100 * 10) / 10,
    upCount: matchUp.length,
    downCount: matchDown.length,
    upPct: Math.round(upPct * 10) / 10,
    downPct: Math.round(downPct * 10) / 10,
    avgUpMagnitude: Math.round(avgUpMag * 10) / 10,
    avgDownMagnitude: Math.round(avgDownMag * 10) / 10,
    expectedValue: Math.round(expectedValue * 10) / 10,
    // Directional accuracy: how often does the pattern match its expected direction?
    directionalAccuracy: archetype.expectedDir
      ? Math.round(
          ((archetype.expectedDir === "UP" ? matchUp.length : matchDown.length) / matches.length) * 100 * 10
        ) / 10
      : null,
    // Sample tickers
    sampleTickers: matches.slice(0, 5).map((m) => `${m.ticker} (${m.startDate}, ${m.direction} ${m.magnitude > 0 ? "+" : ""}${m.magnitude.toFixed(1)}%)`),
  };
}

console.log("  Scoring archetypes...\n");

// Baseline: overall UP/DOWN split
const baselineUpPct = Math.round((upMoves.length / withTrail.length) * 100 * 10) / 10;
const baselineDownPct = Math.round((downMoves.length / withTrail.length) * 100 * 10) / 10;
const baselineAvgUpMag = Math.round((upMoves.reduce((s, p) => s + p.magnitude, 0) / upMoves.length) * 10) / 10;
const baselineAvgDownMag = Math.round((downMoves.reduce((s, p) => s + Math.abs(p.magnitude), 0) / downMoves.length) * 10) / 10;

console.log(`  Baseline: ${baselineUpPct}% UP (avg +${baselineAvgUpMag}%), ${baselineDownPct}% DOWN (avg -${baselineAvgDownMag}%)`);
console.log();

const results = archetypes
  .map((a) => scoreArchetype(a, withTrail))
  .filter((r) => r !== null);

// Sort by expected value
results.sort((a, b) => Math.abs(b.expectedValue) - Math.abs(a.expectedValue));

// ─── Step 4: Identify compound patterns ──────────────────────────────────────
// Look for combinations of 2 archetypes that appear together and score better

console.log("  Finding compound patterns (archetype combinations)...\n");

const compoundResults = [];
for (let i = 0; i < archetypes.length; i++) {
  for (let j = i + 1; j < archetypes.length; j++) {
    const a1 = archetypes[i];
    const a2 = archetypes[j];

    const matches = withTrail.filter((p) => a1.test(p.features) && a2.test(p.features));
    if (matches.length < 5) continue; // need minimum sample size

    const matchUp = matches.filter((p) => p.direction === "UP");
    const matchDown = matches.filter((p) => p.direction === "DOWN");
    const upPct = (matchUp.length / matches.length) * 100;
    const downPct = (matchDown.length / matches.length) * 100;

    const avgUpMag = matchUp.length > 0
      ? matchUp.reduce((s, p) => s + p.magnitude, 0) / matchUp.length
      : 0;
    const avgDownMag = matchDown.length > 0
      ? matchDown.reduce((s, p) => s + Math.abs(p.magnitude), 0) / matchDown.length
      : 0;

    const expectedValue = (upPct * avgUpMag - downPct * avgDownMag) / 100;

    // Is the directional bias strong (>65% one way)?
    const bias = Math.max(upPct, downPct);
    if (bias < 55) continue; // skip weak-bias combos

    compoundResults.push({
      name: `${a1.name} + ${a2.name}`,
      matches: matches.length,
      upCount: matchUp.length,
      downCount: matchDown.length,
      upPct: Math.round(upPct * 10) / 10,
      downPct: Math.round(downPct * 10) / 10,
      avgUpMagnitude: Math.round(avgUpMag * 10) / 10,
      avgDownMagnitude: Math.round(avgDownMag * 10) / 10,
      expectedValue: Math.round(expectedValue * 10) / 10,
      bias: upPct > downPct ? "BULLISH" : "BEARISH",
      biasStrength: Math.round(bias * 10) / 10,
    });
  }
}

compoundResults.sort((a, b) => Math.abs(b.expectedValue) - Math.abs(a.expectedValue));

console.log(`  Found ${compoundResults.length} compound patterns with directional bias\n`);

// ─── Step 5: Feature importance analysis ─────────────────────────────────────
// For each boolean feature, measure how much it shifts the UP/DOWN ratio

console.log("  Computing feature importance...\n");

const boolFeatures = [
  "htf_rising", "htf_falling", "ltf_rising", "ltf_falling",
  "scores_aligned", "htf_ltf_diverging",
  "had_bull_bull", "had_bull_pullback", "had_bear_bear", "had_bear_pullback",
  "had_q4_to_q1",
];

const signalFeatures = [
  "squeeze_releases", "ema_crosses", "st_flips", "momentum_elite", "flip_watches",
];

const featureImportance = [];

for (const feat of boolFeatures) {
  const present = withTrail.filter((p) => p.features[feat] === true);
  const absent = withTrail.filter((p) => p.features[feat] === false);

  if (present.length < 5) continue;

  const presentUpPct = (present.filter((p) => p.direction === "UP").length / present.length) * 100;
  const absentUpPct = absent.length > 0
    ? (absent.filter((p) => p.direction === "UP").length / absent.length) * 100
    : baselineUpPct;

  const lift = presentUpPct - absentUpPct;

  featureImportance.push({
    feature: feat,
    type: "boolean",
    presentCount: present.length,
    presentUpPct: Math.round(presentUpPct * 10) / 10,
    absentUpPct: Math.round(absentUpPct * 10) / 10,
    liftPct: Math.round(lift * 10) / 10,
    direction: lift > 0 ? "BULLISH" : lift < 0 ? "BEARISH" : "NEUTRAL",
  });
}

for (const feat of signalFeatures) {
  const present = withTrail.filter((p) => (p.features[feat] || 0) > 0);
  const absent = withTrail.filter((p) => (p.features[feat] || 0) === 0);

  if (present.length < 5) continue;

  const presentUpPct = (present.filter((p) => p.direction === "UP").length / present.length) * 100;
  const absentUpPct = absent.length > 0
    ? (absent.filter((p) => p.direction === "UP").length / absent.length) * 100
    : baselineUpPct;

  const lift = presentUpPct - absentUpPct;

  featureImportance.push({
    feature: feat,
    type: "signal_count",
    presentCount: present.length,
    presentUpPct: Math.round(presentUpPct * 10) / 10,
    absentUpPct: Math.round(absentUpPct * 10) / 10,
    liftPct: Math.round(lift * 10) / 10,
    direction: lift > 0 ? "BULLISH" : lift < 0 ? "BEARISH" : "NEUTRAL",
  });
}

// Sort by absolute lift
featureImportance.sort((a, b) => Math.abs(b.liftPct) - Math.abs(a.liftPct));

// ─── Step 6: State transition analysis ───────────────────────────────────────
// Which final states most correlate with UP vs DOWN?

const stateAnalysis = {};
for (const p of withTrail) {
  const state = p.features.final_state;
  if (!state) continue;
  if (!stateAnalysis[state]) stateAnalysis[state] = { up: 0, down: 0, total: 0, upMags: [], downMags: [] };
  stateAnalysis[state].total++;
  if (p.direction === "UP") {
    stateAnalysis[state].up++;
    stateAnalysis[state].upMags.push(p.magnitude);
  } else {
    stateAnalysis[state].down++;
    stateAnalysis[state].downMags.push(Math.abs(p.magnitude));
  }
}

for (const [state, d] of Object.entries(stateAnalysis)) {
  d.upPct = Math.round((d.up / d.total) * 100 * 10) / 10;
  d.downPct = Math.round((d.down / d.total) * 100 * 10) / 10;
  d.avgUpMag = d.upMags.length > 0
    ? Math.round((d.upMags.reduce((s, v) => s + v, 0) / d.upMags.length) * 10) / 10
    : 0;
  d.avgDownMag = d.downMags.length > 0
    ? Math.round((d.downMags.reduce((s, v) => s + v, 0) / d.downMags.length) * 10) / 10
    : 0;
  delete d.upMags;
  delete d.downMags;
}

// ─── Step 7: Sector analysis ─────────────────────────────────────────────────

const sectorAnalysis = {};
for (const p of withTrail) {
  const s = p.sector || "Unknown";
  if (!sectorAnalysis[s]) sectorAnalysis[s] = { up: 0, down: 0, total: 0, avgMag: [] };
  sectorAnalysis[s].total++;
  sectorAnalysis[s].avgMag.push(Math.abs(p.magnitude));
  if (p.direction === "UP") sectorAnalysis[s].up++;
  else sectorAnalysis[s].down++;
}

for (const [sector, d] of Object.entries(sectorAnalysis)) {
  d.upPct = Math.round((d.up / d.total) * 100 * 10) / 10;
  d.avgMagnitude = Math.round((d.avgMag.reduce((s, v) => s + v, 0) / d.avgMag.length) * 10) / 10;
  delete d.avgMag;
}

// ─── Step 8: Print summary ───────────────────────────────────────────────────

console.log("  ═══ ARCHETYPE SCORES ═══\n");
console.log("  " + "Archetype".padEnd(30) + "N".padStart(5) + "UP%".padStart(7) + "DN%".padStart(7) + "AvgUp".padStart(8) + "AvgDn".padStart(8) + "EV".padStart(8) + "DirAcc".padStart(8));
console.log("  " + "─".repeat(81));

for (const r of results) {
  console.log(
    "  " +
      r.name.padEnd(30) +
      String(r.matches).padStart(5) +
      `${r.upPct}%`.padStart(7) +
      `${r.downPct}%`.padStart(7) +
      `+${r.avgUpMagnitude}%`.padStart(8) +
      `-${r.avgDownMagnitude}%`.padStart(8) +
      `${r.expectedValue > 0 ? "+" : ""}${r.expectedValue}`.padStart(8) +
      (r.directionalAccuracy != null ? `${r.directionalAccuracy}%` : "—").padStart(8)
  );
}

console.log("\n  ═══ TOP COMPOUND PATTERNS ═══\n");
for (const c of compoundResults.slice(0, 15)) {
  const arrow = c.bias === "BULLISH" ? "▲" : "▼";
  console.log(`  ${arrow} ${c.name}`);
  console.log(`    N=${c.matches}  UP ${c.upPct}% / DOWN ${c.downPct}%  EV=${c.expectedValue > 0 ? "+" : ""}${c.expectedValue}  Bias: ${c.bias} (${c.biasStrength}%)`);
}

console.log("\n  ═══ FEATURE IMPORTANCE ═══\n");
console.log("  " + "Feature".padEnd(25) + "N".padStart(5) + "w/ UP%".padStart(9) + "w/o UP%".padStart(9) + "Lift".padStart(8) + "Dir".padStart(10));
console.log("  " + "─".repeat(66));
for (const f of featureImportance) {
  console.log(
    "  " +
      f.feature.padEnd(25) +
      String(f.presentCount).padStart(5) +
      `${f.presentUpPct}%`.padStart(9) +
      `${f.absentUpPct}%`.padStart(9) +
      `${f.liftPct > 0 ? "+" : ""}${f.liftPct}%`.padStart(8) +
      f.direction.padStart(10)
  );
}

console.log("\n  ═══ STATE ANALYSIS ═══\n");
for (const [state, d] of Object.entries(stateAnalysis).sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${state.padEnd(30)} N=${String(d.total).padStart(3)}  UP ${d.upPct}%  DOWN ${d.downPct}%  avgUP +${d.avgUpMag}%  avgDN -${d.avgDownMag}%`);
}

// ─── Step 9: Write outputs ───────────────────────────────────────────────────

const docsDir = path.join(__dirname, "../docs");

const jsonOutput = {
  generated: new Date().toISOString(),
  baseline: {
    upPct: baselineUpPct,
    downPct: baselineDownPct,
    avgUpMagnitude: baselineAvgUpMag,
    avgDownMagnitude: baselineAvgDownMag,
    totalMoves: withTrail.length,
  },
  archetypeScores: results,
  compoundPatterns: compoundResults,
  featureImportance,
  stateAnalysis,
  sectorAnalysis,
};

fs.writeFileSync(path.join(docsDir, "pattern_scores.json"), JSON.stringify(jsonOutput, null, 2));

// ─── Step 10: Generate MODEL_FINDINGS.md ─────────────────────────────────────

const md = [];
md.push("# Self-Learning Model: Phase 1 Findings");
md.push("");
md.push(`> Generated: ${new Date().toISOString()}`);
md.push(`> Dataset: ${withTrail.length} significant moves with trail data (Oct 2025 – Feb 2026)`);
md.push(`> Baseline: ${baselineUpPct}% UP / ${baselineDownPct}% DOWN`);
md.push("");

md.push("## Executive Summary");
md.push("");
md.push("This report identifies the scoring patterns, signals, and state transitions that");
md.push("most reliably precede significant price moves (≥5%) in our ticker universe.");
md.push("");

// Key findings
md.push("## Key Findings");
md.push("");

// Top bullish patterns
const bullPatterns = results.filter((r) => r.expectedValue > 0).slice(0, 5);
if (bullPatterns.length > 0) {
  md.push("### Strongest Bullish Patterns");
  md.push("");
  md.push("| Pattern | N | UP% | Avg UP | EV | Dir Acc |");
  md.push("|---------|---|-----|--------|-----|---------|");
  for (const r of bullPatterns) {
    md.push(`| **${r.name}** | ${r.matches} | ${r.upPct}% | +${r.avgUpMagnitude}% | +${r.expectedValue} | ${r.directionalAccuracy || "—"}% |`);
  }
  md.push("");
  for (const r of bullPatterns) {
    md.push(`- **${r.name}**: ${r.desc}`);
  }
  md.push("");
}

// Top bearish patterns
const bearPatterns = results.filter((r) => r.expectedValue < 0).slice(0, 5);
if (bearPatterns.length > 0) {
  md.push("### Strongest Bearish Patterns");
  md.push("");
  md.push("| Pattern | N | DOWN% | Avg DOWN | EV | Dir Acc |");
  md.push("|---------|---|-------|----------|-----|---------|");
  for (const r of bearPatterns) {
    md.push(`| **${r.name}** | ${r.matches} | ${r.downPct}% | -${r.avgDownMagnitude}% | ${r.expectedValue} | ${r.directionalAccuracy || "—"}% |`);
  }
  md.push("");
  for (const r of bearPatterns) {
    md.push(`- **${r.name}**: ${r.desc}`);
  }
  md.push("");
}

// Compound patterns
md.push("### Best Compound Patterns (2-archetype combos)");
md.push("");
md.push("| Pattern Combo | N | Bias | Bias% | EV |");
md.push("|---------------|---|------|-------|-----|");
for (const c of compoundResults.slice(0, 10)) {
  const arrow = c.bias === "BULLISH" ? "▲" : "▼";
  md.push(`| ${arrow} ${c.name} | ${c.matches} | ${c.bias} | ${c.biasStrength}% | ${c.expectedValue > 0 ? "+" : ""}${c.expectedValue} |`);
}
md.push("");

// Feature importance
md.push("## Feature Importance");
md.push("");
md.push("How much each feature shifts the probability of an UP move vs baseline:");
md.push("");
md.push("| Feature | When Present UP% | When Absent UP% | Lift | Direction |");
md.push("|---------|------------------|-----------------|------|-----------|");
for (const f of featureImportance) {
  md.push(`| ${f.feature} | ${f.presentUpPct}% | ${f.absentUpPct}% | ${f.liftPct > 0 ? "+" : ""}${f.liftPct}% | ${f.direction} |`);
}
md.push("");

// State analysis
md.push("## State Analysis");
md.push("");
md.push("Which scoring state (before the move) correlates with UP vs DOWN:");
md.push("");
md.push("| State | N | UP% | DOWN% | Avg UP Mag | Avg DOWN Mag |");
md.push("|-------|---|-----|-------|------------|-------------|");
for (const [state, d] of Object.entries(stateAnalysis).sort((a, b) => b[1].total - a[1].total)) {
  md.push(`| ${state} | ${d.total} | ${d.upPct}% | ${d.downPct}% | +${d.avgUpMag}% | -${d.avgDownMag}% |`);
}
md.push("");

// Sector analysis
md.push("## Sector Analysis");
md.push("");
md.push("| Sector | Moves | UP% | Avg Magnitude |");
md.push("|--------|-------|-----|--------------|");
for (const [sector, d] of Object.entries(sectorAnalysis).sort((a, b) => b[1].total - a[1].total)) {
  md.push(`| ${sector} | ${d.total} | ${d.upPct}% | ${d.avgMagnitude}% |`);
}
md.push("");

// Recommendations
md.push("## Actionable Recommendations");
md.push("");
md.push("### For Kanban Lane Classification:");
md.push("1. **ENTER_NOW threshold**: Prioritize tickers matching the top bullish archetypes");
md.push("2. **EXIT signals**: Flag tickers matching bearish archetypes in active positions");
md.push("3. **WATCH list**: Tickers showing early-stage bullish patterns (HTF rising but not yet aligned)");
md.push("");
md.push("### For Trade Simulation:");
md.push("1. Entry trigger: Compound patterns with highest directional accuracy");
md.push("2. Confidence weighting: Use archetype EV as position sizing signal");
md.push("3. Stop-loss calibration: Use avg adverse excursion from matched archetypes");
md.push("");
md.push("### Next Steps (Phase 2):");
md.push("1. **Track decisions**: Log which archetypes trigger entries/exits");
md.push("2. **Measure outcomes**: Compare predicted vs actual results");
md.push("3. **Feedback loop**: Adjust archetype thresholds based on live outcomes");
md.push("");

md.push("---");
md.push(`*Analysis based on ${withTrail.length} significant moves across ${Object.keys(sectorAnalysis).length} sectors*`);

fs.writeFileSync(path.join(docsDir, "MODEL_FINDINGS.md"), md.join("\n"));

console.log(`\n  ✅ Output written:`);
console.log(`     docs/pattern_scores.json`);
console.log(`     docs/MODEL_FINDINGS.md`);
console.log(`\n  Phase 1 complete. Review MODEL_FINDINGS.md for actionable insights.\n`);
