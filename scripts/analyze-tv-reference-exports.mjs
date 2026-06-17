#!/usr/bin/env node
// Analyze independent TradingView reference columns included in the exported CSVs.
//
// This does not produce fixture truth. It answers:
// - Do our exported TD prep counts match LuxAlgo Sequencer's prep formula?
// - Do our Saty phase/leave fields match the MTF Phase Oscillator columns?
// - Are ATRLevels plotted columns internally self-consistent?

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INPUT = path.join(ROOT, "TV Exports/indicator-parity/extracted");
const DEFAULT_REPORT = path.join(ROOT, "TV Exports/indicator-parity/reference-analysis-report.json");

function parseArgs(argv) {
  const args = { input: DEFAULT_INPUT, report: DEFAULT_REPORT, sampleRows: 40 };
  for (const a of argv) {
    if (a.startsWith("--input=")) args.input = path.resolve(ROOT, a.slice("--input=".length));
    else if (a.startsWith("--report=")) args.report = path.resolve(ROOT, a.slice("--report=".length));
    else if (a.startsWith("--sample-rows=")) args.sampleRows = Number(a.slice("--sample-rows=".length)) || args.sampleRows;
  }
  return args;
}

function listCsvFiles(dir) {
  const out = [];
  function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (p.includes("__MACOSX")) continue;
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith(".csv")) out.push(p);
    }
  }
  walk(dir);
  return out.sort();
}

function split(line) {
  return String(line || "").replace(/\r$/, "").split(",");
}

function rowsFromCsv(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\n/).filter((line) => line.trim() !== "");
  const headers = split(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = split(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i]; });
    return row;
  });
}

function n(v) {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function b(v) {
  const x = n(v);
  return x != null && x !== 0;
}

function computeLuxPrep(rows) {
  let bull = 0;
  let bear = 0;
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const c = n(rows[i].close);
    if (i >= 4 && c != null) {
      const c4 = n(rows[i - 4].close);
      bull = c4 != null && c < c4 ? bull + 1 : 0;
      bear = c4 != null && c > c4 ? bear + 1 : 0;
    }
    out.push({ bull, bear });
  }
  return out;
}

function tickerTf(file) {
  const ticker = path.basename(path.dirname(file)).toUpperCase();
  const name = path.basename(file, ".csv");
  const tfRaw = name.includes(",") ? name.split(",").pop().trim() : name.split("_").pop();
  return { ticker, tf: tfRaw === "1D" ? "D" : tfRaw === "1W" ? "W" : tfRaw };
}

function near(a, e, tol) {
  if (a == null || e == null) return false;
  return Math.abs(a - e) <= tol;
}

