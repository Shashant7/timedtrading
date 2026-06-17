#!/usr/bin/env node
// Convert TradingView chart-data CSV exports into local indicator fixture JSON
// and run the shadow parity harness.
//
// This script intentionally writes to TV Exports/ by default (gitignored).
// Commit fixture JSON only after the exports and mismatch classifications are
// reviewed as benchmark truth.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  expectedSessionClip,
  runParityFixture,
} from "../worker/foundation/indicator-parity.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_INPUT = path.join(ROOT, "TV Exports/indicator-parity/extracted");
const DEFAULT_OUT = path.join(ROOT, "TV Exports/indicator-parity/generated-fixtures");
const DEFAULT_REPORT = path.join(ROOT, "TV Exports/indicator-parity/parity-report.json");

const PHASE_ZONE = {
  0: "LOW",
  1: "MEDIUM",
  2: "HIGH",
  3: "EXTREME",
};

const PDZ_ZONE = {
  0: "discount",
  1: "discount_approach",
  2: "equilibrium",
  3: "premium_approach",
  4: "premium",
};

const FIELD_MAP = {
  close: { col: "close", type: "num" },
  ema21: { col: "ema21", type: "num" },
  ema200: { col: "ema200", type: "num" },
  rsi14: { col: "rsi14", type: "num" },
  atr14: { col: "atr14", type: "num" },
  supertrend_dir: { col: "supertrend_dir", type: "int" },
  supertrend_line: { col: "supertrend_line", type: "num" },
  td9_bull: { col: "td9_bull", type: "bool" },
  td9_bear: { col: "td9_bear", type: "bool" },
  td13_bull: { col: "td13_bull", type: "bool" },
  td13_bear: { col: "td13_bear", type: "bool" },
  td_bull_prep_count: { col: "td_bull_prep_count", type: "int" },
  td_bear_prep_count: { col: "td_bear_prep_count", type: "int" },
  td_tv_count: { col: "td_tv_count", type: "int" },
  td_tv_side: { col: "td_tv_side_code", type: "side" },
  phase_value: { col: "phase_value", type: "num" },
  phase_zone: { col: "phase_zone_code", type: "phaseZone" },
  saty_phase_value: { col: "saty_phase_value", type: "num" },
  saty_phase_zone: { col: "saty_phase_zone_code", type: "phaseZone" },
  phase_leaving_accum: { col: "phase_leaving_accum", type: "bool" },
  phase_leaving_distribution: { col: "phase_leaving_distribution", type: "bool" },
  sq_on: { col: "sq_on", type: "bool" },
  sq_release: { col: "sq_release", type: "bool" },
  vwap: { col: "vwap", type: "num" },
  vwap_dist_pct: { col: "vwap_dist_pct", type: "num" },
  rvol: { col: "rvol", type: "num" },
  pdz_position: { col: "pdz_position", type: "num" },
  pdz_zone: { col: "pdz_zone_code", type: "pdzZone" },
  fvg_in_bull: { col: "fvg_in_bull", type: "bool" },
  fvg_in_bear: { col: "fvg_in_bear", type: "bool" },
  liq_nearest_ss_dist_atr: { col: "liq_nearest_ss_dist_atr", type: "num" },
  rsi_bull_divergence: { col: "rsi_bull_divergence", type: "bool" },
  rsi_bear_divergence: { col: "rsi_bear_divergence", type: "bool" },
};

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    out: DEFAULT_OUT,
    report: DEFAULT_REPORT,
    sampleRows: 40,
    includeWarmup: false,
    supertrend: { atr_len: 10, factor: 3.0 },
  };
  for (const a of argv) {
    if (a.startsWith("--input=")) args.input = path.resolve(ROOT, a.slice("--input=".length));
    else if (a.startsWith("--out=")) args.out = path.resolve(ROOT, a.slice("--out=".length));
    else if (a.startsWith("--report=")) args.report = path.resolve(ROOT, a.slice("--report=".length));
    else if (a.startsWith("--sample-rows=")) args.sampleRows = Number(a.slice("--sample-rows=".length)) || args.sampleRows;
    else if (a === "--include-warmup") args.includeWarmup = true;
    else if (a.startsWith("--supertrend=")) {
      const raw = a.slice("--supertrend=".length).trim();
      const parts = raw.split(",").map((x) => Number(x.trim()));
      if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
        throw new Error("--supertrend must be atrLen,factor (example: --supertrend=5,3)");
      }
      args.supertrend = { atr_len: parts[0], factor: parts[1] };
    }
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

