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
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return parseTs(Number(value));
  const ts = Date.parse(String(value));
  return Number.isFinite(ts) ? ts : null;
}

function dayStartUtcMs(value) {
  if (!value) return null;
  const ts = parseTs(`${value}T00:00:00Z`);
  return Number.isFinite(ts) ? ts : null;
}

function dayEndUtcMs(value) {
  if (!value) return null;
  const ts = parseTs(`${value}T23:59:59.999Z`);
  return Number.isFinite(ts) ? ts : null;
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const mult = 10 ** digits;
  return Math.round(value * mult) / mult;
}

function summarizeSide(reason) {
  const s = String(reason || "").toUpperCase();
  if (!s) return "unknown";
  if (s.includes("TP_FULL")) return "tp_full";
  if (s.includes("TP_HIT_TRIM")) return "tp_trim";
  if (s.includes("PRE_EARNINGS")) return "pre_earnings";
  if (s.includes("HARD_LOSS_CAP")) return "hard_loss_cap";
  if (s.includes("MAX_LOSS")) return "max_loss";
  if (s.includes("SUPPORT_BREAK")) return "support_break";
  if (s.includes("PROFIT_GIVEBACK")) return "profit_giveback";
  if (s.includes("REPLAY_END_CLOSE")) return "replay_end_close";
  return "other";
}

