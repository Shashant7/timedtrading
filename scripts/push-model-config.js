#!/usr/bin/env node
// scripts/push-model-config.js
//
// Pushes tuned config values to the production D1 model_config table
// via the POST /timed/admin/model-config endpoint.
//
// Usage:
//   node scripts/push-model-config.js --config configs/tuned-exit-thresholds.json --dry-run
//   node scripts/push-model-config.js --config configs/tuned-exit-thresholds.json --push
//   node scripts/push-model-config.js --config configs/tuned-exit-thresholds.json --push --env production

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) { out[key] = true; }
      else { out[key] = next; i++; }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const CONFIG_PATH = args.config;
const DRY_RUN = !args.push;
const ENV = args.env || "production";

if (!CONFIG_PATH) {
  console.error("Usage: node scripts/push-model-config.js --config <path> [--push] [--env production|staging]");
  process.exit(1);
}

const BASE_URLS = {
  production: "https://timedtrading.pages.dev",
  staging: "https://timedtrading.pages.dev",
  local: "http://localhost:8787",
};

const API_KEY = process.env.TT_ADMIN_KEY || process.env.ADMIN_KEY || "";

async function main() {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw);

  const thresholds = config.thresholds || config;
  const updates = [];

  for (const [key, entry] of Object.entries(thresholds)) {
    if (key.startsWith("_")) continue;
    const value = typeof entry === "object" && entry.value !== undefined ? entry.value : entry;
    const description = typeof entry === "object" && entry.reason ? entry.reason : `Tuned: ${key}`;
    updates.push({ key, value: String(value), description });
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  PUSH MODEL CONFIG`);
  console.log(`  Config: ${CONFIG_PATH}`);
  console.log(`  Target: ${ENV} (${BASE_URLS[ENV] || ENV})`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "LIVE PUSH"}`);
  console.log(`${"═".repeat(60)}\n`);

  console.log(`  ${updates.length} config keys to write:\n`);
  for (const u of updates) {
    console.log(`  ${u.key.padEnd(45)} = ${u.value}`);
  }

  if (DRY_RUN) {
    console.log(`\n  DRY RUN — no changes made. Use --push to apply.`);
    return;
  }

  const baseUrl = BASE_URLS[ENV] || ENV;
  const url = `${baseUrl}/timed/admin/model-config`;

  console.log(`\n  Pushing to: ${url}`);

  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-Admin-Key"] = API_KEY;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ updates }),
  });

  const data = await resp.json();
  if (data.ok) {
    console.log(`  Success: ${data.written} keys written.`);
  } else {
    console.error(`  Error: ${data.error}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
