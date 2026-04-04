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
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return parseTs(Number(value));
  const ts = Date.parse(String(value));
  return Number.isFinite(ts) ? ts : null;
}

function exitFamily(reason) {
  const s = String(reason || "").toUpperCase();
  if (!s) return "unknown";
  if (s.includes("TP_FULL")) return "tp_full";
  if (s.includes("PROFIT_GIVEBACK")) return "profit_giveback";
  if (s.includes("PHASE_LEAVE")) return "phase_leave";
  if (s.includes("TD_EXHAUSTION")) return "td_exhaustion";
  if (s.includes("SUPPORT_BREAK")) return "support_break";
  if (s.includes("SL_BREACHED") || s.includes("MAX_LOSS") || s.includes("HARD_LOSS_CAP") || s.includes("TRIGGER_BREACHED")) return "loss_protect";
  if (s.includes("REPLAY_END_CLOSE")) return "replay_end_close";
  if (s.includes("PRE_EARNINGS")) return "pre_earnings";
  if (s.includes("ST15_FLIP")) return "st15_flip";
  if (s.includes("RIPSTER_34_50_LOST_MTF")) return "ripster_mtf";
  return "other";
}

function normalizeCandidateTrade(trade, autopsyByTradeId) {
  const tradeId = String(trade?.trade_id || "").trim();
  const autopsy = autopsyByTradeId.get(tradeId) || {};
  const signal = parseJsonMaybe(autopsy?.signal_snapshot_json) || {};
  const lineage = signal?.lineage || {};
  const executionProfile = parseJsonMaybe(autopsy?.execution_profile_json) || lineage || {};
  return {
    trade_id: tradeId,
    ticker: String(trade?.ticker || autopsy?.ticker || "").toUpperCase(),
    direction: String(trade?.direction || autopsy?.direction || "").toUpperCase(),
    status: trade?.status || autopsy?.status || null,
    entry_ts: parseTs(trade?.entry_ts || autopsy?.entry_ts),
    exit_ts: parseTs(trade?.exit_ts || autopsy?.exit_ts),
    trim_ts: parseTs(trade?.trim_ts || autopsy?.trim_ts),
    pnl: toNum(trade?.pnl || autopsy?.pnl, 0),
    pnl_pct: toNum(trade?.pnl_pct || trade?.pnlPct || autopsy?.pnl_pct, 0),
    trimmed_pct: toNum(trade?.trimmed_pct || autopsy?.trimmed_pct, 0),
    entry_path: autopsy?.entry_path || lineage?.entry_path || null,
    selected_engine: executionProfile?.selected_engine || lineage?.selected_engine || null,
    selected_management_engine: executionProfile?.selected_management_engine || lineage?.selected_management_engine || null,
    engine_source: executionProfile?.engine_source || lineage?.engine_source || null,
    scenario_policy_source: executionProfile?.scenario_policy_source || lineage?.scenario_policy_source || null,
    execution_profile_name: autopsy?.execution_profile_name || executionProfile?.execution_profile?.active_profile || null,
    exit_reason: trade?.exit_reason || autopsy?.exit_reason || null,
  };
}

function windowFilter(trade, windowStart, windowEnd) {
  if (!trade?.entry_ts) return false;
  if (windowStart != null && trade.entry_ts < windowStart) return false;
  if (windowEnd != null && trade.entry_ts > windowEnd) return false;
  return true;
}

function matchTrades(referenceTrades, candidateTrades) {
  const remaining = candidateTrades.slice();
  const pairs = [];
  for (const reference of referenceTrades) {
    const compatible = remaining
      .filter((candidate) => candidate.ticker === reference.ticker && candidate.direction === reference.direction)
      .sort((a, b) => Math.abs((a.entry_ts || 0) - reference.entry_ts) - Math.abs((b.entry_ts || 0) - reference.entry_ts));
    const candidate = compatible[0] || null;
    if (candidate) {
      const idx = remaining.indexOf(candidate);
      if (idx >= 0) remaining.splice(idx, 1);
    }
    pairs.push({ reference, candidate });
  }
  return { pairs, spurious: remaining };
}