function analyzeFile(file, sampleRows) {
  const rows = rowsFromCsv(file);
  const sampleStart = Math.max(0, rows.length - sampleRows);
  const lux = computeLuxPrep(rows);
  const summary = {
    ...tickerTf(file),
    source_file: path.relative(ROOT, file),
    sampled_rows: rows.length - sampleStart,
    lux_prep: { checked: 0, bull_mismatches: 0, bear_mismatches: 0, examples: [] },
    mtf_phase: { checked: 0, value_mismatches: 0, leaving_accum_mismatches: 0, leaving_distribution_mismatches: 0, max_abs_diff: 0, examples: [] },
    atr_levels: { checked: 0, internal_formula_mismatches: 0, examples: [] },
  };
  for (let i = sampleStart; i < rows.length; i += 1) {
    const row = rows[i];
    const time = row.time;

    const bullExpected = lux[i].bull;
    const bearExpected = lux[i].bear;
    const bullActual = Math.trunc(n(row.td_bull_prep_count) || 0);
    const bearActual = Math.trunc(n(row.td_bear_prep_count) || 0);
    summary.lux_prep.checked += 1;
    if (bullExpected !== bullActual) {
      summary.lux_prep.bull_mismatches += 1;
      if (summary.lux_prep.examples.length < 5) summary.lux_prep.examples.push({ time, side: "bull", expected: bullExpected, actual: bullActual });
    }
    if (bearExpected !== bearActual) {
      summary.lux_prep.bear_mismatches += 1;
      if (summary.lux_prep.examples.length < 5) summary.lux_prep.examples.push({ time, side: "bear", expected: bearExpected, actual: bearActual });
    }

    const phaseRef = n(row["Phase (Chart TF)"]);
    const phaseActual = n(row.saty_phase_value);
    if (phaseRef != null && phaseActual != null) {
      summary.mtf_phase.checked += 1;
      const diff = Math.abs(phaseRef - phaseActual);
      summary.mtf_phase.max_abs_diff = Math.max(summary.mtf_phase.max_abs_diff, diff);
      if (diff > 0.1) {
        summary.mtf_phase.value_mismatches += 1;
        if (summary.mtf_phase.examples.length < 5) summary.mtf_phase.examples.push({ time, expected: phaseRef, actual: phaseActual, diff });
      }
    }
    const refAccum = n(row["Leaving Accumulation"]) != null;
    const refDist = n(row["Leaving Distribution"]) != null;
    const actualAccum = b(row.phase_leaving_accum);
    const actualDist = b(row.phase_leaving_distribution);
    if (refAccum !== actualAccum) summary.mtf_phase.leaving_accum_mismatches += 1;
    if (refDist !== actualDist) summary.mtf_phase.leaving_distribution_mismatches += 1;

    const pc = n(row["ATR Prev Close"]);
    const lower382 = n(row["ATR -38.2%"]);
    const upper382 = n(row["ATR +38.2%"]);
    const lower618 = n(row["ATR -61.8%"]);
    const upper618 = n(row["ATR +61.8%"]);
    const lower100 = n(row["ATR -100%"]);
    const upper100 = n(row["ATR +100%"]);
    if ([pc, lower382, upper382, lower618, upper618, lower100, upper100].every((x) => x != null)) {
      summary.atr_levels.checked += 1;
      const atr = upper100 - pc;
      const ok = near(pc - atr, lower100, 0.02)
        && near(pc + atr * 0.382, upper382, 0.02)
        && near(pc - atr * 0.382, lower382, 0.02)
        && near(pc + atr * 0.618, upper618, 0.02)
        && near(pc - atr * 0.618, lower618, 0.02);
      if (!ok) {
        summary.atr_levels.internal_formula_mismatches += 1;
        if (summary.atr_levels.examples.length < 5) summary.atr_levels.examples.push({ time, pc, lower382, upper382, lower618, upper618, lower100, upper100 });
      }
    }
  }
  return summary;
}

function sumReports(reports) {
  const out = {
    lux_prep: { checked: 0, bull_mismatches: 0, bear_mismatches: 0 },
    mtf_phase: { checked: 0, value_mismatches: 0, leaving_accum_mismatches: 0, leaving_distribution_mismatches: 0, max_abs_diff: 0 },
    atr_levels: { checked: 0, internal_formula_mismatches: 0 },
  };
  for (const r of reports) {
    out.lux_prep.checked += r.lux_prep.checked;
    out.lux_prep.bull_mismatches += r.lux_prep.bull_mismatches;
    out.lux_prep.bear_mismatches += r.lux_prep.bear_mismatches;
    out.mtf_phase.checked += r.mtf_phase.checked;
    out.mtf_phase.value_mismatches += r.mtf_phase.value_mismatches;
    out.mtf_phase.leaving_accum_mismatches += r.mtf_phase.leaving_accum_mismatches;
    out.mtf_phase.leaving_distribution_mismatches += r.mtf_phase.leaving_distribution_mismatches;
    out.mtf_phase.max_abs_diff = Math.max(out.mtf_phase.max_abs_diff, r.mtf_phase.max_abs_diff);
    out.atr_levels.checked += r.atr_levels.checked;
    out.atr_levels.internal_formula_mismatches += r.atr_levels.internal_formula_mismatches;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = listCsvFiles(args.input);
  const reports = files.map((file) => analyzeFile(file, args.sampleRows));
  const report = {
    generated_at: new Date().toISOString(),
    input: path.relative(ROOT, args.input),
    file_count: files.length,
    sample_rows_per_file: args.sampleRows,
    aggregate: sumReports(reports),
    reports,
  };
  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    file_count: report.file_count,
    aggregate: report.aggregate,
    report: path.relative(ROOT, args.report),
  }, null, 2));
}

main();