function parseTickers(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function normalizeTrade(trade, autopsyByTradeId) {
  const tradeId = String(trade?.trade_id || "").trim();
  const autopsy = autopsyByTradeId.get(tradeId) || {};
  const signal = parseJsonMaybe(autopsy?.signal_snapshot_json) || {};
  const lineage = signal?.lineage || {};

  return {
    trade_id: tradeId,
    ticker: String(trade?.ticker || autopsy?.ticker || "").toUpperCase(),
    direction: String(trade?.direction || autopsy?.direction || "").toUpperCase(),
    status: trade?.status || autopsy?.status || null,
    entry_ts: parseTs(trade?.entry_ts || autopsy?.entry_ts),
    exit_ts: parseTs(trade?.exit_ts || autopsy?.exit_ts),
    trim_ts: parseTs(trade?.trim_ts || autopsy?.trim_ts),
    rank: toNum(trade?.rank ?? autopsy?.rank, null),
    pnl: toNum(trade?.pnl ?? autopsy?.pnl, 0),
    pnl_pct: toNum(trade?.pnl_pct ?? trade?.pnlPct ?? autopsy?.pnl_pct, 0),
    exit_reason: trade?.exit_reason || autopsy?.exit_reason || null,
    exit_family: summarizeSide(trade?.exit_reason || autopsy?.exit_reason || null),
    entry_path: autopsy?.entry_path || lineage?.entry_path || null,
    selected_engine: lineage?.selected_engine || null,
    selected_management_engine: lineage?.selected_management_engine || null,
    scenario_policy_source: lineage?.scenario_policy_source || null,
    execution_profile_name: autopsy?.execution_profile_name || null,
    market_state: autopsy?.market_state || lineage?.execution_profile?.market_state || null,
    regime_class: lineage?.regime_class || null,
    setup_state: lineage?.state || null,
    entry_quality_score: toNum(
      autopsy?.entry_quality_score ?? signal?.entry_quality_score ?? signal?.lineage?.entry_quality_score,
      null,
    ),
  };
}

function buildTradeList(tradesPayload, autopsyPayload, windowStart, windowEnd, tickers) {
  const trades = loadRows(tradesPayload);
  const autopsyRows = loadRows(autopsyPayload);
  const autopsyByTradeId = new Map();
  for (const row of autopsyRows) {
    const tradeId = String(row?.trade_id || "").trim();
    if (tradeId) autopsyByTradeId.set(tradeId, row);
  }

  return trades
    .map((trade) => normalizeTrade(trade, autopsyByTradeId))
    .filter((trade) => trade.ticker && trade.direction && trade.entry_ts != null)
    .filter((trade) => !tickers.length || tickers.includes(trade.ticker))
    .filter((trade) => windowStart == null || trade.entry_ts >= windowStart)
    .filter((trade) => windowEnd == null || trade.entry_ts <= windowEnd)
    .sort((a, b) => a.entry_ts - b.entry_ts);
}

function matchTrades(referenceTrades, candidateTrades) {
  const remaining = candidateTrades.slice();
  const pairs = [];

  for (const reference of referenceTrades) {
    const compatible = remaining
      .filter((candidate) => candidate.ticker === reference.ticker && candidate.direction === reference.direction)
      .sort((a, b) => {
        const aDelta = Math.abs((a.entry_ts || 0) - (reference.entry_ts || 0));
        const bDelta = Math.abs((b.entry_ts || 0) - (reference.entry_ts || 0));
        return aDelta - bDelta;
      });

    const candidate = compatible[0] || null;
    if (candidate) {
      const idx = remaining.indexOf(candidate);
      if (idx >= 0) remaining.splice(idx, 1);
    }
    pairs.push({ reference, candidate });
  }

  return { pairs, spurious: remaining };
}

function tradeShape(trade) {
  return {
    trade_id: trade.trade_id,
    ticker: trade.ticker,
    direction: trade.direction,
    entry_ts: trade.entry_ts,
    exit_ts: trade.exit_ts,
    rank: trade.rank,
    pnl: round(trade.pnl, 2),
    pnl_pct: round(trade.pnl_pct, 3),
    exit_reason: trade.exit_reason,
    exit_family: trade.exit_family,
    entry_path: trade.entry_path,
    execution_profile_name: trade.execution_profile_name,
    selected_engine: trade.selected_engine,
    selected_management_engine: trade.selected_management_engine,
    regime_class: trade.regime_class,
    setup_state: trade.setup_state,
    entry_quality_score: trade.entry_quality_score,
  };
}

function uniqueTickers(trades) {
  return [...new Set(trades.map((trade) => trade.ticker))].sort();
}

const referenceTradesFile = getArg("reference-trades");
const referenceAutopsyFile = getArg("reference-autopsy");
const candidateTradesFile = getArg("candidate-trades");
const candidateAutopsyFile = getArg("candidate-autopsy");
const outputFile = getArg("output");

if (!referenceTradesFile || !referenceAutopsyFile || !candidateTradesFile || !candidateAutopsyFile || !outputFile) {
  console.error(
    "Usage: node scripts/compare-month-drift.js"
      + " --reference-trades <trades.json>"
      + " --reference-autopsy <trade-autopsy-trades.json>"
      + " --candidate-trades <trades.json>"
      + " --candidate-autopsy <trade-autopsy-trades.json>"
      + " --output <file>"
      + " [--window-start YYYY-MM-DD]"
      + " [--window-end YYYY-MM-DD]"
      + " [--tickers T1,T2]"
      + " [--entry-tolerance-min 240]",
  );
  process.exit(1);
}

const windowStart = dayStartUtcMs(getArg("window-start"));
const windowEnd = dayEndUtcMs(getArg("window-end"));
const entryToleranceMin = toNum(getArg("entry-tolerance-min", "240"), 240);
const tickers = parseTickers(getArg("tickers"));
const referenceLabel = getArg("reference-label", "reference");
const candidateLabel = getArg("candidate-label", "candidate");

const referenceTradesPayload = readJson(referenceTradesFile);
const referenceAutopsyPayload = readJson(referenceAutopsyFile);
const candidateTradesPayload = readJson(candidateTradesFile);
const candidateAutopsyPayload = readJson(candidateAutopsyFile);

const referenceTrades = buildTradeList(referenceTradesPayload, referenceAutopsyPayload, windowStart, windowEnd, tickers);
const candidateTrades = buildTradeList(candidateTradesPayload, candidateAutopsyPayload, windowStart, windowEnd, tickers);

const { pairs, spurious } = matchTrades(referenceTrades, candidateTrades);
const changedMatches = [];
const missingTrades = [];

let matchedCount = 0;
let sameEntryWindowCount = 0;
let samePathCount = 0;
let sameExitFamilyCount = 0;
let sameProfileCount = 0;
let pnlSignFlipCount = 0;

for (const { reference, candidate } of pairs) {
  if (!candidate) {
    missingTrades.push(tradeShape(reference));
    continue;
  }

  matchedCount += 1;
  const entryDeltaMin = ((candidate.entry_ts || 0) - (reference.entry_ts || 0)) / 60000;
  const sameEntryWindow = Math.abs(entryDeltaMin) <= entryToleranceMin;
  const samePath = (reference.entry_path || "") === (candidate.entry_path || "");
  const sameExitFamily = (reference.exit_family || "") === (candidate.exit_family || "");
  const sameProfile = (reference.execution_profile_name || "") === (candidate.execution_profile_name || "");
  const pnlSignFlip = Math.sign(reference.pnl || 0) !== Math.sign(candidate.pnl || 0);

  if (sameEntryWindow) sameEntryWindowCount += 1;
  if (samePath) samePathCount += 1;
  if (sameExitFamily) sameExitFamilyCount += 1;
  if (sameProfile) sameProfileCount += 1;
  if (pnlSignFlip) pnlSignFlipCount += 1;

  const materialDiffs = [];
  if (!sameEntryWindow) materialDiffs.push("entry_shift");
  if (!samePath) materialDiffs.push("entry_path");
  if (!sameExitFamily) materialDiffs.push("exit_family");
  if (!sameProfile) materialDiffs.push("execution_profile");
  if ((reference.selected_engine || "") !== (candidate.selected_engine || "")) materialDiffs.push("selected_engine");
  if ((reference.selected_management_engine || "") !== (candidate.selected_management_engine || "")) materialDiffs.push("management_engine");
  if ((reference.regime_class || "") !== (candidate.regime_class || "")) materialDiffs.push("regime_class");
  if ((reference.setup_state || "") !== (candidate.setup_state || "")) materialDiffs.push("setup_state");
  if (pnlSignFlip) materialDiffs.push("pnl_sign_flip");

  if (materialDiffs.length) {
    changedMatches.push({
      ticker: reference.ticker,
      direction: reference.direction,
      diff_types: materialDiffs,
      entry_delta_min: round(entryDeltaMin, 2),
      rank_delta: round((candidate.rank ?? 0) - (reference.rank ?? 0), 2),
      entry_quality_delta: round((candidate.entry_quality_score ?? 0) - (reference.entry_quality_score ?? 0), 2),
      pnl_delta: round((candidate.pnl ?? 0) - (reference.pnl ?? 0), 2),
      reference: tradeShape(reference),
      candidate: tradeShape(candidate),
    });
  }
}

const spuriousTrades = spurious.map(tradeShape);
const allTickers = [...new Set([...uniqueTickers(referenceTrades), ...uniqueTickers(candidateTrades)])].sort();

const tickerSummary = allTickers.map((ticker) => {
  const referenceRows = referenceTrades.filter((trade) => trade.ticker === ticker);
  const candidateRows = candidateTrades.filter((trade) => trade.ticker === ticker);
  const referenceIds = new Set(referenceRows.map((trade) => trade.trade_id));
  const candidateIds = new Set(candidateRows.map((trade) => trade.trade_id));
  const matchedRows = pairs.filter(({ reference, candidate }) => reference.ticker === ticker && candidate);

  return {
    ticker,
    reference_trade_count: referenceRows.length,
    candidate_trade_count: candidateRows.length,
    matched_trade_count: matchedRows.length,
    missing_trade_count: referenceRows.length - matchedRows.length,
    spurious_trade_count: candidateRows.length - matchedRows.length,
    reference_pnl: round(referenceRows.reduce((sum, trade) => sum + (trade.pnl || 0), 0), 2),
    candidate_pnl: round(candidateRows.reduce((sum, trade) => sum + (trade.pnl || 0), 0), 2),
    pnl_delta: round(
      candidateRows.reduce((sum, trade) => sum + (trade.pnl || 0), 0)
        - referenceRows.reduce((sum, trade) => sum + (trade.pnl || 0), 0),
      2,
    ),
    changed_match_count: changedMatches.filter((row) => row.ticker === ticker).length,
    reference_trade_ids: referenceRows.map((trade) => trade.trade_id),
    candidate_trade_ids: candidateRows.map((trade) => trade.trade_id),
    _reference_ids: referenceIds.size,
    _candidate_ids: candidateIds.size,
  };
}).map(({ _reference_ids, _candidate_ids, ...row }) => row);

const report = {
  generated_at: new Date().toISOString(),
  labels: {
    reference: referenceLabel,
    candidate: candidateLabel,
  },
  inputs: {
    reference_trades: path.resolve(referenceTradesFile),
    reference_autopsy: path.resolve(referenceAutopsyFile),
    candidate_trades: path.resolve(candidateTradesFile),
    candidate_autopsy: path.resolve(candidateAutopsyFile),
  },
  window: {
    start_entry_ts: windowStart,
    end_entry_ts: windowEnd,
    tickers,
    entry_tolerance_min: entryToleranceMin,
  },
  counts: {
    reference_trade_count: referenceTrades.length,
    candidate_trade_count: candidateTrades.length,
    matched_trade_count: matchedCount,
    missing_trade_count: missingTrades.length,
    spurious_trade_count: spuriousTrades.length,
    changed_match_count: changedMatches.length,
  },
  totals: {
    reference_pnl: round(referenceTrades.reduce((sum, trade) => sum + (trade.pnl || 0), 0), 2),
    candidate_pnl: round(candidateTrades.reduce((sum, trade) => sum + (trade.pnl || 0), 0), 2),
    pnl_delta: round(
      candidateTrades.reduce((sum, trade) => sum + (trade.pnl || 0), 0)
        - referenceTrades.reduce((sum, trade) => sum + (trade.pnl || 0), 0),
      2,
    ),
  },
  parity: {
    basket_pct: referenceTrades.length ? round(matchedCount / referenceTrades.length, 4) : 0,
    same_entry_window_pct: referenceTrades.length ? round(sameEntryWindowCount / referenceTrades.length, 4) : 0,
    same_entry_path_pct: referenceTrades.length ? round(samePathCount / referenceTrades.length, 4) : 0,
    same_exit_family_pct: referenceTrades.length ? round(sameExitFamilyCount / referenceTrades.length, 4) : 0,
    same_execution_profile_pct: referenceTrades.length ? round(sameProfileCount / referenceTrades.length, 4) : 0,
    pnl_sign_flip_pct: referenceTrades.length ? round(pnlSignFlipCount / referenceTrades.length, 4) : 0,
  },
  ticker_summary: tickerSummary,
  missing_trades: missingTrades,
  spurious_trades: spuriousTrades,
  changed_matches: changedMatches,
};

fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
fs.writeFileSync(path.resolve(outputFile), JSON.stringify(report, null, 2));

console.log(path.resolve(outputFile));
console.log(JSON.stringify({
  counts: report.counts,
  totals: report.totals,
  parity: report.parity,
}));
