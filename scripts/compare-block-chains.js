#!/usr/bin/env node

/**
 * scripts/compare-block-chains.js — Phase D redistribution analyzer.
 *
 * Consumes two `block_chain.jsonl` files produced by
 * `scripts/monthly-slice.sh --block-chain`, matches rejected bars by
 * `(ticker, ts)`, and emits the `(reason_before, reason_after)`
 * transition matrix. This is the single tool that answers the question
 * the aggregated `blockReasons` counter cannot: "if we relax gate X,
 * what gate fires next on the same bars?"
 *
 * Usage:
 *   node scripts/compare-block-chains.js \
 *     --baseline data/trade-analysis/<baseline_run_id>/block_chain.jsonl \
 *     --challenger data/trade-analysis/<challenger_run_id>/block_chain.jsonl \
 *     [--out data/trade-analysis/<challenger_run_id>/block_chain_summary.md]
 *     [--cohort etf:SPY,QQQ,IWM,XLY] [--cohort t1_stocks:AAPL,MSFT,...]
 *     [--top N]                                      (default 20)
 *     [--min-transition N]                           (default 1)
 *
 * A bar is a "net pass" if it appears in the baseline (blocked) but NOT
 * in the challenger (either the challenger passed it into entry or it
 * was blocked before the blockChainBars collector ran — in practice the
 * former, since both runs use the same `blockChainTrace` instrumentation).
 *
 * Output sections:
 *   1. Summary: total rejected bars baseline / challenger / intersection.
 *   2. Transition matrix: for each top (reason_before, reason_after),
 *      count how many bars moved.
 *   3. Net passes per ticker cohort: how many bars newly passed all
 *      gates in the challenger relative to the baseline.
 *   4. Net new blocks per reason: reasons that *increased* under the
 *      challenger (a red flag — the proposal is introducing new
 *      rejections).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    baseline: null,
    challenger: null,
    out: null,
    cohorts: [],
    top: 20,
    minTransition: 1,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case "--baseline":
      case "--base":
        out.baseline = argv[++i];
        break;
      case "--challenger":
      case "--chal":
        out.challenger = argv[++i];
        break;
      case "--out":
        out.out = argv[++i];
        break;
      case "--cohort":
        out.cohorts.push(argv[++i]);
        break;
      case "--top":
        out.top = Number(argv[++i]);
        break;
      case "--min-transition":
        out.minTransition = Number(argv[++i]);
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: compare-block-chains.js --baseline FILE --challenger FILE [--out FILE] [--cohort name:TICKERS] ...",
        );
        process.exit(0);
        break;
      default:
        if (a.startsWith("--baseline=")) out.baseline = a.slice("--baseline=".length);
        else if (a.startsWith("--challenger=")) out.challenger = a.slice("--challenger=".length);
        else if (a.startsWith("--out=")) out.out = a.slice("--out=".length);
        else if (a.startsWith("--cohort=")) out.cohorts.push(a.slice("--cohort=".length));
        else if (a.startsWith("--top=")) out.top = Number(a.slice("--top=".length));
        else if (a.startsWith("--min-transition=")) out.minTransition = Number(a.slice("--min-transition=".length));
    }
  }
  return out;
}

function die(msg, code = 2) {
  console.error(`compare-block-chains: ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

async function loadJsonl(file) {
  const rows = [];
  const errors = [];
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      errors.push({ line: lineNo, error: String(err?.message || err) });
    }
  }
  return { rows, errors };
}

function parseCohorts(cohortArgs) {
  const cohorts = [];
  for (const raw of cohortArgs) {
    const colon = raw.indexOf(":");
    if (colon <= 0) {
      console.warn(`skipping invalid --cohort "${raw}" (expected name:TICKERS)`);
      continue;
    }
    const name = raw.slice(0, colon).trim();
    const tickers = new Set(
      raw
        .slice(colon + 1)
        .split(",")
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean),
    );
    if (!name || tickers.size === 0) continue;
    cohorts.push({ name, tickers });
  }
  // Always provide an implicit "all" cohort so a bare run still has a
  // baseline summary.
  cohorts.push({ name: "all", tickers: null });
  return cohorts;
}

function cohortOf(cohorts, ticker) {
  const up = String(ticker || "").toUpperCase();
  for (const c of cohorts) {
    if (!c.tickers) continue;
    if (c.tickers.has(up)) return c.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core: index + transition
// ---------------------------------------------------------------------------

function indexByBarKey(rows) {
  // Key = `${ticker}|${ts}`. If a ticker×ts pair has multiple rows (possible
  // if the worker emits more than one block per bar — shouldn't happen in
  // the current pipeline but we guard anyway) we keep the first occurrence.
  const idx = new Map();
  for (const r of rows) {
    if (!r?.ticker || !r?.ts) continue;
    const key = `${r.ticker}|${r.ts}`;
    if (!idx.has(key)) idx.set(key, r);
  }
  return idx;
}

function buildCounter() {
  return new Map();
}

function bump(counter, key, n = 1) {
  counter.set(key, (counter.get(key) || 0) + n);
}

function topN(counter, n) {
  return [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmtRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

function renderReport({
  baselinePath,
  challengerPath,
  baselineRows,
  challengerRows,
  cohorts,
  top,
  minTransition,
}) {
  const lines = [];
  lines.push("# Block-chain comparison");
  lines.push("");
  lines.push("- **Baseline:** " + "`" + baselinePath + "`");
  lines.push("- **Challenger:** " + "`" + challengerPath + "`");
  lines.push(`- Baseline rejected bars: **${baselineRows.length.toLocaleString()}**`);
  lines.push(`- Challenger rejected bars: **${challengerRows.length.toLocaleString()}**`);
  lines.push(
    `- Delta: **${(challengerRows.length - baselineRows.length).toLocaleString()}** (negative means challenger rejects fewer bars; positive means more)`,
  );
  lines.push("");

  const baseIdx = indexByBarKey(baselineRows);
  const chalIdx = indexByBarKey(challengerRows);
  const baseKeys = new Set(baseIdx.keys());
  const chalKeys = new Set(chalIdx.keys());
  const intersect = [...baseKeys].filter((k) => chalKeys.has(k));
  const baseOnly = [...baseKeys].filter((k) => !chalKeys.has(k));
  const chalOnly = [...chalKeys].filter((k) => !baseKeys.has(k));
  lines.push(`## Bar coverage`);
  lines.push("");
  lines.push(`- Bars rejected by both: **${intersect.length.toLocaleString()}**`);
  lines.push(`- Bars rejected by baseline only (challenger **passed** these): **${baseOnly.length.toLocaleString()}**`);
  lines.push(`- Bars rejected by challenger only (newly blocked): **${chalOnly.length.toLocaleString()}**`);
  lines.push("");

  // ---------------------------------------------------------------------
  // Transition matrix (baseline.reason -> challenger.reason | passed)
  // ---------------------------------------------------------------------
  const transitions = buildCounter();
  for (const key of baseKeys) {
    const b = baseIdx.get(key);
    const c = chalIdx.get(key);
    const before = b?.reason || "UNKNOWN";
    const after = c?.reason || "__PASSED__";
    bump(transitions, `${before}\t${after}`);
  }
  lines.push("## Transition matrix (top)");
  lines.push("");
  lines.push(`Counts the (baseline_reason, challenger_reason) pairs. \`__PASSED__\` means the bar cleared all gates in the challenger.`);
  lines.push(`Only transitions with count ≥ ${minTransition} are shown; top ${top}.`);
  lines.push("");
  lines.push(fmtRow(["baseline_reason", "challenger_reason", "count"]));
  lines.push(fmtRow(["---", "---", "---:"]));
  for (const [key, count] of topN(transitions, top)) {
    if (count < minTransition) break;
    const [before, after] = key.split("\t");
    lines.push(fmtRow([before, after === "__PASSED__" ? "**__PASSED__**" : after, count.toString()]));
  }
  lines.push("");

  // ---------------------------------------------------------------------
  // Per-cohort summary: how many bars newly pass per cohort.
  // ---------------------------------------------------------------------
  lines.push("## Per-cohort redistribution");
  lines.push("");
  lines.push(fmtRow(["cohort", "baseline_rejected", "challenger_rejected", "newly_passed", "newly_blocked"]));
  lines.push(fmtRow(["---", "---:", "---:", "---:", "---:"]));
  for (const cohort of cohorts) {
    const baseIn = baselineRows.filter((r) => (cohort.tickers ? cohort.tickers.has(String(r.ticker || "").toUpperCase()) : true));
    const chalIn = challengerRows.filter((r) => (cohort.tickers ? cohort.tickers.has(String(r.ticker || "").toUpperCase()) : true));
    const baseInKeys = new Set(baseIn.map((r) => `${r.ticker}|${r.ts}`));
    const chalInKeys = new Set(chalIn.map((r) => `${r.ticker}|${r.ts}`));
    const newlyPassed = [...baseInKeys].filter((k) => !chalInKeys.has(k)).length;
    const newlyBlocked = [...chalInKeys].filter((k) => !baseInKeys.has(k)).length;
    lines.push(
      fmtRow([
        cohort.name,
        baseIn.length.toLocaleString(),
        chalIn.length.toLocaleString(),
        newlyPassed.toLocaleString(),
        newlyBlocked.toLocaleString(),
      ]),
    );
  }
  lines.push("");

  // ---------------------------------------------------------------------
  // Reason-level delta (net change in total blocks per reason).
  // ---------------------------------------------------------------------
  const baseReasons = buildCounter();
  const chalReasons = buildCounter();
  for (const r of baselineRows) bump(baseReasons, r.reason || "UNKNOWN");
  for (const r of challengerRows) bump(chalReasons, r.reason || "UNKNOWN");
  const allReasons = new Set([...baseReasons.keys(), ...chalReasons.keys()]);
  const deltaRows = [];
  for (const reason of allReasons) {
    const b = baseReasons.get(reason) || 0;
    const c = chalReasons.get(reason) || 0;
    deltaRows.push({ reason, baseline: b, challenger: c, delta: c - b });
  }
  deltaRows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  lines.push("## Net reason deltas (challenger − baseline)");
  lines.push("");
  lines.push(`Negative = challenger blocks fewer bars on this reason (good if the proposal is meant to relax it). Positive = challenger blocks more (either the proposal is introducing a new gate or the bars that used to be rejected earlier in the chain are now falling through to this gate).`);
  lines.push("");
  lines.push(fmtRow(["reason", "baseline", "challenger", "delta"]));
  lines.push(fmtRow(["---", "---:", "---:", "---:"]));
  for (const row of deltaRows.slice(0, top)) {
    const sign = row.delta > 0 ? `+${row.delta}` : `${row.delta}`;
    lines.push(fmtRow([row.reason, row.baseline.toString(), row.challenger.toString(), sign]));
  }
  lines.push("");

  // ---------------------------------------------------------------------
  // Footer: how to interpret.
  // ---------------------------------------------------------------------
  lines.push("## How to interpret");
  lines.push("");
  lines.push("- **Large `__PASSED__` counts for a specific baseline_reason** = the proposal successfully unblocked those bars at all downstream gates too. This is the signal we want.");
  lines.push("- **Large transitions into a *different* reason** = the proposal only shifted bars from one gate to another; the `newly_passed` column will be small for the cohort and the proposal is *symptomatic*, not causal (the T6 failure mode).");
  lines.push("- **Positive `delta` on a reason that wasn't touched by the proposal** = the proposal's upstream relaxation sent bars down-chain and they're getting caught there. Consider proposing a joint relaxation.");
  lines.push("- **newly_blocked > 0 in any cohort** = the proposal introduced new rejections. Investigate before merging.");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.baseline) die("missing --baseline FILE");
  if (!args.challenger) die("missing --challenger FILE");
  if (!fs.existsSync(args.baseline)) die(`baseline not found: ${args.baseline}`);
  if (!fs.existsSync(args.challenger)) die(`challenger not found: ${args.challenger}`);

  const cohorts = parseCohorts(args.cohorts);

  const [b, c] = await Promise.all([loadJsonl(args.baseline), loadJsonl(args.challenger)]);
  if (b.errors.length) {
    console.warn(`baseline parse: ${b.errors.length} lines failed`);
  }
  if (c.errors.length) {
    console.warn(`challenger parse: ${c.errors.length} lines failed`);
  }

  const report = renderReport({
    baselinePath: args.baseline,
    challengerPath: args.challenger,
    baselineRows: b.rows,
    challengerRows: c.rows,
    cohorts,
    top: args.top,
    minTransition: args.minTransition,
  });

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, report);
    console.log(`wrote ${args.out}`);
  } else {
    process.stdout.write(report);
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
