#!/usr/bin/env node
/**
 * Process Phase 2 TradingView parity exports (USO, GLD, XLE, NVDA, TSLA, UNH, MSTR).
 *
 * Prefers flat Parity-BATS_{TICKER} CSVs in tradingview/ (same layout as Phase 1).
 * Falls back to extracting tradingview/{TICKER}.zip when Parity CSVs are absent.
 *
 * Usage:
 *   node scripts/process-tv-parity-phase2.mjs
 *   node scripts/process-tv-parity-phase2.mjs --promote
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TICKERS = ["USO", "GLD", "XLE", "NVDA", "TSLA", "UNH", "MSTR"];
const STAGING = path.join(ROOT, "TV Exports/indicator-parity/parity-phase2");
const GENERATED = path.join(ROOT, "TV Exports/indicator-parity/generated-fixtures-phase2");
const REPORT = path.join(ROOT, "TV Exports/indicator-parity/parity-report-phase2.json");
const ACCEPTED = path.join(ROOT, "data/indicator-fixtures/v1/accepted/tv-phase2");

const PROMOTE = process.argv.includes("--promote");

function listParityCsvs() {
  const dir = path.join(ROOT, "tradingview");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^Parity-BATS_/i.test(name) && name.endsWith(".csv"))
    .map((name) => path.join(dir, name));
}

function parityCsvsForPhase2() {
  const all = listParityCsvs();
  return all.filter((p) => {
    const base = path.basename(p).toUpperCase();
    return TICKERS.some((t) => base.includes(`_${t},`) || base.includes(`_${t} `));
  });
}

function extractZips() {
  fs.mkdirSync(STAGING, { recursive: true });
  for (const ticker of TICKERS) {
    const zipPath = path.join(ROOT, "tradingview", `${ticker}.zip`);
    if (!fs.existsSync(zipPath)) continue;
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", STAGING], { stdio: "inherit" });
  }
}

function copyParityCsvs(files) {
  fs.mkdirSync(STAGING, { recursive: true });
  for (const src of files) {
    const dest = path.join(STAGING, path.basename(src));
    fs.copyFileSync(src, dest);
  }
}

function runBuild() {
  execFileSync(process.execPath, [
    path.join(ROOT, "scripts/build-indicator-fixtures.mjs"),
    `--input=${STAGING}`,
    `--out=${GENERATED}`,
    `--report=${REPORT}`,
    "--sample-rows=80",
    "--supertrend=10,3",
  ], { stdio: "inherit", cwd: ROOT });
}

function promoteClean() {
  const report = JSON.parse(fs.readFileSync(REPORT, "utf8"));
  fs.mkdirSync(ACCEPTED, { recursive: true });
  const promoted = [];
  for (const s of report.summaries || []) {
    if (!s.ok || !s.fixture_file) continue;
    const src = path.join(ROOT, s.fixture_file);
    const name = `${s.ticker}_${s.tf}_${path.basename(s.fixture_file).split("_").slice(2).join("_")}`;
    const dest = path.join(ACCEPTED, name);
    fs.copyFileSync(src, dest);
    promoted.push({ file: name, ticker: s.ticker, tf: s.tf });
  }
  fs.writeFileSync(path.join(ACCEPTED, "manifest.json"), JSON.stringify({
    generated_at: new Date().toISOString(),
    source: "tradingview_export",
    phase: 2,
    parity: {
      files: report.file_count,
      ok: report.ok_count,
      report: path.relative(ROOT, REPORT),
    },
    fixtures: promoted,
  }, null, 2));
  return promoted;
}

function main() {
  const parityFiles = parityCsvsForPhase2();
  if (parityFiles.length >= TICKERS.length) {
    console.log(`Using ${parityFiles.length} Parity-BATS CSVs from tradingview/`);
    fs.rmSync(STAGING, { recursive: true, force: true });
    copyParityCsvs(parityFiles);
  } else {
    console.warn(
      `Only ${parityFiles.length} Parity-BATS Phase-2 CSVs found (expected ${TICKERS.length * 3}).`,
      "Falling back to tradingview/*.zip extracts (older export layout).",
    );
    fs.rmSync(STAGING, { recursive: true, force: true });
    if (parityFiles.length) copyParityCsvs(parityFiles);
    extractZips();
  }

  runBuild();

  if (PROMOTE) {
    const promoted = promoteClean();
    console.log(`Promoted ${promoted.length} clean fixtures to ${path.relative(ROOT, ACCEPTED)}`);
  }
}

main();
