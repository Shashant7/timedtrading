#!/usr/bin/env node
// Analyze LuxAlgo Sequencer numeric export companion CSVs against the current
// worker TD Sequential lead-up semantics.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INPUT = path.join(ROOT, "TV Exports/indicator-parity/lux-sequencer");
const DEFAULT_REPORT = path.join(ROOT, "TV Exports/indicator-parity/lux-sequencer-analysis-report.json");

function parseArgs(argv) {
  const args = { input: DEFAULT_INPUT, report: DEFAULT_REPORT, sampleRows: 40 };
  for (const a of argv) {
    if (a.startsWith("--input=")) args.input = path.resolve(ROOT, a.slice("--input=".length));
    else if (a.startsWith("--report=")) args.report = path.resolve(ROOT, a.slice("--report=".length));
    else if (a.startsWith("--sample-rows=")) args.sampleRows = Number(a.slice("--sample-rows=".length)) || args.sampleRows;
  }
  return args;
}

function n(v) {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function readCsv(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\n/).filter((line) => line.trim() !== "");
  const headers = lines[0].replace(/\r$/, "").split(",");
  return lines.slice(1).map((line) => {
    const vals = line.replace(/\r$/, "").split(",");
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i]; });
    return row;
  });
}

function listCsvFiles(dir) {
  return fs.readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".csv"))
    .map((name) => path.join(dir, name))
    .sort();
}

function computeWorkerTd(rows) {
  let bullPrep = 0;
  let bearPrep = 0;
  let bullLead = 0;
  let bearLead = 0;
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const c = n(rows[i].close);
    if (i >= 4 && c != null) {
      const c4 = n(rows[i - 4].close);
      bullPrep = c4 != null && c < c4 ? bullPrep + 1 : 0;
      bearPrep = c4 != null && c > c4 ? bearPrep + 1 : 0;
      const bullComplete = bullPrep === 9;
      const bearComplete = bearPrep === 9;
      if (bearComplete) bullLead = 0;
      if (bullComplete) bearLead = 0;
      if (i >= 2) {
        const low2 = n(rows[i - 2].low);
        const high2 = n(rows[i - 2].high);
        if (bullComplete && low2 != null && c < low2) bullLead += 1;
        else if (bullLead > 0 && low2 != null && c < low2) bullLead += 1;
        else if (bullLead > 0 && low2 != null && c >= low2) bullLead = 0;

        if (bearComplete && high2 != null && c > high2) bearLead += 1;
        else if (bearLead > 0 && high2 != null && c > high2) bearLead += 1;
        else if (bearLead > 0 && high2 != null && c <= high2) bearLead = 0;
      }
    }
    out.push({ bullPrep, bearPrep, bullLead, bearLead });
  }
  return out;
}

function analyzeFile(file, sampleRows) {
  const rows = readCsv(file);
  const calc = computeWorkerTd(rows);
  const start = Math.max(0, rows.length - sampleRows);
  const report = {
    file: path.basename(file),
    rows: rows.length,
    sampled_rows: rows.length - start,
    prep_bull_mismatches: 0,
    prep_bear_mismatches: 0,
    lead_bull_mismatches: 0,
    lead_bear_mismatches: 0,
    examples: [],
  };
  for (let i = start; i < rows.length; i += 1) {
    const r = rows[i];
    const expected = {
      prepBull: Math.trunc(n(r.lux_bull_prep_count) || 0),
      prepBear: Math.trunc(n(r.lux_bear_prep_count) || 0),
      leadBull: Math.trunc(n(r.lux_bull_leadup_count) || 0),
      leadBear: Math.trunc(n(r.lux_bear_leadup_count) || 0),
    };
    const actual = calc[i];
    const checks = [
      ["prep_bull_mismatches", "prep_bull", expected.prepBull, actual.bullPrep],
      ["prep_bear_mismatches", "prep_bear", expected.prepBear, actual.bearPrep],
      ["lead_bull_mismatches", "lead_bull", expected.leadBull, actual.bullLead],
      ["lead_bear_mismatches", "lead_bear", expected.leadBear, actual.bearLead],
    ];
    for (const [counter, field, exp, act] of checks) {
      if (exp !== act) {
        report[counter] += 1;
        if (report.examples.length < 8) report.examples.push({ time: r.time, field, expected: exp, actual: act });
      }
    }
  }
  return report;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = listCsvFiles(args.input);
  const reports = files.map((file) => analyzeFile(file, args.sampleRows));
  const aggregate = {
    files: reports.length,
    sampled_rows: reports.reduce((a, r) => a + r.sampled_rows, 0),
    prep_bull_mismatches: reports.reduce((a, r) => a + r.prep_bull_mismatches, 0),
    prep_bear_mismatches: reports.reduce((a, r) => a + r.prep_bear_mismatches, 0),
    lead_bull_mismatches: reports.reduce((a, r) => a + r.lead_bull_mismatches, 0),
    lead_bear_mismatches: reports.reduce((a, r) => a + r.lead_bear_mismatches, 0),
  };
  const report = {
    generated_at: new Date().toISOString(),
    input: path.relative(ROOT, args.input),
    sample_rows_per_file: args.sampleRows,
    aggregate,
    reports,
  };
  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ aggregate, report: path.relative(ROOT, args.report) }, null, 2));
}

main();
