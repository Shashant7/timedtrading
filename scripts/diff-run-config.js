#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const getArg = (name, fallback = "") => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};

const baselineFile = getArg("baseline-file");
const compareFile = getArg("compare-file");
const compareRunId = getArg("compare-run-id");
const outputFile = getArg("output");
const apiBase = process.env.WORKER_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const apiKey = process.env.TIMED_API_KEY || "AwesomeSauce";

if (!baselineFile) {
  console.error("Usage: node scripts/diff-run-config.js --baseline-file <path> [--compare-file <path> | --compare-run-id <id>] [--output <path>]");
  process.exit(1);
}
if (!compareFile && !compareRunId) {
  console.error("ERROR: pass either --compare-file or --compare-run-id");
  process.exit(1);
}

function readConfigFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return {
    source: filePath,
    run_id: raw.run_id || raw.source_run_id || null,
    config: raw.config || raw,
  };
}

async function fetchRunConfig(runId) {
  const url = new URL(`${apiBase}/timed/admin/runs/config`);
  url.searchParams.set("run_id", runId);
  url.searchParams.set("key", apiKey);
  const resp = await fetch(url);
  const raw = await resp.json();
  if (!raw?.ok) {
    throw new Error(raw?.error || `failed_to_fetch_run_config:${runId}`);
  }
  return {
    source: url.toString(),
    run_id: runId,
    config: raw.config || {},
  };
}

function buildDiff(baseline, compare) {
  const baseCfg = baseline.config || {};
  const cmpCfg = compare.config || {};
  const onlyBaseline = Object.keys(baseCfg).filter((key) => !(key in cmpCfg)).sort();
  const onlyCompare = Object.keys(cmpCfg).filter((key) => !(key in baseCfg)).sort();
  const changed = Object.keys(baseCfg)
    .filter((key) => key in cmpCfg && String(baseCfg[key]) !== String(cmpCfg[key]))
    .sort()
    .map((key) => ({
      key,
      baseline: baseCfg[key],
      compare: cmpCfg[key],
    }));
  return {
    generated_at: new Date().toISOString(),
    baseline: {
      source: baseline.source,
      run_id: baseline.run_id,
      key_count: Object.keys(baseCfg).length,
    },
    compare: {
      source: compare.source,
      run_id: compare.run_id,
      key_count: Object.keys(cmpCfg).length,
    },
    summary: {
      baseline_only: onlyBaseline.length,
      compare_only: onlyCompare.length,
      changed: changed.length,
    },
    baseline_only_keys: onlyBaseline,
    compare_only_keys: onlyCompare,
    changed_keys: changed,
  };
}

async function main() {
  const baseline = readConfigFile(path.resolve(baselineFile));
  const compare = compareFile
    ? readConfigFile(path.resolve(compareFile))
    : await fetchRunConfig(compareRunId);
  const diff = buildDiff(baseline, compare);
  const outPath = outputFile
    ? path.resolve(outputFile)
    : path.resolve("data", "iter5-config-diff.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(diff, null, 2));
  console.log(outPath);
  console.log(JSON.stringify(diff.summary));
}

main().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
