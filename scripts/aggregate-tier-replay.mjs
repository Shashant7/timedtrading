#!/usr/bin/env node
/**
 * Aggregate all move-replay summary-*.json files into one reliability report.
 * Run after Tier A + B complete (or anytime for partial progress).
 *
 * Usage:
 *   node scripts/aggregate-tier-replay.mjs
 *   node scripts/aggregate-tier-replay.mjs --out-dir data/setup-mining/tiered-reliability
 */

import fs from "node:fs";
import path from "node:path";
import {
  buildReliabilityReport,
  formatReliabilityMarkdown,
} from "../worker/foundation/setup-replay-mining.js";

const REPLAY_DIR = process.argv.includes("--replay-dir")
  ? process.argv[process.argv.indexOf("--replay-dir") + 1]
  : "data/setup-mining/move-replay";

const OUT_DIR = process.argv.includes("--out-dir")
  ? process.argv[process.argv.indexOf("--out-dir") + 1]
  : "data/setup-mining/tiered-reliability";

function loadJoinedRows(dir) {
  const rows = [];
  const moveIds = new Set();
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith("summary-") && x.endsWith(".json"))) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const it of j.summary?.items || j.items || []) {
      if (!it?.mining?.ticker || moveIds.has(it.move_id)) continue;
      moveIds.add(it.move_id);
      rows.push(it.mining);
    }
  }
  return { rows, moveIds };
}

const { rows, moveIds } = loadJoinedRows(REPLAY_DIR);
if (!rows.length) {
  console.error("No mining rows in", REPLAY_DIR);
  process.exit(1);
}

const report = buildReliabilityReport(rows, {
  cohort: "discovery_tiered_replay",
  analysis_mode: "sequence_trail_replay",
  discovery_file: "data/move-discovery-live.json",
});

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const jsonPath = path.join(OUT_DIR, `aggregate-${stamp}.json`);
const mdPath = path.join(OUT_DIR, `aggregate-${stamp}.md`);

const payload = {
  generated_at: new Date().toISOString(),
  replay_dir: REPLAY_DIR,
  unique_moves: moveIds.size,
  report,
};

fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
fs.writeFileSync(mdPath, formatReliabilityMarkdown(report));

console.log(JSON.stringify({
  unique_moves: moveIds.size,
  json: jsonPath,
  md: mdPath,
  reliability_keys: Object.keys(report.reliability || {}),
}, null, 2));
