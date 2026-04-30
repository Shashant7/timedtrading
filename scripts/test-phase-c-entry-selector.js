// scripts/test-phase-c-entry-selector.js
//
// Pure-function unit tests for worker/pipeline/entry-selector.js.
// Run with: node scripts/test-phase-c-entry-selector.js

import {
  divergenceModifier,
  pdzModifier,
  tdExhaustionModifier,
  personalityModifier,
  computeQualityScore,
  computeCapacityForBar,
  tiebreakerKey,
  selectTopN,
  loadPhaseCConfig,
  DEFAULTS,
} from "../worker/pipeline/entry-selector.js";

let pass = 0;
let fail = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push({ label, actual: a, expected: e });
    console.log(`  ✗ ${label}\n    actual:   ${a}\n    expected: ${e}`);
  }
}
function close(actual, expected, eps, label) {
  if (Math.abs(actual - expected) <= eps) {
    pass++;
    console.log(`  ✓ ${label} (${actual.toFixed(4)} ≈ ${expected.toFixed(4)})`);
  } else {
    fail++;
    failures.push({ label, actual, expected });
    console.log(`  ✗ ${label}\n    actual:   ${actual}\n    expected: ${expected} ± ${eps}`);
  }
}

// ───────────────────────────────────────────────────────────────────────
console.log("\n## divergenceModifier");
eq(divergenceModifier(null), 0, "null returns 0");
eq(divergenceModifier({}), +5, "empty divergence is pristine = +5");
eq(divergenceModifier({ adverse_rsi: { count: 1 }, adverse_phase: { count: 1 } }), -25, "F4 (BOTH active) = -25");
eq(divergenceModifier({ adverse_phase: { count: 1, strongest: { tf: "10m" } } }), -10, "LTF (10m) phase div = -10");
eq(divergenceModifier({ adverse_phase: { count: 1, strongest: { tf: "30m" } } }), -10, "LTF (30m) phase div = -10");
eq(divergenceModifier({ adverse_phase: { count: 1, strongest: { tf: "1h" } } }), -5, "h1 phase div alone = -5");
eq(divergenceModifier({ adverse_rsi: { count: 1 } }), -10, "adverse_rsi alone = -10");
eq(divergenceModifier({ adverse_phase: { count: 2 } }), -5, "count=2 phase only = -5");

// ───────────────────────────────────────────────────────────────────────
console.log("\n## pdzModifier (LONG)");
eq(pdzModifier(null, "LONG"), 0, "null returns 0");
eq(pdzModifier({ D: "premium", h4: "premium" }, "LONG"), +10, "premium-stack LONG = +10");
eq(pdzModifier({ D: "premium", h4: "premium_approach" }, "LONG"), +5, "D=premium, 4h=approach = +5");
eq(pdzModifier({ D: "premium" }, "LONG"), +5, "single D=premium LONG = +5");
eq(pdzModifier({ D: "premium_approach", h4: "premium" }, "LONG"), +3, "approach + premium 4h = +3");
eq(pdzModifier({ D: "premium_approach", h4: "premium_approach" }, "LONG"), 0, "approach-stack = neutral");
eq(pdzModifier({ D: "discount" }, "LONG"), 0, "discount LONG = neutral");

console.log("\n## pdzModifier (SHORT — flipped)");
eq(pdzModifier({ D: "discount", h4: "discount" }, "SHORT"), +10, "discount-stack SHORT = +10");
eq(pdzModifier({ D: "premium" }, "SHORT"), 0, "premium SHORT = neutral");

// ───────────────────────────────────────────────────────────────────────
console.log("\n## tdExhaustionModifier (LONG)");
eq(tdExhaustionModifier(null, "LONG"), 0, "null returns 0");
eq(tdExhaustionModifier({ D: { td9_bear: true } }, "LONG"), -15, "Daily TD9_bear fired = -15 hard penalty");
eq(tdExhaustionModifier({ D: { bear_prep: 8 } }, "LONG"), -10, "Daily bear_prep=8 = -10");
eq(tdExhaustionModifier({ D: { bear_prep: 9 } }, "LONG"), -10, "Daily bear_prep=9 = -10");
eq(tdExhaustionModifier({ D: { bear_prep: 6 } }, "LONG"), -5, "Daily bear_prep=6 = -5");
eq(tdExhaustionModifier({ D: { bear_prep: 1 } }, "LONG"), 0, "Daily bear_prep=1 LONG = neutral");
eq(tdExhaustionModifier({ "240": { bear_prep: 2 } }, "LONG"), +5, "4h bear_prep=2 = +5 (early HTF strength)");
eq(tdExhaustionModifier({ D: { bear_prep: 6 }, "240": { bear_prep: 2 } }, "LONG"), 0, "D=-5 + 4h=+5 = 0");

