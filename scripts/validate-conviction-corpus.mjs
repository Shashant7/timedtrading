#!/usr/bin/env node
/**
 * Slice E — validate the conviction fusion lever on the EXISTING corpus.
 *
 * Runs the REAL fuseConviction() logic over the 362-trade backtest corpus
 * (already enriched with per-trade pattern_profile + outcome + pnl_pct) and
 * the 211 missed-move corpus, with a walk-forward (in-sample / out-of-sample)
 * split. No wrangler/D1 — pure cache replay, so it is fast and reproducible.
 *
 * Note: the cache carries the confirm-stack gate inputs (pattern_profile) and
 * MR sequence, but NOT focus_conviction / daily-EMA21 — so this is a LOWER
 * BOUND on the fusion's selectivity (those terms are neutral here; live data
 * differentiates more). It directly tests the promotable edge term.
 *
 * Usage: node scripts/validate-conviction-corpus.mjs
 */
import fs from "node:fs";
import { evaluateGateOnProfile } from "../worker/foundation/setup-replay-mining.js";
import { fuseConviction } from "../worker/conviction.js";

const BACKTEST = "data/setup-mining/pattern-lift/backtest-enriched.json";
const MISSED = "data/setup-mining/pattern-lift/missed-enriched.json";
const OUT_DIR = "data/setup-mining/conviction-validation";