const referenceEvidenceFile = getArg("reference-evidence");
const candidateTradesFile = getArg("candidate-trades");
const candidateAutopsyFile = getArg("candidate-autopsy");
const outputFile = getArg("output");
const candidateLabel = getArg("candidate-label", "candidate");
const entryToleranceMin = toNum(getArg("entry-tolerance-min", "20"), 20);
const exitToleranceMin = toNum(getArg("exit-tolerance-min", "240"), 240);
const trimToleranceMin = toNum(getArg("trim-tolerance-min", "240"), 240);

if (!referenceEvidenceFile || !candidateTradesFile || !candidateAutopsyFile || !outputFile) {
  console.error("Usage: node scripts/compare-run-lifecycle-parity.js --reference-evidence <file> --candidate-trades <trades.json> --candidate-autopsy <trade-autopsy-trades.json> --output <file> [--candidate-label <label>]");
  process.exit(1);
}

const referenceEvidence = readJson(referenceEvidenceFile);
const candidateTradesPayload = readJson(candidateTradesFile);
const candidateAutopsyPayload = readJson(candidateAutopsyFile);
const candidateTrades = loadRows(candidateTradesPayload);
const candidateAutopsyRows = loadRows(candidateAutopsyPayload);

const autopsyByTradeId = new Map();
for (const row of candidateAutopsyRows) {
  const tradeId = String(row?.trade_id || "").trim();
  if (tradeId) autopsyByTradeId.set(tradeId, row);
}

const windowStart = referenceEvidence?.window?.start_entry_ts ?? null;
const windowEnd = referenceEvidence?.window?.end_entry_ts ?? null;
const referenceTrades = Array.isArray(referenceEvidence?.trades) ? referenceEvidence.trades : [];
const candidateRows = candidateTrades
  .map((trade) => normalizeCandidateTrade(trade, autopsyByTradeId))
  .filter((trade) => trade.ticker && trade.direction && windowFilter(trade, windowStart, windowEnd))
  .sort((a, b) => (a.entry_ts || 0) - (b.entry_ts || 0));

const { pairs, spurious } = matchTrades(referenceTrades, candidateRows);
const details = [];
let matchedCount = 0;
let entryMatchedCount = 0;
let exitMatchedCount = 0;
let trimMatchedCount = 0;
let pathMatchedCount = 0;
let lifecycleMatchedCount = 0;

