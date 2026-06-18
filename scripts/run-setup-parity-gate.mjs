#!/usr/bin/env node
/**
 * Run indicator fixture parity + optional live API parity gate.
 *
 * Usage:
 *   node scripts/run-setup-parity-gate.mjs
 *   node scripts/run-setup-parity-gate.mjs --fixtures data/indicator-fixtures/v1/accepted
 *   TIMED_API_KEY=... node scripts/run-setup-parity-gate.mjs --live
 */

import fs from "node:fs";
import path from "node:path";
import { runFixtureParityGate } from "../worker/foundation/setup-parity-gate-runner.js";

const FIXTURES_DIR = process.argv.includes("--fixtures")
  ? process.argv[process.argv.indexOf("--fixtures") + 1]
  : path.join(process.cwd(), "data/indicator-fixtures/v1/accepted");

const API_BASE = process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";
const LIVE = process.argv.includes("--live");

function loadFixtures(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "manifest.json")
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

async function main() {
  const fixtures = loadFixtures(FIXTURES_DIR);
  if (!fixtures.length) {
    console.error("No fixtures in", FIXTURES_DIR, "- run: node scripts/seed-accepted-parity-fixtures.mjs");
    process.exit(1);
  }

  const gate = await runFixtureParityGate(fixtures);
  console.log(JSON.stringify(gate, null, 2));

  if (LIVE && API_KEY) {
    const params = new URLSearchParams({ key: API_KEY });
    const resp = await fetch(`${API_BASE}/timed/admin/setup-parity-gate?${params}`);
    const live = await resp.json();
    console.log("\n--- live gate ---\n", JSON.stringify(live, null, 2));
    if (!live.ok) process.exit(2);
  }

  if (!gate.ok) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
