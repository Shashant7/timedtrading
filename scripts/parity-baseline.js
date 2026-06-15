#!/usr/bin/env node
// scripts/parity-baseline.js
// ─────────────────────────────────────────────────────────────────────────────
//  FOUNDATION Phase 0 — measure & record live-vs-replay score divergence.
//
//  This is the operator runner for the baseline number the rebuild must drive
//  to zero (tasks/2026-06-14-foundation-rebuild-plan.md, Phase 0). It is a thin
//  shell around the PURE diff core in worker/foundation/parity.js — the math is
//  unit-tested there; this just plumbs two score maps in and writes a report.
//
//  It performs NO network mutation and reads nothing from live infrastructure on
//  its own — you hand it two JSON files. Produce them however your environment
//  allows (examples below), ideally from PRE-PROD or a LOCAL replay so nothing
//  touches live trade state.
//
//  USAGE:
//    node scripts/parity-baseline.js \
//      --live    data/parity/<date>-live.json \
//      --replay  data/parity/<date>-replay.json \
//      --date    2026-05-08 \
//      [--fields status,value,tier,components.sector,components.relative_strength] \
//      [--tolerance 0] \
//      [--out data/parity/<date>-baseline.json]
//
//  INPUT SHAPE (both files): { "<TICKER>": { status, value, tier, components? }, ... }
//  for the SAME as-of timestamp. See worker/foundation/__fixtures__/golden-day-sample.json.
//
//  HOW TO PRODUCE THE TWO SIDES (no live writes):
//   • replay side — run a focused/local replay for <date> on PRE-PROD or via
//     scripts/local-replay.js, then export per-ticker {status,value,tier} from
//     the run's scored payloads (rank_trace_json / focus_conviction_score).
//   • live side — capture the scores the live system recorded for <date>
//     (e.g. archived timed:latest / rank_trace_json on the trades created that
//     day). Read-only.
//  Until the rebuild lands, "status" will usually be absent on the live side
//  (the current engine emits a number even on stale input — that's the very gap
//  we are measuring); treat a present number as SCORABLE for the baseline.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { computeParityReport, summarizeParity } from "../worker/foundation/parity.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { out[key] = true; }
      else { out[key] = next; i++; }
    }
  }
  return out;
}

function loadMap(path, label) {
  if (!path || typeof path !== "string") {
    console.error(`ERROR: --${label} <file> is required`);
    process.exit(1);
  }
  if (!existsSync(path)) {
    console.error(`ERROR: --${label} file not found: ${path}`);
    process.exit(1);
  }
  let obj;
  try { obj = JSON.parse(readFileSync(path, "utf-8")); }
  catch (e) { console.error(`ERROR: --${label} is not valid JSON: ${e.message}`); process.exit(1); }
  // Tolerate a wrapper like { live: {...} } or { scores: {...} }.
  if (obj && typeof obj === "object" && (obj[label] || obj.scores)) obj = obj[label] || obj.scores;
  return obj || {};
}

const args = parseArgs(process.argv.slice(2));
const date = args.date || new Date().toISOString().slice(0, 10);
const fields = (typeof args.fields === "string" ? args.fields : "status,value,tier")
  .split(",").map((s) => s.trim()).filter(Boolean);
const tolerance = Number(args.tolerance) || 0;
const outPath = (typeof args.out === "string" && args.out) || join("data", "parity", `${date}-baseline.json`);

const live = loadMap(args.live, "live");
const replay = loadMap(args.replay, "replay");

const report = computeParityReport(live, replay, { fields, tolerance });
const envelope = {
  contract: "parity_baseline_v1",
  date,
  generated_at: new Date().toISOString(),
  fields,
  tolerance,
  inputs: { live: args.live, replay: args.replay },
  report,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(envelope, null, 2) + "\n");

console.log(summarizeParity(report));
console.log(`baseline written: ${outPath}`);
if (!report.identical) {
  console.log(`\nTop divergences (first 20):`);
  for (const d of report.divergent.slice(0, 20)) {
    console.log(`  ${d.ticker.padEnd(8)} ${d.field.padEnd(24)} live=${JSON.stringify(d.live)} replay=${JSON.stringify(d.replay)}`);
  }
}
// Non-zero exit signals divergence, so this can gate CI once the rebuild lands.
process.exit(report.identical ? 0 : 1);
