// scripts/phase-c-counterfactual-baseline.js
//
// Replay the entry-selector on the v16-baseline-ctx 101 trades and validate
// that the composite quality score discriminates winners from losers.
//
// This is a sanity check before any backtest — if the score doesn't separate
// wins from losses on data the engine actually entered, the design is wrong.
//
// Run: node scripts/phase-c-counterfactual-baseline.js

import fs from "node:fs";
import { computeQualityScore } from "../worker/pipeline/entry-selector.js";

const TRADES_PATH = "/workspace/data/trade-analysis/v16-baseline-ctx-jul-30m-1777485135/trades.json";

const data = JSON.parse(fs.readFileSync(TRADES_PATH, "utf8"));
const trades = data.trades || [];

// Build "candidate" objects from each trade's rank_trace_json.setup_snapshot.
// Note: we're using the snapshot AT ENTRY TIME — same as what Phase C would have.
function buildCandidate(trade) {
  let rt = {};
  try { rt = JSON.parse(trade.rank_trace_json || "{}"); } catch {}
  const snap = rt.setup_snapshot || {};
  const direction = String(trade.direction || "LONG").toUpperCase();

  // Reconstruct a tickerData-like object that computeQualityScore can read
  return {
    rank: trade.rank ?? rt.finalScore ?? 0,
    score: trade.rank ?? rt.finalScore ?? 0,
    rr: trade.rr ?? rt.rr ?? snap.rr ?? 0,
    direction,
    __entry_path: trade.entry_path,
    __entry_direction: direction,
    __focus_conviction_score: rt.focus_conviction_score ?? 0,
    __entry_setup_snapshot: snap,
    __entry_divergence_summary: snap.divergence,
    ticker_character: { personality: snap.ticker_personality || "" },
    _ticker_profile: { learning: { personality: snap.ticker_personality || "" } },
  };
}

const closed = trades.filter(t => t.status === "WIN" || t.status === "LOSS");
const scored = closed.map(t => {
  const td = buildCandidate(t);
  const s = computeQualityScore(td);
  return { ticker: t.ticker, status: t.status, pnl: t.pnl_pct, score: s, trade: t };
});

scored.sort((a, b) => b.score.composite - a.score.composite);

// Bucket by score range and report WR/PnL
const bucket = (s) => {
  if (s >= 150) return "150+";
  if (s >= 130) return "130-150";
  if (s >= 110) return "110-130";
  if (s >= 90)  return "90-110";
  if (s >= 70)  return "70-90";
  return "<70";
};

const buckets = {};
for (const r of scored) {
  const b = bucket(r.score.composite);
  if (!buckets[b]) buckets[b] = { trades: [], wins: 0, losses: 0, pnl: 0 };
  buckets[b].trades.push(r);
  if (r.status === "WIN") buckets[b].wins++;
  else buckets[b].losses++;
  buckets[b].pnl += r.pnl;
}

console.log("\n=== Composite Score Buckets — v16-baseline-ctx (101 trades, 67.3% WR) ===\n");
console.log("Bucket    | N   | Wins | Losses | WR%   | Avg PnL  | Total PnL");
console.log("----------|-----|------|--------|-------|----------|----------");
for (const b of ["150+", "130-150", "110-130", "90-110", "70-90", "<70"]) {
  const x = buckets[b];
  if (!x) continue;
  const wr = (x.wins / x.trades.length) * 100;
  const avg = x.pnl / x.trades.length;
  console.log(
    `${b.padEnd(9)} | ${String(x.trades.length).padStart(3)} | ${String(x.wins).padStart(4)} | ${String(x.losses).padStart(6)} | ${wr.toFixed(1).padStart(5)}% | ${avg.toFixed(2).padStart(7)}% | ${x.pnl.toFixed(2)}%`
  );
}

// Top decile / bottom decile
const top10 = scored.slice(0, Math.ceil(scored.length / 10));
const bot10 = scored.slice(-Math.ceil(scored.length / 10));
const stats = (arr) => ({
  n: arr.length,
  wins: arr.filter(r => r.status === "WIN").length,
  pnl: arr.reduce((s, r) => s + r.pnl, 0),
});
const t = stats(top10);
const b = stats(bot10);
console.log(`\nTop 10% (${t.n} trades): ${t.wins}W / ${t.n - t.wins}L = ${(t.wins / t.n * 100).toFixed(0)}% WR, PnL ${t.pnl.toFixed(2)}%`);
console.log(`Bot 10% (${b.n} trades): ${b.wins}W / ${b.n - b.wins}L = ${(b.wins / b.n * 100).toFixed(0)}% WR, PnL ${b.pnl.toFixed(2)}%`);

// Print top 10 best-scored trades
console.log("\n=== Top 10 by composite score ===");
console.log("Ticker  | Score   | rank conv  div   pdz   td   pers | Status | PnL    | Path");
for (const r of scored.slice(0, 10)) {
  const s = r.score;
  console.log(`${r.ticker.padEnd(7)} | ${s.composite.toFixed(2).padStart(7)} | ${String(s.rank).padStart(4)} ${String(s.conviction).padStart(4)} ${String(s.div_modifier).padStart(5)} ${String(s.pdz_modifier).padStart(5)} ${String(s.td_modifier).padStart(4)} ${String(s.personality_mod).padStart(5)} | ${r.status.padEnd(6)} | ${r.pnl.toFixed(2).padStart(6)}% | ${r.trade.entry_path}`);
}

console.log("\n=== Bottom 10 by composite score ===");
console.log("Ticker  | Score   | rank conv  div   pdz   td   pers | Status | PnL    | Path");
for (const r of scored.slice(-10)) {
  const s = r.score;
  console.log(`${r.ticker.padEnd(7)} | ${s.composite.toFixed(2).padStart(7)} | ${String(s.rank).padStart(4)} ${String(s.conviction).padStart(4)} ${String(s.div_modifier).padStart(5)} ${String(s.pdz_modifier).padStart(5)} ${String(s.td_modifier).padStart(4)} ${String(s.personality_mod).padStart(5)} | ${r.status.padEnd(6)} | ${r.pnl.toFixed(2).padStart(6)}% | ${r.trade.entry_path}`);
}

// What if we'd kept only the top X%?
console.log("\n=== Hypothetical: keep only top X% by composite score ===");
console.log("Cutoff   | N   | Wins | WR%   | PnL");
for (const pct of [100, 90, 80, 70, 60, 50, 40]) {
  const n = Math.round(scored.length * pct / 100);
  const sub = scored.slice(0, n);
  const w = sub.filter(r => r.status === "WIN").length;
  const pnl = sub.reduce((s, r) => s + r.pnl, 0);
  console.log(`top ${String(pct).padStart(3)}% | ${String(n).padStart(3)} | ${String(w).padStart(4)} | ${(w / n * 100).toFixed(1).padStart(5)}% | ${pnl.toFixed(2)}%`);
}
