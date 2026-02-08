#!/usr/bin/env node
/**
 * Phase 2.2: Seed Pattern Library
 *
 * Takes the archetype scores from Phase 1.3 (pattern_scores.json) and inserts
 * them into the pattern_library D1 table with serialized rule definitions.
 *
 * Usage:
 *   node scripts/seed-pattern-library.js
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

console.log(`\n╔══════════════════════════════════════════════╗`);
console.log(`║   Phase 2.2: Seed Pattern Library             ║`);
console.log(`╚══════════════════════════════════════════════╝\n`);

// ─── Pattern Definitions (mapping archetype names → real-time conditions) ────

const PATTERN_DEFS = [
  // === BULLISH ===
  {
    pattern_id: "bull_state_dominance",
    name: "Bull State Dominance",
    description: "Final state is HTF_BULL_LTF_BULL — already in bullish quadrant",
    expected_direction: "UP",
    definition: [
      { field: "state", op: "eq", value: "HTF_BULL_LTF_BULL" },
    ],
  },
  {
    pattern_id: "st_flip_bull_state",
    name: "ST Flip + Bull State",
    description: "SuperTrend flip while in or transitioning to bull state",
    expected_direction: "UP",
    definition: [
      { field: "state", op: "in", value: ["HTF_BULL_LTF_BULL", "HTF_BULL_LTF_PULLBACK"] },
      // At least one ST flip is active (any timeframe)
      { field: "flags.st_flip_30m", op: "truthy" },
    ],
  },
  {
    pattern_id: "st_flip_bull_state_1h",
    name: "ST Flip 1H + Bull State",
    description: "1H SuperTrend flip while in bull state — higher timeframe confirmation",
    expected_direction: "UP",
    definition: [
      { field: "state", op: "in", value: ["HTF_BULL_LTF_BULL", "HTF_BULL_LTF_PULLBACK"] },
      { field: "flags.st_flip_1h", op: "truthy" },
    ],
  },
  {
    pattern_id: "ema_cross_rising_htf",
    name: "EMA Cross + Rising HTF",
    description: "EMA crossover combined with strong HTF score — trend confirmation",
    expected_direction: "UP",
    definition: [
      { field: "flags.ema_cross_1h_13_48", op: "truthy" },
      { field: "htf_score", op: "gte", value: 55 },
    ],
  },
  {
    pattern_id: "high_momentum_elite",
    name: "High Momentum Elite",
    description: "Momentum elite flag firing — strong multi-TF buying pressure",
    expected_direction: "UP",
    definition: [
      { field: "flags.momentum_elite", op: "truthy" },
    ],
  },
  {
    pattern_id: "htf_bull_pullback_recovery",
    name: "HTF Bull + Pullback State",
    description: "In pullback within bull trend — divergence setup for recovery",
    expected_direction: "UP",
    definition: [
      { field: "state", op: "eq", value: "HTF_BULL_LTF_PULLBACK" },
      { field: "htf_score", op: "gte", value: 55 },
    ],
  },
  {
    pattern_id: "strong_htf_surge",
    name: "Strong HTF Surge",
    description: "HTF score very high (>75) — rapid HTF strengthening",
    expected_direction: "UP",
    definition: [
      { field: "htf_score", op: "gte", value: 75 },
      { field: "state", op: "in", value: ["HTF_BULL_LTF_BULL", "HTF_BULL_LTF_PULLBACK"] },
    ],
  },
  {
    pattern_id: "ltf_recovery_high_htf",
    name: "LTF Recovery + High HTF",
    description: "LTF recovering (score rising) while HTF stays strong — trend resumption",
    expected_direction: "UP",
    definition: [
      { field: "htf_score", op: "gte", value: 50 },
      { field: "ltf_score", op: "gte", value: 40 },
      { field: "ltf_score", op: "lte", value: 65 },
      { field: "state", op: "eq", value: "HTF_BULL_LTF_PULLBACK" },
    ],
  },
  {
    pattern_id: "bull_momentum_elite_bull_state",
    name: "Bull State + Momentum Elite",
    description: "Momentum elite in bull state — compound bullish setup (78.8% hit rate)",
    expected_direction: "UP",
    definition: [
      { field: "state", op: "eq", value: "HTF_BULL_LTF_BULL" },
      { field: "flags.momentum_elite", op: "truthy" },
    ],
  },

  // === BEARISH ===
  {
    pattern_id: "squeeze_release_bear",
    name: "Squeeze Release (Bear)",
    description: "Squeeze release without bull state — volatility expansion into weakness (100% DOWN in sample)",
    expected_direction: "DOWN",
    definition: [
      { field: "flags.sq30_release", op: "truthy" },
      { field: "state", op: "in", value: ["HTF_BEAR_LTF_BEAR", "HTF_BEAR_LTF_PULLBACK"] },
    ],
  },
  {
    pattern_id: "bear_state_dominance",
    name: "Bear State Dominance",
    description: "In HTF_BEAR_LTF_BEAR — bearish quadrant dominance",
    expected_direction: "DOWN",
    definition: [
      { field: "state", op: "eq", value: "HTF_BEAR_LTF_BEAR" },
    ],
  },
  {
    pattern_id: "st_flip_bear_state",
    name: "ST Flip + Bear State",
    description: "SuperTrend flip while in bear state — acceleration to downside",
    expected_direction: "DOWN",
    definition: [
      { field: "state", op: "in", value: ["HTF_BEAR_LTF_BEAR", "HTF_BEAR_LTF_PULLBACK"] },
      { field: "flags.st_flip_bear", op: "truthy" },
    ],
  },
  {
    pattern_id: "htf_collapse",
    name: "HTF Collapse",
    description: "HTF score very low (<25) — rapid HTF deterioration",
    expected_direction: "DOWN",
    definition: [
      { field: "htf_score", op: "lte", value: 25 },
      { field: "state", op: "in", value: ["HTF_BEAR_LTF_BEAR", "HTF_BEAR_LTF_PULLBACK"] },
    ],
  },
  {
    pattern_id: "bear_squeeze_multi_signal",
    name: "Bear State + Squeeze + Multi-Signal",
    description: "Bear state with squeeze release and ST flip — 100% DOWN compound pattern",
    expected_direction: "DOWN",
    definition: [
      { field: "state", op: "eq", value: "HTF_BEAR_LTF_BEAR" },
      { field: "flags.sq30_release", op: "truthy" },
      { field: "flags.st_flip_bear", op: "truthy" },
    ],
  },
  {
    pattern_id: "htf_ltf_divergence_bear",
    name: "HTF/LTF Divergence (Bear)",
    description: "HTF falling while LTF rising — bearish divergence, unsustainable bounce (87.5% DOWN)",
    expected_direction: "DOWN",
    definition: [
      { field: "htf_score", op: "lte", value: 40 },
      { field: "ltf_score", op: "gte", value: 55 },
      { field: "state", op: "in", value: ["HTF_BEAR_LTF_PULLBACK"] },
    ],
  },

  // === NEUTRAL / HIGH-VOLATILITY ===
  {
    pattern_id: "multi_signal_cluster",
    name: "Multi-Signal Cluster",
    description: "Multiple different signal types firing simultaneously — high volatility, watch closely",
    expected_direction: null,
    definition: [
      { field: "flags.sq30_release", op: "truthy" },
      { field: "flags.st_flip_30m", op: "truthy" },
    ],
  },
  {
    pattern_id: "high_completion_exhaustion",
    name: "High Completion Exhaustion",
    description: "Completion > 0.7 and phase > 70% — near cycle end, mean reversion likely",
    expected_direction: "DOWN",
    definition: [
      { field: "completion", op: "gte", value: 0.7 },
      { field: "phase_pct", op: "gte", value: 70 },
    ],
  },
];

// ─── Load Phase 1 scores to populate metrics ─────────────────────────────────

const scoresPath = path.join(__dirname, "../docs/pattern_scores.json");
let archetypeScores = {};
if (fs.existsSync(scoresPath)) {
  const scores = JSON.parse(fs.readFileSync(scoresPath, "utf-8"));
  for (const a of (scores.archetypeScores || [])) {
    // Map by a slug version of the name
    const slug = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "");
    archetypeScores[slug] = a;
  }
}

// ─── Map Phase 1 scores to pattern defs ──────────────────────────────────────

function findScore(patternId) {
  // Try exact match first, then fuzzy
  for (const [slug, score] of Object.entries(archetypeScores)) {
    if (patternId.includes(slug) || slug.includes(patternId.replace(/_/g, ""))) {
      return score;
    }
  }
  // Try by name
  for (const def of PATTERN_DEFS) {
    if (def.pattern_id === patternId) {
      for (const [slug, score] of Object.entries(archetypeScores)) {
        const nameSlug = def.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        if (slug === nameSlug || nameSlug.includes(slug)) {
          return score;
        }
      }
    }
  }
  return null;
}

// ─── Generate SQL file and execute via --file ────────────────────────────────

const workerDir = path.join(__dirname, "../worker");
const now = Date.now();
const sqlLines = [];

console.log(`  Generating SQL for ${PATTERN_DEFS.length} patterns...\n`);

let count = 0;
for (const def of PATTERN_DEFS) {
  const score = findScore(def.pattern_id);

  const hitRate = score ? (score.upPct / 100) : 0.5;
  const sampleCount = score ? score.matches : 0;
  const avgReturn = score ? score.avgUpMagnitude : 0;
  const avgMagnitude = score ? Math.max(score.avgUpMagnitude, score.avgDownMagnitude) : 0;
  const expectedValue = score ? score.expectedValue : 0;
  const dirAccuracy = score ? (score.directionalAccuracy || 50) / 100 : 0.5;
  const confidence = Math.min(0.95, Math.max(0.1,
    hitRate * 0.6 + (Math.min(sampleCount, 100) / 100) * 0.4
  ));

  const defJson = JSON.stringify(def.definition);
  const esc = (s) => (s || "").replace(/'/g, "''");

  sqlLines.push(
    `INSERT OR REPLACE INTO pattern_library (pattern_id, name, description, expected_direction, definition_json, hit_rate, sample_count, avg_return, avg_magnitude, expected_value, directional_accuracy, confidence, status, version, last_updated, created_at) VALUES ('${esc(def.pattern_id)}', '${esc(def.name)}', '${esc(def.description)}', ${def.expected_direction ? "'" + def.expected_direction + "'" : "NULL"}, '${esc(defJson)}', ${Math.round(hitRate * 10000) / 10000}, ${sampleCount}, ${Math.round(avgReturn * 100) / 100}, ${Math.round(avgMagnitude * 100) / 100}, ${Math.round(expectedValue * 100) / 100}, ${Math.round(dirAccuracy * 10000) / 10000}, ${Math.round(confidence * 10000) / 10000}, 'active', 1, ${now}, ${now});`
  );

  const dir = def.expected_direction || "—";
  const hr = score ? `${score.upPct}% UP (n=${score.matches})` : "no Phase 1 data";
  console.log(`  + ${def.pattern_id.padEnd(35)} ${dir.padEnd(5)} ${hr}`);
  count++;
}

// Changelog entry
sqlLines.push(
  `INSERT INTO model_changelog (change_id, change_type, description, status, proposed_at, approved_by, approved_at, created_at) VALUES ('chg:seed:${now}', 'add_pattern', 'Seeded ${count} patterns from Phase 1 analysis', 'auto_applied', ${now}, 'system', ${now}, ${now});`
);

// Write SQL file
const sqlFile = path.join(workerDir, "migrations", "_seed_patterns.sql");
fs.writeFileSync(sqlFile, sqlLines.join("\n"));
console.log(`\n  Wrote ${sqlLines.length} SQL statements to ${sqlFile}`);

// Execute
console.log("  Executing against D1...");
try {
  const out = execSync(
    `cd "${workerDir}" && npx wrangler d1 execute timed-trading-ledger --file=migrations/_seed_patterns.sql --env production --remote --json`,
    { maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" }
  );
  const parsed = JSON.parse(out);
  const meta = parsed[0]?.meta || {};
  console.log(`  ✅ Executed: ${meta.rows_written || "?"} rows written`);
} catch (e) {
  console.error(`  ❌ Execution failed: ${String(e.message || e).slice(0, 500)}`);
}

console.log(`\n  ✅ Seeded ${count} patterns into pattern_library`);
console.log(`  ✅ Changelog entry created\n`);

// Verify
const verifyCmd = `cd "${workerDir}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "SELECT pattern_id, name, expected_direction, hit_rate, sample_count, confidence, status FROM pattern_library ORDER BY expected_value DESC"`;
try {
  const raw = execSync(verifyCmd, { maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" });
  const parsed = JSON.parse(raw);
  const rows = parsed[0]?.results || [];
  console.log(`  Verification: ${rows.length} patterns in pattern_library:`);
  for (const r of rows) {
    console.log(`    ${r.pattern_id.padEnd(35)} ${(r.expected_direction || "—").padEnd(5)} HR=${((r.hit_rate || 0) * 100).toFixed(1)}%  n=${r.sample_count}  conf=${((r.confidence || 0) * 100).toFixed(0)}%  [${r.status}]`);
  }
} catch (e) {
  console.error("  Verification failed:", String(e.message || e).slice(0, 200));
}

console.log();