// ───────────────────────────────────────────────────────────────────────
console.log("\n## personalityModifier");
eq(personalityModifier("VOLATILE_RUNNER", "tt_pullback"), +5, "VOLATILE_RUNNER on trend setup = +5");
eq(personalityModifier("PULLBACK_PLAYER", "tt_pullback"), -3, "PULLBACK_PLAYER on trend setup = -3");
eq(personalityModifier("PULLBACK_PLAYER", "tt_n_test_resistance"), 0, "PULLBACK_PLAYER on reversal = 0");
eq(personalityModifier("MEAN_REVERT", "tt_pullback"), -5, "MEAN_REVERT on trend setup = -5");
eq(personalityModifier("MEAN_REVERT", "tt_range_reversal_long"), +3, "MEAN_REVERT on reversal = +3");
eq(personalityModifier("", "tt_pullback"), 0, "empty personality = neutral");

// ───────────────────────────────────────────────────────────────────────
console.log("\n## computeQualityScore");
const baseTrade = {
  rank: 100,
  __focus_conviction_score: 90,
  rr: 2.5,
  __entry_path: "tt_gap_reversal_long",
  __entry_direction: "LONG",
  __entry_setup_snapshot: {
    pdz: { D: "premium", h4: "premium" },        // +10
    td_seq: { D: { bear_prep: 0 }, "240": { bear_prep: 2 } },  // +5 (early HTF strength)
  },
  __entry_divergence_summary: { adverse_rsi: null, adverse_phase: null, bull_rsi: false, bear_rsi: false }, // +5 pristine (computed, none active)
  ticker_character: { personality: "VOLATILE_RUNNER" },             // +5
};
const score = computeQualityScore(baseTrade);
console.log(`  → baseline: composite=${score.composite.toFixed(2)}, rank=${score.rank}, conv=${score.conviction}, div=${score.div_modifier}, pdz=${score.pdz_modifier}, td=${score.td_modifier}, pers=${score.personality_mod}`);
// Default weights: rank 1.0, conviction 0.5, div 1.0, pdz 1.0, td 1.0, personality 1.0
// = 100 + 45 + 5 + 10 + 5 + 5 = 170
close(score.composite, 100 + 0.5 * 90 + 5 + 10 + 5 + 5, 0.001, "composite for high-quality LONG = 170.00");

// F4 trade (BOTH adv RSI + adv phase): should score MUCH lower
const f4Trade = {
  ...baseTrade,
  __entry_divergence_summary: { adverse_rsi: { count: 1 }, adverse_phase: { count: 1 } },
};
const f4Score = computeQualityScore(f4Trade);
console.log(`  → F4 trade: composite=${f4Score.composite.toFixed(2)}, div=${f4Score.div_modifier}`);
close(f4Score.composite, 100 + 0.5 * 90 + (-25) + 10 + 5 + 5, 0.001, "composite for F4 trade = 140.00 (vs 170 pristine)");

// ───────────────────────────────────────────────────────────────────────
console.log("\n## computeCapacityForBar");
eq(computeCapacityForBar(35, 0), 7, "0 open of 35: ceil(35*0.20)=7");
eq(computeCapacityForBar(35, 12), 5, "12 open of 35 (23 remaining): ceil(23*0.20)=5");
eq(computeCapacityForBar(35, 30), 1, "30 open of 35 (5 remaining): ceil(5*0.20)=1");
eq(computeCapacityForBar(35, 35), 0, "35 open of 35: 0 capacity");
eq(computeCapacityForBar(35, 40), 0, "over-cap: 0 capacity");
eq(computeCapacityForBar(100, 0), 8, "huge book hits hard_cap_per_bar=8");

// ───────────────────────────────────────────────────────────────────────
console.log("\n## selectTopN");
const candidates = [
  { ticker: "AAA", score: { composite: 100, rr: 2.0 }, tickerData: { rank: 100 } },
  { ticker: "BBB", score: { composite: 150, rr: 3.0 }, tickerData: { rank: 100 } },
  { ticker: "CCC", score: { composite: 80, rr: 2.0 }, tickerData: { rank: 100 } },
  { ticker: "DDD", score: { composite: 120, rr: 2.5 }, tickerData: { rank: 100 } },
];

const sel = selectTopN(candidates, 2);
eq(sel.winners.map(c => c.ticker), ["BBB", "DDD"], "top 2 by composite");
eq(sel.losers.map(c => c.ticker), ["AAA", "CCC"], "rest are losers");
eq(sel.losers[0].reject_reason, "below_topn", "loser reject_reason");

// Quality floor test
const sel2 = selectTopN([
  { ticker: "WIN", score: { composite: 50, rr: 2.0 }, tickerData: {} },
  { ticker: "FAIL", score: { composite: -30, rr: 2.0 }, tickerData: {} },
], 5, { quality_score_min: -20 });
eq(sel2.winners.map(c => c.ticker), ["WIN"], "score below floor rejected");
eq(sel2.losers[0].reject_reason, "below_quality_floor", "below floor reject_reason");