function splitCsvLine(line) {
  // TradingView export values here are unquoted numeric/text fields. Header
  // names from other indicators can include commas and get split, but the
  // parity columns have exact names and are still addressable.
  return String(line || "").replace(/\r$/, "").split(",");
}

function indexHeaders(headers) {
  const first = new Map();
  const last = new Map();
  headers.forEach((h, i) => {
    if (!first.has(h)) first.set(h, i);
    last.set(h, i);
  });
  return { first, last };
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function valueBy(headers, row, name, prefer = "last") {
  const idx = headers[prefer].get(name);
  return idx == null ? null : row[idx];
}

function convertValue(raw, type) {
  const n = num(raw);
  if (type === "num") return n;
  if (type === "int") return n == null ? null : Math.trunc(n);
  if (type === "bool") return n == null ? null : n !== 0;
  if (type === "side") return n === 1 ? "bull" : n === -1 ? "bear" : null;
  if (type === "phaseZone") return n == null ? null : PHASE_ZONE[Math.trunc(n)] || null;
  if (type === "pdzZone") return n == null ? null : PDZ_ZONE[Math.trunc(n)] || null;
  return raw;
}

function tfFromFile(file) {
  const name = path.basename(file, ".csv");
  const raw = name.includes(",") ? name.split(",").pop().trim() : name.split("_").pop();
  if (raw === "1D") return "D";
  if (raw === "1W") return "W";
  if (raw === "1M") return "M";
  return raw;
}

function tickerFromFile(file) {
  const parent = path.basename(path.dirname(file));
  if (parent && parent !== "extracted") return parent.toUpperCase();
  const name = path.basename(file, ".csv").split(",")[0];
  return name.replace(/^.*[_:]/, "").toUpperCase();
}

function tsFromRaw(raw) {
  const n = num(raw);
  if (n == null) return null;
  return n < 1e12 ? Math.trunc(n * 1000) : Math.trunc(n);
}

function sampleIndices(total, sampleRows, includeWarmup = false) {
  const out = new Set();
  if (includeWarmup) {
    const warmup = Math.min(total - 1, 320);
    if (warmup >= 0) out.add(warmup);
  }
  const lastN = Math.min(total, sampleRows);
  for (let i = total - lastN; i < total; i += 1) {
    if (i >= 0) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

function fixtureFromCsv(file, opts) {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) throw new Error(`CSV has no rows: ${file}`);
  const headersRaw = splitCsvLine(lines[0]);
  const headers = indexHeaders(headersRaw);
  const rowsRaw = lines.slice(1).map(splitCsvLine);
  const ticker = tickerFromFile(file);
  const tf = tfFromFile(file);
  const sessionClip = expectedSessionClip(tf);

  const timeIdx = headers.first.get("time");
  const openIdx = headers.first.get("open");
  const highIdx = headers.first.get("high");
  const lowIdx = headers.first.get("low");
  const closeIdx = headers.first.get("close");
  const volumeIdx = headers.last.get("volume");
  for (const [label, idx] of Object.entries({ timeIdx, openIdx, highIdx, lowIdx, closeIdx })) {
    if (idx == null) throw new Error(`Missing base ${label} in ${file}`);
  }

  const candles = [];
  for (const r of rowsRaw) {
    const ts = tsFromRaw(r[timeIdx]);
    const o = num(r[openIdx]);
    const h = num(r[highIdx]);
    const l = num(r[lowIdx]);
    const c = num(r[closeIdx]);
    if (ts == null || o == null || h == null || l == null || c == null) continue;
    candles.push({ ts, o, h, l, c, v: volumeIdx == null ? 0 : (num(r[volumeIdx]) || 0) });
  }
  if (candles.length === 0) throw new Error(`No valid candles in ${file}`);

  const sampled = sampleIndices(rowsRaw.length, opts.sampleRows, opts.includeWarmup);
  const fixtureRows = [];
  for (const i of sampled) {
    const raw = rowsRaw[i];
    const ts = tsFromRaw(raw[timeIdx]);
    if (ts == null) continue;
    const expected = {};
    for (const [field, spec] of Object.entries(FIELD_MAP)) {
      const v = convertValue(valueBy(headers, raw, spec.col, "last"), spec.type);
      if (v != null) expected[field] = v;
    }
    fixtureRows.push({ ts, expected });
  }

  const range = {
    start: new Date(candles[0].ts).toISOString().slice(0, 10),
    end: new Date(candles[candles.length - 1].ts).toISOString().slice(0, 10),
  };
  return {
    fixture_version: 1,
    source: "tradingview_export",
    source_file: path.relative(ROOT, file),
    ticker,
    tf,
    session_clip: sessionClip,
    range,
    candles_source: "tradingview",
    indicator_params: {
      supertrend: opts.supertrend,
    },
    candles,
    rows: fixtureRows,
  };
}

function summarizeParity(fixture, parity) {
  const byField = {};
  for (const row of parity.rows || []) {
    for (const m of row.mismatches || []) {
      byField[m.field] = (byField[m.field] || 0) + 1;
    }
  }
  return {
    ticker: fixture.ticker,
    tf: fixture.tf,
    source_file: fixture.source_file,
    session_clip: fixture.session_clip,
    supertrend: fixture.indicator_params.supertrend,
    candle_count: fixture.candles.length,
    sampled_rows: fixture.rows.length,
    ok: parity.ok,
    validation_errors: parity.validation?.errors || [],
    mismatch_count: Object.values(byField).reduce((a, b) => a + b, 0),
    mismatches_by_field: byField,
    sample_mismatches: (parity.rows || [])
      .flatMap((row) => (row.mismatches || []).slice(0, 5).map((m) => ({ ts: row.ts, ...m })))
      .slice(0, 25),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = listCsvFiles(opts.input);
  fs.mkdirSync(opts.out, { recursive: true });
  fs.mkdirSync(path.dirname(opts.report), { recursive: true });

  const summaries = [];
  for (const file of files) {
    const fixture = fixtureFromCsv(file, opts);
    const tickerDir = path.join(opts.out, fixture.ticker);
    fs.mkdirSync(tickerDir, { recursive: true });
    const outFile = path.join(tickerDir, `${fixture.ticker}_${fixture.tf}_${fixture.range.start}_${fixture.range.end}.json`);
    fs.writeFileSync(outFile, `${JSON.stringify(fixture, null, 2)}\n`);
    const parity = runParityFixture(fixture);
    summaries.push({ ...summarizeParity(fixture, parity), fixture_file: path.relative(ROOT, outFile) });
  }

  const aggregate = {};
  for (const s of summaries) {
    for (const [field, count] of Object.entries(s.mismatches_by_field)) {
      aggregate[field] = (aggregate[field] || 0) + count;
    }
  }
  const report = {
    generated_at: new Date().toISOString(),
    input: path.relative(ROOT, opts.input),
    out: path.relative(ROOT, opts.out),
    sample_rows_per_file: opts.sampleRows,
    include_warmup: opts.includeWarmup,
    supertrend: opts.supertrend,
    file_count: summaries.length,
    ok_count: summaries.filter((s) => s.ok).length,
    mismatch_fields: aggregate,
    summaries,
  };
  fs.writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    file_count: report.file_count,
    ok_count: report.ok_count,
    mismatch_fields: report.mismatch_fields,
    report: path.relative(ROOT, opts.report),
  }, null, 2));
}

main();
