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

function loadRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const key of ["trades", "rows", "results"]) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return [];
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

function toNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseTs(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value > 0 ? Math.trunc(value) : null;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return parseTs(Number(value));
  const ts = Date.parse(String(value));
  return Number.isFinite(ts) ? ts : null;
}

function pick(obj, keys, fallback = null) {
  for (const key of keys) {
    if (obj && obj[key] != null) return obj[key];
  }
  return fallback;
}

function tfBias(snapshot, label) {
  return toNum(snapshot?.tf?.[label]?.bias, null);
}

function buildCriteriaFingerprint(autopsyRow) {
  const signal = parseJsonMaybe(autopsyRow?.signal_snapshot_json) || {};
  const lineage = signal?.lineage || {};
  return {
    entry_path: autopsyRow?.entry_path || lineage?.entry_path || null,
    direction_source: lineage?.direction_source || null,
    state: lineage?.state || null,
    regime_class: lineage?.regime_class || null,
    consensus_direction: autopsyRow?.consensus_direction || lineage?.swing_consensus?.dir || signal?.swing_consensus?.dir || null,
    engine_source: lineage?.engine_source || null,
    scenario_policy_source: lineage?.scenario_policy_source || null,
    tf_bias: {
      "10m": tfBias(signal, "10m"),
      "15m": tfBias(signal, "15m"),
      "30m": tfBias(signal, "30m"),
      "1H": tfBias(signal, "1H"),
      "4H": tfBias(signal, "4H"),
      "D": tfBias(signal, "D"),
    },
  };
}

function buildTradeEvidence(trade, autopsyRow, runId) {
  const signal = parseJsonMaybe(autopsyRow?.signal_snapshot_json) || {};
  const exitSignal = parseJsonMaybe(autopsyRow?.exit_snapshot_json) || {};
  const lineage = signal?.lineage || {};
  const executionProfile = parseJsonMaybe(autopsyRow?.execution_profile_json) || lineage || {};
  return {
    trade_id: trade.trade_id || autopsyRow?.trade_id || null,
    run_id: runId,
    ticker: String(trade.ticker || autopsyRow?.ticker || "").toUpperCase(),
    direction: String(trade.direction || autopsyRow?.direction || "").toUpperCase(),
    status: trade.status || autopsyRow?.status || null,
    entry_ts: parseTs(trade.entry_ts || autopsyRow?.entry_ts),
    exit_ts: parseTs(trade.exit_ts || autopsyRow?.exit_ts),
    trim_ts: parseTs(trade.trim_ts || autopsyRow?.trim_ts),
    entry_price: toNum(trade.entry_price || autopsyRow?.entry_price),
    exit_price: toNum(trade.exit_price || autopsyRow?.exit_price),
    trim_price: toNum(trade.trim_price || autopsyRow?.trim_price),
    pnl: toNum(trade.pnl || autopsyRow?.pnl, 0),
    pnl_pct: toNum(pick(trade, ["pnl_pct", "pnlPct"], autopsyRow?.pnl_pct), 0),
    trimmed_pct: toNum(trade.trimmed_pct || autopsyRow?.trimmed_pct, 0),
    exit_reason: trade.exit_reason || autopsyRow?.exit_reason || null,
    setup_name: trade.setup_name || autopsyRow?.setup_name || null,
    setup_grade: trade.setup_grade || autopsyRow?.setup_grade || null,
    risk_budget: toNum(trade.risk_budget || autopsyRow?.risk_budget),
    shares: toNum(trade.shares || autopsyRow?.shares),
    notional: toNum(trade.notional || autopsyRow?.notional),
    entry_path: autopsyRow?.entry_path || lineage?.entry_path || null,
    selected_engine: executionProfile?.selected_engine || lineage?.selected_engine || null,
    selected_management_engine: executionProfile?.selected_management_engine || lineage?.selected_management_engine || null,
    engine_source: executionProfile?.engine_source || lineage?.engine_source || null,
    scenario_policy_source: executionProfile?.scenario_policy_source || lineage?.scenario_policy_source || null,
    execution_profile_name: autopsyRow?.execution_profile_name || executionProfile?.execution_profile?.active_profile || null,
    execution_profile_confidence: toNum(autopsyRow?.execution_profile_confidence || executionProfile?.execution_profile?.confidence),
    market_state: autopsyRow?.market_state || executionProfile?.market_internals?.overall || null,
    consensus_direction: autopsyRow?.consensus_direction || lineage?.swing_consensus?.dir || signal?.swing_consensus?.dir || null,
    max_favorable_excursion: toNum(autopsyRow?.max_favorable_excursion),
    max_adverse_excursion: toNum(autopsyRow?.max_adverse_excursion),
    entry_quality_score: toNum(autopsyRow?.entry_quality_score || lineage?.entry_quality_score),
    rvol_best: toNum(autopsyRow?.rvol_best || signal?.lineage?.rvol?.["30m"]),
    criteria_fingerprint: buildCriteriaFingerprint(autopsyRow),
    signal_snapshot_json: signal,
    exit_snapshot_json: exitSignal,
  };
}