// Tiebreaker: identical composite, higher R:R wins
const tied = [
  { ticker: "T1", score: { composite: 100, rr: 2.0 }, tickerData: { rank: 100 } },
  { ticker: "T2", score: { composite: 100, rr: 3.5 }, tickerData: { rank: 100 } },
  { ticker: "T3", score: { composite: 100, rr: 1.5 }, tickerData: { rank: 100 } },
];
const tiedSel = selectTopN(tied, 2);
eq(tiedSel.winners.map(c => c.ticker), ["T2", "T1"], "tiebreaker: higher R:R wins; insertion order breaks final tie");

// Tiebreaker with historical WR
const tiedWr = [
  { ticker: "LITE", score: { composite: 100, rr: 2.0 }, tickerData: { _ticker_profile: { learning: { personality: "VOLATILE_RUNNER" }, win_rate: 0.65 } } },
  { ticker: "OTHER", score: { composite: 100, rr: 2.0 }, tickerData: { _ticker_profile: { win_rate: 0.45 } } },
];
const tiedWrSel = selectTopN(tiedWr, 1);
eq(tiedWrSel.winners.map(c => c.ticker), ["LITE"], "tiebreaker: higher historical WR wins after R:R tie");

// Empty buffer
eq(selectTopN([], 3).winners.length, 0, "empty buffer = no winners");
eq(selectTopN(candidates, 0).winners.length, 0, "zero capacity = no winners");

// ───────────────────────────────────────────────────────────────────────
console.log("\n## loadPhaseCConfig");
const cfg = loadPhaseCConfig({
  deep_audit_phase_c_enabled: "true",
  deep_audit_phase_c_w_rank: "1.5",
  deep_audit_phase_c_fill_factor: "0.30",
});
eq(cfg.enabled, true, "enabled flag parsed");
eq(cfg.weights.rank, 1.5, "rank weight overridden");
eq(cfg.weights.conviction, 0.5, "conviction weight uses default");
eq(cfg.capacity.fill_factor, 0.30, "fill_factor overridden");
eq(cfg.capacity.hard_cap_per_bar, 8, "hard_cap_per_bar uses default");

// Disabled by default
const cfgDefault = loadPhaseCConfig({});
eq(cfgDefault.enabled, false, "phase_c disabled by default");

// ───────────────────────────────────────────────────────────────────────
console.log("\n## End-to-end: realistic LONG candidates");
const realCandidates = [
  // Top winner: clean setup, premium-stack, no divergence, volatile runner
  {
    ticker: "LITE",
    score: computeQualityScore({
      rank: 100, __focus_conviction_score: 80, rr: 3.0,
      __entry_direction: "LONG",
      __entry_setup_snapshot: { pdz: { D: "premium", h4: "premium" }, td_seq: { D: { bear_prep: 0 }, "240": { bear_prep: 2 } } },
      __entry_divergence_summary: { adverse_rsi: null, adverse_phase: null },
      ticker_character: { personality: "VOLATILE_RUNNER" },
    }),
    tickerData: { rank: 100 },
  },
  // Marginal: F4 severe divergence — should rank LOW
  {
    ticker: "BAD_F4",
    score: computeQualityScore({
      rank: 100, __focus_conviction_score: 90, rr: 2.5,
      __entry_direction: "LONG",
      __entry_setup_snapshot: { pdz: { D: "premium_approach" }, td_seq: { D: { bear_prep: 8 } } },
      __entry_divergence_summary: { adverse_rsi: { count: 1 }, adverse_phase: { count: 1 } },
      ticker_character: { personality: "PULLBACK_PLAYER" },
    }),
    tickerData: { rank: 100 },
  },
  // Mid-tier: ok setup, no boost
  {
    ticker: "MID",
    score: computeQualityScore({
      rank: 95, __focus_conviction_score: 70, rr: 2.0,
      __entry_direction: "LONG",
      __entry_setup_snapshot: { pdz: { D: "premium_approach" }, td_seq: {} },
      __entry_divergence_summary: { adverse_phase: { count: 1, strongest: { tf: "1h" } } },
    }),
    tickerData: { rank: 95 },
  },
];

console.log("  candidates:");
for (const c of realCandidates) {
  console.log(`    ${c.ticker.padEnd(7)} composite=${c.score.composite.toFixed(2)} (rank=${c.score.rank} conv=${c.score.conviction} div=${c.score.div_modifier} pdz=${c.score.pdz_modifier} td=${c.score.td_modifier} pers=${c.score.personality_mod})`);
}
const realSel = selectTopN(realCandidates, 1);
eq(realSel.winners[0].ticker, "LITE", "LITE (clean, premium-stack, runner) wins top-1");
eq(realSel.losers.find(c => c.ticker === "BAD_F4").reject_reason, "below_topn", "BAD_F4 (severe div) rejected");

// ───────────────────────────────────────────────────────────────────────
console.log("\n========================================");
console.log(`Tests: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  - ${f.label}\n      actual:   ${f.actual}\n      expected: ${f.expected}`);
  }
  process.exit(1);
}
process.exit(0);
