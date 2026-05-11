#!/usr/bin/env node
/**
 * Phase 3.9d — Investor Mode config-tuning smoke test.
 *
 * Pure-function tests for loadInvestorConfig + classifyInvestorStage
 * threshold tunability. Validates that:
 *   1. Defaults match the doc'd values (post-Phase-3.9d: strong=65)
 *   2. daCfg overrides apply with bounds-checking
 *   3. End-to-end gate behavior changes when overrides flip thresholds
 *
 * Run: `node scripts/test-investor-config.js`
 */

import {
  DEFAULT_INVESTOR_CONFIG,
  loadInvestorConfig,
  classifyInvestorStage,
  detectAccumulationZone,
} from "../worker/investor.js";

let pass = 0, fail = 0;
const log = [];

function t(name, fn) {
  try { fn(); pass++; log.push(`  PASS  ${name}`); }
  catch (e) { fail++; log.push(`  FAIL  ${name}\n         ${e.message}`); }
}

function expect(actual, op, expected, label) {
  const ops = {
    "==": () => actual === expected,
    "!=": () => actual !== expected,
    ">=": () => actual >= expected,
    "<=": () => actual <= expected,
  };
  if (!ops[op] || !ops[op]()) {
    throw new Error(`${label}: expected ${op} ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Minimal tickerData fixture — enough for classifyInvestorStage to run
// the no-position branch without throwing.
const fxTickerData = () => ({
  monthly_bundle: { supertrend_dir: -1 }, // PINE bull → no monthly_bear early-exit
  tf_tech: { W: { atr: { xs: 1 } } },     // weekly ST bull (STD convention)
  regimeVocabulary: null,
  regime_class: "TRENDING",
  ichimoku_w: null,
  rsi_divergence: null,
});

// ─────────────────────────────────────────────────────────────────────
// loadInvestorConfig defaults
// ─────────────────────────────────────────────────────────────────────
t("loadInvestorConfig: default matches Phase 3.9d (strong=65)", () => {
  const cfg = loadInvestorConfig({});
  expect(cfg.accumulate_strong_score_min, "==", 65, "strong_score_min");
  expect(cfg.accumulate_inzone_score_min, "==", 30, "inzone_score_min");
  expect(cfg.watch_score_min, "==", 50, "watch_score_min");
  expect(cfg.research_on_watch_score_min, "==", 40, "research_on_watch_min");
});

t("loadInvestorConfig: null daCfg returns defaults", () => {
  const cfg = loadInvestorConfig(null);
  expect(cfg.accumulate_strong_score_min, "==", DEFAULT_INVESTOR_CONFIG.accumulate_strong_score_min, "strong=default");
});

// ─────────────────────────────────────────────────────────────────────
// daCfg override semantics
// ─────────────────────────────────────────────────────────────────────
t("loadInvestorConfig: deep_audit_investor_accumulate_strong_score_min override", () => {
  const cfg = loadInvestorConfig({ deep_audit_investor_accumulate_strong_score_min: 70 });
  expect(cfg.accumulate_strong_score_min, "==", 70, "override applied");
});

t("loadInvestorConfig: deep_audit_investor_watch_score_min override", () => {
  const cfg = loadInvestorConfig({ deep_audit_investor_watch_score_min: 55 });
  expect(cfg.watch_score_min, "==", 55, "watch override");
});

t("loadInvestorConfig: deep_audit_investor_research_on_watch_score_min override", () => {
  const cfg = loadInvestorConfig({ deep_audit_investor_research_on_watch_score_min: 35 });
  expect(cfg.research_on_watch_score_min, "==", 35, "research override");
});

// Bounds-checking
t("loadInvestorConfig: rejects out-of-range strong score (<=0)", () => {
  const cfg = loadInvestorConfig({ deep_audit_investor_accumulate_strong_score_min: 0 });
  expect(cfg.accumulate_strong_score_min, "==", DEFAULT_INVESTOR_CONFIG.accumulate_strong_score_min, "rejected; default kept");
});

t("loadInvestorConfig: rejects out-of-range strong score (>=100)", () => {
  const cfg = loadInvestorConfig({ deep_audit_investor_accumulate_strong_score_min: 101 });
  expect(cfg.accumulate_strong_score_min, "==", DEFAULT_INVESTOR_CONFIG.accumulate_strong_score_min, "rejected; default kept");
});

t("loadInvestorConfig: rejects non-numeric override", () => {
  const cfg = loadInvestorConfig({ deep_audit_investor_accumulate_strong_score_min: "not-a-number" });
  expect(cfg.accumulate_strong_score_min, "==", DEFAULT_INVESTOR_CONFIG.accumulate_strong_score_min, "rejected; default kept");
});

// ─────────────────────────────────────────────────────────────────────
// End-to-end: gating actually changes when threshold changes
// ─────────────────────────────────────────────────────────────────────
t("classifyInvestorStage: score=66 → ACCUMULATE under default (65)", () => {
  const td = fxTickerData();
  const result = classifyInvestorStage(td, 66, null, { marketHealth: 50, accumZone: null });
  expect(result.stage, "==", "accumulate", "stage=accumulate at 66");
});

t("classifyInvestorStage: score=66 → WATCH when threshold raised to 70", () => {
  const td = fxTickerData();
  const cfg = loadInvestorConfig({ deep_audit_investor_accumulate_strong_score_min: 70 });
  const result = classifyInvestorStage(td, 66, null, { marketHealth: 50, accumZone: null, cfg });
  expect(result.stage, "==", "watch", "stage=watch when threshold=70");
});

t("classifyInvestorStage: score=64 → WATCH under default 65", () => {
  // 64 < 65 → no strong-score accumulate; 64 >= 50 → watch (not accumulate).
  const td = fxTickerData();
  const result = classifyInvestorStage(td, 64, null, { marketHealth: 50, accumZone: null });
  expect(result.stage, "==", "watch", "stage=watch at 64");
});

t("classifyInvestorStage: score=70 → ACCUMULATE both pre and post Phase 3.9d", () => {
  const td = fxTickerData();
  const result = classifyInvestorStage(td, 70, null, { marketHealth: 50, accumZone: null });
  expect(result.stage, "==", "accumulate", "stage=accumulate at 70");
});

t("classifyInvestorStage: marketHealth=30 still blocks strong-score accumulate", () => {
  const td = fxTickerData();
  const result = classifyInvestorStage(td, 80, null, { marketHealth: 30, accumZone: null });
  // marketHealth gate at 40 unchanged — should fall through to watch
  expect(result.stage, "==", "watch", "stage=watch when marketHealth too low");
});

t("classifyInvestorStage: in-zone path still accumulates at score 30+ marketHealth 30+", () => {
  const td = fxTickerData();
  const accumZone = { inZone: true, zoneType: "test_zone", confidence: 80 };
  const result = classifyInvestorStage(td, 30, null, { marketHealth: 30, accumZone });
  expect(result.stage, "==", "accumulate", "in-zone accumulate at 30/30");
});

// ─────────────────────────────────────────────────────────────────────
// Phase 3.9e — detectAccumulationZone momentum-runner branch
// ─────────────────────────────────────────────────────────────────────

// Fixture: a healthy mid-trend SNDK profile — above weekly+daily EMA21,
// monthly bull, weekly RSI in 65 (healthy zone), weekly ST bull.
// Pre-Phase-3.9e this would have inZone=false, confidence=0.
const fxMomentumRunnerTd = () => ({
  ticker: "SNDK",
  price: 200,
  monthly_bundle: { supertrend_dir: -1, ema_structure: 0.7, rsi: 60, ema_depth: 6 },
  tf_tech: {
    W: {
      ema: { priceAboveEma21: true, depth: 5 },
      atr: { xs: 1 },                 // weekly ST bull (STD)
      rsi: { r5: 65 },                // healthy mid-trend
    },
    D: {
      ema: { priceAboveEma21: true, depth: 4 },
      stDir: -1,                      // daily ST bull (Pine)
      rsi: { r5: 60 },
    },
  },
  ema_map: { W: { depth: 5, structure: 0.6 } },
  td_sequential: { per_tf: { W: { bullish_prep_count: 0, bearish_prep_count: 4 } } },
});

t("detectAccumulationZone: momentum-runner profile fires (Phase 3.9e default)", () => {
  const z = detectAccumulationZone(fxMomentumRunnerTd());
  expect(z.inZone, "==", true, "inZone");
  expect(z.zoneType, "==", "momentum_runner", "zoneType");
});

t("detectAccumulationZone: weekly RSI=92 (above max 88) → momentum-runner does NOT fire on RSI signal", () => {
  const td = fxMomentumRunnerTd();
  td.tf_tech.W.rsi.r5 = 92; // exhausted
  const z = detectAccumulationZone(td);
  // Without weekly_rsi_healthy signal, count drops 6→5 (still has 4+ from
  // the other criteria), confidence still high. Should still fire.
  expect(z.inZone, "==", true, "still fires on momentum-runner with hot RSI");
  expect(z.signals.includes("weekly_rsi_healthy"), "==", false, "rsi signal dropped");
});

t("detectAccumulationZone: oversold profile bypasses momentum-runner branch", () => {
  // weekly EMA21 below + RSI < 35 → momentum-runner doesn't fire,
  // existing oversold branch can still fire if other signals present.
  const td = fxMomentumRunnerTd();
  td.tf_tech.W.ema.priceAboveEma21 = false;
  td.tf_tech.D.ema.priceAboveEma21 = false;
  td.tf_tech.W.rsi.r5 = 30;
  td.tf_tech.W.atr.xs = -1;
  td.tf_tech.D.stDir = 1; // bear (Pine +1)
  const z = detectAccumulationZone(td);
  expect(z.zoneType, "!=", "momentum_runner", "not momentum-runner");
});

t("detectAccumulationZone: momentum-runner branch can be disabled via config", () => {
  const cfg = loadInvestorConfig({ deep_audit_investor_accum_zone_momentum_runner_enabled: "false" });
  expect(cfg.accum_zone_momentum_runner_enabled, "==", false, "disabled via config");
  const z = detectAccumulationZone(fxMomentumRunnerTd(), cfg);
  expect(z.zoneType, "!=", "momentum_runner", "branch disabled — no momentum-runner zone");
});

t("detectAccumulationZone: stricter min_signals=6 fails on borderline runner", () => {
  const td = fxMomentumRunnerTd();
  td.tf_tech.D.stDir = 0; // drop one criterion (daily ST not bull)
  const cfgStrict = loadInvestorConfig({
    deep_audit_investor_accum_zone_momentum_runner_min_signals: 6, // require all 6
  });
  const z = detectAccumulationZone(td, cfgStrict);
  expect(z.zoneType, "!=", "momentum_runner", "strict gate rejects borderline");
});

t("detectAccumulationZone: tunable RSI band — restrict 60-70 → 65-RSI passes, 55 fails", () => {
  const cfgTight = loadInvestorConfig({
    deep_audit_investor_accum_zone_momentum_runner_weekly_rsi_min: 60,
    deep_audit_investor_accum_zone_momentum_runner_weekly_rsi_max: 70,
  });
  const td = fxMomentumRunnerTd();
  td.tf_tech.W.rsi.r5 = 65;
  let z = detectAccumulationZone(td, cfgTight);
  expect(z.signals.includes("weekly_rsi_healthy"), "==", true, "65 in 60-70 band");
  td.tf_tech.W.rsi.r5 = 55;
  z = detectAccumulationZone(td, cfgTight);
  expect(z.signals.includes("weekly_rsi_healthy"), "==", false, "55 outside 60-70 band");
});

// ─────────────────────────────────────────────────────────────────────
// Print summary
// ─────────────────────────────────────────────────────────────────────
console.log(log.join("\n"));
console.log("---");
console.log(`PASS: ${pass}  FAIL: ${fail}  TOTAL: ${pass + fail}`);
if (fail > 0) process.exit(1);