function load(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

// Build a minimal tickerData that fuseConviction understands, from a cache row.
function tickerDataFromRow(row) {
  const profile = row.pattern_profile || {};
  const dir = String(row.direction || "").toUpperCase();
  const confirmStack = evaluateGateOnProfile(profile, "stack_full_confirm");
  const runwayFull = evaluateGateOnProfile(profile, "gate_runway_full");
  // Reconstruct MR sequences from the profile's per-direction stage fields so
  // the wrong-way veto can fire (cache `sequence` is often null on backtest).
  const seqs = [];
  if (Number(profile.long_mr_stage) > 0) {
    seqs.push({ direction: "LONG", stage: Number(profile.long_mr_stage), status: String(profile.long_mr_status || "forming") });
  }
  if (Number(profile.short_mr_stage) > 0) {
    seqs.push({ direction: "SHORT", stage: Number(profile.short_mr_stage), status: String(profile.short_mr_status || "forming") });
  }
  return {
    trigger_dir: dir,
    setup_gates: {
      stack_full_confirm: { fires: confirmStack },
      gate_runway_full: { fires: runwayFull },
    },
    setup_sequences: seqs,
  };
}

function isWin(row) { return String(row.outcome || "").toLowerCase() === "win"; }
function pnl(row) { const v = Number(row.pnl_pct); return Number.isFinite(v) ? v : 0; }

function stats(rows) {
  const n = rows.length;
  if (!n) return { n: 0, wr: null, mean: null, sqn: null };
  const wins = rows.filter(isWin).length;
  const pnls = rows.map(pnl);
  const mean = pnls.reduce((a, b) => a + b, 0) / n;
  const variance = pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const sqn = std > 0 ? (mean / std) * Math.sqrt(n) : 0;
  return {
    n,
    wr: Math.round((wins / n) * 1000) / 10,
    mean: Math.round(mean * 1000) / 1000,
    sqn: Math.round(sqn * 100) / 100,
  };
}

function fmt(label, s) {
  return `${label.padEnd(26)} n=${String(s.n).padStart(3)}  WR=${s.wr == null ? "—" : (s.wr + "%").padStart(6)}  meanPnl=${s.mean == null ? "—" : String(s.mean).padStart(7)}  SQN=${s.sqn == null ? "—" : String(s.sqn).padStart(6)}`;
}

// ── Backtest corpus ──────────────────────────────────────────────────────
const trades = load(BACKTEST).map((r) => ({ ...r, _conv: fuseConviction(tickerDataFromRow(r), { direction: r.direction }), _confirm: evaluateGateOnProfile(r.pattern_profile || {}, "stack_full_confirm") }));
trades.sort((a, b) => (Number(a.entry_ts) || 0) - (Number(b.entry_ts) || 0));

const baseline = stats(trades);
const confirmFired = stats(trades.filter((t) => t._confirm));
const confirmNot = stats(trades.filter((t) => !t._confirm));
const tierA = stats(trades.filter((t) => t._conv.tier === "A"));
const tierB = stats(trades.filter((t) => t._conv.tier === "B"));
const tierC = stats(trades.filter((t) => t._conv.tier === "C"));

// Walk-forward 75/25 by entry_ts.
const split = Math.floor(trades.length * 0.75);
const inSample = trades.slice(0, split);
const outSample = trades.slice(split);
const isConfirm = stats(inSample.filter((t) => t._confirm));
const oosConfirm = stats(outSample.filter((t) => t._confirm));
const isBase = stats(inSample);
const oosBase = stats(outSample);

// ── Missed corpus (capture opportunity) ─────────────────────────────────
const misses = load(MISSED);
const tierAmisses = misses.filter((m) => Number(m.move_atr) >= 8);
const confirmCatch = misses.filter((m) => evaluateGateOnProfile(m.pattern_profile || {}, "stack_full_confirm"));
const confirmCatchTierA = tierAmisses.filter((m) => evaluateGateOnProfile(m.pattern_profile || {}, "stack_full_confirm"));

// ── Verdict against promotion gates ──────────────────────────────────────
const GATE_MIN_N = 30;
const oosHoldsRatio = (isConfirm.sqn && oosConfirm.sqn) ? oosConfirm.sqn / isConfirm.sqn : null;
const checks = {
  gate_fired_n_oos: { value: oosConfirm.n, pass: oosConfirm.n >= GATE_MIN_N, want: `>=${GATE_MIN_N}` },
  confirm_beats_baseline_wr: { value: confirmFired.wr, base: baseline.wr, pass: confirmFired.wr != null && confirmFired.wr > baseline.wr, want: `> baseline ${baseline.wr}%` },
  confirm_positive_expectancy: { value: confirmFired.mean, pass: confirmFired.mean > 0, want: "> 0" },
  oos_sqn_holds_70pct: { value: oosHoldsRatio == null ? null : Math.round(oosHoldsRatio * 100) / 100, pass: oosHoldsRatio != null && oosHoldsRatio >= 0.7, want: ">= 0.70 of in-sample" },
  tierA_beats_tierC_wr: { value: [tierA.wr, tierC.wr], pass: tierA.wr != null && tierC.wr != null && tierA.wr > tierC.wr, want: "Tier A WR > Tier C WR" },
};
const allPass = Object.values(checks).every((c) => c.pass);

// ── Report ───────────────────────────────────────────────────────────────
const lines = [];
lines.push("# Conviction Fusion — Corpus Validation (Slice E)");
lines.push("");
lines.push(`Backtest corpus: ${trades.length} trades (${load(BACKTEST).length} enriched). Missed corpus: ${misses.length} (Tier A move_atr>=8: ${tierAmisses.length}).`);
lines.push("Caveat: focus_conviction + daily-EMA21 not in cache => neutral here (lower bound on selectivity).");
lines.push("");
lines.push("## Backtest outcomes");
lines.push("```");
lines.push(fmt("BASELINE (all)", baseline));
lines.push(fmt("confirm_stack FIRED", confirmFired));
lines.push(fmt("confirm_stack NOT fired", confirmNot));
lines.push(fmt("conviction Tier A", tierA));
lines.push(fmt("conviction Tier B", tierB));
lines.push(fmt("conviction Tier C", tierC));
lines.push("```");
lines.push("");
lines.push("## Walk-forward (75/25 by entry_ts)");
lines.push("```");
lines.push(fmt("in-sample  BASELINE", isBase));
lines.push(fmt("in-sample  confirm FIRED", isConfirm));
lines.push(fmt("out-sample BASELINE", oosBase));
lines.push(fmt("out-sample confirm FIRED", oosConfirm));
lines.push("```");
lines.push("");
lines.push("## Missed-move capture opportunity");
lines.push("```");
lines.push(`all misses confirm_stack would flag:    ${confirmCatch.length} / ${misses.length} (${(100 * confirmCatch.length / misses.length).toFixed(1)}%)`);
lines.push(`Tier-A misses confirm_stack would flag: ${confirmCatchTierA.length} / ${tierAmisses.length} (${tierAmisses.length ? (100 * confirmCatchTierA.length / tierAmisses.length).toFixed(1) : "0"}%)`);
lines.push("```");
lines.push("");
lines.push("## Verdict vs promotion gates");
lines.push("```");
for (const [k, c] of Object.entries(checks)) {
  lines.push(`${c.pass ? "PASS" : "FAIL"}  ${k.padEnd(28)} value=${JSON.stringify(c.value)} want ${c.want}`);
}
lines.push("");
lines.push(`OVERALL: ${allPass ? "PASS — eligible to flip deep_audit_conviction_fusion_enabled (live small under governor)" : "PARTIAL — do NOT flip live yet; see failing checks"}`);
lines.push("```");

const report = lines.join("\n");
console.log(report);

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifact = {
  generated_at: new Date().toISOString(),
  backtest: { baseline, confirmFired, confirmNot, tierA, tierB, tierC },
  walk_forward: { inSampleBaseline: isBase, inSampleConfirm: isConfirm, outSampleBaseline: oosBase, outSampleConfirm: oosConfirm, oosHoldsRatio },
  misses: { total: misses.length, tierA: tierAmisses.length, confirmCatch: confirmCatch.length, confirmCatchTierA: confirmCatchTierA.length },
  checks,
  overall_pass: allPass,
};
fs.writeFileSync(`${OUT_DIR}/validation-${stamp}.json`, JSON.stringify(artifact, null, 2));
fs.writeFileSync(`${OUT_DIR}/latest.md`, report + "\n");
console.log(`\nArtifacts: ${OUT_DIR}/validation-${stamp}.json + latest.md`);
