#!/usr/bin/env node
/**
 * CI guard: if scoring-source files change, SCORING_VERSION in indicators.js
 * must also change (Trust Spine provenance contract).
 *
 * Usage:
 *   node scripts/check-scoring-version-bump.mjs
 *   node scripts/check-scoring-version-bump.mjs --base origin/main
 */
import { execSync } from "node:child_process";
import fs from "node:fs";

const SCORING_FILE = "worker/indicators.js";
const WATCH_GLOBS = [
  "worker/indicators.js",
  "worker/conviction.js",
  "worker/bleeder-guard.js",
  "worker/calibration-guards.js",
  "worker/model.js",
  "worker/replay-runtime-setup.js",
];

function git(args) {
  return execSync(`git ${args}`, { encoding: "utf8" }).trim();
}

const base = process.argv.includes("--base")
  ? process.argv[process.argv.indexOf("--base") + 1]
  : "origin/main";

let diff = "";
try {
  diff = git(`diff --name-only ${base}...HEAD`);
} catch {
  console.log("[scoring-version-guard] skip — no merge base");
  process.exit(0);
}

const changed = diff.split("\n").filter(Boolean);
const scoringTouched = changed.some((f) => WATCH_GLOBS.includes(f));
if (!scoringTouched) {
  console.log("[scoring-version-guard] OK — no scoring-source files changed");
  process.exit(0);
}

let baseVersion = "";
let headVersion = "";
try {
  baseVersion = git(`show ${base}:${SCORING_FILE}`);
  headVersion = fs.readFileSync(SCORING_FILE, "utf8");
} catch (e) {
  console.error("[scoring-version-guard] could not read versions:", e.message);
  process.exit(1);
}

const extract = (src) => {
  const m = src.match(/export const SCORING_VERSION = "([^"]+)"/);
  return m ? m[1] : null;
};

const vBase = extract(baseVersion);
const vHead = extract(headVersion);

if (!vHead) {
  console.error("[scoring-version-guard] FAIL — SCORING_VERSION not found in head");
  process.exit(1);
}

if (vBase === vHead) {
  console.error("[scoring-version-guard] FAIL — scoring files changed but SCORING_VERSION unchanged");
  console.error(`  base=${vBase} head=${vHead}`);
  console.error(`  touched: ${changed.filter((f) => WATCH_GLOBS.includes(f)).join(", ")}`);
  console.error("  bump export const SCORING_VERSION in worker/indicators.js");
  process.exit(1);
}

console.log(`[scoring-version-guard] OK — SCORING_VERSION bumped ${vBase} -> ${vHead}`);