for (const { reference, candidate } of pairs) {
  if (!candidate) {
    details.push({
      ticker: reference.ticker,
      direction: reference.direction,
      reference_trade_id: reference.trade_id,
      matched: false,
      reason: "missing_candidate_trade",
    });
    continue;
  }
  matchedCount += 1;
  const entryDeltaMin = ((candidate.entry_ts || 0) - (reference.entry_ts || 0)) / 60000;
  const exitDeltaMin = reference.exit_ts && candidate.exit_ts ? ((candidate.exit_ts - reference.exit_ts) / 60000) : null;
  const trimDeltaMin = reference.trim_ts && candidate.trim_ts ? ((candidate.trim_ts - reference.trim_ts) / 60000) : null;
  const pathMatch = (reference.entry_path || "") === (candidate.entry_path || "");
  const engineMatch = (reference.selected_engine || "") === (candidate.selected_engine || "");
  const managementEngineMatch = (reference.selected_management_engine || "") === (candidate.selected_management_engine || "");
  const engineSourceMatch = (reference.engine_source || "") === (candidate.engine_source || "");
  const scenarioPolicyMatch = (reference.scenario_policy_source || "") === (candidate.scenario_policy_source || "");
  const trimParity = Math.abs((reference.trimmed_pct || 0) - (candidate.trimmed_pct || 0)) < 0.001;
  const exitFamilyMatch = exitFamily(reference.exit_reason) === exitFamily(candidate.exit_reason);

  if (Math.abs(entryDeltaMin) <= entryToleranceMin) entryMatchedCount += 1;
  if (exitDeltaMin != null && Math.abs(exitDeltaMin) <= exitToleranceMin) exitMatchedCount += 1;
  if (
    (reference.trim_ts == null && candidate.trim_ts == null)
    || (trimDeltaMin != null && Math.abs(trimDeltaMin) <= trimToleranceMin)
  ) trimMatchedCount += 1;
  if (pathMatch && engineMatch && managementEngineMatch && engineSourceMatch && scenarioPolicyMatch) pathMatchedCount += 1;
  if (trimParity && exitFamilyMatch) lifecycleMatchedCount += 1;

  details.push({
    ticker: reference.ticker,
    direction: reference.direction,
    reference_trade_id: reference.trade_id,
    candidate_trade_id: candidate.trade_id,
    matched: true,
    entry_delta_min: entryDeltaMin,
    exit_delta_min: exitDeltaMin,
    trim_delta_min: trimDeltaMin,
    path_match: pathMatch,
    engine_match: engineMatch,
    management_engine_match: managementEngineMatch,
    engine_source_match: engineSourceMatch,
    scenario_policy_match: scenarioPolicyMatch,
    trim_parity: trimParity,
    exit_family_match: exitFamilyMatch,
    reference: {
      entry_path: reference.entry_path,
      selected_engine: reference.selected_engine,
      selected_management_engine: reference.selected_management_engine,
      engine_source: reference.engine_source,
      scenario_policy_source: reference.scenario_policy_source,
      exit_reason: reference.exit_reason,
      exit_family: exitFamily(reference.exit_reason),
      trimmed_pct: reference.trimmed_pct,
    },
    candidate: {
      entry_path: candidate.entry_path,
      selected_engine: candidate.selected_engine,
      selected_management_engine: candidate.selected_management_engine,
      engine_source: candidate.engine_source,
      scenario_policy_source: candidate.scenario_policy_source,
      exit_reason: candidate.exit_reason,
      exit_family: exitFamily(candidate.exit_reason),
      trimmed_pct: candidate.trimmed_pct,
    },
  });
}

const report = {
  generated_at: new Date().toISOString(),
  reference_run_id: referenceEvidence?.run_id || null,
  candidate_run_id: candidateTradesPayload?.archive_run_id || candidateTradesPayload?.run_id || null,
  candidate_label: candidateLabel,
  window: {
    start_entry_ts: windowStart,
    end_entry_ts: windowEnd,
  },
  counts: {
    reference_trade_count: referenceTrades.length,
    candidate_trade_count_in_window: candidateRows.length,
    matched_trade_count: matchedCount,
    missing_trade_count: referenceTrades.length - matchedCount,
    spurious_trade_count: spurious.length,
  },
  parity: {
    basket_pct: referenceTrades.length ? matchedCount / referenceTrades.length : 0,
    entry_timing_pct: referenceTrades.length ? entryMatchedCount / referenceTrades.length : 0,
    exit_timing_pct: referenceTrades.length ? exitMatchedCount / referenceTrades.length : 0,
    trim_timing_pct: referenceTrades.length ? trimMatchedCount / referenceTrades.length : 0,
    path_pct: referenceTrades.length ? pathMatchedCount / referenceTrades.length : 0,
    lifecycle_pct: referenceTrades.length ? lifecycleMatchedCount / referenceTrades.length : 0,
  },
  spurious_trades: spurious.map((trade) => ({
    trade_id: trade.trade_id,
    ticker: trade.ticker,
    direction: trade.direction,
    entry_ts: trade.entry_ts,
    entry_path: trade.entry_path,
    exit_reason: trade.exit_reason,
  })),
  details,
};

fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
fs.writeFileSync(path.resolve(outputFile), JSON.stringify(report, null, 2));
console.log(path.resolve(outputFile));
console.log(JSON.stringify(report.parity));