const tradesFile = getArg("trades");
const autopsyFile = getArg("autopsy");
const configFile = getArg("config");
const outputFile = getArg("output");
const label = getArg("label", "run-evidence-pack");

if (!tradesFile || !autopsyFile || !configFile || !outputFile) {
  console.error("Usage: node scripts/build-run-evidence-pack.js --trades <trades.json> --autopsy <trade-autopsy-trades.json> --config <model-config.json> --output <file> [--label <label>]");
  process.exit(1);
}

const tradesPayload = readJson(tradesFile);
const autopsyPayload = readJson(autopsyFile);
const configPayload = readJson(configFile);

const trades = loadRows(tradesPayload);
const autopsyRows = loadRows(autopsyPayload);
const config = configPayload?.config || configPayload;
const runId = tradesPayload?.archive_run_id || tradesPayload?.run_id || configPayload?.run_id || configPayload?.source_run_id || null;

const autopsyByTradeId = new Map();
for (const row of autopsyRows) {
  const tradeId = String(row?.trade_id || "").trim();
  if (tradeId) autopsyByTradeId.set(tradeId, row);
}

const evidenceTrades = trades
  .map((trade) => buildTradeEvidence(trade, autopsyByTradeId.get(String(trade.trade_id || "").trim()) || {}, runId))
  .filter((row) => row.ticker && row.direction && row.entry_ts)
  .sort((a, b) => a.entry_ts - b.entry_ts);

const entryTsList = evidenceTrades.map((row) => row.entry_ts).filter(Number.isFinite);
const exitTsList = evidenceTrades.map((row) => row.exit_ts).filter(Number.isFinite);
const referenceMap = parseJsonMaybe(config?.reference_execution_map) || {};

const output = {
  generated_at: new Date().toISOString(),
  label,
  run_id: runId,
  source: {
    trades: path.resolve(tradesFile),
    autopsy: path.resolve(autopsyFile),
    config: path.resolve(configFile),
  },
  window: {
    start_entry_ts: entryTsList.length ? Math.min(...entryTsList) : null,
    end_entry_ts: entryTsList.length ? Math.max(...entryTsList) : null,
    end_exit_ts: exitTsList.length ? Math.max(...exitTsList) : null,
  },
  summary: {
    trade_count: evidenceTrades.length,
    tickers: [...new Set(evidenceTrades.map((row) => row.ticker))],
    wins: evidenceTrades.filter((row) => row.pnl > 0).length,
    losses: evidenceTrades.filter((row) => row.pnl < 0).length,
    total_pnl: evidenceTrades.reduce((sum, row) => sum + (row.pnl || 0), 0),
  },
  config_summary: {
    source_run_id: configPayload?.source_run_id || null,
    key_count: Object.keys(config || {}).length,
    reference_execution_map_version: referenceMap?.version || null,
    reference_execution_map_exact_entries: Array.isArray(referenceMap?.exact_reference_entries)
      ? referenceMap.exact_reference_entries.length
      : 0,
  },
  trades: evidenceTrades,
};

fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
fs.writeFileSync(path.resolve(outputFile), JSON.stringify(output, null, 2));
console.log(path.resolve(outputFile));
console.log(JSON.stringify(output.summary));
