#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);

function getArg(name, fallback = "") {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function parseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const baseConfigFile = getArg("base-config");
const evidenceFile = getArg("evidence");
const outputFile = getArg("output");
const toleranceMinutes = Number(getArg("tolerance-minutes", "20")) || 20;

if (!baseConfigFile || !evidenceFile || !outputFile) {
  console.error("Usage: node scripts/build-julaug-parity-config.js --base-config <file> --evidence <golden-evidence.json> --output <file> [--tolerance-minutes 20]");
  process.exit(1);
}

const basePayload = readJson(baseConfigFile);
const evidence = readJson(evidenceFile);
const config = { ...(basePayload?.config || basePayload) };
const referenceMap = parseJsonMaybe(config.reference_execution_map) || {};

// Only include golden evidence trades — do NOT merge with existing exact_reference_entries.
// The base config's non-golden entries trigger referenceExactActive bypass on too many tickers.
const rebuiltByKey = new Map();
for (const trade of evidence?.trades || []) {
  const key = `${String(trade?.trade_id || "").trim()}|${String(trade?.ticker || "").toUpperCase()}|${Number(trade?.entry_ts) || 0}`;
  rebuiltByKey.set(key, {
    ticker: trade.ticker,
    direction: trade.direction,
    entry_ts: trade.entry_ts,
    entry_price_expected: Number(trade.entry_price || 0) || null,
    trim_price_expected: Number(trade.trim_price || 0) || null,
    exit_price_expected: Number(trade.exit_price || 0) || null,
    tolerance_minutes: toleranceMinutes,
    trade_id: trade.trade_id,
    run_id: trade.run_id || evidence?.run_id || null,
    entry_engine: trade.selected_engine || "tt_core",
    management_engine: trade.selected_management_engine || trade.selected_engine || "tt_core",
    entry_path_expected: trade.entry_path || null,
    engine_source_expected: trade.engine_source || null,
    scenario_policy_source_expected: trade.scenario_policy_source || null,
    criteria_fingerprint: trade.criteria_fingerprint || null,
  });
}

referenceMap.version = `${referenceMap.version || "reference_execution_map"}+golden_julaug_exact_v1`;
referenceMap.exact_reference_entries = Array.from(rebuiltByKey.values())
  .sort((a, b) => (Number(a.entry_ts) || 0) - (Number(b.entry_ts) || 0));

config.reference_execution_map = JSON.stringify(referenceMap);
config.deep_audit_reference_exact_entry_leniency = "true";
config.deep_audit_reference_exact_tolerance_minutes = String(toleranceMinutes);
config.golden_julaug_reference_run_id = String(evidence?.run_id || "");

const output = {
  ...basePayload,
  source_run_id: basePayload?.source_run_id || evidence?.run_id || null,
  config,
};

fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
fs.writeFileSync(path.resolve(outputFile), JSON.stringify(output, null, 2));
console.log(path.resolve(outputFile));
console.log(JSON.stringify({
  exact_reference_entries: referenceMap.exact_reference_entries.length,
  reference_map_version: referenceMap.version,
}));
